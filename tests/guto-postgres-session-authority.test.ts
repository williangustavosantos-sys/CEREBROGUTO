import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { PostgresOfficialStateRepository } from "../src/v3/postgres.js";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import type { ActorContext } from "../src/v3/types.js";

// ─── P0 SESSION IDENTITY & COMPLETION AUTHORITY — REAL POSTGRES ──────────
//
// Proves that workoutSessionId is used LITERALLY as the PK of
// workout_sessions (MODELO B), so all exercise events of one session group
// under a single row, and completeWorkoutSession finds that row by the same
// id. Also proves XP events no longer create completed sessions.

type EmbeddedDb = { port: number; stop: () => Promise<void> };

async function startEmbeddedPostgres(): Promise<EmbeddedDb> {
  let PGlite: any, PGLiteSocketServer: any, pgcrypto: any;
  try {
    const pgliteName = "@electric-sql" + "/pglite";
    const pgcryptoName = "@electric-sql" + "/pglite/contrib/pgcrypto";
    const socketName = "@electric-sql" + "/pglite-socket";
    ({ PGlite } = await import(pgliteName));
    ({ pgcrypto } = await import(pgcryptoName));
    ({ PGLiteSocketServer } = await import(socketName));
  } catch (error) {
    throw new Error(
      "CRITICAL GATE FAILED: PGlite infra unavailable for Postgres test. " +
      "It is a declared devDependency — run `npm ci`/`npm install` first. Underlying: " + String(error),
    );
  }
  const dataDir = path.join(os.tmpdir(), `guto-pg-sess-${randomUUID()}`);
  const db = new PGlite({ dataDir, extensions: { pgcrypto } });
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const a = probe.address() as net.AddressInfo; probe.close(() => resolve(a.port)); });
    probe.on("error", reject);
  });
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 10 });
  await server.start();
  return { port, stop: async () => { await server.stop(); await db.close(); } };
}

async function applyMigrations(port: number): Promise<void> {
  const admin = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres", password: "postgres" });
  await admin.connect();
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const migrationDir = join(import.meta.dirname, "..", "migrations", "v3");
  await admin.query("CREATE SCHEMA IF NOT EXISTS guto_v3");
  for (const file of readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationDir, file), "utf8");
    try { await admin.query(sql); } catch { /* idempotent */ }
  }
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guto_v3_runtime') THEN CREATE ROLE guto_v3_runtime LOGIN PASSWORD 'runtime'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guto_v3_app') THEN CREATE ROLE guto_v3_app NOLOGIN; END IF;
  END $$;`);
  await admin.query(`GRANT guto_v3_app TO guto_v3_runtime`);
  await admin.query(`GRANT USAGE ON SCHEMA guto_v3 TO guto_v3_app`);
  await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA guto_v3 TO guto_v3_app`);
  await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA guto_v3 TO guto_v3_app`);
  await admin.end();
}

function createPool(port: number, max: number): pg.Pool {
  return new pg.Pool({ host: "127.0.0.1", port, user: "guto_v3_runtime", password: "runtime", database: "postgres", max, idleTimeoutMillis: 20_000, connectionTimeoutMillis: 8_000 });
}

async function freshActor(repo: PostgresOfficialStateRepository, freq = 6): Promise<ActorContext> {
  const actor = await repo.provisionActor({ externalSubject: `pg-sess-${randomUUID()}`, role: "student", tenantKey: "GUTO_CORE", tenantName: "GUTO Core" });
  const svc = new V3CutoverService(repo);
  await svc.acceptConsent(actor, randomUUID());
  await svc.saveMemory(actor, { requestId: randomUUID(), name: "Will", confirmedName: true, language: "pt-BR" });
  await svc.saveMemory(actor, { requestId: randomUUID(), biologicalSex: "male", userAge: 33, weightKg: 80, heightCm: 181, trainingLevel: "consistent", trainingGoal: "muscle_gain", trainingFrequency: freq });
  await svc.saveMemory(actor, { requestId: randomUUID(), name: "Will", xpEvent: "grant_initial_xp" });
  await svc.startFirstContact(actor, randomUUID());
  await svc.respondFirstContact(actor, { requestId: randomUUID(), expectedStep: "food_restrictions", answer: "Sem restrições." });
  await svc.respondFirstContact(actor, { requestId: randomUUID(), expectedStep: "training_limitations", answer: "Sem limitações." });
  await svc.confirmFirstContact(actor, { requestId: randomUUID(), confirmed: true });
  await svc.generateWorkout(actor, randomUUID());
  return actor;
}

async function cleanup(repo: PostgresOfficialStateRepository, actor: ActorContext): Promise<void> {
  await repo["pool"].query(`DELETE FROM guto_v3.users WHERE id=$1 AND tenant_id=$2`, [actor.userId, actor.tenantId]).catch(() => {});
  await repo["pool"].query(`DELETE FROM guto_v3.tenants WHERE id=$1`, [actor.tenantId]).catch(() => {});
}

let dbHandle: { port: number; stop: () => Promise<void> } | null = null;

async function getDb() {
  // CRITICAL GATE: PGlite is a DECLARED devDependency, so a missing engine is
  // an infrastructure failure, NOT a reason to skip. This must FAIL loudly.
  if (!dbHandle) {
    const e = await startEmbeddedPostgres();
    await applyMigrations(e.port);
    dbHandle = e;
  }
  return dbHandle;
}

test.after(async () => { if (dbHandle) { await dbHandle.stop().catch(() => {}); dbHandle = null; } });

// ─── CASE 1: 5 exercise events → 1 session row, status=started; complete → 1 completed ─

test("PG_SESSION_IDENTITY: 5 exercises with same workoutSessionId → 1 session row, started; complete → 1 completed", async (t) => {
  const db = await getDb(); assert.ok(db, "Postgres engine must be available (declared devDependency)");
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const plan = state.workout!;
    const wsid = randomUUID();
    for (const item of plan.items) {
      await repo.recordWorkoutExerciseEvent({ actor, requestId: randomUUID(), event: { exerciseId: item.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 } });
    }
    // 1 session row, started
    const before = await repo["pool"].query<{ n: string; status: string }>(`SELECT count(*)::text AS n, (SELECT status FROM guto_v3.workout_sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3::uuid) AS status FROM guto_v3.workout_sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3::uuid`, [actor.tenantId, actor.userId, wsid]);
    assert.equal(Number(before.rows[0]!.n), 1, "exactly 1 session row");
    assert.equal(before.rows[0]!.status, "started", "session is started, not completed");
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 0, "0 completed before completion");
    // Complete
    await repo.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid });
    const after = await repo["pool"].query<{ status: string }>(`SELECT status FROM guto_v3.workout_sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3::uuid`, [actor.tenantId, actor.userId, wsid]);
    assert.equal(after.rows[0]!.status, "completed", "session is completed");
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 1, "1 completed after completion");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── CASE 2: same requestId completion = 1 ────────────────────────────────

test("PG_SESSION_COMPLETION: same requestId → 1 completion", async (t) => {
  const db = await getDb(); assert.ok(db, "Postgres engine must be available (declared devDependency)");
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const wsid = randomUUID();
    await repo.recordWorkoutExerciseEvent({ actor, requestId: randomUUID(), event: { exerciseId: state.workout!.items[0]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 } });
    const reqId = randomUUID();
    await repo.completeWorkoutSession({ actor, requestId: reqId, workoutSessionId: wsid });
    await repo.completeWorkoutSession({ actor, requestId: reqId, workoutSessionId: wsid });
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 1, "same requestId = 1 completion");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── CASE 3: different requestIds same session = 1 ───────────────────────

test("PG_SESSION_COMPLETION: different requestIds same session → 1 completion", async (t) => {
  const db = await getDb(); assert.ok(db, "Postgres engine must be available (declared devDependency)");
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const wsid = randomUUID();
    await repo.recordWorkoutExerciseEvent({ actor, requestId: randomUUID(), event: { exerciseId: state.workout!.items[0]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 } });
    await repo.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid });
    await repo.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid });
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 1, "different requestIds same session = 1 completion");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── CASE 4: concurrent completion = 1 ────────────────────────────────────

test("PG_SESSION_COMPLETION: concurrent different requestIds same session → 1", async (t) => {
  const db = await getDb(); assert.ok(db, "Postgres engine must be available (declared devDependency)");
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const wsid = randomUUID();
    await repo.recordWorkoutExerciseEvent({ actor, requestId: randomUUID(), event: { exerciseId: state.workout!.items[0]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 } });
    await Promise.allSettled([
      repo.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid }),
      repo.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid }),
    ]);
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 1, "concurrent = 1 completion");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── CASE 5: concurrent exercise events same session = 1 session row ─────

test("PG_SESSION_IDENTITY: concurrent exercise events same workoutSessionId → 1 session row", async (t) => {
  const db = await getDb(); assert.ok(db, "Postgres engine must be available (declared devDependency)");
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const wsid = randomUUID();
    const items = state.workout!.items.slice(0, 2);
    await Promise.allSettled(items.map((item) => repo.recordWorkoutExerciseEvent({ actor, requestId: randomUUID(), event: { exerciseId: item.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 } })));
    const rows = await repo["pool"].query<{ n: string }>(`SELECT count(*)::text AS n FROM guto_v3.workout_sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3::uuid`, [actor.tenantId, actor.userId, wsid]);
    assert.equal(Number(rows.rows[0]!.n), 1, "concurrent exercise events = 1 session row");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── XP AUTHORITY: complete_daily_mission does NOT create workout session ─

test("PG_XP_AUTHORITY: bare complete_daily_mission memory mutation is blocked; XP never rotates", async (t) => {
  const db = await getDb(); assert.ok(db, "Postgres engine must be available (declared devDependency)");
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const before = await repo.countCompletedWorkoutSessions(actor);
    assert.equal(before, 0);
    const svc = new V3CutoverService(repo);
    // P0 (workout validation authority): the bypass is closed — a bare memory
    // mutation with complete_daily_mission is REJECTED; the only path to XP is
    // validateAndCompleteWorkoutSession (selfie proof + session completion).
    await assert.rejects(
      () => svc.saveMemory(actor, { requestId: randomUUID(), name: "Will", xpEvent: "complete_daily_mission" }),
      (error: unknown) => (error as { code?: string }).code === "V3_WORKOUT_VALIDATION_REQUIRED",
      "bare complete_daily_mission mutation must be blocked",
    );
    const after = await repo.countCompletedWorkoutSessions(actor);
    assert.equal(after, 0, "blocked XP-only path does NOT create a completed workout session");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── XP AUTHORITY: accept_adapted_mission does NOT create workout session ─

test("PG_XP_AUTHORITY: accept_adapted_mission does not advance workout session rotation", async (t) => {
  const db = await getDb(); assert.ok(db, "Postgres engine must be available (declared devDependency)");
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const before = await repo.countCompletedWorkoutSessions(actor);
    assert.equal(before, 0);
    const svc = new V3CutoverService(repo);
    await svc.saveMemory(actor, { requestId: randomUUID(), name: "Will", xpEvent: "accept_adapted_mission" });
    const after = await repo.countCompletedWorkoutSessions(actor);
    assert.equal(after, 0, "accept_adapted_mission XP event does NOT create a completed workout session");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── CROSS-TENANT: cannot complete another user's session ─────────────────

test("PG_CROSS_TENANT: cannot complete another user's session", async (t) => {
  const db = await getDb(); assert.ok(db, "Postgres engine must be available (declared devDependency)");
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actorA = await freshActor(repo);
  const actorB = await freshActor(repo);
  try {
    const stateA = await repo.loadAppState(actorA);
    const wsid = randomUUID();
    await repo.recordWorkoutExerciseEvent({ actor: actorA, requestId: randomUUID(), event: { exerciseId: stateA.workout!.items[0]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 } });
    // Actor B tries to complete Actor A's session
    await assert.rejects(() => repo.completeWorkoutSession({ actor: actorB, requestId: randomUUID(), workoutSessionId: wsid }), "cross-user completion rejected");
    assert.equal(await repo.countCompletedWorkoutSessions(actorA), 0, "Actor A's session not completed by Actor B");
    assert.equal(await repo.countCompletedWorkoutSessions(actorB), 0, "Actor B has no sessions");
  } finally { await cleanup(repo, actorA); await cleanup(repo, actorB); await repo["pool"].end(); }
});

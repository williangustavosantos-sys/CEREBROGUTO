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

// ─── P0 WORKOUT VALIDATION AUTHORITY — REAL POSTGRES (PGlite) ─────────────
// ONE transaction completes the session AND records XP (never one without the
// other), with ownership/existence/context-currency gates and idempotency.

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
    throw new Error("CRITICAL GATE FAILED: PGlite infra unavailable for Postgres validation test. Underlying: " + String(error));
  }
  const dataDir = path.join(os.tmpdir(), `guto-pg-val-${randomUUID()}`);
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

async function freshActor(repo: PostgresOfficialStateRepository, tenantKey = "GUTO_CORE"): Promise<ActorContext> {
  const actor = await repo.provisionActor({ externalSubject: `pg-val-${randomUUID()}`, role: "student", tenantKey, tenantName: tenantKey });
  const svc = new V3CutoverService(repo);
  await svc.acceptConsent(actor, randomUUID());
  await svc.saveMemory(actor, { requestId: randomUUID(), name: "Will", confirmedName: true, language: "pt-BR" });
  await svc.saveMemory(actor, { requestId: randomUUID(), biologicalSex: "male", userAge: 33, weightKg: 80, heightCm: 181, trainingLevel: "consistent", trainingGoal: "muscle_gain", trainingFrequency: 4 });
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
  if (!dbHandle) {
    const e = await startEmbeddedPostgres();
    await applyMigrations(e.port);
    dbHandle = e;
  }
  return dbHandle;
}

test.after(async () => { if (dbHandle) { await dbHandle.stop().catch(() => {}); dbHandle = null; } });

const evidence = () => ({ sha256: "b".repeat(64), mime: "image/jpeg" as const, byteLength: 16384 });

async function openSession(repo: PostgresOfficialStateRepository, actor: ActorContext): Promise<string> {
  const state = await repo.loadOfficialSnapshot(actor);
  const wsid = randomUUID();
  await repo.recordWorkoutExerciseEvent({
    actor,
    requestId: randomUUID(),
    event: { exerciseId: state.workout!.items[0]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
  });
  return wsid;
}

async function sessionStatus(repo: PostgresOfficialStateRepository, actor: ActorContext, wsid: string): Promise<string> {
  const row = await repo["pool"].query<{ status: string }>(`SELECT status FROM guto_v3.workout_sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3::uuid`, [actor.tenantId, actor.userId, wsid]);
  return row.rows[0]?.status;
}

async function xpCount(repo: PostgresOfficialStateRepository, actor: ActorContext): Promise<number> {
  const row = await repo["pool"].query<{ n: string }>(`SELECT count(*)::text AS n FROM guto_v3.xp_ledger WHERE tenant_id=$1 AND user_id=$2 AND reason_code='complete_daily_mission'`, [actor.tenantId, actor.userId]);
  return Number(row.rows[0]!.n);
}

test("PG_VALIDATE_ATOMIC: validation completes session + XP + rotation in one authoritative call", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const wsid = await openSession(repo, actor);
    assert.equal(await sessionStatus(repo, actor, wsid), "started");
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 0);
    const outcome = await repo.validateAndCompleteWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() });
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.xpGranted, true);
    assert.equal(outcome.nextSessionIndex, 1);
    assert.equal(await sessionStatus(repo, actor, wsid), "completed", "session completed");
    assert.equal(await xpCount(repo, actor), 1, "XP exactly once");
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 1, "rotation once");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

test("PG_VALIDATE_IDEMPOTENT: same requestId replay → completed ok, no second XP, no second rotation", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const wsid = await openSession(repo, actor);
    const reqId = randomUUID();
    const first = await repo.validateAndCompleteWorkoutSession({ actor, requestId: reqId, workoutSessionId: wsid, evidence: evidence() });
    const replay = await repo.validateAndCompleteWorkoutSession({ actor, requestId: reqId, workoutSessionId: wsid, evidence: evidence() });
    assert.equal(first.xpGranted, true);
    assert.equal(replay.xpGranted, false, "replay grants no XP");
    assert.equal(await xpCount(repo, actor), 1);
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 1);
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

test("PG_VALIDATE_DIFFERENT_REQUEST: different requestId same session → XP once, rotation once", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const wsid = await openSession(repo, actor);
    await repo.validateAndCompleteWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() });
    const second = await repo.validateAndCompleteWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() });
    assert.equal(second.xpGranted, false);
    assert.equal(await xpCount(repo, actor), 1);
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 1);
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

test("PG_VALIDATE_CONCURRENT: 2 concurrent validations → 1 completion, 1 XP, 1 rotation", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const wsid = await openSession(repo, actor);
    const results = await Promise.allSettled([
      repo.validateAndCompleteWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() }),
      repo.validateAndCompleteWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.ok(fulfilled.length >= 1, "at least one completion succeeds");
    assert.equal(await sessionStatus(repo, actor, wsid), "completed");
    assert.equal(await xpCount(repo, actor), 1, "concurrent = exactly one XP");
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 1, "concurrent = exactly one rotation");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

test("PG_VALIDATE_CROSS_USER: user B cannot validate user A's session — no mutation", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const a = await freshActor(repo);
  const b = await freshActor(repo);
  try {
    const wsid = await openSession(repo, a);
    // RLS hides the foreign row entirely → 404 deny without cross-tenant leak.
    await assert.rejects(
      () => repo.validateAndCompleteWorkoutSession({ actor: b, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() }),
      (error: unknown) => (error as { code?: string }).code === "V3_WORKOUT_SESSION_NOT_FOUND",
    );
    assert.equal(await sessionStatus(repo, a, wsid), "started", "A's session untouched");
    assert.equal(await xpCount(repo, b), 0);
  } finally { await cleanup(repo, a); await cleanup(repo, b); await repo["pool"].end(); }
});

test("PG_VALIDATE_CROSS_TENANT: tenant B cannot validate tenant A's session — no mutation", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const a = await freshActor(repo, "GUTO_CORE");
  const b = await freshActor(repo, "OTHER_TENANT");
  try {
    const wsid = await openSession(repo, a);
    await assert.rejects(
      () => repo.validateAndCompleteWorkoutSession({ actor: b, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() }),
      (error: unknown) => (error as { code?: string }).code === "V3_WORKOUT_SESSION_NOT_FOUND",
    );
    assert.equal(await sessionStatus(repo, a, wsid), "started", "A's session untouched");
  } finally { await cleanup(repo, a); await cleanup(repo, b); await repo["pool"].end(); }
});

test("PG_VALIDATE_MISSING: random session id → 404 deny, no mutation", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    await assert.rejects(
      () => repo.validateAndCompleteWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: randomUUID(), evidence: evidence() }),
      (error: unknown) => (error as { code?: string }).code === "V3_WORKOUT_SESSION_NOT_FOUND",
    );
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 0);
    assert.equal(await xpCount(repo, actor), 0);
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

test("PG_VALIDATE_STALE_CONTEXT: stale confirmed context blocks validation", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const wsid = await openSession(repo, actor);
    const svc = new V3CutoverService(repo);
    await svc.saveMemory(actor, { requestId: randomUUID(), weightKg: 74 });
    await assert.rejects(
      () => repo.validateAndCompleteWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() }),
      (error: unknown) => (error as { code?: string }).code === "V3_CONTEXT_RECONFIRMATION_REQUIRED",
    );
    assert.equal(await sessionStatus(repo, actor, wsid), "started");
    assert.equal(await xpCount(repo, actor), 0);
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

test("PG_VALIDATE_EVIDENCE: only the sha256 + metadata are persisted, never the image", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const wsid = await openSession(repo, actor);
    await repo.validateAndCompleteWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() });
    const rows = await repo["pool"].query<{ payload: unknown }>(`SELECT payload FROM guto_v3.guto_events WHERE tenant_id=$1 AND user_id=$2 AND event_type='workout.validation_completed' ORDER BY event_id DESC LIMIT 1`, [actor.tenantId, actor.userId]);
    const payload = JSON.stringify(rows.rows[0]?.payload || {});
    assert.match(payload, /evidenceSha256/);
    assert.doesNotMatch(payload, /base64|data:image|0xff|image\/jpeg;base64/i, "raw evidence never persisted");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});
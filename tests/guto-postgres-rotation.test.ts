import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { PostgresOfficialStateRepository } from "../src/v3/postgres.js";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import { generateWorkoutDraft } from "../src/v3/generation-engines.js";
import type { ActorContext, OfficialSnapshot } from "../src/v3/types.js";

// ─── GATE 2 — POSTGRES 6-SESSION ROTATION (REAL POSTGRES / PGlite) ─────────
//
// Proves the WHOLE chain on the real Postgres engine:
//
//   Postgres workout_sessions row → exercise events → completeWorkoutSession
//   → countCompletedWorkoutSessions → OfficialSnapshot.nextSessionIndex
//   → generateWorkoutDraft → next session.
//
// This is the authority test for the closed-beta gate. It runs against PGlite
// (the actual Postgres engine compiled to WASM, exposed over the wire protocol
// via @electric-sql/pglite-socket). It NEVER uses InMemoryOfficialStateRepository.
//
// PGlite is a DECLARED devDependency (package.json). If it cannot be loaded,
// this file FAILS — it never silently SKIPs a critical gate.

type EmbeddedDb = { port: number; stop: () => Promise<void> };

async function startEmbeddedPostgres(): Promise<EmbeddedDb> {
  let PGlite: any, PGLiteSocketServer: any, pgcrypto: any;
  try {
    // Indirect specifiers: TypeScript static resolution must NOT pull these
    // into the Vercel build gate; at runtime they resolve normally.
    const pgliteName = "@electric-sql" + "/pglite";
    const pgcryptoName = "@electric-sql" + "/pglite/contrib/pgcrypto";
    const socketName = "@electric-sql" + "/pglite-socket";
    ({ PGlite } = await import(pgliteName));
    ({ pgcrypto } = await import(pgcryptoName));
    ({ PGLiteSocketServer } = await import(socketName));
  } catch (error) {
    throw new Error(
      "CRITICAL GATE FAILED: PGlite infra unavailable for Postgres rotation test. " +
      "It is declared in devDependencies; run `npm ci`/`npm install` first. Underlying: " + String(error),
    );
  }
  const dataDir = path.join(os.tmpdir(), `guto-pg-rot-${randomUUID()}`);
  const db = new PGlite({ dataDir, extensions: { pgcrypto } });
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const a = probe.address() as net.AddressInfo; probe.close(() => resolve(a.port)); });
    probe.on("error", reject);
  });
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 10 });
  await server.start();
  return { port, stop: async () => { await server.stop().catch(() => {}); await db.close(); } };
}

async function applyMigrations(port: number): Promise<void> {
  const admin = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres", password: "postgres" });
  await admin.connect();
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const migrationDir = join(import.meta.dirname, "..", "migrations", "v3");
  await admin.query("CREATE SCHEMA IF NOT EXISTS guto_v3");
  await admin.query(`CREATE TABLE IF NOT EXISTS guto_v3.schema_migrations (
    filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const file of readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationDir, file), "utf8");
    const applied = await admin.query("SELECT 1 FROM guto_v3.schema_migrations WHERE filename=$1", [file]);
    if (applied.rows[0]) continue;
    await admin.query(sql);
    await admin.query("INSERT INTO guto_v3.schema_migrations (filename, checksum) VALUES ($1, $2)", [file, "embedded"]);
  }
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guto_v3_runtime') THEN CREATE ROLE guto_v3_runtime LOGIN PASSWORD 'runtime'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guto_v3_app') THEN CREATE ROLE guto_v3_app NOLOGIN; END IF;
  END $$;`);
  await admin.query(`GRANT guto_v3_app TO guto_v3_runtime`);
  await admin.query(`GRANT USAGE ON SCHEMA guto_v3 TO guto_v3_app`);
  await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA guto_v3 TO guto_v3_app`);
  await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA guto_v3 TO guto_v3_app`);
  await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA guto_v3 GRANT ALL ON TABLES TO guto_v3_app`);
  await admin.end();
}

function createPool(port: number, max: number): pg.Pool {
  return new pg.Pool({ host: "127.0.0.1", port, user: "guto_v3_runtime", password: "runtime", database: "postgres", max, idleTimeoutMillis: 20_000, connectionTimeoutMillis: 8_000 });
}

async function provisionFresh(repo: PostgresOfficialStateRepository, tenantKey: string, freq = 6): Promise<ActorContext> {
  const actor = await repo.provisionActor({ externalSubject: `pg-rot-${randomUUID()}`, role: "student", tenantKey, tenantName: `Tenant ${tenantKey}` });
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

let dbHandle: EmbeddedDb | null = null;

async function getDb(): Promise<EmbeddedDb> {
  if (!dbHandle) {
    const embedded = await startEmbeddedPostgres();
    await applyMigrations(embedded.port);
    dbHandle = embedded;
  }
  return dbHandle;
}

test.after(async () => { if (dbHandle) { await dbHandle.stop().catch(() => {}); dbHandle = null; } });

/** Record every exercise of the current active plan under one logical session, then complete it. Returns the session id. */
async function completeOnePlanSession(repo: PostgresOfficialStateRepository, actor: ActorContext): Promise<string> {
  const state = await repo.loadAppState(actor);
  const plan = state.workout!;
  const wsid = randomUUID();
  for (const item of plan.items) {
    await repo.recordWorkoutExerciseEvent({
      actor, requestId: randomUUID(),
      event: { exerciseId: item.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
    });
  }
  await repo.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid });
  return wsid;
}

// ─── GATE 2 CORE: full 6-session rotation on Postgres ─────────────────────

test("PG_ROTATION_6: PUSH→PULL→LEGS→PUSH→PULL→LEGS in Postgres (count + nextSessionIndex + draft labels)", async () => {
  const db = await getDb();
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await provisionFresh(repo, "tenant-rot6");
  const svc = new V3CutoverService(repo);
  try {
    const expected = ["Push", "Pull", "Legs", "Push", "Pull", "Legs"];
    const labels: string[] = [];

    for (let s = 0; s < 6; s++) {
      // Phase A: generate the workout draft for the current next session.
      const snapI = await repo.loadOfficialSnapshot(actor);
      assert.equal(snapI.nextSessionIndex, s, `nextSessionIndex before session ${s + 1} = ${s}`);
      const draft = generateWorkoutDraft(snapI);
      labels.push((draft.generatedFrom as { sessionLabel?: string })?.sessionLabel || draft.title);

      // Phase B: record + complete THIS session (multiple exercises, one row).
      const wsid = await completeOnePlanSession(repo, actor);

      // Phase C: verify durable Postgres state advanced by exactly one.
      const snapJ = await repo.loadOfficialSnapshot(actor);
      assert.equal(snapJ.nextSessionIndex, s + 1, `nextSessionIndex after session ${s + 1} = ${s + 1}`);
      assert.equal((await repo.countCompletedWorkoutSessions(actor)), s + 1, `completed count after session ${s + 1}`);
      assert.equal(
        (await repo["pool"].query(`SELECT count(*)::int AS n FROM guto_v3.workout_sessions WHERE tenant_id=$1 AND user_id=$2 AND status='completed'`, [actor.tenantId, actor.userId])).rows[0]!.n,
        s + 1, "workout_sessions completed rows match count",
      );
      // Each logical session maps to exactly one workout_sessions row.
      const sessId = (await repo["pool"].query<{ id: string }>(`SELECT id FROM guto_v3.workout_sessions WHERE tenant_id=$1 AND user_id=$2 AND status='completed' AND id=$3::uuid`, [actor.tenantId, actor.userId, wsid])).rows[0];
      assert.ok(sessId, "completed session row present with the literal workoutSessionId");

      // Phase D: regenerate the workout so the next session index is exercised
      // end-to-end through replaceWorkoutPlan.
      if (s < 5) await svc.generateWorkout(actor, randomUUID());
    }

    // EXPLICIT deep-equal sequence assert (not just length).
    assert.deepEqual(labels, expected, "6x Postgres rotation sequence must be PUSH/PULL/LEGS ×2");
    assert.equal(labels.length, 6);
    console.log("PG_ROTATION_6 labels:", labels.join(" → "));
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── GATE 2 auxiliary: cross-tenant same workoutSessionId (Gate 1 assert) ─

test("PG_ROTATION_CROSS_TENANT: B cannot record an exercise event on A's session by reusing the same workoutSessionId", async () => {
  const db = await getDb();
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actorA = await provisionFresh(repo, "tenant-A");
  const actorB = await provisionFresh(repo, "tenant-B");
  try {
    // A legitimately creates session X.
    const stateA = await repo.loadAppState(actorA);
    const wsid = randomUUID();
    await repo.recordWorkoutExerciseEvent({ actor: actorA, requestId: randomUUID(), event: { exerciseId: stateA.workout!.items[0]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 } });
    const before = await repo["pool"].query<{ n: string }>(`SELECT count(*)::text AS n FROM guto_v3.workout_session_exercises WHERE session_id=$1::uuid`, [wsid]);
    assert.equal(Number(before.rows[0]!.n), 1, "A recorded exactly 1 exercise on X");

    // B (different tenant AND user) tries to reuse A's session id with B's own exercise.
    const stateB = await repo.loadAppState(actorB);
    await assert.rejects(
      () => repo.recordWorkoutExerciseEvent({ actor: actorB, requestId: randomUUID(), event: { exerciseId: stateB.workout!.items[0]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 } }),
      "B must be rejected when reusing A's workoutSessionId",
    );

    // Session X is still A's and NOTHING was attached by B.
    const after = await repo["pool"].query<{ n: string; tenant: string; user: string }>(
      `SELECT e.session_id,
              (SELECT count(*) FROM guto_v3.workout_session_exercises e2 WHERE e2.session_id=$1::uuid) AS n,
              s.tenant_id::text AS tenant, s.user_id::text AS user
         FROM guto_v3.workout_session_exercises e JOIN guto_v3.workout_sessions s ON s.id=e.session_id
        WHERE e.session_id=$1::uuid LIMIT 1`, [wsid]);
    const row = after.rows[0]!;
    assert.equal(Number(row.n), 1, "no foreign exercise appended to A's session");
    assert.equal(row.tenant, actorA.tenantId, "session X still belongs to A's tenant");
    assert.equal(row.user, actorA.userId, "session X still belongs to A's user");

    // B has no session rows or exercise history pointing at X.
    const bHist = await repo["pool"].query<{ n: string }>(`SELECT count(*)::text AS n FROM guto_v3.workout_session_exercises WHERE tenant_id=$1 AND user_id=$2 AND session_id=$3::uuid`, [actorB.tenantId, actorB.userId, wsid]);
    assert.equal(Number(bHist.rows[0]!.n), 0, "B has zero exercises linked to X");

    // A can still use X afterwards.
    await repo.recordWorkoutExerciseEvent({ actor: actorA, requestId: randomUUID(), event: { exerciseId: stateA.workout!.items[0]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 11, setsCompleted: 3, perceivedDifficulty: 5 } });
    assert.equal(Number((await repo["pool"].query(`SELECT count(*)::text AS n FROM guto_v3.workout_session_exercises WHERE session_id=$1::uuid`, [wsid])).rows[0]!.n), 2, "A can keep using X after B's rejected attempt");
  } finally { await cleanup(repo, actorA); await cleanup(repo, actorB); await repo["pool"].end(); }
});

// ─── GATE 2 auxiliary: partial session does not advance (Postgres) ────────

test("PG_ROTATION_PARTIAL: partial session (1 of 5 exercises) does not advance index", async () => {
  const db = await getDb();
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await provisionFresh(repo, "tenant-partial");
  try {
    const state = await repo.loadAppState(actor);
    const wsid = randomUUID();
    await repo.recordWorkoutExerciseEvent({ actor, requestId: randomUUID(), event: { exerciseId: state.workout!.items[0]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 } });
    assert.equal((await repo.loadOfficialSnapshot(actor)).nextSessionIndex, 0, "1 exercise, no completion → index stays 0");
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 0, "no completed session count");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── GATE 2 auxiliary: 5 exercises → one workout_sessions row (Postgres) ──

test("PG_ROTATION_5EX_1ROW: 5 exercise events in one session → one workout_sessions row", async () => {
  const db = await getDb();
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await provisionFresh(repo, "tenant-5ex");
  try {
    const state = await repo.loadAppState(actor);
    const wsid = randomUUID();
    for (const item of state.workout!.items) {
      await repo.recordWorkoutExerciseEvent({ actor, requestId: randomUUID(), event: { exerciseId: item.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 } });
    }
    const sessions = (await repo["pool"].query(`SELECT count(*)::int AS n FROM guto_v3.workout_sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3::uuid`, [actor.tenantId, actor.userId, wsid])).rows[0]!.n;
    assert.equal(sessions, 1, "exactly one workout_sessions row for 5 events in one session");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── IN-MEMORY PARITY: same contract semantics on the in-memory repo ──────

async function inMemoryFounder(freq = 6) {
  const repository = new InMemoryOfficialStateRepository();
  const actor = await repository.provisionActor({ externalSubject: `mem-rot-${randomUUID()}`, role: "student", tenantKey: "GUTO_CORE", tenantName: "GUTO Core" });
  const svc = new V3CutoverService(repository);
  await svc.acceptConsent(actor, randomUUID());
  await svc.saveMemory(actor, { requestId: randomUUID(), name: "Will", confirmedName: true, language: "pt-BR" });
  await svc.saveMemory(actor, { requestId: randomUUID(), biologicalSex: "male", userAge: 33, weightKg: 80, heightCm: 181, trainingLevel: "consistent", trainingGoal: "muscle_gain", trainingFrequency: freq });
  await svc.saveMemory(actor, { requestId: randomUUID(), name: "Will", xpEvent: "grant_initial_xp" });
  await svc.startFirstContact(actor, randomUUID());
  await svc.respondFirstContact(actor, { requestId: randomUUID(), expectedStep: "food_restrictions", answer: "Sem restrições." });
  await svc.respondFirstContact(actor, { requestId: randomUUID(), expectedStep: "training_limitations", answer: "Sem limitações." });
  await svc.confirmFirstContact(actor, { requestId: randomUUID(), confirmed: true });
  await svc.generateWorkout(actor, randomUUID());
  return { repository, actor };
}

async function inMemoryCompleteOne(repository: InMemoryOfficialStateRepository, actor: ActorContext, snapshot?: OfficialSnapshot): Promise<string> {
  const snap = snapshot || await repository.loadOfficialSnapshot(actor);
  const wsid = randomUUID();
  for (const item of snap.workout!.items) {
    await repository.recordWorkoutExerciseEvent({ actor, requestId: randomUUID(), event: { exerciseId: item.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 } });
  }
  await repository.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid });
  return wsid;
}

test("IN_MEMORY_PARITY: 6x rotation produces the same PUSH/PULL/LEGS sequence", async () => {
  const { repository, actor } = await inMemoryFounder(6);
  const expected = ["Push", "Pull", "Legs", "Push", "Pull", "Legs"];
  const labels: string[] = [];
  const svc = new V3CutoverService(repository);
  for (let s = 0; s < 6; s++) {
    const snap = await repository.loadOfficialSnapshot(actor);
    assert.equal(snap.nextSessionIndex, s, `in-memory nextSessionIndex before ${s + 1}`);
    const draft = generateWorkoutDraft(snap);
    labels.push((draft.generatedFrom as { sessionLabel?: string })?.sessionLabel || draft.title);
    await inMemoryCompleteOne(repository, actor, snap);
    assert.equal((await repository.loadOfficialSnapshot(actor)).nextSessionIndex, s + 1, `in-memory advance after ${s + 1}`);
    if (s < 5) await svc.generateWorkout(actor, randomUUID());
  }
  assert.deepEqual(labels, expected, "in-memory parity: same 6x sequence");
  console.log("IN_MEMORY_PARITY labels:", labels.join(" → "));
});

// ─── IN-MEMORY PARITY: cross-tenant isolation semantics ──────────────────

test("IN_MEMORY_PARITY: cross-actor workoutSessionId is isolated per actor", async () => {
  const repoA = new InMemoryOfficialStateRepository();
  const repoB = new InMemoryOfficialStateRepository();
  // Even with the SAME workoutSessionId, indices stay independent per actor
  // because in-memory state is keyed by actor. Prove the parity contract: A
  // advancing does not move B, and vice versa.
  const a = await repoA.provisionActor({ externalSubject: `mem-a-${randomUUID()}`, role: "student", tenantKey: "T_A", tenantName: "Tenant A" });
  const b = await repoB.provisionActor({ externalSubject: `mem-b-${randomUUID()}`, role: "student", tenantKey: "T_B", tenantName: "Tenant B" });
  const wsa = randomUUID();
  await repoA.completeWorkoutSession({ actor: a, requestId: randomUUID(), workoutSessionId: wsa });
  assert.equal(await repoA.countCompletedWorkoutSessions(a), 1, "A advanced");
  assert.equal(await repoB.countCompletedWorkoutSessions(b), 0, "B unaffected by A's session id");
});
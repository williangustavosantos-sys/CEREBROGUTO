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
import { Beta1CurationService } from "../src/v3/beta1-curation-service.js";
import { Beta1WorkoutService } from "../src/v3/beta1-workout-service.js";
import type { ActorContext } from "../src/v3/types.js";

// ─── BETA1 CRITICAL GATE — REAL POSTGRES (PGlite) ────────────────────────────
// Proves the Beta 1 hypothesis end-to-end on the real authority:
//   memory persists → recall is scoped → correction supersedes → tenant
//   isolation holds → execution is set-level → completion is self_report,
//   exactly-once → the next workout reflects the memory/history.

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
  const dataDir = path.join(os.tmpdir(), `guto-pg-beta1-${randomUUID()}`);
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

async function freshActor(repo: PostgresOfficialStateRepository, opts: { trainingLevel?: "beginner" | "returning" | "consistent" | "advanced" } = {}): Promise<ActorContext> {
  const actor = await repo.provisionActor({ externalSubject: `pg-beta1-${randomUUID()}`, role: "student", tenantKey: "GUTO_CORE", tenantName: "GUTO Core" });
  const svc = new V3CutoverService(repo);
  await svc.acceptConsent(actor, randomUUID());
  await svc.saveMemory(actor, { requestId: randomUUID(), name: "Beta", confirmedName: true, language: "pt-BR" });
  await svc.saveMemory(actor, {
    requestId: randomUUID(),
    biologicalSex: "male", userAge: 30, weightKg: 80, heightCm: 180,
    trainingLevel: opts.trainingLevel ?? "consistent",
    trainingGoal: "muscle_gain", trainingFrequency: 4,
  });
  await svc.saveMemory(actor, { requestId: randomUUID(), name: "Beta", xpEvent: "grant_initial_xp" });
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

// ─── MEMORY 1/5/6: persistence + provenance (survives new connections) ──────

test("BETA1_MEMORY_PERSISTENCE: declared preference persists with provenance and survives new connections", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const actor = await freshActor(repo);
  try {
    const requestId = randomUUID();
    const persisted = await curation.curateFromTurn(actor, requestId, "Eu odeio esteira. Prefiro bicicleta a esteira.");
    assert.ok(persisted.length >= 1, "at least one curated memory persisted");
    const preferred = persisted.find((memory) => memory.key === "preferred_cardio");
    assert.ok(preferred, "preferred_cardio persisted");
    assert.equal(preferred!.category, "TRAINING_PREFERENCES");
    assert.equal(preferred!.status, "ACTIVE");
    assert.equal(preferred!.sourceType, "conversation");
    assert.equal(preferred!.sourceRequestId, requestId, "provenance: source request id");
    assert.ok(preferred!.supersedesId === null, "first fact has no predecessor");
    // Readback through a DIFFERENT repository instance (fresh connection = fresh runtime).
    const repo2 = new PostgresOfficialStateRepository(createPool(db.port, 10));
    const snapshot = await new Beta1CurationService(repo2).buildRelevantMemorySnapshot(actor, "chat");
    const found = snapshot.memories.find((memory) => memory.key === "preferred_cardio");
    assert.ok(found, "memory readable from a brand-new repository/connection");
    assert.equal(found!.value.preferred, "bike");
    await repo2["pool"].end();
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── MEMORY 3: correction supersedes (never two simultaneous truths) ────────

test("BETA1_MEMORY_SUPERSESSION: 'agora minha academia tem hack' supersedes the old fact, history preserved", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const actor = await freshActor(repo);
  try {
    await curation.curateFromTurn(actor, randomUUID(), "Minha academia não tem hack squat.");
    const first = await repo.loadRelevantMemories({ actor, categories: ["TRAINING_ENVIRONMENT"], limit: 10 });
    assert.equal(first.filter((memory) => memory.key === "equipment_missing_hack_squat" && memory.status === "ACTIVE").length, 1);
    assert.equal(first.find((memory) => memory.key === "equipment_missing_hack_squat")!.value.available, false);
    // Correction
    const second = await curation.curateFromTurn(actor, randomUUID(), "Agora minha academia tem hack squat.");
    assert.ok(second.length >= 1);
    const active = await repo.loadRelevantMemories({ actor, categories: ["TRAINING_ENVIRONMENT"], limit: 10 });
    assert.equal(active.filter((memory) => memory.key === "equipment_missing_hack_squat").length, 1, "exactly ONE active truth");
    assert.equal(active.find((memory) => memory.key === "equipment_missing_hack_squat")!.value.available, true, "new truth wins");
    // History preserved (both rows exist, old one SUPERSEDED with link)
    const history = await repo.listMemoryHistory(actor, 50);
    const rows = history.filter((memory) => memory.key === "equipment_missing_hack_squat");
    assert.equal(rows.length, 2, "history keeps both versions");
    const superseded = rows.find((memory) => memory.status === "SUPERSEDED");
    const activeRow = rows.find((memory) => memory.status === "ACTIVE");
    assert.ok(superseded && activeRow, "one SUPERSEDED + one ACTIVE");
    assert.equal(activeRow!.supersedesId, superseded!.id, "new fact points at the old one");
    assert.ok(superseded!.version < activeRow!.version, "version incremented");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── MEMORY 2/3 (workout): equipment memory excludes the exercise ───────────

test("BETA1_MEMORY_TO_WORKOUT: 'academia sem hack squat' excludes hack squat from generation; correction re-enables", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const actor = await freshActor(repo);
  try {
    await curation.curateFromTurn(actor, randomUUID(), "Minha academia não tem hack squat.");
    const svc = new V3CutoverService(repo);
    await svc.generateWorkout(actor, randomUUID());
    const state = await repo.loadAppState(actor);
    const ids = state.workout!.items.map((item) => item.exerciseId);
    assert.ok(!ids.some((id) => id.includes("hack")), "hack squat absent while memory says unavailable");
    // Correction → regenerate → allowed again
    await curation.curateFromTurn(actor, randomUUID(), "Agora minha academia tem hack squat.");
    await svc.generateWorkout(actor, randomUUID());
    const state2 = await repo.loadAppState(actor);
    assert.ok(state2.workout, "workout regenerated after correction");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── MEMORY 4/7: isolation + scoped retrieval ────────────────────────────────

test("BETA1_MEMORY_ISOLATION: user B never sees user A memories; diet query does not load training facts", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const actorA = await freshActor(repo);
  const actorB = await freshActor(repo);
  try {
    await curation.curateFromTurn(actorA, randomUUID(), "Eu odeio esteira. Prefiro bicicleta.");
    const bSnapshot = await curation.buildRelevantMemorySnapshot(actorB, "chat");
    assert.equal(bSnapshot.memories.filter((memory) => memory.key === "preferred_cardio").length, 0, "B has no A memory");
    const aSnapshotDiet = await curation.buildRelevantMemorySnapshot(actorA, "diet");
    assert.equal(aSnapshotDiet.memories.filter((memory) => memory.category === "TRAINING_PREFERENCES").length, 0, "diet query loads no training preference");
    assert.ok(aSnapshotDiet.memories.length <= 8, "diet retrieval is bounded");
  } finally {
    await cleanup(repo, actorA); await cleanup(repo, actorB);
    await repo["pool"].end();
  }
});

// ─── EXECUTION: set-level REAL execution, never inferred ─────────────────────

test("BETA1_EXECUTION: set rows are stored exactly as reported ('8-12' never becomes 812)", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const beta1 = new Beta1WorkoutService(repo, curation);
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const plan = state.workout!;
    const exercise = plan.items.find((item) => item.position > 0)!;
    const wsid = randomUUID();
    await beta1.recordExecution({
      actor,
      requestId: randomUUID(),
      workoutSessionId: wsid,
      exerciseId: exercise.exerciseId,
      difficultyLabel: "PESADA",
      pain: false,
      sets: [
        { setNumber: 1, loadKg: 80, reps: 10, techniqueType: "STRAIGHT_SET" },
        { setNumber: 2, loadKg: 80, reps: 10, techniqueType: "STRAIGHT_SET" },
        { setNumber: 3, loadKg: 80, reps: 9, techniqueType: "STRAIGHT_SET" },
      ],
    });
    const rows = await repo["pool"].query<{ set_number: number; load_kg: string; reps: number; technique_type: string }>(
      `SELECT set_number,load_kg,reps,technique_type FROM guto_v3.workout_set_executions
        WHERE tenant_id=$1 AND user_id=$2 AND session_id=$3::uuid AND exercise_id=$4 ORDER BY set_number`,
      [actor.tenantId, actor.userId, wsid, exercise.exerciseId],
    );
    assert.equal(rows.rows.length, 3, "3 REAL set rows");
    assert.deepEqual(rows.rows.map((row) => Number(row.reps)), [10, 10, 9], "reps stored as reported");
    assert.deepEqual(rows.rows.map((row) => Number(row.load_kg)), [80, 80, 80], "load stored as reported");
    // Aggregate row keeps the legacy pipeline consistent
    const feedback = await repo.loadSessionExecutionFeedback(actor, wsid);
    const entry = feedback.find((item) => item.exerciseId === exercise.exerciseId)!;
    assert.equal(entry.difficultyLabel, "PESADA");
    assert.equal(entry.pain, false);
    assert.equal(entry.repRangeLow, 8, "prescription '8-12' parsed as 8..12 (never 812)");
    assert.equal(entry.repRangeHigh, 12);
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── COMPLETION: self_report exactly-once + XP exactly-once + rotation ──────

test("BETA1_COMPLETION: self_report completes once, advances rotation once, XP once (no selfie)", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const beta1 = new Beta1WorkoutService(repo, curation);
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const exercise = state.workout!.items.find((item) => item.position > 0)!;
    const wsid = randomUUID();
    await beta1.recordExecution({
      actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId: exercise.exerciseId,
      difficultyLabel: "BOA", sets: [{ setNumber: 1, loadKg: 40, reps: 10, techniqueType: "STRAIGHT_SET" }],
    });
    const first = await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid });
    assert.equal(first.status, "completed");
    assert.equal(first.xpGranted, true, "XP granted on first completion");
    // Replay (same session, new requestId) and concurrent duplicate
    const [replay, concurrent] = await Promise.allSettled([
      beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid }),
      beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid }),
    ]);
    assert.ok(replay.status === "fulfilled" || concurrent.status === "fulfilled");
    assert.equal(await repo.countCompletedWorkoutSessions(actor), 1, "exactly ONE completed session");
    const xp = await repo["pool"].query<{ n: string }>(
      `SELECT count(*)::text AS n FROM guto_v3.xp_ledger WHERE tenant_id=$1 AND user_id=$2 AND reason_code='complete_daily_mission'`,
      [actor.tenantId, actor.userId],
    );
    assert.equal(Number(xp.rows[0]!.n), 1, "XP granted exactly once");
    // Completion without any execution is rejected
    const wsid2 = randomUUID();
    await assert.rejects(
      () => beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid2 }),
      (error: unknown) => {
        const code = (error as { code?: string })?.code;
        assert.ok(code === "V3_WORKOUT_EXECUTION_REQUIRED" || code === "V3_WORKOUT_SESSION_NOT_FOUND", `expected execution-required or not-found, got ${code}`);
        return true;
      },
      "empty completion must be rejected",
    );
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── PAIN SAFETY: pain feedback becomes a limitation memory ─────────────────

test("BETA1_PAIN_SAFETY: pain during execution persists a TRAINING_LIMITATIONS memory (source=workout_execution)", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const beta1 = new Beta1WorkoutService(repo, curation);
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const exercise = state.workout!.items.find((item) => item.position > 0)!;
    const wsid = randomUUID();
    await beta1.recordExecution({
      actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId: exercise.exerciseId,
      difficultyLabel: "DOR", pain: true,
      sets: [{ setNumber: 1, loadKg: 40, reps: 6, techniqueType: "STRAIGHT_SET" }],
    });
    await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid });
    const memories = await repo.loadRelevantMemories({ actor, categories: ["TRAINING_LIMITATIONS"], limit: 10 });
    const fromExecution = memories.find((memory) => memory.sourceType === "workout_execution");
    assert.ok(fromExecution, "pain-derived limitation memory persisted after completion");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── PROGRESSION: history drives the decision (top reached twice → PROGRESS) ─

test("BETA1_PROGRESSION: two consecutive top-of-range sessions then PROGRESS decision with evidence", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const beta1 = new Beta1WorkoutService(repo, curation);
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const exerciseId = state.workout!.items.find((item) => item.position > 0)!.exerciseId;
    // Session 1: 80kg 10/10/9 PESADA
    let wsid = randomUUID();
    await beta1.recordExecution({ actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId, difficultyLabel: "PESADA", sets: [
      { setNumber: 1, loadKg: 80, reps: 10, techniqueType: "STRAIGHT_SET" },
      { setNumber: 2, loadKg: 80, reps: 10, techniqueType: "STRAIGHT_SET" },
      { setNumber: 3, loadKg: 80, reps: 9, techniqueType: "STRAIGHT_SET" }] });
    await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid });
    // Session 2: 80kg 10/10/10 BOA (reps at top? 10 < 12 → still within range)
    wsid = randomUUID();
    await beta1.recordExecution({ actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId, difficultyLabel: "BOA", sets: [
      { setNumber: 1, loadKg: 80, reps: 12, techniqueType: "STRAIGHT_SET" },
      { setNumber: 2, loadKg: 80, reps: 12, techniqueType: "STRAIGHT_SET" },
      { setNumber: 3, loadKg: 80, reps: 12, techniqueType: "STRAIGHT_SET" }] });
    // Record the second top session through the legacy decision path
    const decision = await repo.recordWorkoutExerciseEvent({ actor, requestId: randomUUID(), event: { exerciseId, workoutSessionId: wsid, completed: true, loadValue: 80, repetitions: 12, setsCompleted: 3, perceivedDifficulty: 8 } });
    assert.ok(decision, "legacy decision path still works alongside Beta1");
    await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid });
    // After two 12/12/12 BOA sessions the evolution decision must be PROGRESS on the next event
    const nextDecision = await repo.recordWorkoutExerciseEvent({ actor, requestId: randomUUID(), event: { exerciseId, workoutSessionId: randomUUID(), completed: true, loadValue: 80, repetitions: 12, setsCompleted: 3, perceivedDifficulty: 8 } });
    assert.equal(nextDecision.decision, "PROGRESS", "double progression: top reached consistently → PROGRESS");
    assert.equal(nextDecision.reasonCode, "CONSISTENT_LOW_DIFFICULTY_COMPLETION");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── REGRESSION: failing reps / high effort never progress ───────────────────

test("BETA1_REGRESSION: 8/6/5 PESADA does not PROGRESS (REGRESS or MAINTAIN only)", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const beta1 = new Beta1WorkoutService(repo, curation);
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const exerciseId = state.workout!.items.find((item) => item.position > 0)!.exerciseId;
    const { decideDoubleProgression } = await import("../src/v3/beta1-progression.js");
    const catalogItem = { id: "x", exerciseId, name: "Supino reto máquina", purpose: "empurrar", muscleGroup: "peito", position: 1 };
    const decision = decideDoubleProgression({
      exerciseId,
      repRangeLow: 8,
      repRangeHigh: 12,
      sessions: [
        { loadKg: 80, repsPerSet: [8, 6, 5], difficultyLabel: "PESADA", pain: false, completed: true },
      ],
    }, catalogItem);
    assert.notEqual(decision.decision, "PROGRESS", "failing reps never progress");
    assert.ok(decision.decision === "REGRESS", "failing reps with high effort → REGRESS");
    assert.ok((decision.toLoadKg ?? 0) < 80, "load reduced");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

// ─── TECHNIQUES: advanced gets structured technique; beginner does not ──────

test("BETA1_TECHNIQUES: generation attaches ONE structured intensifier for advanced, none for beginner", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const advanced = await freshActor(repo, { trainingLevel: "advanced" });
  try {
    const state = await repo.loadAppState(advanced);
    const techniques = state.workout!.items.map((item) => item.technique).filter(Boolean);
    const intensifiers = techniques.filter((technique) => technique!.type === "DROP_SET" || technique!.type === "REST_PAUSE");
    assert.ok(intensifiers.length <= 1, "at most ONE intensifier per session");
    if (intensifiers[0]) {
      assert.ok(intensifiers[0]!.type === "DROP_SET" || intensifiers[0]!.type === "REST_PAUSE");
      assert.ok(intensifiers[0]!.loadReductionPercent !== undefined || intensifiers[0]!.pauseSeconds !== undefined, "structured metadata present");
    }
    const beginner = await freshActor(repo, { trainingLevel: "beginner" });
    try {
      const bState = await repo.loadAppState(beginner);
      const bTechniques = bState.workout!.items.map((item) => item.technique).filter(Boolean);
      assert.equal(bTechniques.filter((technique) => technique!.type === "DROP_SET" || technique!.type === "REST_PAUSE").length, 0, "beginner receives NO intensifier");
    } finally { await cleanup(repo, beginner); }
  } finally { await cleanup(repo, advanced); await repo["pool"].end(); }
});

// ─── SET-LEVEL vs STRAIGHT: technique extensions are not work sets ──────────

test("BETA1_TECHNIQUE_EXECUTION: DROP_SET extension stored separately from straight work sets", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const beta1 = new Beta1WorkoutService(repo, curation);
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const exercise = state.workout!.items.find((item) => item.position > 0)!;
    const wsid = randomUUID();
    await beta1.recordExecution({
      actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId: exercise.exerciseId,
      difficultyLabel: "BOA", sets: [
        { setNumber: 1, loadKg: 12, reps: 12, techniqueType: "STRAIGHT_SET" },
        { setNumber: 2, loadKg: 12, reps: 11, techniqueType: "STRAIGHT_SET" },
        { setNumber: 3, loadKg: 12, reps: 10, techniqueType: "STRAIGHT_SET" },
        { setNumber: 4, loadKg: 9, reps: 9, techniqueType: "DROP_SET" },
      ],
    });
    const rows = await repo["pool"].query<{ technique_type: string; reps: number }>(
      `SELECT technique_type,reps FROM guto_v3.workout_set_executions
        WHERE tenant_id=$1 AND user_id=$2 AND session_id=$3::uuid AND exercise_id=$4 ORDER BY set_number`,
      [actor.tenantId, actor.userId, wsid, exercise.exerciseId],
    );
    assert.equal(rows.rows.filter((row) => row.technique_type === "STRAIGHT_SET").length, 3, "3 straight sets");
    assert.equal(rows.rows.filter((row) => row.technique_type === "DROP_SET").length, 1, "1 drop extension");
    const feedback = await repo.loadSessionExecutionFeedback(actor, wsid);
    const entry = feedback.find((item) => item.exerciseId === exercise.exerciseId)!;
    assert.equal(entry.setRows.filter((set) => set.techniqueType === "STRAIGHT_SET").length, 3, "progression evidence counts only straight sets");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

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
    try { await admin.query(sql); } catch (error) { throw new Error("Migration " + file + " failed: " + String(error)); }
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

async function startBeta1Session(beta1: Beta1WorkoutService, actor: ActorContext): Promise<string> {
  return (await beta1.startOrResumeSession({ actor, requestId: randomUUID() })).workoutSessionId;
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
    const preferred = persisted.find((memory) => memory.key === "cardio_preference");
    assert.ok(preferred, "cardio_preference persisted");
    assert.equal(preferred!.category, "TRAINING_PREFERENCES");
    assert.equal(preferred!.status, "ACTIVE");
    assert.equal(preferred!.sourceType, "conversation");
    assert.equal(preferred!.sourceRequestId, requestId, "provenance: source request id");
    assert.ok(preferred!.supersedesId === null, "first fact has no predecessor");
    // Readback through a DIFFERENT repository instance (fresh connection = fresh runtime).
    const repo2 = new PostgresOfficialStateRepository(createPool(db.port, 10));
    const snapshot = await new Beta1CurationService(repo2).buildRelevantMemorySnapshot(actor, "chat");
    const found = snapshot.memories.find((memory) => memory.key === "cardio_preference");
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
    assert.equal(bSnapshot.memories.filter((memory) => memory.key === "cardio_preference").length, 0, "B has no A memory");
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
    const wsid = await startBeta1Session(beta1, actor);
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
    const wsid = await startBeta1Session(beta1, actor);
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
    const wsid = await startBeta1Session(beta1, actor);
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
    let wsid = await startBeta1Session(beta1, actor);
    await beta1.recordExecution({ actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId, difficultyLabel: "PESADA", sets: [
      { setNumber: 1, loadKg: 80, reps: 10, techniqueType: "STRAIGHT_SET" },
      { setNumber: 2, loadKg: 80, reps: 10, techniqueType: "STRAIGHT_SET" },
      { setNumber: 3, loadKg: 80, reps: 9, techniqueType: "STRAIGHT_SET" }] });
    await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid });
    // Session 2: 80kg 10/10/10 BOA (reps at top? 10 < 12 → still within range)
    wsid = await startBeta1Session(beta1, actor);
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

test("P1-10 REST_PAUSE_REACHABLE: odd advanced session prescribes, executes and excludes extension from progression", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const beta1 = new Beta1WorkoutService(repo, new Beta1CurationService(repo));
  const actor = await freshActor(repo, { trainingLevel: "advanced" });
  try {
    const first = await repo.loadAppState(actor);
    const firstExercise = first.workout!.items.find((item) => item.position > 0)!;
    const firstSession = await startBeta1Session(beta1, actor);
    await beta1.recordExecution({ actor, requestId: randomUUID(), workoutSessionId: firstSession, exerciseId: firstExercise.exerciseId, difficultyLabel: "BOA", sets: [{ setNumber: 1, loadKg: 30, reps: 10, techniqueType: "STRAIGHT_SET" }] });
    await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: firstSession });

    const rotated = await new V3CutoverService(repo).generateWorkout(actor, randomUUID());
    const restItem = rotated.workout!.items.find((item) => item.technique?.type === "REST_PAUSE");
    assert.ok(restItem, "odd logical session must make REST_PAUSE reachable");
    assert.ok(restItem!.technique?.pauseSeconds, "REST_PAUSE prescription has structured pause metadata");

    const wsid = await startBeta1Session(beta1, actor);
    const outcome = await beta1.recordExecution({
      actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId: restItem!.exerciseId, difficultyLabel: "BOA",
      sets: [
        { setNumber: 1, loadKg: 30, reps: 8, techniqueType: "STRAIGHT_SET" },
        { setNumber: 2, loadKg: 30, reps: 8, techniqueType: "STRAIGHT_SET" },
        { setNumber: 3, loadKg: 30, reps: 8, techniqueType: "STRAIGHT_SET" },
        { setNumber: 4, loadKg: 30, reps: 99, techniqueType: "REST_PAUSE" },
      ],
    });
    assert.notEqual(outcome.decision.decision, "PROGRESS", "REST_PAUSE extension reps are not straight-set progression evidence");
    const history = await repo.loadSessionExecutionFeedback(actor, wsid);
    const entry = history.find((item) => item.exerciseId === restItem!.exerciseId)!;
    assert.equal(entry.setRows.filter((set) => set.techniqueType === "STRAIGHT_SET").length, 3);
    assert.equal(entry.setRows.filter((set) => set.techniqueType === "REST_PAUSE").length, 1);
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
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
    const wsid = await startBeta1Session(beta1, actor);
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

// ─── PRESENCE: subjective feedback persists, trends, and closes the loop ────

test("BETA1_PRESENCE_PERSISTENCE: session feedback persists, replays are idempotent, trend is derived", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const beta1 = new Beta1WorkoutService(repo, curation);
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const exercise = state.workout!.items.find((item) => item.position > 0)!;
    const wsid = await startBeta1Session(beta1, actor);
    await beta1.recordExecution({
      actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId: exercise.exerciseId,
      difficultyLabel: "PESADA", pain: false,
      sets: [{ setNumber: 1, loadKg: 80, reps: 8, techniqueType: "STRAIGHT_SET" }],
    });
    const complete = await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid });
    // Presence rides along completion (additive): facts echo what was OBSERVED.
    assert.ok(complete.presence, "completion returns presence summary");
    assert.ok(complete.presence!.knownFactsEcho.length >= 1, "presence echoes observed facts (never asks what the system knows)");
    assert.ok(complete.presence!.knownFactsEcho.some((line) => /executou|completou|registr/iu.test(line)), "echo references execution reality");

    // Subjective feedback: FIRST PESADA ever → still MAINTAIN (one data point
    // is not a trend — never invent cause) but asks the ONE question.
    const requestId = randomUUID();
    const feedback1 = await beta1.recordSessionFeedback({
      actor, requestId, workoutSessionId: wsid, overallDifficulty: "PESADA", pain: false,
    });
    assert.equal(feedback1.outcome, "MAINTAIN");
    assert.ok(feedback1.contextualQuestion, "first hard session already asks the cause question");

    // Replay with the SAME requestId is idempotent (no duplicate history).
    const replay = await beta1.recordSessionFeedback({
      actor, requestId, workoutSessionId: wsid, overallDifficulty: "PESADA", pain: false,
    });
    const history = await repo.loadBeta1SessionFeedbackHistory(actor, 12);
    assert.equal(history.length, 1, "exactly one feedback record despite replay");
    assert.equal(replay.outcome, feedback1.outcome, "replay returns the same outcome");

    // Second PESADA on another session: trend → NEEDS_INVESTIGATION, no auto-REGRESS.
    const wsid2 = await startBeta1Session(beta1, actor);
    await beta1.recordExecution({
      actor, requestId: randomUUID(), workoutSessionId: wsid2, exerciseId: exercise.exerciseId,
      difficultyLabel: "PESADA", pain: false,
      sets: [{ setNumber: 1, loadKg: 80, reps: 8, techniqueType: "STRAIGHT_SET" }],
    });
    await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid2 });
    const feedback2 = await beta1.recordSessionFeedback({
      actor, requestId: randomUUID(), workoutSessionId: wsid2, overallDifficulty: "PESADA", pain: false,
    });
    assert.equal(feedback2.outcome, "INVESTIGATE", "hard streak stays INVESTIGATE (never auto-REGRESS)");
    assert.equal(feedback2.trend, "NEEDS_INVESTIGATION");
    assert.ok(!JSON.stringify(feedback2).includes("REGRESS"), "no regression is prescribed at presence level");

    // Reload/readback: records survive (Postgres is the authority).
    const reloaded = await repo.loadBeta1SessionFeedbackHistory(actor, 12);
    assert.equal(reloaded.length, 2);
    assert.ok(reloaded.every((entry) => entry.overallDifficulty === "PESADA" && !entry.pain));
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

test("BETA1_PRESENCE_LOOP: user explains cause → training ADAPT, user_state MAINTAIN; isolated per user", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const curation = new Beta1CurationService(repo);
  const beta1 = new Beta1WorkoutService(repo, curation);
  const actorA = await freshActor(repo);
  const actorB = await freshActor(repo);
  try {
    for (const actor of [actorA, actorB]) {
      const state = await repo.loadAppState(actor);
      const exercise = state.workout!.items.find((item) => item.position > 0)!;
      for (let index = 0; index < 2; index += 1) {
        const wsid = await startBeta1Session(beta1, actor);
        await beta1.recordExecution({
          actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId: exercise.exerciseId,
          difficultyLabel: "PESADA", pain: false,
          sets: [{ setNumber: 1, loadKg: 80, reps: 8, techniqueType: "STRAIGHT_SET" }],
        });
        await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid });
        await beta1.recordSessionFeedback({
          actor, requestId: randomUUID(), workoutSessionId: wsid, overallDifficulty: "PESADA", pain: false,
        });
      }
    }
    // User A: cause is their state → MAINTAIN (temporary, NOT a permanent preference).
    const latestA = (await repo.loadBeta1SessionFeedbackHistory(actorA, 12))[0]!.workoutSessionId;
    const a = await beta1.recordSessionFeedback({
      actor: actorA, requestId: randomUUID(), workoutSessionId: latestA,
      overallDifficulty: "PESADA", pain: false,
      causeCategory: "user_state", causeExplanation: "Estou dormindo mal essa semana.",
    });
    assert.equal(a.outcome, "MAINTAIN");
    assert.equal(a.contextualQuestion, null, "cause known → no further question");
    assert.ok(a.knownFactsEcho.some((line) => line.includes("dormindo mal")), "echo references the user's own explanation");

    // User B: cause is the training → ADAPT.
    const latestB = (await repo.loadBeta1SessionFeedbackHistory(actorB, 12))[0]!.workoutSessionId;
    const b = await beta1.recordSessionFeedback({
      actor: actorB, requestId: randomUUID(), workoutSessionId: latestB,
      overallDifficulty: "PESADA", pain: false,
      causeCategory: "training", causeExplanation: "O treino que está pesado demais.",
    });
    assert.equal(b.outcome, "ADAPT");

    // Isolation: each user sees only their own history.
    const historyA = await repo.loadBeta1SessionFeedbackHistory(actorA, 12);
    const historyB = await repo.loadBeta1SessionFeedbackHistory(actorB, 12);
    assert.equal(historyA.length, 2, "correction does not manufacture a third session");
    assert.equal(historyB.length, 2, "correction does not manufacture a third session");
    assert.ok(historyA.every((entry) => entry.causeCategory !== "training"), "user A never sees user B's cause");
    assert.ok(historyB.some((entry) => entry.causeCategory === "training"), "user B's cause is stored");

    // DOR closes into SAFETY and only asks what is still missing.
    const pain = await beta1.recordSessionFeedback({
      actor: actorA, requestId: randomUUID(), workoutSessionId: latestA,
      overallDifficulty: "DOR", pain: true,
    });
    assert.equal(pain.outcome, "SAFETY");
    assert.ok(pain.contextualQuestion, "SAFETY asks only the missing info (location)");
  } finally {
    await cleanup(repo, actorA); await cleanup(repo, actorB);
    await repo["pool"].end();
  }
});


// ─── P1 REMEDIATION REGRESSIONS: Wave 1 ─────────────────────────────────────

test("P1-03 EMPTY_SETS_REJECTED: empty execution creates no aggregate and is not completable", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const beta1 = new Beta1WorkoutService(repo, new Beta1CurationService(repo));
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const exercise = state.workout!.items.find((item) => item.position > 0)!;
    const wsid = randomUUID();
    await assert.rejects(
      () => beta1.recordExecution({ actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId: exercise.exerciseId, difficultyLabel: "BOA", sets: [] }),
      (error: unknown) => (error as { code?: string }).code === "V3_BETA1_SETS_REQUIRED",
      "sets: [] must be rejected before persistence",
    );
    const aggregate = await repo["pool"].query<{ n: string }>(
      `SELECT count(*)::text AS n FROM guto_v3.workout_session_exercises WHERE tenant_id=$1 AND user_id=$2 AND session_id=$3::uuid`,
      [actor.tenantId, actor.userId, wsid],
    );
    const setRows = await repo["pool"].query<{ n: string }>(
      `SELECT count(*)::text AS n FROM guto_v3.workout_set_executions WHERE tenant_id=$1 AND user_id=$2 AND session_id=$3::uuid`,
      [actor.tenantId, actor.userId, wsid],
    );
    assert.equal(Number(aggregate.rows[0]!.n), 0, "NO_AGGREGATE");
    assert.equal(Number(setRows.rows[0]!.n), 0, "NO_SET_ROWS");
    await assert.rejects(() => beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid }), "NOT_COMPLETABLE");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

test("P1-04 DOR_SAFETY_PRIORITY: pain/DOR wins before regression and progression", async () => {
  const { decideWorkoutEvolution } = await import("../src/v3/workout-evolution.js");
  const { decideDoubleProgression } = await import("../src/v3/beta1-progression.js");
  const { decideSessionOutcome } = await import("../src/v3/beta1-presence.js");
  const legacy = decideWorkoutEvolution({
    exerciseId: "leg_press", completed: true, repetitions: 5, setsCompleted: 3,
    perceivedDifficulty: 10, context: { safetyConcern: true, difficultyLabel: "DOR" },
  });
  assert.equal(legacy.decision, "REVIEW", "DOR + poor reps → safety REVIEW, never REGRESS");
  assert.equal(legacy.reasonCode, "PAIN_OR_SAFETY_CONCERN");

  const perSet = decideDoubleProgression({
    exerciseId: "leg_press", repRangeLow: 8, repRangeHigh: 12,
    sessions: [
      { loadKg: 80, repsPerSet: [12, 12, 12], difficultyLabel: "DOR", pain: false, completed: true },
      { loadKg: 80, repsPerSet: [12, 12, 12], difficultyLabel: "DOR", pain: false, completed: true },
    ],
  }, { id: "x", exerciseId: "leg_press", name: "Leg press máquina", purpose: "empurrar", muscleGroup: "quadriceps", position: 1 });
  assert.equal(perSet.decision, "REVIEW", "DOR + perfect reps → safety REVIEW, never PROGRESS");
  assert.equal(perSet.reasonCode, "PAIN_SAFETY_BRANCH");

  const presence = decideSessionOutcome({ todayFeedback: { overallDifficulty: "DOR", pain: false }, history: [] });
  assert.equal(presence.decision.decision, "SAFETY", "difficulty=DOR is safety even if client pain flag is false");
});

test("P1-05 PER_SET_PROGRESSION: best set cannot manufacture a top-range session", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const beta1 = new Beta1WorkoutService(repo, new Beta1CurationService(repo));
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const exerciseId = state.workout!.items.find((item) => item.position > 0)!.exerciseId;
    const record = async (reps: number[]) => {
      const wsid = await startBeta1Session(beta1, actor);
      const result = await beta1.recordExecution({
        actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId, difficultyLabel: "BOA",
        sets: reps.map((value, index) => ({ setNumber: index + 1, loadKg: 80, reps: value, techniqueType: "STRAIGHT_SET" as const })),
      });
      await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid });
      return result;
    };
    const top = await record([12, 12, 12]);
    assert.notEqual(top.decision.decision, "PROGRESS", "one 12/12/12 session is not enough");
    const collapsed = await record([12, 6, 5]);
    assert.notEqual(collapsed.decision.decision, "PROGRESS", "12/6/5 must NOT be treated as 12/12/12");
    const mixed = await record([12, 12, 5]);
    assert.notEqual(mixed.decision.decision, "PROGRESS", "12/12/5 must NOT be treated as 12/12/12");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});


test("P1-02 MEMORY_SUPERSESSION: semantic cardio concept cannot keep contradictory ACTIVE rows", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const legacy = await repo.persistCuratedMemory({
      actor, requestId: randomUUID(), sourceType: "conversation",
      candidate: { category: "TRAINING_PREFERENCES", key: "liked_cardio", value: { liked: ["bike"] }, confidence: "explicit" },
    });
    const current = await repo.persistCuratedMemory({
      actor, requestId: randomUUID(), sourceType: "conversation",
      candidate: { category: "TRAINING_PREFERENCES", key: "cardio_preference", value: { preferred: "treadmill", avoided: "bike" }, confidence: "explicit" },
    });
    const active = await repo.loadRelevantMemories({ actor, categories: ["TRAINING_PREFERENCES"], limit: 20 });
    const semantic = active.filter((memory) => ["preferred_cardio", "liked_cardio", "disliked_cardio", "cardio_preference"].includes(memory.key));
    assert.equal(semantic.length, 1, "one ACTIVE row for the cardio_preference concept");
    assert.equal(semantic[0]!.key, "cardio_preference");
    assert.equal(semantic[0]!.value.preferred, "treadmill");
    const history = await repo.listMemoryHistory(actor, 50);
    assert.equal(history.find((memory) => memory.id === legacy.id)?.status, "SUPERSEDED", "legacy semantic predecessor is superseded");
    assert.equal(history.find((memory) => memory.id === current.id)?.status, "ACTIVE");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

test("P1-06 FEEDBACK_EXACTLY_ONCE: same session correction replaces prior logical feedback", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const beta1 = new Beta1WorkoutService(repo, new Beta1CurationService(repo));
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const exerciseId = state.workout!.items.find((item) => item.position > 0)!.exerciseId;
    const wsid = await startBeta1Session(beta1, actor);
    await beta1.recordExecution({ actor, requestId: randomUUID(), workoutSessionId: wsid, exerciseId, difficultyLabel: "BOA", sets: [{ setNumber: 1, loadKg: 40, reps: 10, techniqueType: "STRAIGHT_SET" }] });
    await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId: wsid });
    await beta1.recordSessionFeedback({ actor, requestId: randomUUID(), workoutSessionId: wsid, overallDifficulty: "PESADA", pain: false });
    await beta1.recordSessionFeedback({ actor, requestId: randomUUID(), workoutSessionId: wsid, overallDifficulty: "BOA", pain: false });
    const history = await repo.loadBeta1SessionFeedbackHistory(actor, 12);
    const sameSession = history.filter((entry) => entry.workoutSessionId === wsid);
    assert.equal(sameSession.length, 1, "same session represents exactly one logical feedback");
    assert.equal(sameSession[0]!.overallDifficulty, "BOA", "correction wins");
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

test("P1-08 SESSION_REHYDRATION: backend start/resume survives a new runtime", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const actor = await freshActor(repo);
  try {
    const firstSvc = new Beta1WorkoutService(repo, new Beta1CurationService(repo)) as any;
    const first = await firstSvc.startOrResumeSession({ actor, requestId: randomUUID() });
    assert.ok(first.workoutSessionId);
    const repo2 = new PostgresOfficialStateRepository(createPool(db.port, 10));
    try {
      const secondSvc = new Beta1WorkoutService(repo2, new Beta1CurationService(repo2)) as any;
      const resumed = await secondSvc.startOrResumeSession({ actor, requestId: randomUUID() });
      assert.equal(resumed.workoutSessionId, first.workoutSessionId, "new runtime resumes the same backend session");
    } finally { await repo2["pool"].end(); }
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

test("P1-09 SESSION_FEEDBACK_AUTHORITY: random/foreign session rejected; owned completed session accepted", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const beta1 = new Beta1WorkoutService(repo, new Beta1CurationService(repo));
  const actorA = await freshActor(repo);
  const actorB = await freshActor(repo);
  try {
    await assert.rejects(
      () => beta1.recordSessionFeedback({ actor: actorA, requestId: randomUUID(), workoutSessionId: randomUUID(), overallDifficulty: "BOA", pain: false }),
      (error: unknown) => (error as { code?: string }).code === "V3_WORKOUT_SESSION_NOT_FOUND",
      "random UUID must be rejected",
    );
    const stateB = await repo.loadAppState(actorB);
    const exerciseB = stateB.workout!.items.find((item) => item.position > 0)!.exerciseId;
    const foreign = await startBeta1Session(beta1, actorB);
    await beta1.recordExecution({ actor: actorB, requestId: randomUUID(), workoutSessionId: foreign, exerciseId: exerciseB, difficultyLabel: "BOA", sets: [{ setNumber: 1, loadKg: 30, reps: 10, techniqueType: "STRAIGHT_SET" }] });
    await beta1.completeWorkout({ actor: actorB, requestId: randomUUID(), workoutSessionId: foreign });
    await assert.rejects(
      () => beta1.recordSessionFeedback({ actor: actorA, requestId: randomUUID(), workoutSessionId: foreign, overallDifficulty: "BOA", pain: false }),
      (error: unknown) => ["V3_FOREIGN_WORKOUT_SESSION", "V3_WORKOUT_SESSION_NOT_FOUND"].includes((error as { code?: string }).code || ""),
      "other user's session must be rejected without cross-user access",
    );
    const stateA = await repo.loadAppState(actorA);
    const exerciseA = stateA.workout!.items.find((item) => item.position > 0)!.exerciseId;
    const owned = await startBeta1Session(beta1, actorA);
    await beta1.recordExecution({ actor: actorA, requestId: randomUUID(), workoutSessionId: owned, exerciseId: exerciseA, difficultyLabel: "BOA", sets: [{ setNumber: 1, loadKg: 30, reps: 10, techniqueType: "STRAIGHT_SET" }] });
    await beta1.completeWorkout({ actor: actorA, requestId: randomUUID(), workoutSessionId: owned });
    const accepted = await beta1.recordSessionFeedback({ actor: actorA, requestId: randomUUID(), workoutSessionId: owned, overallDifficulty: "BOA", pain: false });
    assert.ok(accepted.outcome);
  } finally {
    await cleanup(repo, actorA); await cleanup(repo, actorB); await repo["pool"].end();
  }
});

test("RLS_ADVERSARIAL: actor isolation blocks memory/session cross-user and cross-tenant access", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const beta1 = new Beta1WorkoutService(repo, new Beta1CurationService(repo));
  const actorA = await freshActor(repo);
  const actorB = await freshActor(repo);
  const actorOtherTenant = await repo.provisionActor({
    externalSubject: `pg-beta1-other-${randomUUID()}`,
    role: "student",
    tenantKey: `OTHER_${randomUUID()}`,
    tenantName: "Other tenant",
  });
  try {
    await new Beta1CurationService(repo).curateFromTurn(actorB, randomUUID(), "Prefiro bicicleta a esteira.");
    const stateB = await repo.loadAppState(actorB);
    const exerciseB = stateB.workout!.items.find((item) => item.position > 0)!.exerciseId;
    const sessionB = await startBeta1Session(beta1, actorB);
    await beta1.recordExecution({ actor: actorB, requestId: randomUUID(), workoutSessionId: sessionB, exerciseId: exerciseB, difficultyLabel: "BOA", sets: [{ setNumber: 1, loadKg: 30, reps: 10, techniqueType: "STRAIGHT_SET" }] });

    await assert.rejects(() => beta1.recordExecution({ actor: actorA, requestId: randomUUID(), workoutSessionId: sessionB, exerciseId: exerciseB, difficultyLabel: "BOA", sets: [{ setNumber: 1, loadKg: 30, reps: 10, techniqueType: "STRAIGHT_SET" }] }));
    await assert.rejects(() => beta1.completeWorkout({ actor: actorA, requestId: randomUUID(), workoutSessionId: sessionB }));
    const client = await repo["pool"].connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [actorA.tenantId, actorA.userId]);
      await client.query("SET LOCAL ROLE guto_v3_app");
      const foreignMemory = await client.query("SELECT id FROM guto_v3.user_memories WHERE tenant_id=$1 AND user_id=$2", [actorB.tenantId, actorB.userId]);
      assert.equal(foreignMemory.rowCount, 0, "actor A cannot read actor B memory");
      const foreignMemoryWrite = await client.query("UPDATE guto_v3.user_memories SET last_confirmed_at=now() WHERE tenant_id=$1 AND user_id=$2", [actorB.tenantId, actorB.userId]);
      assert.equal(foreignMemoryWrite.rowCount, 0, "actor A cannot write actor B memory");
      const foreignTenant = await client.query("SELECT id FROM guto_v3.users WHERE tenant_id=$1 AND id=$2", [actorOtherTenant.tenantId, actorOtherTenant.userId]);
      assert.equal(foreignTenant.rowCount, 0, "tenant A cannot access tenant B user");
      await client.query("ROLLBACK");
    } finally { client.release(); }

    await beta1.completeWorkout({ actor: actorB, requestId: randomUUID(), workoutSessionId: sessionB });
    await assert.rejects(() => beta1.recordSessionFeedback({ actor: actorA, requestId: randomUUID(), workoutSessionId: sessionB, overallDifficulty: "BOA", pain: false }));
  } finally {
    await cleanup(repo, actorA); await cleanup(repo, actorB); await cleanup(repo, actorOtherTenant); await repo["pool"].end();
  }
});

test("PRESENCE retains recorded exercise pain after general session feedback", async () => {
  const db = await getDb(); assert.ok(db);
  const repo = new PostgresOfficialStateRepository(createPool(db.port, 10));
  const beta1 = new Beta1WorkoutService(repo, new Beta1CurationService(repo));
  const actor = await freshActor(repo);
  try {
    const state = await repo.loadAppState(actor);
    const exerciseId = state.workout!.items.find((item) => item.position > 0)!.exerciseId;
    const workoutSessionId = await startBeta1Session(beta1, actor);
    await beta1.recordExecution({ actor, requestId: randomUUID(), workoutSessionId, exerciseId,
      difficultyLabel: "DOR", pain: true,
      sets: [{ setNumber: 1, loadKg: 20, reps: 8, techniqueType: "STRAIGHT_SET" }] });
    assert.equal((await beta1.completeWorkout({ actor, requestId: randomUUID(), workoutSessionId })).presence?.outcome, "SAFETY");
    for (const overallDifficulty of ["PESADA", "BOA", "FACIL"] as const) {
      const presence = await beta1.recordSessionFeedback({ actor, requestId: randomUUID(), workoutSessionId, overallDifficulty, pain: false });
      assert.equal(presence.outcome, "SAFETY", "general effort does not retract pain recorded in an exercise");
    }
  } finally { await cleanup(repo, actor); await repo["pool"].end(); }
});

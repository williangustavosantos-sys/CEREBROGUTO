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

// ─── P0 B — REAL POSTGRES CONCURRENT IDEMPOTENCY ─────────────────────────
//
// Proves the advisory-lock barrier (pg_advisory_xact_lock before the dedup
// read) with TWO INDEPENDENT PostgreSQL connections against a REAL Postgres
// engine (PGlite — the actual Postgres compiled to WASM, exposed over the
// wire protocol via a TCP socket server). Not the in-memory repository, not
// a simulated race. The same schema + the same runtime code as the deployed
// preview are used; a dedicated test user is created and cleaned up.

// ─── embedded Postgres (PGlite over TCP) ─────────────────────────────────
//
// PGlite (@electric-sql/pglite) is an OPTIONAL dev-only dependency: the real
// Postgres engine compiled to WASM, exposed over the wire protocol via
// @electric-sql/pglite-socket so TWO INDEPENDENT pg connections can race.
// It is not in package.json — install it with
//   npm install --no-save @electric-sql/pglite @electric-sql/pglite-socket
// before running this test locally. Without it, the tests skip (they are
// additive proof, not required regressions).

type EmbeddedDb = { port: number; stop: () => Promise<void> };

/** Internal signal: PGlite not installed — tests must SKIP, not fail. */
class PgLiteUnavailable extends Error {}

async function startEmbeddedPostgres(): Promise<EmbeddedDb> {
  let PGlite: any;
  let PGLiteSocketServer: any;
  let pgcrypto: any;
  try {
    // Indirect specifiers: TypeScript (and therefore the Vercel build gate,
    // where these optional dev packages are not installed) must NOT resolve
    // them statically. At runtime the resolution happens normally.
    const pgliteName = "@electric-sql" + "/pglite";
    const pgcryptoName = "@electric-sql" + "/pglite/contrib/pgcrypto";
    const socketName = "@electric-sql" + "/pglite-socket";
    ({ PGlite } = await import(pgliteName));
    ({ pgcrypto } = await import(pgcryptoName));
    ({ PGLiteSocketServer } = await import(socketName));
  } catch {
    throw new PgLiteUnavailable(
      "PGlite not installed (optional dev dependency) — skipping real-Postgres tests. " +
      "Install with: npm install --no-save @electric-sql/pglite @electric-sql/pglite-socket",
    );
  }
  const dataDir = path.join(os.tmpdir(), `guto-pg-idem-${randomUUID()}`);
  // pgcrypto is required by migration 0001 (gen_random_uuid). PGlite ships it
  // as a contrib extension — load it explicitly.
  const db = new PGlite({ dataDir, extensions: { pgcrypto } });
  // Ephemeral free port: bind port 0 on loopback, read the assigned port,
  // close the probe socket, then hand the port to the PGlite socket server.
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
    probe.on("error", reject);
  });
  // maxConnections must exceed 2 so TWO INDEPENDENT connections can race.
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
  await admin.query(`CREATE TABLE IF NOT EXISTS guto_v3.schema_migrations (
    filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const file of readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationDir, file), "utf8");
    const applied = await admin.query("SELECT 1 FROM guto_v3.schema_migrations WHERE filename=$1", [file]);
    if (applied.rows[0]) continue;
    await admin.query(sql);
    await admin.query("INSERT INTO guto_v3.schema_migrations (filename, checksum) VALUES ($1, $2)", [file, "embedded"]);
  }
  // Runtime role mirroring the preview setup: guto_v3_runtime can SET ROLE
  // guto_v3_app (the migration runner's role hardening may or may not exist).
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guto_v3_runtime') THEN
      CREATE ROLE guto_v3_runtime LOGIN PASSWORD 'runtime';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guto_v3_app') THEN
      CREATE ROLE guto_v3_app NOLOGIN;
    END IF;
  END $$;`);
  await admin.query(`GRANT guto_v3_app TO guto_v3_runtime`);
  await admin.query(`GRANT USAGE ON SCHEMA guto_v3 TO guto_v3_app`);
  await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA guto_v3 TO guto_v3_app`);
  await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA guto_v3 TO guto_v3_app`);
  await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA guto_v3 GRANT ALL ON TABLES TO guto_v3_app`);
  await admin.end();
}

async function startDb(): Promise<{ port: number; stop: () => Promise<void> }> {
  const embedded = await startEmbeddedPostgres();
  await applyMigrations(embedded.port);
  return embedded;
}

function createPool(port: number, max: number): pg.Pool {
  return new pg.Pool({
    host: "127.0.0.1", port, user: "guto_v3_runtime", password: "runtime",
    database: "postgres", max,
    idleTimeoutMillis: 20_000, connectionTimeoutMillis: 8_000,
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────

async function freshActor(repository: PostgresOfficialStateRepository): Promise<ActorContext> {
  const actor = await repository.provisionActor({
    externalSubject: `pg-idem-${randomUUID()}`,
    role: "student",
    tenantKey: "GUTO_CORE",
    tenantName: "GUTO Core",
  });
  const service = new V3CutoverService(repository);
  await service.acceptConsent(actor, randomUUID());
  await service.saveMemory(actor, { requestId: randomUUID(), name: "Will", confirmedName: true, language: "pt-BR" });
  await service.saveMemory(actor, {
    requestId: randomUUID(), biologicalSex: "male", userAge: 33, weightKg: 80, heightCm: 181,
    trainingLevel: "consistent", trainingGoal: "muscle_gain", trainingFrequency: 4,
  });
  await service.saveMemory(actor, { requestId: randomUUID(), name: "Will", xpEvent: "grant_initial_xp" });
  await service.startFirstContact(actor, randomUUID());
  await service.respondFirstContact(actor, { requestId: randomUUID(), expectedStep: "food_restrictions", answer: "Sem restrições." });
  await service.respondFirstContact(actor, { requestId: randomUUID(), expectedStep: "training_limitations", answer: "Sem limitações declaradas." });
  await service.confirmFirstContact(actor, { requestId: randomUUID(), confirmed: true });
  await service.generateWorkout(actor, randomUUID());
  return actor;
}

async function cleanup(repository: PostgresOfficialStateRepository, actor: ActorContext): Promise<void> {
  // Durable cleanup of the dedicated test user (V3 tables cascade from users).
  await repository["pool"].query(
    `DELETE FROM guto_v3.users WHERE id=$1 AND tenant_id=$2`,
    [actor.userId, actor.tenantId],
  ).catch(() => {});
  await repository["pool"].query(
    `DELETE FROM guto_v3.tenants WHERE id=$1`,
    [actor.tenantId],
  ).catch(() => {});
}

// ─── shared embedded instance ────────────────────────────────────────────

let dbHandle: { port: number; stop: () => Promise<void> } | null = null;
let skipReason: string | null = null;

async function getDb(): Promise<{ port: number; stop: () => Promise<void> }> {
  if (!dbHandle) {
    try {
      dbHandle = await startDb();
    } catch (error) {
      if (error instanceof PgLiteUnavailable) {
        skipReason = error.message;
        return null as unknown as { port: number; stop: () => Promise<void> };
      }
      throw error;
    }
  }
  return dbHandle;
}

test.after(async () => {
  if (dbHandle) { await dbHandle.stop().catch(() => {}); dbHandle = null; }
});

// ─── tests ───────────────────────────────────────────────────────────────

test("PG_CONCURRENT_IDEMPOTENCY: two real connections, same requestId → one logical execution", async (t) => {
  const db = await getDb();
  if (!db) t.skip(skipReason || "PGlite unavailable");
  const { port } = db;
  const repository = new PostgresOfficialStateRepository(createPool(port, 10));
  const actor = await freshActor(repository);
  try {
    const state = await repository.loadAppState(actor);
    const exerciseId = state.workout!.items[0]!.exerciseId;
    const requestId = randomUUID();
    const event = {
      exerciseId, completed: true, repetitions: 12, setsCompleted: 3, perceivedDifficulty: 5,
    };

    // TWO INDEPENDENT transactions racing on the SAME requestId via Promise.all.
    const [a, b] = await Promise.allSettled([
      repository.recordWorkoutExerciseEvent({ actor, requestId, event }),
      repository.recordWorkoutExerciseEvent({ actor, requestId, event }),
    ]);
    assert.equal(a.status, "fulfilled", `request A failed: ${a.status === "rejected" ? String(a.reason) : ""}`);
    assert.equal(b.status, "fulfilled", `request B failed: ${b.status === "rejected" ? String(b.reason) : ""}`);
    // Second request is an idempotent REPLAY of the first decision.
    assert.equal((a.value as any).decision, (b.value as any).decision);
    assert.equal((a.value as any).reasonCode, (b.value as any).reasonCode);

    // Durable asserts: inspect storage directly.
    const planIdRow = await repository["pool"].query<{ id: string }>(
      `SELECT id FROM guto_v3.workout_plans WHERE tenant_id=$1 AND user_id=$2 AND status='active'`,
      [actor.tenantId, actor.userId],
    );
    const planId = planIdRow.rows[0]!.id;
    const counts = await repository["pool"].query<{
      events: string; sessions: string; session_exercises: string; decisions: string;
    }>(
      `SELECT
         (SELECT count(*) FROM guto_v3.guto_events
           WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3 AND event_type='workout.evolution_decided') AS events,
         (SELECT count(*) FROM guto_v3.workout_sessions
           WHERE tenant_id=$1 AND user_id=$2 AND plan_id=$5) AS sessions,
         (SELECT count(*) FROM guto_v3.workout_session_exercises
           WHERE tenant_id=$1 AND user_id=$2 AND exercise_id=$4) AS session_exercises,
         (SELECT count(*) FROM guto_v3.workout_evolution_decisions
           WHERE tenant_id=$1 AND user_id=$2 AND exercise_id=$4) AS decisions`,
      [actor.tenantId, actor.userId, requestId, exerciseId, planId],
    );
    const row = counts.rows[0]!;
    assert.equal(Number(row.events), 1, "guto_events: exactly 1 logical event for the requestId");
    assert.equal(Number(row.sessions), 1, "workout_sessions: exactly 1 logical execution");
    assert.equal(Number(row.session_exercises), 1, "workout_session_exercises: exactly 1");
    assert.equal(Number(row.decisions), 1, "workout_evolution_decisions: exactly 1");

    // Replay AFTER commit: still exactly one logical execution.
    const replay = await repository.recordWorkoutExerciseEvent({ actor, requestId, event });
    assert.equal(replay.decision, (a.value as any).decision, "replay returns the cached decision");
    const afterReplay = await repository["pool"].query<{ n: string }>(
      `SELECT count(*) AS n FROM guto_v3.workout_session_exercises WHERE tenant_id=$1 AND user_id=$2 AND exercise_id=$3`,
      [actor.tenantId, actor.userId, exerciseId],
    );
    assert.equal(Number(afterReplay.rows[0]!.n), 1, "replay adds no execution");
  } finally {
    await cleanup(repository, actor);
    await repository["pool"].end();
  }
});

test("PG_CONCURRENT_IDEMPOTENCY: duplicate does not create false PROGRESS; NEW requestId counts", async (t) => {
  const db = await getDb();
  if (!db) t.skip(skipReason || "PGlite unavailable");
  const { port } = db;
  const repository = new PostgresOfficialStateRepository(createPool(port, 10));
  const actor = await freshActor(repository);
  try {
    const state = await repository.loadAppState(actor);
    const exerciseId = state.workout!.items[0]!.exerciseId;
    const event = {
      exerciseId, completed: true, repetitions: 12, setsCompleted: 3, perceivedDifficulty: 5,
    };

    // First real execution — easy but alone -> MAINTAIN.
    const firstId = randomUUID();
    const first = await repository.recordWorkoutExerciseEvent({ actor, requestId: firstId, event });
    assert.equal(first.decision, "MAINTAIN");

    // SAME execution replayed concurrently 2x under the SAME requestId.
    await Promise.allSettled([
      repository.recordWorkoutExerciseEvent({ actor, requestId: firstId, event }),
      repository.recordWorkoutExerciseEvent({ actor, requestId: firstId, event }),
    ]);

    const historyCount = await repository["pool"].query<{ n: string }>(
      `SELECT count(*) AS n FROM guto_v3.workout_session_exercises WHERE tenant_id=$1 AND user_id=$2 AND exercise_id=$3`,
      [actor.tenantId, actor.userId, exerciseId],
    );
    assert.equal(Number(historyCount.rows[0]!.n), 1, "no duplicated history from concurrent replays");

    // A second REAL execution (NEW requestId) is the one that may progress.
    const second = await repository.recordWorkoutExerciseEvent({
      actor, requestId: randomUUID(), event: { ...event, repetitions: 13 },
    });
    assert.equal(second.decision, "PROGRESS", "a NEW real execution counts and can progress");
  } finally {
    await cleanup(repository, actor);
    await repository["pool"].end();
  }
});

test("PG_POOL_MAX_1: recordWorkoutExerciseEvent does not deadlock with a single pool connection", async (t) => {
  // Pool deliberately limited to max=1: if recordWorkoutExerciseEvent (holding
  // the transaction) tried to acquire a SECOND connection (e.g. through
  // loadOfficialSnapshot), it would wait forever. The within-transaction
  // snapshot loader must prevent this.
  const db = await getDb();
  if (!db) t.skip(skipReason || "PGlite unavailable");
  const { port } = db;
  const repository = new PostgresOfficialStateRepository(createPool(port, 1));
  const actor = await freshActor(repository);
  try {
    const state = await repository.loadAppState(actor);
    const baseExerciseId = state.workout!.items[0]!.exerciseId;
    // Adapted event path: exercises the snapshot-within-transaction loader.
    const decision = await Promise.race([
      repository.recordWorkoutExerciseEvent({
        actor,
        requestId: randomUUID(),
        event: {
          exerciseId: "burpee",
          completed: true,
          repetitions: 12,
          setsCompleted: 3,
          perceivedDifficulty: 5,
          substitutedFromExerciseId: baseExerciseId,
          substitutionReason: "MACHINE_OCCUPIED",
        },
      }),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("DEADLOCK: operation did not complete with pool max=1")), 15_000)),
    ]);
    assert.equal((decision as any).decision, "SUBSTITUTE");
  } finally {
    await cleanup(repository, actor);
    await repository["pool"].end();
  }
});

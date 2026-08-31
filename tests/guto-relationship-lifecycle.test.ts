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
import { V3Error } from "../src/v3/errors.js";
import {
  evaluateRelationshipLifecycleState,
  absenceDaysBetween,
  shouldSuppressProactivity,
  RELATIONSHIP_LIFECYCLE_POLICY,
} from "../src/v3/relationship-lifecycle.js";
import type { ActorContext } from "../src/v3/types.js";

// ─── RELATIONSHIP LIFECYCLE (GATE: RELATIONSHIP_LIFECYCLE PARTIAL → PASS) ──
//
// The official relationship lifecycle is deterministic, persistent,
// tenant-safe, idempotent and auditable. The LLM never decides it. This suite
// proves the state machine (ACTIVE → AT_RISK → DECAYING → TERMINAL), presence
// recovery, explicit reactivation, persistence across reload, idempotency,
// concurrency safety, tenant isolation and the proactivity charge gate — on
// both the in-memory repository and real Postgres (PGlite).

// ─── Pure policy ─────────────────────────────────────────────────────────────

test("LIFECYCLE: deterministic state machine ACTIVE → AT_RISK → DECAYING → TERMINAL", () => {
  const p = RELATIONSHIP_LIFECYCLE_POLICY;
  assert.equal(evaluateRelationshipLifecycleState("ACTIVE", 0).state, "ACTIVE");
  assert.equal(evaluateRelationshipLifecycleState("ACTIVE", 1).state, "ACTIVE");
  assert.equal(evaluateRelationshipLifecycleState("ACTIVE", p.atRiskAfterAbsenceDays).state, "AT_RISK");
  assert.equal(evaluateRelationshipLifecycleState("AT_RISK", p.decayingAfterAbsenceDays).state, "DECAYING");
  assert.equal(evaluateRelationshipLifecycleState("DECAYING", p.terminalAfterAbsenceDays).state, "TERMINAL");
  // monotonic: a higher absence never regresses a non-terminal state
  assert.equal(evaluateRelationshipLifecycleState("DECAYING", p.terminalAfterAbsenceDays + 5).state, "TERMINAL");
});

test("LIFECYCLE: TERMINAL is terminal — presence alone never silently restores it", () => {
  const t = evaluateRelationshipLifecycleState("TERMINAL", 0);
  assert.equal(t.state, "TERMINAL");
  assert.equal(t.transitioned, false);
});

test("LIFECYCLE: non-terminal presence recovers to ACTIVE (weakening → recovery)", () => {
  assert.equal(evaluateRelationshipLifecycleState("DECAYING", 0).state, "ACTIVE");
  assert.equal(evaluateRelationshipLifecycleState("AT_RISK", 0).state, "ACTIVE");
});

test("LIFECYCLE: absenceDaysBetween counts full calendar days", () => {
  assert.equal(absenceDaysBetween("2026-06-01", "2026-06-01"), 0);
  assert.equal(absenceDaysBetween("2026-06-01", "2026-06-04"), 3);
  assert.equal(absenceDaysBetween(null, "2026-06-04"), 0);
});

test("LIFECYCLE: proactivity suppressed ONLY in TERMINAL", () => {
  assert.equal(shouldSuppressProactivity("ACTIVE"), false);
  assert.equal(shouldSuppressProactivity("AT_RISK"), false);
  assert.equal(shouldSuppressProactivity("DECAYING"), false);
  assert.equal(shouldSuppressProactivity("TERMINAL"), true);
});

// ─── In-memory repository ────────────────────────────────────────────────────

async function memoryUser(tenantKey: string) {
  const repository = new InMemoryOfficialStateRepository();
  const actor = await repository.provisionActor({ externalSubject: `lc-mem-${randomUUID()}`, role: "student", tenantKey, tenantName: `Tenant ${tenantKey}` });
  const service = new V3CutoverService(repository);
  return { repository, actor, service };
}

test("LIFECYCLE (mem): full degradation over absence days, presence recovers", async () => {
  const { actor, service } = await memoryUser("A");
  const p = RELATIONSHIP_LIFECYCLE_POLICY;
  const lastPresenceDay = "2026-06-01";
  const evalDay = (days: number) => service.evaluateRelationshipLifecycle(actor, {
    requestId: randomUUID(), lastPresenceDay, asOf: `2026-06-${String(1 + days).padStart(2, "0")}`,
  });
  assert.equal((await evalDay(0)).state, "ACTIVE");
  assert.equal((await evalDay(p.atRiskAfterAbsenceDays)).state, "AT_RISK");
  assert.equal((await evalDay(p.decayingAfterAbsenceDays)).state, "DECAYING");
  assert.equal((await evalDay(p.terminalAfterAbsenceDays)).state, "TERMINAL");
});

test("LIFECYCLE (mem): presence recovers a NON-terminal state (DECAYING → ACTIVE)", async () => {
  const { actor, service } = await memoryUser("A");
  const p = RELATIONSHIP_LIFECYCLE_POLICY;
  await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay: "2026-06-01", asOf: `2026-06-${String(1 + p.decayingAfterAbsenceDays).padStart(2, "0")}` });
  assert.equal((await service.getRelationshipLifecycle(actor))?.state, "DECAYING");
  // returning presence recovers from DECAYING (fresh anchor day)
  const recovered = await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay: "2026-06-20", asOf: "2026-06-20" });
  assert.equal(recovered.state, "ACTIVE");
});

test("LIFECYCLE (mem): TERMINAL requires EXPLICIT reactivation; official data survives", async () => {
  const { actor, service } = await memoryUser("A");
  const lastPresenceDay = "2026-06-01";
  await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay, asOf: "2026-06-20" });
  assert.equal((await service.getRelationshipLifecycle(actor))?.state, "TERMINAL");
  // presence alone does NOT restore
  const stillTerminal = await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay: "2026-06-21", asOf: "2026-06-21" });
  assert.equal(stillTerminal.state, "TERMINAL");
  // explicit reactivation
  const reactivated = await service.reactivateRelationship(actor, { requestId: randomUUID() });
  assert.equal(reactivated.state, "ACTIVE");
  assert.equal((await service.getRelationshipLifecycle(actor))?.state, "ACTIVE");
});

test("LIFECYCLE (mem): idempotent on requestId — no duplicate transition events", async () => {
  const { actor, service, repository } = await memoryUser("A");
  const requestId = randomUUID();
  const first = await service.evaluateRelationshipLifecycle(actor, { requestId, lastPresenceDay: "2026-06-01", asOf: "2026-06-10" });
  const second = await service.evaluateRelationshipLifecycle(actor, { requestId, lastPresenceDay: "2026-06-01", asOf: "2026-06-10" });
  assert.equal(second.state, first.state);
  assert.equal(second.version, first.version);
  assert.equal(repository.lifecycleEvents.filter((event) => event.requestId === requestId).length, 1);
});

test("LIFECYCLE (mem): concurrent evaluations produce ONE coherent transition", async () => {
  const { actor, service, repository } = await memoryUser("A");
  const results = await Promise.all([
    service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay: "2026-06-01", asOf: "2026-06-10" }),
    service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay: "2026-06-01", asOf: "2026-06-10" }),
  ]);
  assert.equal(results[0].state, results[1].state);
  assert.ok(["DECAYING", "TERMINAL"].includes(results[0].state), `coherent single state, got ${results[0].state}`);
  assert.equal(new Set(repository.lifecycleEvents.map((event) => `${event.fromState}->${event.toState}`)).size, 1);
});

test("LIFECYCLE (mem): tenant isolation — B cannot see or change A's lifecycle", async () => {
  const { actor, service } = await memoryUser("A");
  await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay: "2026-06-01", asOf: "2026-06-20" });
  assert.equal((await service.getRelationshipLifecycle(actor))?.state, "TERMINAL");
  const { actor: other, service: otherService } = await memoryUser("B");
  assert.equal(await otherService.getRelationshipLifecycle(other), null);
  // B's evaluation is independent and cannot touch A's record
  await otherService.evaluateRelationshipLifecycle(other, { requestId: randomUUID(), lastPresenceDay: "2026-06-01", asOf: "2026-06-02" });
  assert.equal((await service.getRelationshipLifecycle(actor))?.state, "TERMINAL");
  assert.equal((await otherService.getRelationshipLifecycle(other))?.state, "ACTIVE");
});

test("LIFECYCLE (mem): TERMINAL blocks the daily miss penalty (no infinite charges)", async () => {
  const { actor, service, repository } = await memoryUser("A");
  await service.saveMemory(actor, { requestId: randomUUID(), name: "Will", biologicalSex: "male", userAge: 34, weightKg: 80, heightCm: 181, trainingLevel: "consistent", trainingGoal: "muscle_gain", trainingFrequency: 4 } as never);
  await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay: "2026-06-01", asOf: "2026-06-20" });
  assert.equal((await service.getRelationshipLifecycle(actor))?.state, "TERMINAL");
  await assert.rejects(
    () => service.saveMemory(actor, { requestId: randomUUID(), name: "Will", xpEvent: "apply_daily_miss_penalty" } as never),
    (error: unknown) => {
      assert.ok(error instanceof V3Error);
      assert.equal(error.code, "V3_RELATIONSHIP_TERMINAL");
      return true;
    },
  );
  // And no penalty was recorded
  const state = await service.load(actor);
  assert.equal(state.progression.xpEvents.some((event) => event.reasonCode === "apply_daily_miss_penalty"), false);
  // ACTIVE users still get charged (gate is TERMINAL-only)
  const { actor: activeUser, service: activeService } = await memoryUser("B");
  await activeService.evaluateRelationshipLifecycle(activeUser, { requestId: randomUUID(), lastPresenceDay: "2026-06-01", asOf: "2026-06-01" });
  await activeService.saveMemory(activeUser, { requestId: randomUUID(), name: "Active", xpEvent: "apply_daily_miss_penalty" } as never);
  const activeState = await activeService.load(activeUser);
  assert.equal(activeState.progression.xpEvents.some((event) => event.reasonCode === "apply_daily_miss_penalty"), true);
});

test("LIFECYCLE (mem): lifecycle state is exposed on the snapshot (LLM can only verbalize)", async () => {
  const { actor, service } = await memoryUser("A");
  await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay: "2026-06-01", asOf: "2026-06-20" });
  const snapshot = await service.load(actor);
  assert.equal(snapshot.relationshipLifecycle?.state, "TERMINAL");
});

// ─── Postgres (PGlite) — durability, concurrency, tenant isolation ─────────

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
    throw new Error("CRITICAL GATE FAILED: PGlite infra unavailable for lifecycle test. Underlying: " + String(error));
  }
  const dataDir = path.join(os.tmpdir(), `guto-pg-lc-${randomUUID()}`);
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

test("LIFECYCLE (pg): full chain on real Postgres — durability across reload, idempotency, concurrency, tenant isolation", async () => {
  const db = await startEmbeddedPostgres();
  try {
    await applyMigrations(db.port);
    const pool = createPool(db.port, 6);
    try {
      const repo = new PostgresOfficialStateRepository(pool);
      const svc = new V3CutoverService(repo);
      const actor = await repo.provisionActor({ externalSubject: `pg-lc-${randomUUID()}`, role: "student", tenantKey: "A", tenantName: "Tenant A" });
      const p = RELATIONSHIP_LIFECYCLE_POLICY;
      const lastPresenceDay = "2026-06-01";
      const evalDay = (days: number) => svc.evaluateRelationshipLifecycle(actor, {
        requestId: randomUUID(), lastPresenceDay, asOf: `2026-06-${String(1 + days).padStart(2, "0")}`,
      });
      assert.equal((await evalDay(0)).state, "ACTIVE");
      assert.equal((await evalDay(p.atRiskAfterAbsenceDays)).state, "AT_RISK");
      assert.equal((await evalDay(p.decayingAfterAbsenceDays)).state, "DECAYING");
      assert.equal((await evalDay(p.terminalAfterAbsenceDays)).state, "TERMINAL");

      // Durability across a NEW repository instance (survives reload/new backend)
      const freshRepo = new PostgresOfficialStateRepository(pool);
      const freshService = new V3CutoverService(freshRepo);
      const reloaded = await freshService.getRelationshipLifecycle(actor);
      assert.equal(reloaded?.state, "TERMINAL");

      // Idempotency: same requestId twice → same version, one event
      const requestId = randomUUID();
      const once = await freshService.evaluateRelationshipLifecycle(actor, { requestId, lastPresenceDay, asOf: "2026-06-30" });
      const twice = await freshService.evaluateRelationshipLifecycle(actor, { requestId, lastPresenceDay, asOf: "2026-06-30" });
      assert.equal(once.state, twice.state);
      assert.equal(once.version, twice.version);

      // Concurrency: two simultaneous evaluations → one coherent transition
      const [c1, c2] = await Promise.all([
        freshService.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay, asOf: "2026-06-15" }),
        freshService.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay, asOf: "2026-06-15" }),
      ]);
      assert.equal(c1.state, c2.state);

      // Explicit reactivation works and keeps official data (same user, no dup)
      const reactivated = await freshService.reactivateRelationship(actor, { requestId: randomUUID() });
      assert.equal(reactivated.state, "ACTIVE");

      // Tenant isolation: B (different tenant, its own user) can never read A's
      // lifecycle or affect it. (User UUIDs are globally unique by design, so a
      // cross-tenant same-UUID collision is impossible — RLS by tenant is the
      // authoritative boundary.)
      const otherRepo = new PostgresOfficialStateRepository(pool);
      const otherService = new V3CutoverService(otherRepo);
      const otherActor = await otherRepo.provisionActor({ externalSubject: `pg-lc-other-${randomUUID()}`, role: "student", tenantKey: "B", tenantName: "Tenant B" });
      assert.equal(await otherService.getRelationshipLifecycle(otherActor), null);
      // B evaluating writes B's OWN row; A (tenant A) untouched.
      await otherService.evaluateRelationshipLifecycle(otherActor, { requestId: randomUUID(), lastPresenceDay, asOf: "2026-06-01" });
      const bRow = await otherService.getRelationshipLifecycle(otherActor);
      assert.equal(bRow?.state, "ACTIVE");
      const aAfterB = await freshService.getRelationshipLifecycle(actor);
      assert.equal(aAfterB?.state, "ACTIVE");

      // Proactivity gate on real Postgres
      await freshService.saveMemory(actor, { requestId: randomUUID(), name: "Will", xpEvent: "complete_daily_mission" } as never);
      await freshService.evaluateRelationshipLifecycle(actor, { requestId: randomUUID(), lastPresenceDay: "2026-06-01", asOf: "2026-06-20" });
      assert.equal((await freshService.getRelationshipLifecycle(actor))?.state, "TERMINAL");
      await assert.rejects(
        () => freshService.saveMemory(actor, { requestId: randomUUID(), name: "Will", xpEvent: "apply_daily_miss_penalty" } as never),
        (error: unknown) => {
          assert.ok(error instanceof V3Error);
          assert.equal(error.code, "V3_RELATIONSHIP_TERMINAL");
          return true;
        },
      );
    } finally {
      await pool.end().catch(() => undefined);
    }
  } finally {
    await db.stop().catch(() => undefined);
  }
});

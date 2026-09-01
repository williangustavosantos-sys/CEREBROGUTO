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
  absenceDaysBetween,
  evaluateOfficialRelationshipReturn,
  evaluateRelationshipLifecycleState,
  RELATIONSHIP_LIFECYCLE_POLICY,
  shouldSuppressProactivity,
} from "../src/v3/relationship-lifecycle.js";
import {
  parseRelationshipLifecycleEvaluationBody,
  rejectPublicRelationshipReactivationBody,
} from "../src/v3/router.js";
import type { OfficialStateRepository } from "../src/v3/repository.js";

class MutableClock {
  private value = new Date("2026-06-01T12:00:00.000Z");
  now = (): Date => new Date(this.value);
  set(day: string): void { this.value = new Date(`${day}T12:00:00.000Z`); }
}

async function confirmedUser(repository: OfficialStateRepository, suffix: string = randomUUID()) {
  const actor = await repository.provisionActor({ externalSubject: `lifecycle-${suffix}`, role: "student", tenantKey: `tenant-${suffix}`, tenantName: `Tenant ${suffix}` });
  const service = new V3CutoverService(repository);
  const id = () => randomUUID();
  await service.acceptConsent(actor, id());
  await service.saveMemory(actor, { requestId: id(), name: "Will", confirmedName: true, language: "pt-BR" });
  await service.saveMemory(actor, {
    requestId: id(), biologicalSex: "male", userAge: 34, weightKg: 80, heightCm: 181,
    trainingLevel: "consistent", trainingGoal: "muscle_gain", trainingFrequency: 4,
  });
  await service.saveMemory(actor, { requestId: id(), name: "Will", xpEvent: "grant_initial_xp" });
  await service.startFirstContact(actor, id());
  await service.respondFirstContact(actor, { requestId: id(), expectedStep: "food_restrictions", answer: "Vegetariano." });
  await service.respondFirstContact(actor, { requestId: id(), expectedStep: "training_limitations", answer: "Sem limitações declaradas." });
  await service.confirmFirstContact(actor, { requestId: id(), confirmed: true });
  return { actor, service };
}

test("LIFECYCLE policy is deterministic and official return is an explicit event", () => {
  const p = RELATIONSHIP_LIFECYCLE_POLICY;
  assert.equal(evaluateRelationshipLifecycleState("ACTIVE", 0).state, "ACTIVE");
  assert.equal(evaluateRelationshipLifecycleState("ACTIVE", p.atRiskAfterAbsenceDays).state, "AT_RISK");
  assert.equal(evaluateRelationshipLifecycleState("AT_RISK", p.decayingAfterAbsenceDays).state, "DECAYING");
  assert.equal(evaluateRelationshipLifecycleState("DECAYING", p.terminalAfterAbsenceDays).state, "TERMINAL");
  assert.equal(evaluateRelationshipLifecycleState("TERMINAL", 0).state, "TERMINAL");
  assert.deepEqual(evaluateOfficialRelationshipReturn("TERMINAL"), { state: "ACTIVE", transitioned: true, reason: "official_user_return" });
  assert.equal(absenceDaysBetween("2026-06-01", "2026-06-15"), 14);
  assert.equal(shouldSuppressProactivity("TERMINAL"), true);
  assert.equal(shouldSuppressProactivity("DECAYING"), false);
});

test("LIFECYCLE public contract rejects client time/presence authority and arbitrary reactivation", () => {
  const requestId = randomUUID();
  assert.deepEqual(parseRelationshipLifecycleEvaluationBody({ requestId }), { requestId });
  for (const body of [
    { requestId, asOf: "2099-01-01" },
    { requestId, lastPresenceDay: "2000-01-01" },
    { requestId, asOf: "2099-01-01", lastPresenceDay: null },
  ]) {
    assert.throws(() => parseRelationshipLifecycleEvaluationBody(body));
  }
  assert.throws(
    () => rejectPublicRelationshipReactivationBody({ requestId }),
    (error: unknown) => error instanceof V3Error && error.status === 403 && error.code === "V3_RELATIONSHIP_REACTIVATION_FORBIDDEN",
  );
});

test("LIFECYCLE (mem): official presence drives full chain; retry/concurrency are coherent", async () => {
  const clock = new MutableClock();
  const repository = new InMemoryOfficialStateRepository(clock.now);
  const { actor, service } = await confirmedUser(repository, "mem-chain");
  await repository.recordTurn({ actor, requestId: randomUUID(), action: "acknowledge", resultCode: "NO_MUTATION_REQUIRED" });
  assert.equal((await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() })).state, "ACTIVE");
  clock.set("2026-06-04");
  assert.equal((await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() })).state, "AT_RISK");
  clock.set("2026-06-08");
  const concurrent = await Promise.all([
    service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() }),
    service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() }),
  ]);
  assert.deepEqual(concurrent.map((record) => record.state), ["DECAYING", "DECAYING"]);
  clock.set("2026-06-15");
  const requestId = randomUUID();
  const once = await service.evaluateRelationshipLifecycle(actor, { requestId });
  const twice = await service.evaluateRelationshipLifecycle(actor, { requestId });
  assert.equal(once.state, "TERMINAL");
  assert.equal(twice.version, once.version);
  assert.equal(repository.lifecycleEvents.filter((event) => event.requestId === requestId).length, 1);
});

test("LIFECYCLE STRESS (mem): 100/100 concurrent terminal evaluations stay monotonic", async () => {
  const clock = new MutableClock();
  const repository = new InMemoryOfficialStateRepository(clock.now);
  const { actor, service } = await confirmedUser(repository, "mem-stress");
  await repository.recordTurn({ actor, requestId: randomUUID(), action: "acknowledge", resultCode: "OK" });
  assert.equal((await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() })).state, "ACTIVE");
  clock.set("2026-06-15");
  const results = await Promise.all(Array.from({ length: 100 }, () =>
    service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() })
  ));
  assert.equal(results.filter((record) => record.state === "TERMINAL").length, 100);
  assert.equal(repository.lifecycleEvents.filter((event) => event.toState === "TERMINAL").length, 1);
  assert.equal((await service.getRelationshipLifecycle(actor))?.state, "TERMINAL");
});

test("LIFECYCLE (mem): only a legitimate persisted turn returns TERMINAL to ACTIVE and preserves product state", async () => {
  const clock = new MutableClock();
  const repository = new InMemoryOfficialStateRepository(clock.now);
  const { actor, service } = await confirmedUser(repository, "mem-return");
  await repository.recordTurn({ actor, requestId: randomUUID(), action: "acknowledge", resultCode: "NO_MUTATION_REQUIRED" });
  await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() });
  clock.set("2026-06-15");
  await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() });
  const terminal = await service.load(actor);
  assert.equal(terminal.relationshipLifecycle?.state, "TERMINAL");
  assert.ok(terminal.confirmedContext && terminal.workout && terminal.diet);
  assert.throws(() => rejectPublicRelationshipReactivationBody({ requestId: randomUUID() }), V3Error);
  assert.equal((await service.getRelationshipLifecycle(actor))?.state, "TERMINAL");

  const returnRequestId = randomUUID();
  await repository.recordTurn({ actor, requestId: returnRequestId, action: "acknowledge", resultCode: "NO_MUTATION_REQUIRED" });
  await repository.recordTurn({ actor, requestId: returnRequestId, action: "acknowledge", resultCode: "NO_MUTATION_REQUIRED" });
  const returned = await service.load(actor);
  assert.equal(returned.relationshipLifecycle?.state, "ACTIVE");
  assert.equal(returned.confirmedContext?.id, terminal.confirmedContext.id);
  assert.equal(returned.workout?.id, terminal.workout.id);
  assert.equal(returned.diet?.id, terminal.diet.id);
  assert.equal(repository.lifecycleEvents.filter((event) => event.requestId === returnRequestId && event.reason === "official_user_return").length, 1);
});

test("LIFECYCLE (mem): terminal suppresses miss penalty and tenant B cannot touch A", async () => {
  const clock = new MutableClock();
  const repository = new InMemoryOfficialStateRepository(clock.now);
  const { actor: actorA, service: serviceA } = await confirmedUser(repository, "mem-a");
  const { actor: actorB, service: serviceB } = await confirmedUser(repository, "mem-b");
  const sameRequestIdAcrossTenants = randomUUID();
  await repository.recordTurn({ actor: actorA, requestId: sameRequestIdAcrossTenants, action: "acknowledge", resultCode: "OK" });
  await repository.recordTurn({ actor: actorB, requestId: sameRequestIdAcrossTenants, action: "acknowledge", resultCode: "OK" });
  assert.equal(
    repository.events.filter((event) => event.requestId === sameRequestIdAcrossTenants && event.action === "acknowledge").length,
    2,
    "requestId dedupe is scoped by tenant/user, never shared between tenants",
  );
  await serviceA.evaluateRelationshipLifecycle(actorA, { requestId: randomUUID() });
  await serviceB.evaluateRelationshipLifecycle(actorB, { requestId: randomUUID() });
  clock.set("2026-06-15");
  await serviceA.evaluateRelationshipLifecycle(actorA, { requestId: randomUUID() });
  assert.equal((await serviceA.getRelationshipLifecycle(actorA))?.state, "TERMINAL");
  assert.equal((await serviceB.getRelationshipLifecycle(actorB))?.state, "ACTIVE");
  await assert.rejects(
    () => serviceA.saveMemory(actorA, { requestId: randomUUID(), xpEvent: "apply_daily_miss_penalty" } as never),
    (error: unknown) => error instanceof V3Error && error.code === "V3_RELATIONSHIP_TERMINAL",
  );
  assert.equal((await serviceB.getRelationshipLifecycle(actorB))?.state, "ACTIVE");
});

type EmbeddedDb = { port: number; stop: () => Promise<void> };

async function startEmbeddedPostgres(): Promise<EmbeddedDb> {
  const pgliteName = "@electric-sql" + "/pglite";
  const pgcryptoName = "@electric-sql" + "/pglite/contrib/pgcrypto";
  const socketName = "@electric-sql" + "/pglite-socket";
  const { PGlite } = await import(pgliteName);
  const { pgcrypto } = await import(pgcryptoName);
  const { PGLiteSocketServer } = await import(socketName);
  const db = new PGlite({ dataDir: path.join(os.tmpdir(), `guto-pg-lifecycle-${randomUUID()}`), extensions: { pgcrypto } });
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
    probe.on("error", reject);
  });
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 12 });
  await server.start();
  return { port, stop: async () => { await server.stop().catch(() => undefined); await db.close(); } };
}

async function applyMigrations(port: number): Promise<void> {
  const admin = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres", password: "postgres" });
  await admin.connect();
  const { readdirSync, readFileSync } = await import("node:fs");
  const migrationDir = path.join(import.meta.dirname, "..", "migrations", "v3");
  await admin.query("CREATE SCHEMA IF NOT EXISTS guto_v3");
  await admin.query("CREATE TABLE IF NOT EXISTS guto_v3.schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
    await admin.query(readFileSync(path.join(migrationDir, file), "utf8"));
    await admin.query("INSERT INTO guto_v3.schema_migrations (filename, checksum) VALUES ($1,$2) ON CONFLICT DO NOTHING", [file, "embedded"]);
  }
  await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guto_v3_runtime') THEN CREATE ROLE guto_v3_runtime LOGIN PASSWORD 'runtime'; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guto_v3_app') THEN CREATE ROLE guto_v3_app NOLOGIN; END IF; END $$;");
  await admin.query("GRANT guto_v3_app TO guto_v3_runtime");
  await admin.query("GRANT USAGE ON SCHEMA guto_v3 TO guto_v3_app");
  await admin.query("GRANT ALL ON ALL TABLES IN SCHEMA guto_v3 TO guto_v3_app");
  await admin.query("GRANT ALL ON ALL SEQUENCES IN SCHEMA guto_v3 TO guto_v3_app");
  await admin.end();
}

test("LIFECYCLE (Postgres): authority, persistence, idempotency, concurrency, tenant isolation and legitimate return", async () => {
  const db = await startEmbeddedPostgres();
  try {
    await applyMigrations(db.port);
    const pool = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "guto_v3_runtime", password: "runtime", database: "postgres", max: 8 });
    const clock = new MutableClock();
    try {
      const repository = new PostgresOfficialStateRepository(pool, clock.now);
      const { actor, service } = await confirmedUser(repository, "pg-a");
      const initial = await service.load(actor);
      assert.ok(initial.confirmedContext && initial.workout && initial.diet);
      await repository.recordTurn({ actor, requestId: randomUUID(), action: "acknowledge", resultCode: "OK" });
      assert.equal((await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() })).state, "ACTIVE");
      clock.set("2026-06-04");
      assert.equal((await service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() })).state, "AT_RISK");
      clock.set("2026-06-08");
      const [c1, c2] = await Promise.all([
        service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() }),
        service.evaluateRelationshipLifecycle(actor, { requestId: randomUUID() }),
      ]);
      assert.equal(c1.state, "DECAYING");
      assert.equal(c2.state, "DECAYING");
      clock.set("2026-06-15");
      const terminalRequestId = randomUUID();
      const [once, twice] = await Promise.all([
        service.evaluateRelationshipLifecycle(actor, { requestId: terminalRequestId }),
        service.evaluateRelationshipLifecycle(actor, { requestId: terminalRequestId }),
      ]);
      assert.equal(once.state, "TERMINAL");
      assert.equal(twice.version, once.version);

      const fresh = new V3CutoverService(new PostgresOfficialStateRepository(pool, clock.now));
      assert.equal((await fresh.getRelationshipLifecycle(actor))?.state, "TERMINAL");
      assert.throws(() => rejectPublicRelationshipReactivationBody({ requestId: randomUUID() }), V3Error);
      assert.equal((await fresh.getRelationshipLifecycle(actor))?.state, "TERMINAL");

      const returnRequestId = randomUUID();
      await repository.recordTurn({ actor, requestId: returnRequestId, action: "acknowledge", resultCode: "OK" });
      await repository.recordTurn({ actor, requestId: returnRequestId, action: "acknowledge", resultCode: "OK" });
      const returned = await service.load(actor);
      assert.equal(returned.relationshipLifecycle?.state, "ACTIVE");
      assert.equal(returned.confirmedContext?.id, initial.confirmedContext.id);
      assert.equal(returned.workout?.id, initial.workout.id);
      assert.equal(returned.diet?.id, initial.diet.id);

      const { actor: actorB, service: serviceB } = await confirmedUser(repository, "pg-b");
      await repository.recordTurn({ actor: actorB, requestId: randomUUID(), action: "acknowledge", resultCode: "OK" });
      assert.equal((await serviceB.evaluateRelationshipLifecycle(actorB, { requestId: randomUUID() })).state, "ACTIVE");
      assert.equal((await service.getRelationshipLifecycle(actor))?.state, "ACTIVE");

      const admin = new pg.Client({ host: "127.0.0.1", port: db.port, user: "postgres", database: "postgres", password: "postgres" });
      await admin.connect();
      const events = await admin.query("SELECT request_id::text,reason FROM guto_v3.relationship_lifecycle_events WHERE tenant_id=$1 AND user_id=$2 ORDER BY sequence_id", [actor.tenantId, actor.userId]);
      assert.equal(events.rows.filter((row) => row.request_id === terminalRequestId && row.reason === "prolonged_absence_terminal").length, 1);
      assert.equal(events.rows.filter((row) => row.request_id === returnRequestId && row.reason === "official_user_return").length, 1);
      await admin.end();
    } finally {
      await pool.end().catch(() => undefined);
    }
  } finally {
    await db.stop().catch(() => undefined);
  }
});

import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";
import { PostgresOfficialStateRepository } from "../src/v3/postgres.js";
import { V3Error } from "../src/v3/errors.js";
import type { DietPlanDraft, OfficialStateRepository } from "../src/v3/repository.js";
import type { ActorContext, ConfirmedUserContext } from "../src/v3/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class DietFinalizationBarrierRepository extends InMemoryOfficialStateRepository {
  private armed = false;
  private readonly entered = deferred();
  private readonly release = deferred();

  arm(): void { this.armed = true; }
  waitUntilFinalization(): Promise<void> { return this.entered.promise; }
  releaseFinalization(): void { this.release.resolve(); }

  override async replaceDietPlan(input: {
    actor: ActorContext;
    requestId: string;
    context: ConfirmedUserContext;
    draft: DietPlanDraft;
  }) {
    if (this.armed) {
      this.armed = false;
      this.entered.resolve();
      await this.release.promise;
    }
    return super.replaceDietPlan(input);
  }
}

async function confirmedUser(repository: OfficialStateRepository) {
  const actor = await repository.provisionActor({
    externalSubject: `diet-race-${randomUUID()}`,
    role: "student",
    tenantKey: "diet-race",
    tenantName: "Diet Race",
  });
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

test("DIET RACE: 100/100 stale generations are rejected before becoming active", async () => {
  let false200 = 0;
  let staleActive = 0;
  let staleOfficial = 0;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const repository = new DietFinalizationBarrierRepository();
    const { actor, service } = await confirmedUser(repository);
    const before = await service.load(actor);
    assert.ok(before.confirmedContext && before.diet);

    repository.arm();
    const generationRequestId = randomUUID();
    const generation = service.generateDiet(actor, generationRequestId);
    await repository.waitUntilFinalization();

    const changed = await repository.applyFactChanges({
      actor,
      requestId: randomUUID(),
      expectedContextVersion: before.confirmedContext.version,
      changes: [{
        factType: "BEHAVIORAL_PREFERENCE",
        canonicalValue: `prefere refeições simples ${iteration}`,
        value: { declaration: `Prefiro refeições simples ${iteration}.` },
        source: "user_declared",
        confirmationStatus: "FACT_CONFIRMED",
      }],
    });
    repository.releaseFinalization();

    try {
      await generation;
      false200 += 1;
    } catch (error) {
      assert.ok(error instanceof V3Error);
      assert.equal(error.status, 409);
      assert.match(error.code, /CONTEXT/);
    }
    const after = await service.load(actor);
    if (after.diet?.confirmedContextVersion === before.confirmedContext.version) staleActive += 1;
    if (repository.events.some((event) => event.requestId === generationRequestId && event.action === "generateDiet")) staleOfficial += 1;
    assert.equal(after.confirmedContext?.version, changed.context.version);
    assert.equal(after.diet?.confirmedContextVersion, changed.context.version);
  }
  assert.deepEqual({ false200, staleActive, staleOfficial }, { false200: 0, staleActive: 0, staleOfficial: 0 });
});

type EmbeddedDb = { port: number; stop: () => Promise<void> };

async function startEmbeddedPostgres(): Promise<EmbeddedDb> {
  let PGlite: any, PGLiteSocketServer: any, pgcrypto: any;
  const pgliteName = "@electric-sql" + "/pglite";
  const pgcryptoName = "@electric-sql" + "/pglite/contrib/pgcrypto";
  const socketName = "@electric-sql" + "/pglite-socket";
  ({ PGlite } = await import(pgliteName));
  ({ pgcrypto } = await import(pgcryptoName));
  ({ PGLiteSocketServer } = await import(socketName));
  const db = new PGlite({ dataDir: path.join(os.tmpdir(), `guto-pg-diet-race-${randomUUID()}`), extensions: { pgcrypto } });
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
    probe.on("error", reject);
  });
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 10 });
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

class PostgresDietFinalizationBarrierRepository extends PostgresOfficialStateRepository {
  private armed = false;
  private readonly entered = deferred();
  private readonly release = deferred();
  arm(): void { this.armed = true; }
  waitUntilFinalization(): Promise<void> { return this.entered.promise; }
  releaseFinalization(): void { this.release.resolve(); }
  override async replaceDietPlan(input: { actor: ActorContext; requestId: string; context: ConfirmedUserContext; draft: DietPlanDraft }) {
    if (this.armed) {
      this.armed = false;
      this.entered.resolve();
      await this.release.promise;
    }
    return super.replaceDietPlan(input);
  }
}

test("DIET RACE (Postgres): stale generation returns 409 and writes no active/event row", async () => {
  const db = await startEmbeddedPostgres();
  try {
    await applyMigrations(db.port);
    const pool = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "guto_v3_runtime", password: "runtime", database: "postgres", max: 6 });
    try {
      const repository = new PostgresDietFinalizationBarrierRepository(pool);
      const { actor, service } = await confirmedUser(repository);
      const before = await service.load(actor);
      assert.ok(before.confirmedContext && before.diet);
      const authorityProbe = new pg.Client({ host: "127.0.0.1", port: db.port, user: "postgres", database: "postgres", password: "postgres" });
      await authorityProbe.connect();
      const authorityRows = await authorityProbe.query("SELECT version FROM guto_v3.confirmed_user_contexts WHERE tenant_id=$1 AND user_id=$2 ORDER BY version DESC", [actor.tenantId, actor.userId]);
      assert.equal(Number(authorityRows.rows[0]?.version), before.confirmedContext.version, JSON.stringify(authorityRows.rows));
      await authorityProbe.end();
      repository.arm();
      const generationRequestId = randomUUID();
      const generation = service.generateDiet(actor, generationRequestId);
      await repository.waitUntilFinalization();
      const changed = await repository.applyFactChanges({
        actor,
        requestId: randomUUID(),
        expectedContextVersion: before.confirmedContext.version,
        changes: [{ factType: "BEHAVIORAL_PREFERENCE", canonicalValue: "simple", value: { declaration: "simple" }, source: "user_declared", confirmationStatus: "FACT_CONFIRMED" }],
      });
      repository.releaseFinalization();
      await assert.rejects(generation, (error: unknown) => error instanceof V3Error && error.status === 409 && /CONTEXT/.test(error.code));
      const after = await service.load(actor);
      assert.equal(after.confirmedContext?.version, changed.context.version);
      assert.equal(after.diet?.confirmedContextVersion, changed.context.version);

      const admin = new pg.Client({ host: "127.0.0.1", port: db.port, user: "postgres", database: "postgres", password: "postgres" });
      await admin.connect();
      const event = await admin.query("SELECT count(*)::int AS count FROM guto_v3.guto_events WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3 AND event_type='diet.generated'", [actor.tenantId, actor.userId, generationRequestId]);
      const stale = await admin.query("SELECT count(*)::int AS count FROM guto_v3.diet_plans WHERE tenant_id=$1 AND user_id=$2 AND status='active' AND confirmed_context_version=$3", [actor.tenantId, actor.userId, before.confirmedContext.version]);
      assert.equal(event.rows[0]?.count, 0);
      assert.equal(stale.rows[0]?.count, 0);
      await admin.end();
    } finally {
      await pool.end().catch(() => undefined);
    }
  } finally {
    await db.stop().catch(() => undefined);
  }
});

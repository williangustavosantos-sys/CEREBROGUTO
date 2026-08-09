import "dotenv/config";
import "../src/v3/observability/instrumentation.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createV3Genkit, GenkitGeminiDecisionModel } from "../src/v3/ai.js";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import { shutdownV3Telemetry } from "../src/v3/observability/instrumentation.js";
import { withV3Span, withV3Trace } from "../src/v3/observability/tracing.js";
import { RedisV3OperationalState } from "../src/v3/operational-state.js";
import { PostgresOfficialStateRepository, createV3Pool } from "../src/v3/postgres.js";
import { Mem0RelationshipMemoryStore } from "../src/v3/relationship-memory.js";
import type { ActiveContext, ActorContext } from "../src/v3/types.js";

const required = [
  "DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "GEMINI_API_KEY",
  "MEM0_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
] as const;

const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`Missing required V3 integration variables: ${missing.join(", ")}`);

const pool = createV3Pool();
const repository = new PostgresOfficialStateRepository(pool);
const operational = RedisV3OperationalState.fromEnvironment();
const relationshipMemory = new Mem0RelationshipMemoryStore();
const service = new V3CutoverService(repository);
const tenantKey = "guto-v3-integration";

async function provision(externalSubject: string): Promise<ActorContext> {
  const actor = await repository.provisionActor({
    externalSubject,
    role: "student",
    tenantKey,
    tenantName: "GUTO V3 Integration",
    displayName: externalSubject,
  });
  await service.acceptConsent(actor, randomUUID());
  await repository.persistCalibration(actor, {
    requestId: randomUUID(),
    profile: {
      biologicalSex: "prefer_not_to_say",
      age: 35,
      weightKg: 80,
      heightCm: 180,
      trainingStatus: "active",
      trainingLocation: "gym",
      city: "Roma",
      country: "Italia",
      language: "pt-BR",
    },
    goal: { code: "consistency" },
    preferences: {},
    healthConstraints: [],
  });
  return actor;
}

async function assertRlsIsolation(actorA: ActorContext, actorB: ActorContext): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [actorA.tenantId, actorA.userId]);
    await client.query("SET LOCAL ROLE guto_v3_app");
    const visible = await client.query<{ id: string }>(
      "SELECT id FROM guto_v3.users WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[actorA.userId, actorB.userId]],
    );
    assert.deepEqual(visible.rows.map((row) => row.id), [actorA.userId]);
    const crossUserUpdate = await client.query(
      "UPDATE guto_v3.users SET display_name='RLS MUST BLOCK' WHERE id=$1",
      [actorB.userId],
    );
    assert.equal(crossUserUpdate.rowCount, 0);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function context(actor: ActorContext, version: number, label: string): ActiveContext {
  return {
    id: randomUUID(),
    version,
    kind: "workout",
    planId: randomUUID(),
    planVersion: 1,
    itemId: randomUUID(),
    itemLabel: label,
    rejectedCandidateIds: [],
    updatedAt: new Date().toISOString(),
  };
}

async function assertRedisIsolationAndConcurrency(actorA: ActorContext, actorB: ActorContext): Promise<void> {
  const initialA = context(actorA, 1, "user-a");
  const initialB = context(actorB, 1, "user-b");
  await Promise.all([
    operational.compareAndSetActiveContext(actorA, null, initialA),
    operational.compareAndSetActiveContext(actorB, null, initialB),
  ]);
  assert.equal((await operational.getActiveContext(actorA))?.itemLabel, "user-a");
  assert.equal((await operational.getActiveContext(actorB))?.itemLabel, "user-b");

  const competing = await Promise.allSettled([
    operational.compareAndSetActiveContext(actorA, 1, { ...initialA, version: 2, itemLabel: "winner-one" }),
    operational.compareAndSetActiveContext(actorA, 1, { ...initialA, version: 2, itemLabel: "winner-two" }),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(competing.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await operational.getActiveContext(actorA))?.version, 2);

  await Promise.all([
    operational.clearActiveContext(actorA, 2),
    operational.clearActiveContext(actorB, 1),
  ]);
}

try {
  const result = await withV3Trace({
    requestId: randomUUID(),
    externalSubject: "guto-v3-integration-verifier",
    attributes: { "guto.input_category": "real_integration_verification" },
  }, async () => {
    const [postgres, redis] = await Promise.all([repository.health(), operational.health()]);
    assert.equal(postgres.ok, true);
    assert.equal(redis.ok, true);

    const [actorA, actorB] = await Promise.all([
      provision("guto-v3-integration-a"),
      provision("guto-v3-integration-b"),
    ]);
    await withV3Span("RLS_ISOLATION_TEST", {}, () => assertRlsIsolation(actorA, actorB));
    await withV3Span("REDIS_CONCURRENCY_TEST", {}, () => assertRedisIsolationAndConcurrency(actorA, actorB));

    const snapshot = await repository.loadOfficialSnapshot(actorA);
    const ai = createV3Genkit();
    const decision = await new GenkitGeminiDecisionModel(ai).decide({
      brainVersion: "guto-cerebro-v3",
      requestId: randomUUID(),
      actor: { tenantId: actorA.tenantId, userId: actorA.userId, role: actorA.role },
      message: "Oi GUTO. Confirma que está comigo sem alterar meu plano.",
      official: {
        profile: snapshot.profile,
        goal: snapshot.goal,
        preferences: snapshot.preferences,
        healthConstraints: snapshot.healthConstraints,
      },
      activeContext: null,
      relationshipMemories: [],
      candidates: [],
    });
    assert.ok(decision.speech.length > 0);

    await relationshipMemory.submit(actorA, [{
      classification: "RELATIONSHIP",
      fact: "O usuário sintético do teste prefere confirmações curtas.",
      evidence: "Declaração sintética do verificador de integração V3.",
    }], randomUUID());
    await relationshipMemory.search(actorA, "confirmações curtas", 1);

    return {
      postgres: { ok: true, latencyMs: postgres.latencyMs },
      rls: { ok: true, isolatedUsers: 2 },
      redis: { ok: true, latencyMs: redis.latencyMs, isolatedUsers: 2, concurrentWinners: 1 },
      gemini: { ok: true, action: decision.action, decisionEnvelopeValidated: true },
      mem0: { ok: true, classification: "RELATIONSHIP" },
      langfuse: { configured: true, traceFlushRequested: true },
    };
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await pool.end();
  await shutdownV3Telemetry();
}

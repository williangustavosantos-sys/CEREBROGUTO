import "dotenv/config";
import "../src/v3/observability/instrumentation.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { createV3Genkit, GeminiInteractionsDecisionModel } from "../src/v3/ai.js";
import { ConservativeCatalogCandidateProviderV3 } from "../src/v3/candidate-provider.js";
import { GutoContextBuilderV3 } from "../src/v3/context-builder.js";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import { InngestDurableEventPublisher } from "../src/v3/durable-events.js";
import { createGutoTurnFlow } from "../src/v3/flow.js";
import { shutdownV3Telemetry } from "../src/v3/observability/instrumentation.js";
import { withV3Span, withV3Trace } from "../src/v3/observability/tracing.js";
import { RedisV3OperationalState } from "../src/v3/operational-state.js";
import { PostgresOfficialStateRepository, createV3Pool } from "../src/v3/postgres.js";
import { Mem0RelationshipMemoryStore } from "../src/v3/relationship-memory.js";
import type { ActiveContext, ActorContext } from "../src/v3/types.js";

const required = [
  "DATABASE_URL",
  "GEMINI_API_KEY",
  "MEM0_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "INNGEST_EVENT_KEY",
] as const;

const missing: string[] = required.filter((name) => !process.env[name]);
if (!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)) missing.push("UPSTASH_REDIS_REST_URL|KV_REST_API_URL");
if (!(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)) missing.push("UPSTASH_REDIS_REST_TOKEN|KV_REST_API_TOKEN");
if (missing.length) throw new Error(`Missing required V3 integration variables: ${missing.join(", ")}`);

const pool = createV3Pool();
const repository = new PostgresOfficialStateRepository(pool);
const operational = RedisV3OperationalState.fromEnvironment();
const relationshipMemory = new Mem0RelationshipMemoryStore();
const rawRedis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "",
});
const service = new V3CutoverService(repository);
const tenantKey = "guto-v3-integration";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const [ttlA, ttlB] = await Promise.all([
    rawRedis.ttl(`guto:v3:{${actorA.tenantId}:${actorA.userId}}:active-context`),
    rawRedis.ttl(`guto:v3:{${actorB.tenantId}:${actorB.userId}}:active-context`),
  ]);
  assert.ok(ttlA > 0, "Redis context A must have a positive TTL");
  assert.ok(ttlB > 0, "Redis context B must have a positive TTL");

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

async function assertMem0RelationshipMemory(actor: ActorContext): Promise<number> {
  const marker = `guto-v3-preview-${randomUUID()}`;
  await relationshipMemory.submit(actor, [{
    classification: "RELATIONSHIP",
    fact: `O usuário sintético do teste prefere confirmações curtas. ${marker}`,
    evidence: "Declaração sintética do verificador de integração V3.",
  }], randomUUID());

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const memories = await relationshipMemory.search(actor, "confirmações curtas", 5);
    if (memories.length > 0) return memories.length;
    await wait(1_000 * (attempt + 1));
  }
  assert.fail("Mem0 accepted the write but did not return relational memory after retries");
}

async function assertInngestRelationshipMemory(actor: ActorContext): Promise<number> {
  const marker = `guto-v3-inngest-${randomUUID()}`;
  await new InngestDurableEventPublisher().enqueueRelationshipMemorySync({
    actor,
    correlationId: randomUUID(),
    facts: [{
      classification: "RELATIONSHIP",
      fact: `O usuário sintético do fluxo durável prefere confirmação objetiva. ${marker}`,
      evidence: "Evento sintético do verificador de integração V3.",
    }],
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const memories = await relationshipMemory.search(actor, marker, 10);
    if (memories.some((memory) => memory.text.includes(marker))) return memories.length;
    await wait(2_000);
  }
  assert.fail("Inngest accepted the event but did not complete the durable relationship-memory sync");
}

async function assertLangfuseTrace(requestId: string): Promise<{ traceId: string; observationCount: number }> {
  const baseUrl = (process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/+$/, "");
  const authorization = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
  const headers = { Authorization: `Basic ${authorization}` };

  const maxAttempts = Number(process.env.GUTO_V3_LANGFUSE_VERIFY_ATTEMPTS || 8);
  const pollDelayMs = Number(process.env.GUTO_V3_LANGFUSE_VERIFY_POLL_DELAY_MS || 1_000);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/public/traces?limit=100&name=GUTO_TURN`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.ok, true, `Langfuse trace query failed with status ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ id?: string; [key: string]: unknown }> };
    const trace = (body.data || []).find((candidate) => JSON.stringify(candidate).includes(requestId));
    if (trace?.id) {
      const detailResponse = await fetch(`${baseUrl}/api/public/traces/${trace.id}`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(detailResponse.ok, true, `Langfuse trace detail failed with status ${detailResponse.status}`);
      const detail = (await detailResponse.json()) as { observations?: Array<{ name?: string }> };
      const observations = detail.observations || [];
      const names = observations.map((observation) => observation.name);
      assert.ok(names.includes("GUTO_TURN"), "Langfuse trace is missing GUTO_TURN");
      assert.ok(names.includes("GEMINI_CALL"), "Langfuse trace is missing GEMINI_CALL");
      assert.ok(names.includes("DECISION_VALIDATION"), "Langfuse trace is missing DECISION_VALIDATION");
      return { traceId: trace.id, observationCount: observations.length };
    }
    await wait(pollDelayMs);
  }
  assert.fail("Langfuse did not expose the flushed V3 trace after retries");
}

let telemetryShutdown = false;
try {
  const traceRequestId = randomUUID();
  const result = await withV3Trace({
    requestId: traceRequestId,
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

    const ai = createV3Genkit();
    const contextBuilder = new GutoContextBuilderV3(
      repository,
      operational,
      relationshipMemory,
      new ConservativeCatalogCandidateProviderV3(),
    );
    const flow = createGutoTurnFlow({
      ai,
      repository,
      operational,
      relationshipMemory,
      contextBuilder,
      decisionModel: new GeminiInteractionsDecisionModel(),
      durableEvents: new InngestDurableEventPublisher(),
    });
    const decision = await flow({
      externalSubject: actorA.externalSubject,
      role: actorA.role,
      message: "Oi GUTO. Confirma que está comigo sem alterar meu plano.",
      requestId: randomUUID(),
    });
    assert.equal(decision.brainVersion, "guto-cerebro-v3");
    assert.ok(decision.speech.length > 0);

    const mem0ResultCount = await assertMem0RelationshipMemory(actorA);
    const inngestResultCount = await assertInngestRelationshipMemory(actorA);

    return {
      postgres: { ok: true, latencyMs: postgres.latencyMs },
      rls: { ok: true, isolatedUsers: 2 },
      redis: { ok: true, latencyMs: redis.latencyMs, isolatedUsers: 2, concurrentWinners: 1, ttlValidated: true },
      gemini: { ok: true, api: "interactions", action: decision.action, decisionEnvelopeValidated: true, genkitFlowValidated: true },
      mem0: { ok: true, classification: "RELATIONSHIP", resultCount: mem0ResultCount },
      inngest: { ok: true, durableRelationshipMemoryResultCount: inngestResultCount },
    };
  });
  await shutdownV3Telemetry();
  telemetryShutdown = true;
  const langfuse = await assertLangfuseTrace(traceRequestId);
  process.stdout.write(`${JSON.stringify({
    ...result,
    langfuse: { ok: true, traceFlushed: true, ...langfuse },
  }, null, 2)}\n`);
} finally {
  await pool.end();
  if (!telemetryShutdown) await shutdownV3Telemetry();
}

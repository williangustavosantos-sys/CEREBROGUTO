import { z, type Genkit } from "genkit";
import type { DecisionModel } from "./ai.js";
import { BrainVersion } from "./contracts.js";
import { GutoContextBuilderV3 } from "./context-builder.js";
import { V3Error } from "./errors.js";
import { DeterministicExecutorV3 } from "./executors.js";
import { currentTraceId, withV3Span, withV3Trace } from "./observability/tracing.js";
import type { OperationalStateStore } from "./operational-state.js";
import { PolicyGateV3 } from "./policy-gate.js";
import type { RelationshipMemoryStore } from "./relationship-memory.js";
import type { OfficialStateRepository } from "./repository.js";
import type { V3TurnResponse } from "./types.js";

const InternalFlowInputSchema = z.object({
  externalSubject: z.string().trim().min(1).max(200),
  role: z.enum(["student", "coach", "admin", "super_admin"]),
  message: z.string().trim().min(1).max(4_000),
  requestId: z.string().uuid(),
  uiContextId: z.string().trim().min(1).max(160).optional(),
});

const ExecutorResultSchema = z.object({
  status: z.enum(["confirmed", "not_executed", "rejected"]),
  code: z.string(),
  message: z.string(),
  planVersion: z.number().optional(),
  activeContextVersion: z.number().optional(),
});

const V3TurnResponseSchema = z.object({
  speech: z.string(),
  action: z.enum(["none", "askClarification", "swapExercise", "swapFood", "generateWorkout", "generateDiet", "startMinimumMission", "acknowledge", "callSafetyPath"]),
  requestId: z.string().uuid(),
  traceId: z.string(),
  brainVersion: z.literal("guto-cerebro-v3"),
  execution: ExecutorResultSchema,
  versions: z.object({
    memoryVersion: z.number(),
    activeContextVersion: z.number().nullable(),
    planVersion: z.number().nullable(),
  }),
});

export interface GutoTurnFlowDependencies {
  ai: Genkit;
  repository: OfficialStateRepository;
  operational: OperationalStateStore;
  relationshipMemory: RelationshipMemoryStore;
  contextBuilder: GutoContextBuilderV3;
  decisionModel: DecisionModel;
  policyGate?: PolicyGateV3;
  executor?: DeterministicExecutorV3;
}

function finalSpeech(action: string, modelSpeech: string, clarification: string | undefined, executorMessage: string, confirmed: boolean): string {
  if (action === "askClarification") return clarification || modelSpeech;
  if ((action === "swapExercise" || action === "swapFood") && confirmed) return executorMessage;
  if ((action === "swapExercise" || action === "swapFood") && !confirmed) return `Não alterei nada. ${executorMessage}`;
  return modelSpeech;
}

export function createGutoTurnFlow(deps: GutoTurnFlowDependencies) {
  const policyGate = deps.policyGate || new PolicyGateV3();
  const executor = deps.executor || new DeterministicExecutorV3(deps.repository, deps.operational);

  return deps.ai.defineFlow(
    {
      name: "gutoTurnFlow",
      inputSchema: InternalFlowInputSchema,
      outputSchema: V3TurnResponseSchema,
    },
    async (input): Promise<V3TurnResponse> => withV3Trace({
      requestId: input.requestId,
      externalSubject: input.externalSubject,
      attributes: { "guto.input_category": "user_turn" },
    }, async () => {
      const actor = await deps.ai.run("AUTH", () => withV3Span("AUTH", {}, async () => {
        const resolved = await deps.repository.resolveActor(input.externalSubject, input.role);
        if (!resolved) throw new V3Error("V3_IDENTITY_NOT_MIGRATED", "Identidade ainda não migrada para o Cérebro V3.", 409);
        return resolved;
      }));

      const idempotency = await deps.ai.run("REDIS_IDEMPOTENCY", () => withV3Span("REDIS_UPDATE", { "guto.operation": "idempotency_begin" }, () =>
        deps.operational.beginRequest(actor, input.requestId)));
      if (idempotency.state === "completed" && idempotency.response) return idempotency.response;
      if (idempotency.state === "pending") throw new V3Error("V3_REQUEST_IN_PROGRESS", "Esta solicitação já está em processamento.", 409);
      const requestToken = idempotency.requestToken;
      if (!requestToken) throw new V3Error("V3_IDEMPOTENCY_TOKEN_MISSING", "Token de idempotência ausente.", 503);

      try {
        return await deps.operational.withLock(actor, "turn", async () => {
        const { envelope, snapshot } = await deps.ai.run("CONTEXT_BUILD", () =>
          deps.contextBuilder.build(actor, input.requestId, input.message));
        const decision = await deps.ai.run("GEMINI_CALL", () => deps.decisionModel.decide(envelope));
        const gate = await deps.ai.run("POLICY_GATE", () => withV3Span("POLICY_GATE", {
          "guto.action": decision.action,
        }, async () => policyGate.authorize(decision, envelope, snapshot)));

        const execution = gate.authorized
          ? await deps.ai.run("EXECUTOR", () => withV3Span("EXECUTOR", { "guto.action": gate.decision.action }, () =>
              executor.execute(gate.decision, envelope, snapshot)))
          : { status: "rejected" as const, code: gate.code, message: "A política determinística bloqueou a mutação." };

        await withV3Span("POSTGRES_TRANSACTION", { "guto.operation": "record_turn" }, () => deps.repository.recordTurn({
          actor,
          requestId: input.requestId,
          action: gate.decision.action,
          resultCode: execution.code,
        }));

        const response: V3TurnResponse = {
          speech: finalSpeech(
            gate.decision.action,
            gate.decision.speech,
            gate.decision.clarificationQuestion,
            execution.message,
            execution.status === "confirmed",
          ),
          action: gate.decision.action,
          requestId: input.requestId,
          traceId: currentTraceId(),
          brainVersion: BrainVersion,
          execution,
          versions: {
            memoryVersion: snapshot.memoryVersion,
            activeContextVersion: execution.activeContextVersion ?? envelope.activeContext?.version ?? null,
            planVersion: execution.planVersion ?? envelope.activeContext?.planVersion ?? null,
          },
        };

        await withV3Span("REDIS_UPDATE", { "guto.operation": "idempotency_complete" }, () =>
          deps.operational.completeRequest(actor, input.requestId, requestToken, response));

        if (gate.decision.factsToPropose?.length) {
          await withV3Span("MEM0_WRITE", { "guto.fact_count": gate.decision.factsToPropose.length }, async () => {
            try {
              await deps.relationshipMemory.submit(actor, gate.decision.factsToPropose || [], input.requestId);
            } catch {
              // Official transaction remains valid. Mem0 is relationship-only and never owns truth.
            }
          });
        }

        await withV3Span("RESPONSE", { "guto.result": execution.code }, async () => undefined);
        return response;
        });
      } catch (error) {
        await deps.operational.abortRequest(actor, input.requestId, requestToken).catch(() => undefined);
        throw error;
      }
    }),
  );
}

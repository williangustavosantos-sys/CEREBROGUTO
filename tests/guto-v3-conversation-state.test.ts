import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { applyConversationDecision, assertClarificationIsMaterial, emptyConversationDecisionState } from "../src/v3/conversation-state.js";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";
import { V3Error } from "../src/v3/errors.js";
import type { ActorContext } from "../src/v3/types.js";

const actorA: ActorContext = {
  tenantId: "10000000-0000-4000-8000-000000000101",
  userId: "20000000-0000-4000-8000-000000000101",
  externalSubject: "conversation-user-a",
  role: "student",
};

const actorB: ActorContext = {
  tenantId: "10000000-0000-4000-8000-000000000102",
  userId: "20000000-0000-4000-8000-000000000102",
  externalSubject: "conversation-user-b",
  role: "student",
};

test("a declared physical limitation stays operational and allows an action without clinical clarification", () => {
  const next = applyConversationDecision(emptyConversationDecisionState(), {
    proposedAction: "generateWorkout",
    requiresMoreInformation: false,
    proposal: {
      topic: "workout_generation",
      resolvedFacts: [{
        key: "physical_constraint",
        value: { kind: "limitation", area: "lower_back", description: "limitation reported by the user" },
        certainty: "FACT_CONFIRMED",
        source: "user_declared",
      }],
    },
    resultCode: "WORKOUT_GENERATED",
    interactionId: "interaction-generic-limitation",
  });

  assert.equal(next.decisionSufficiency, "ACTION_SUFFICIENT");
  assert.equal(next.status, "READY_TO_EXECUTE");
  assert.equal(next.uncertaintyType, "none");
  assert.equal(next.previousInteractionId, "interaction-generic-limitation");
  assert.deepEqual(next.knownFacts[0]?.value, {
    kind: "limitation",
    area: "lower_back",
    description: "limitation reported by the user",
  });
});

test("a clarification is rejected when its slot was already resolved", () => {
  const state = applyConversationDecision(emptyConversationDecisionState(), {
    proposedAction: "acknowledge",
    requiresMoreInformation: false,
    proposal: {
      resolvedFacts: [{ key: "available_equipment", value: ["dumbbells"], certainty: "FACT_CONFIRMED" }],
    },
    resultCode: "ACKNOWLEDGED",
  });

  assert.throws(() => assertClarificationIsMaterial(state, {
    required: true,
    reason: "Need equipment information",
    expectedDecisionImpact: "Changes the allowed exercise candidates",
    missingInformation: [{
      key: "available_equipment",
      reason: "Need equipment information",
      expectedDecisionImpact: "Changes the allowed exercise candidates",
    }],
  }), (error: unknown) => error instanceof V3Error && error.code === "V3_CLARIFICATION_ALREADY_RESOLVED");
});

test("conversation decision state and interaction continuity are isolated by tenant and user", async () => {
  const repository = new InMemoryOfficialStateRepository();
  const stateA = applyConversationDecision(emptyConversationDecisionState("main"), {
    proposedAction: "generateDiet",
    requiresMoreInformation: false,
    proposal: {
      topic: "diet_generation",
      resolvedFacts: [{ key: "food_preference", value: "vegetarian", certainty: "FACT_CONFIRMED", source: "user_declared" }],
    },
    resultCode: "DIET_GENERATED",
    interactionId: "interaction-user-a",
  });

  await repository.recordConversationDecision({
    actor: actorA,
    requestId: "30000000-0000-4000-8000-000000000101",
    state: stateA,
    interactionId: "interaction-user-a",
    decisionId: "30000000-0000-4000-8000-000000000101",
    resolvedFacts: stateA.knownFacts,
  });

  const [loadedA, loadedB] = await Promise.all([
    repository.loadConversationDecisionState(actorA, "main"),
    repository.loadConversationDecisionState(actorB, "main"),
  ]);

  assert.equal(loadedA.previousInteractionId, "interaction-user-a");
  assert.equal(loadedA.knownFacts[0]?.key, "food_preference");
  assert.equal(loadedB.previousInteractionId, null);
  assert.deepEqual(loadedB.knownFacts, []);
});

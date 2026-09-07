import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { GenkitGeminiDecisionModel } from "../src/v3/ai.js";

test("P1-01 MEMORY_CHAT: curated ACTIVE memory reaches the exact model prompt as UNTRUSTED USER DATA", async () => {
  let capturedPrompt = "";
  let capturedSystem = "";
  const fakeAi = {
    async generate(input: { prompt: string; system: string }) {
      capturedPrompt = input.prompt;
      capturedSystem = input.system;
      return {
        output: { speech: "Ok.", action: "acknowledge", reasonCode: "test_memory_consumption" },
        usage: {},
      };
    },
  };
  const model = new GenkitGeminiDecisionModel(fakeAi as never, "test-model");
  await model.decide({
    brainVersion: "guto-cerebro-v3",
    requestId: randomUUID(),
    actor: { tenantId: randomUUID(), userId: randomUUID(), role: "student" },
    message: "Que cardio você colocaria?",
    official: {
      profile: { version: 1, language: "pt-BR", biologicalSex: "male", age: 30, weightKg: 80, heightCm: 180, trainingStatus: "active", trainingLocation: "gym" },      goal: { version: 1, code: "hypertrophy" },
      preferences: { version: 1 },
      healthConstraints: [],
      confirmedContext: { id: randomUUID(), version: 1, confirmedAt: new Date().toISOString(), foodDeclaration: "", limitationDeclaration: "" },
    },
    activeContext: null,
    conversation: { version: 1, status: "IN_PROGRESS", knownFacts: [], unresolvedFacts: [], previousInteractionId: null },
    relationshipMemories: [],
    relevantMemories: [{
      id: randomUUID(), category: "TRAINING_PREFERENCES", key: "cardio_preference",
      value: { preferred: "bike", avoided: "treadmill" }, status: "ACTIVE", sourceType: "conversation", updatedAt: new Date().toISOString(),
    }],
    candidates: [],
  } as never);

  assert.match(capturedPrompt, /UNTRUSTED CURATED USER MEMORY/i, "curated memory must be explicitly labeled untrusted in model input");
  assert.match(capturedPrompt, /cardio_preference/);
  assert.match(capturedPrompt, /bike/);
  assert.doesNotMatch(capturedSystem, /cardio_preference|bike/i, "user memory must never be promoted into system instruction");
});
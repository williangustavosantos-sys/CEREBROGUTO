import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { addContextItem } from "../src/presence/context-bank";
import {
  buildValidationBrief,
  getPendingValidations,
  getValidationQueueForDebug,
  markValidationAsked,
  resolveValidation,
  syncValidationQueue,
} from "../src/presence/validation-engine";
import { writeMemoryStoreAsync } from "../src/memory-store";

const USER_ID = "validation-test-user";

afterEach(async () => {
  await writeMemoryStoreAsync({});
});

describe("presence validation engine", () => {
  it("cria validação para health_signal sem permitir uso direto", async () => {
    const context = await addContextItem(USER_ID, {
      type: "health_signal",
      value: "dor no joelho direito",
      state: "needs_validation",
      confidence: 0.92,
      source: "extractor",
      rawPhrase: "meu joelho direito tá doendo",
      meta: {
        originalType: "health_limitation",
        language: "pt",
        dateText: null,
        bodyPart: "joelho direito",
        needsUserValidation: true,
        extractor: "gemini",
      },
    });

    const result = await syncValidationQueue(USER_ID);
    assert.equal(result.created, 1);

    const pending = await getPendingValidations(USER_ID);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].contextItemId, context.id);
    assert.equal(pending[0].reason, "health_safety_check");
    assert.equal(pending[0].priority, 100);
  });

  it("cria brief que proíbe linguagem de sistema e conselho médico", async () => {
    await addContextItem(USER_ID, {
      type: "preference_signal",
      value: "borão",
      state: "blocked_unknown",
      confidence: 0.45,
      source: "extractor",
      rawPhrase: "não gosto de borão",
      meta: {
        originalType: "preference_block",
        language: "pt",
        dateText: null,
        bodyPart: null,
        needsUserValidation: true,
        extractor: "gemini",
      },
    });

    const [pending] = await getPendingValidations(USER_ID);
    const brief = buildValidationBrief(pending);

    assert.equal(brief.objective, "clarify_unknown_term");
    assert.equal(brief.style.mode, "clarify");
    assert.equal(brief.style.allowMedicalAdvice, false);
    assert.ok(brief.facts.mustAvoid.includes("adicionar patologia"));
    assert.ok(brief.facts.mustAvoid.includes("sistema"));
  });

  it("não duplica item já pendente na fila", async () => {
    await addContextItem(USER_ID, {
      type: "future_event",
      value: "reunião quarta-feira",
      state: "needs_validation",
      confidence: 0.8,
      source: "extractor",
      rawPhrase: "quarta tenho reunião",
      meta: {
        originalType: "future_event",
        language: "pt",
        dateText: "quarta",
        bodyPart: null,
        needsUserValidation: true,
        extractor: "gemini",
      },
    });

    const first = await syncValidationQueue(USER_ID);
    const second = await syncValidationQueue(USER_ID);

    assert.equal(first.created, 1);
    assert.equal(second.created, 0);

    const queue = await getValidationQueueForDebug(USER_ID);
    assert.equal(queue.length, 1);
  });

  it("marca validação como asked e depois resolve ativando o contexto", async () => {
    const context = await addContextItem(USER_ID, {
      type: "preference_signal",
      value: "burpee",
      state: "needs_validation",
      confidence: 0.72,
      source: "extractor",
      rawPhrase: "não gosto de burpee",
      meta: {
        originalType: "preference_block",
        language: "pt",
        dateText: null,
        bodyPart: null,
        needsUserValidation: true,
        extractor: "gemini",
      },
    });

    const [pending] = await getPendingValidations(USER_ID);
    const asked = await markValidationAsked(USER_ID, pending.id);
    assert.equal(asked?.status, "asked");
    assert.equal(asked?.attempts, 1);

    const resolved = await resolveValidation(USER_ID, pending.id, "confirmed");
    assert.equal(resolved?.status, "resolved");

    const queue = await getValidationQueueForDebug(USER_ID);
    assert.equal(queue[0].status, "resolved");
    assert.equal(queue[0].contextItemId, context.id);
  });

  it("clarificação troca valor confuso e resolve a fila", async () => {
    await addContextItem(USER_ID, {
      type: "preference_signal",
      value: "borão",
      state: "blocked_unknown",
      confidence: 0.4,
      source: "extractor",
      rawPhrase: "não tenho borão em casa",
      meta: {
        originalType: "preference_block",
        language: "pt",
        dateText: null,
        bodyPart: null,
        needsUserValidation: true,
        extractor: "gemini",
      },
    });

    const [pending] = await getPendingValidations(USER_ID);
    const resolved = await resolveValidation(USER_ID, pending.id, "clarified", "feijão");

    assert.equal(resolved?.status, "resolved");
    assert.equal(resolved?.meta?.clarifiedValue, "feijão");
  });
});

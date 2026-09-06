import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionFacts,
  buildSessionPresence,
  classifyCauseExplanation,
  computeFeedbackTrend,
  decideSessionOutcome,
  humanFallbackLine,
  type SessionFeedbackRecord,
} from "../src/v3/beta1-presence.js";

function record(overallDifficulty: SessionFeedbackRecord["overallDifficulty"], daysAgo = 0, pain = false): SessionFeedbackRecord {
  const created = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return { workoutSessionId: `s-${daysAgo}-${Math.random().toString(36).slice(2, 8)}`, overallDifficulty, pain, causeExplanation: null, causeCategory: null, createdAt: created };
}

test("PRESENCE 1+2: sessionFacts derivam da execução; pergunta referencia fato real sem inventar", () => {
  const facts = buildSessionFacts([
    { exerciseId: "supino", difficultyLabel: "BOA", pain: false, completed: true, setRows: [
      { setNumber: 1, loadKg: 40, reps: 12, techniqueType: "STRAIGHT_SET" },
      { setNumber: 2, loadKg: 42.5, reps: 10, techniqueType: "STRAIGHT_SET" },
    ] },
    { exerciseId: "remada", difficultyLabel: "BOA", pain: false, completed: true, setRows: [
      { setNumber: 1, loadKg: 50, reps: 10, techniqueType: "STRAIGHT_SET" },
      { setNumber: 2, loadKg: 50, reps: 10, techniqueType: "STRAIGHT_SET" },
    ] },
  ]);
  assert.equal(facts.completedExercises, 2);
  assert.equal(facts.loadIncreases, 1);

  const presence = buildSessionPresence({ facts, history: [] });
  assert.equal(presence.outcome, "MAINTAIN");
  // The question must reference the OBSERVED load increase, not invent.
  assert.ok(presence.contextualQuestion!.includes("carga"));
  assert.ok(!/você terminou\?|fez todos/iu.test(presence.contextualQuestion!));
});

test("PRESENCE 3: feedback por sessão entra no histórico e define trend IMPROVING", () => {
  const history = [record("PESADA", 7), record("BOA", 3), record("FACIL", 0)];
  assert.equal(computeFeedbackTrend(history), "IMPROVING");
  assert.equal(computeFeedbackTrend([record("BOA", 0)]), "INSUFFICIENT_DATA");
});

test("PRESENCE 4: três PESADAS consecutivas → INVESTIGATE, nunca REGRESS automático", () => {
  const history = [record("PESADA", 14), record("PESADA", 7), record("PESADA", 0)];
  const outcome = decideSessionOutcome({ todayFeedback: { overallDifficulty: "PESADA", pain: false }, history: history.slice(0, 2) });
  assert.equal(outcome.decision.decision, "INVESTIGATE");
  assert.ok(outcome.contextualQuestion!.includes("treino") || outcome.contextualQuestion!.includes("cansado"));
  // No regression is prescribed at presence level.
  assert.ok(!JSON.stringify(outcome).includes("REGRESS"));

  const presence = buildSessionPresence({ facts: buildSessionFacts([]), history });
  assert.equal(presence.outcome, "INVESTIGATE");
  assert.equal(computeFeedbackTrend(history), "NEEDS_INVESTIGATION");
});

test("PRESENCE 5: causa no usuário (dormindo mal) → MAINTAIN, não vira preferência permanente", () => {
  const outcome = decideSessionOutcome({
    todayFeedback: { overallDifficulty: "PESADA", pain: false },
    history: [record("PESADA", 7)],
    cause: { category: "user_state", explanation: "Estou dormindo mal." },
  });
  assert.equal(outcome.decision.decision, "MAINTAIN");
  assert.equal(outcome.contextualQuestion, null);
  assert.ok(outcome.knownFactsEcho.some((line) => line.includes("dormindo mal")));
});

test("PRESENCE 6: causa no treino → ADAPT", () => {
  const outcome = decideSessionOutcome({
    todayFeedback: { overallDifficulty: "PESADA", pain: false },
    history: [record("PESADA", 7)],
    cause: { category: "training", explanation: "O treino que está pesado demais." },
  });
  assert.equal(outcome.decision.decision, "ADAPT");
});

test("PRESENCE 7: histórico fácil/boa + boa execução → PROGRESS sem pergunta de permissão", () => {
  const history = [record("FACIL", 7), record("BOA", 3)];
  const presence = buildSessionPresence({ facts: buildSessionFacts([]), history });
  assert.equal(presence.outcome, "PROGRESS");
  assert.notEqual(presence.contextualQuestion, null); // still asks the one unknown: today's feeling
  assert.ok(!/posso|permiss|devo aumentar/iu.test(presence.contextualQuestion!));
});

test("PRESENCE 8: dor → SAFETY e pergunta apenas o que falta (local/momento)", () => {
  const outcome = decideSessionOutcome({ todayFeedback: { overallDifficulty: "DOR", pain: true }, history: [] });
  assert.equal(outcome.decision.decision, "SAFETY");
  assert.ok(outcome.contextualQuestion!.includes("exercício"));

  const facts = buildSessionFacts([{ exerciseId: "agachamento", difficultyLabel: "DOR", pain: true, completed: true, setRows: [] }]);
  const presence = buildSessionPresence({ facts, history: [] });
  assert.equal(presence.outcome, "SAFETY");
});

test("PRESENCE 9: fallback humano para não-entendimento (contrato, não string exata)", () => {
  for (const line of [humanFallbackLine("req-1"), humanFallbackLine("req-2")]) {
    assert.ok(line.length > 10 && line.length < 200);
    assert.ok(!/invalid|error|falha interna|unexpected|exception/iu.test(line));
    assert.ok(/de novo|outro jeito|repetir/iu.test(line)); // invites retry/clarification
    assert.ok(!/ja (ger|cri|atualiz)/iu.test(line)); // never claims an action
  }
  assert.equal(humanFallbackLine("same-id"), humanFallbackLine("same-id")); // stable per requestId
});

test("B12: erro técnico fica em code/details; mensagem ao usuário é humana", () => {
  const line = humanFallbackLine("11111111-2222-4333-8444-555555555555");
  assert.ok(!line.includes("V3_"));
  assert.ok(!/\bstack\b|traceback/iu.test(line));
});

test("classificador de causa é determinístico por keywords; desconhecido fica null", () => {
  assert.equal(classifyCauseExplanation("Estou dormindo mal essa semana"), "user_state");
  assert.equal(classifyCauseExplanation("O treino que está pesado demais"), "training");
  assert.equal(classifyCauseExplanation("Não sei dizer"), null);
  assert.equal(classifyCauseExplanation("aumentei a carga e senti"), "training");
});

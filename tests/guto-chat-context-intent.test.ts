import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyShortContextIntent,
  detectActiveChatContext,
  stripInjectedContext,
  hasExplicitBodyRegion,
} from "../src/chat-context-intent";

// Fase 3L — mensagem curta interpretada pelo CONTEXTO ATIVO. Reproduz o formato
// que o app injeta: bloco de contexto + "User message:" (exercício) /
// "User question:" (dieta). O bloco de dieta/treino CITA a patologia do usuário
// ("Limitations/pathology: ombro..."), que NÃO pode ser lida como a fala atual.

function dietContext(userText: string, pathology = "ombro direito chato em empurrar"): string {
  return [
    "[DIET CONTEXT — language: pt-BR — nutrition only]",
    'Food in question: "Azeite de oliva" (1 colher, 90 kcal).',
    'Meal: "Almoço" (13:00). Full meal: Frango, Arroz, Azeite de oliva.',
    "Goal: muscle_gain.",
    "Food restrictions: none.",
    `Limitations/pathology: ${pathology}.`,
    `User question: ${userText}`,
  ].join(" ");
}

function exerciseContext(userText: string, pathology = "ombro"): string {
  return [
    "[WORKOUT EXERCISE CONTEXT — language: pt-BR]",
    'Exercise: "Bike" (canonical PT: Aquecimento bike). Muscle group: aquecimento.',
    "Prescription: 1 sets × 5min reps, rest 0s.",
    `Limitations/pathology: ${pathology}.`,
    `User message: ${userText}`,
  ].join(" ");
}

describe("stripInjectedContext / detectActiveChatContext", () => {
  it("remove o bloco injetado e devolve só a fala do usuário (dieta)", () => {
    const stripped = stripInjectedContext(dietContext("não tenho"));
    assert.equal(stripped, "não tenho");
    assert.equal(hasExplicitBodyRegion(stripped), false, "ombro do bloco NÃO conta como fala");
  });

  it("remove o bloco injetado (exercício)", () => {
    assert.equal(stripInjectedContext(exerciseContext("não tenho")), "não tenho");
  });

  it("detecta o contexto ativo", () => {
    assert.equal(detectActiveChatContext(dietContext("oi")), "food");
    assert.equal(detectActiveChatContext(exerciseContext("oi")), "exercise");
    assert.equal(detectActiveChatContext("oi"), "none");
  });
});

describe("classifyShortContextIntent — regra determinística por contexto", () => {
  it('"não tenho" em contexto de ALIMENTO → food_unavailable (NUNCA patologia)', () => {
    const r = classifyShortContextIntent({ rawInput: dietContext("não tenho") });
    assert.equal(r.intent, "food_unavailable");
    assert.notEqual(r.intent, "pathology");
  });

  it('"azeite acabou" em contexto de alimento → food_unavailable', () => {
    const r = classifyShortContextIntent({ rawInput: dietContext("o azeite acabou") });
    assert.equal(r.intent, "food_unavailable");
  });

  it('"non ce l\'ho" (it) em contexto de alimento → food_unavailable', () => {
    const r = classifyShortContextIntent({ rawInput: dietContext("non ce l'ho") });
    assert.equal(r.intent, "food_unavailable");
  });

  it('"não tenho" em contexto de EXERCÍCIO → equipment_unavailable (NUNCA patologia)', () => {
    const r = classifyShortContextIntent({ rawInput: exerciseContext("não tenho") });
    assert.equal(r.intent, "equipment_unavailable");
    assert.notEqual(r.intent, "pathology");
  });

  it('"bike ocupada" em contexto de exercício → equipment_unavailable', () => {
    const r = classifyShortContextIntent({ rawInput: exerciseContext("bike ocupada") });
    assert.equal(r.intent, "equipment_unavailable");
  });

  it('"não tenho" SEM contexto → needs_clarification (pede esclarecimento)', () => {
    const r = classifyShortContextIntent({ rawInput: "não tenho" });
    assert.equal(r.intent, "needs_clarification");
  });

  it('"dor no ombro" SEM contexto → pathology (região explícita na fala)', () => {
    const r = classifyShortContextIntent({ rawInput: "tenho dor no ombro" });
    assert.equal(r.intent, "pathology");
  });

  it("região corporal explícita NA FALA vence o contexto (usuário relata dor real)", () => {
    const r = classifyShortContextIntent({ rawInput: dietContext("na verdade meu joelho dói") });
    assert.equal(r.intent, "pathology");
  });

  it("mensagem normal em contexto de alimento não é forçada a nada", () => {
    const r = classifyShortContextIntent({ rawInput: dietContext("quantas calorias tem?") });
    assert.equal(r.intent, "none");
  });
});

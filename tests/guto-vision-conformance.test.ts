import "./test-env.js";
// Sem Gemini: exercita o piso determinístico (classificador + gerador de treino),
// que é exatamente o caminho que o usuário pega quando o modelo cai/estoura quota.
process.env.GEMINI_API_KEY = "";
process.env.GUTO_GEMINI_MODEL = process.env.GUTO_GEMINI_MODEL || "gemini-3.1-flash-lite";
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyContractIntentFallback,
  classifyProactiveContinuitySignal,
  buildWorkoutPlanFromSemanticFocus,
} from "../server.js";

type FallbackInput = Parameters<typeof classifyContractIntentFallback>[0];
const mem = {} as unknown as FallbackInput["memory"];
const classify = (rawInput: string) =>
  classifyContractIntentFallback({ rawInput, memory: mem, previousExpectedResponse: null });

// ── Visão: o objetivo molda a missão (GUTO_CALIBRAGEM §6 / GUTO_SISTEMA_DE_TREINO).
// "Força total" só pode rotular treino de FORÇA. fat_loss/condicionamento/saúde
// recebem rótulo neutro de corpo inteiro — o título nunca afirma força sem ser força.
describe("Visão: título de corpo inteiro respeita o objetivo (não vira 'Força total' pra fat_loss)", () => {
  const fullBody = (goal: string, language = "pt-BR") =>
    buildWorkoutPlanFromSemanticFocus({
      language, location: "gym", status: "beginner", limitation: "ombro", age: 24,
      focus: "full_body", trainingGoal: goal,
    }).focus;

  it("fat_loss NÃO recebe 'Força total' (recebe rótulo neutro)", () => {
    assert.equal(fullBody("fat_loss"), "Corpo inteiro");
    assert.equal(fullBody("fat_loss", "en-US"), "Full body");
    assert.equal(fullBody("fat_loss", "it-IT"), "Corpo intero");
  });

  it("conditioning / mobility_health / consistency também são neutros", () => {
    assert.equal(fullBody("conditioning"), "Corpo inteiro");
    assert.equal(fullBody("mobility_health"), "Corpo inteiro");
    assert.equal(fullBody("consistency"), "Corpo inteiro");
  });

  it("muscle_gain mantém 'Força total' (rótulo de força é correto pra objetivo de força)", () => {
    assert.equal(fullBody("muscle_gain"), "Força total");
    assert.equal(fullBody("muscle_gain", "en-US"), "Full-body strength");
    assert.equal(fullBody("muscle_gain", "it-IT"), "Forza totale");
  });

  it("objetivo ausente é neutro (nunca afirma força sem certeza)", () => {
    assert.equal(
      buildWorkoutPlanFromSemanticFocus({
        language: "pt-BR", location: "gym", status: "beginner", limitation: "ombro", age: 24, focus: "full_body",
      }).focus,
      "Corpo inteiro",
    );
  });
});

// ── Visão: falta de tempo é CONTINUIDADE, não recusa (GUTO_PROATIVIDADE_E_CICLO_SEMANAL:
// pouco tempo → ajusta a missão; nunca cobra nem cancela). Antes "sem tempo" caía em
// resistance_common → escada de cobrança/caminhada.
describe("Visão: falta de tempo é continuidade (proactive_context), nunca recusa", () => {
  for (const msg of [
    "tô sem tempo",
    "não vou ter tempo hoje",
    "não tenho tempo",
    "tá com o tempo curto hoje",
    "falta de tempo essa semana",
    "só tenho 10 minutos",
    "semana corrida",
  ]) {
    it(`proactive_context: "${msg}"`, () => {
      assert.equal(classify(msg).kind, "proactive_context");
    });
  }

  it("falta de tempo NÃO é resistance_common (não dispara a escada de cobrança)", () => {
    assert.notEqual(classify("tô sem tempo").kind, "resistance_common");
    assert.notEqual(classify("não vou ter tempo").kind, "resistance_common");
  });

  it("sinal de continuidade de falta de tempo é janela curta (short_window)", () => {
    assert.equal(classifyProactiveContinuitySignal("tô sem tempo"), "short_window");
    assert.equal(classifyProactiveContinuitySignal("não vou ter tempo hoje"), "short_window");
    assert.equal(classifyProactiveContinuitySignal("falta de tempo"), "short_window");
  });

  it("recusa real continua recusa (não é varrida pela continuidade)", () => {
    // Sem menção a tempo, segue como resistência/none — não vira proactive_context.
    assert.notEqual(classify("não quero treinar").kind, "proactive_context");
    assert.notEqual(classify("tô enrolando").kind, "proactive_context");
    assert.equal(classify("tô enrolando").kind, "resistance_common");
  });
});

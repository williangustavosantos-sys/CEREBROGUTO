import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyContractIntentFallback } from "../server.js";

// Regressão B-? (proatividade): compartilhar viagem/compromisso/mudança de
// horário é CONTEXTO de proatividade, NUNCA recusa (postpone/resistance). Sem
// isso, o GUTO cobrava treino em vez de acolher e confirmar a viagem.
// Cobre o piso determinístico (fallback); a classificação semântica fina roda
// no modelo (verificada ao vivo).

type FallbackInput = Parameters<typeof classifyContractIntentFallback>[0];
const mem = {} as unknown as FallbackInput["memory"];
const classify = (rawInput: string) =>
  classifyContractIntentFallback({ rawInput, memory: mem, previousExpectedResponse: null });

describe("Proactive context — viagem/compromisso ≠ recusa (fallback determinístico)", () => {
  for (const msg of [
    "viajo na quarta",
    "vou viajar sexta",
    "sexta tenho um compromisso o dia todo",
    "tenho um casamento sábado",
    "tenho reunião amanhã cedo",
  ]) {
    it(`proactive_context: "${msg}"`, () => {
      assert.equal(classify(msg).kind, "proactive_context");
    });
  }

  // Recusa real / pergunta operacional NÃO pode ser classificada como proactive_context.
  for (const msg of ["não vou treinar hoje", "qual o treino de hoje?", "tô cansado demais"]) {
    it(`não é proactive_context: "${msg}"`, () => {
      assert.notEqual(classify(msg).kind, "proactive_context");
    });
  }
});

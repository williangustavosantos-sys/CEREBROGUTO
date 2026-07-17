import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSovereignBrainPrompt } from "../src/brain/sovereign-prompt.js";

function worldState(systemTrigger?: Record<string, unknown>) {
  return {
    userId: "prompt-user",
    language: "pt-BR",
    memory: {},
    dailyContext: { raw: null },
    contextSignals: systemTrigger ? { systemTrigger } : {},
  } as any;
}

describe("prompt soberano — proveniência do turno vazio", () => {
  it("não chama mensagem vazia do usuário de turno do sistema", () => {
    const prompt = buildSovereignBrainPrompt({ worldState: worldState(), input: "" });
    const message = prompt.split("MENSAGEM DO USUÁRIO:").pop() || "";
    assert.match(message, /mensagem vazia do usuário/i);
    assert.doesNotMatch(message, /turno iniciado pelo sistema/i);
  });

  it("rotula como sistema somente quando existe systemTrigger tipado", () => {
    const prompt = buildSovereignBrainPrompt({
      worldState: worldState({ source: "proactive_scheduler", slot: "arrival" }),
      input: "",
    });
    const message = prompt.split("MENSAGEM DO USUÁRIO:").pop() || "";
    assert.match(message, /turno iniciado pelo sistema/i);
  });
});

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

describe("prompt soberano — foco no assunto atual", () => {
  it("ordena que a mensagem atual domine sem abrir agenda ou outro domínio", () => {
    const prompt = buildSovereignBrainPrompt({
      worldState: worldState(),
      input: "não consumo lactose",
    });

    assert.match(prompt, /A mensagem atual manda no turno/i);
    assert.match(prompt, /resolva o assunto que o usuário trouxe AGORA e encerre/i);
    assert.match(prompt, /contexto de outros domínios informa a decisão, mas não vira um novo assunto na fala/i);
    assert.match(prompt, /pendência proativa que exija resposta agora/i);
    assert.match(prompt, /Pedido explícito e executável já é autorização/i);
    assert.match(prompt, /não prometa executar com acao:"none"/i);
    assert.match(prompt, /O GUTO comanda o treino como personal/i);
    assert.match(prompt, /não escolhe grupo muscular nem substitui a missão prescrita por preferência/i);
    assert.match(prompt, /Não gostar, não curtir ou preferir outro exercício NÃO autoriza troca/i);
    assert.match(prompt, /Pedido vago de troca sem motivo usa acao:"none"/i);
  });
});

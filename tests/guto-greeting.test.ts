import "./test-env.js";
process.env.GUTO_DISABLE_LISTEN = "1";
process.env.GEMINI_API_KEY = "";
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

let looksLikeGreeting: (raw: string) => boolean;

before(async () => {
  looksLikeGreeting = ((await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as any).looksLikeGreeting;
});

describe("looksLikeGreeting — saudação não é nonsense", () => {
  it("reconhece saudações puras (pt/en/it)", () => {
    for (const g of [
      "oi", "Oi!", "olá", "ola guto", "bom dia", "Boa noite", "oi tudo bem",
      "e aí guto", "opa", "hey", "hello guto", "ciao", "buongiorno", "good morning",
    ]) {
      assert.equal(looksLikeGreeting(g), true, `deveria ser saudação: "${g}"`);
    }
  });

  it("NÃO trata mensagem com conteúdo real como saudação", () => {
    for (const m of [
      "oi não vou treinar",
      "ola, quero mudar meu treino",
      "bom dia, tô com dor no joelho",
      "não vou",
      "treino de hoje",
      "minha mãe faleceu",
      "tô com preguiça",
    ]) {
      assert.equal(looksLikeGreeting(m), false, `NÃO deveria ser saudação: "${m}"`);
    }
  });
});

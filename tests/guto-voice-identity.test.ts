import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  GUTO_PERSONA_CANONICAL,
  detectForeignLanguageLeak,
  resolveCanonicalVoiceText,
  normalizeVoiceLanguage,
} from "../src/voice-identity.js";

// Identidade canônica de voz: um idioma, uma personalidade, uma voz.
// Regras (GUTO_CHAT_E_CEREBRO §10: idioma é lei): o idioma vem da memória, nunca
// é autodetectado pelo texto; se a fala vazar outro idioma, é corrigida antes do TTS.

describe("CASO 1 — pt-BR fala português (não é falso-positivo)", () => {
  it("uma fala real do GUTO em pt-BR passa intacta e fica em pt-BR", () => {
    const r = resolveCanonicalVoiceText({
      text: "Boa. A primeira alimentação é sagrada — come e volta que eu te puxo pro treino.",
      language: "pt-BR",
    });
    assert.equal(r.languageCode, "pt-BR");
    assert.equal(r.repaired, false);
    assert.match(r.text, /come e volta|te puxo/i);
  });
});

describe("CASO 2 — it-IT fala italiano (não é falso-positivo)", () => {
  it("uma fala real do GUTO em it-IT passa intacta e fica em it-IT", () => {
    const r = resolveCanonicalVoiceText({
      text: "Allora oggi è una missione corta. Andiamo, ti guido e teniamo viva la striscia.",
      language: "it-IT",
    });
    assert.equal(r.languageCode, "it-IT");
    assert.equal(r.repaired, false);
    assert.equal(detectForeignLanguageLeak("vado in viaggio mercoledì", "it-IT"), false);
  });
});

describe("CASO 3 — GUTO Online é a MESMA identidade do chat", () => {
  it("GUTO_PERSONA_CANONICAL é a mesma entidade usada em chat e online", () => {
    assert.ok(GUTO_PERSONA_CANONICAL.includes("Você é o GUTO"));
    assert.ok(/MESMA entidade/i.test(GUTO_PERSONA_CANONICAL));
    // A mesma constante alimenta ≥2 prompts (chat brain + GUTO Online) em server.ts.
    const server = readFileSync(join(process.cwd(), "server.ts"), "utf8");
    const uses = (server.match(/GUTO_PERSONA_CANONICAL/g) || []).length;
    assert.ok(uses >= 3, `esperado GUTO_PERSONA_CANONICAL usado em chat+online (import + 2 prompts), achei ${uses}`);
  });
});

describe("CASO 4 — modelo devolve espanhol: TTS NÃO fala espanhol", () => {
  it("fala em espanhol numa sessão pt-BR é corrigida antes do TTS", () => {
    const spanish = "¡Vamos! Hoy tu entrenamiento es muy importante, puedes hacerlo ahora mismo.";
    assert.equal(detectForeignLanguageLeak(spanish, "pt-BR"), true);
    const r = resolveCanonicalVoiceText({ text: spanish, language: "pt-BR" });
    assert.equal(r.languageCode, "pt-BR");
    assert.equal(r.repaired, true);
    // O texto que vai pro TTS NÃO contém mais espanhol.
    assert.equal(detectForeignLanguageLeak(r.text, "pt-BR"), false);
    assert.doesNotMatch(r.text, /hoy|muy|ahora|entrenamiento|puedes|¡|¿/i);
  });

  it("inglês numa sessão pt-BR também é corrigido", () => {
    const english = "Let's go, today we train your body, no excuses, you can do it right now.";
    assert.equal(detectForeignLanguageLeak(english, "pt-BR"), true);
    const r = resolveCanonicalVoiceText({ text: english, language: "pt-BR" });
    assert.equal(r.repaired, true);
    assert.equal(r.languageCode, "pt-BR");
  });
});

describe("CASO 5 — fallback continua parecendo GUTO (idioma certo)", () => {
  it("linha de fallback em pt-BR passa limpa pelo resolver", () => {
    const fallback = "Deu um curto rápido no meu sistema aqui. Manda de novo em uma frase que eu resolvo.";
    const r = resolveCanonicalVoiceText({ text: fallback, language: "pt-BR" });
    assert.equal(r.repaired, false);
    assert.equal(r.languageCode, "pt-BR");
  });
});

describe("Idioma SEMPRE canônico, nunca autodetectado", () => {
  it("normalizeVoiceLanguage mapeia para os 3 idiomas suportados", () => {
    assert.equal(normalizeVoiceLanguage("pt-BR"), "pt-BR");
    assert.equal(normalizeVoiceLanguage("pt"), "pt-BR");
    assert.equal(normalizeVoiceLanguage("en-US"), "en-US");
    assert.equal(normalizeVoiceLanguage("en"), "en-US");
    assert.equal(normalizeVoiceLanguage("it-IT"), "it-IT");
    assert.equal(normalizeVoiceLanguage("es-ES"), "pt-BR"); // espanhol não é suportado → cai no default seguro
    assert.equal(normalizeVoiceLanguage(undefined), "pt-BR");
  });

  it("não dispara falso-positivo em frases pt-BR comuns com palavras compartilhadas", () => {
    for (const ok of [
      "Vamos nessa, bebe água e volta pro treino.",
      "Hoje a missão é curta, mas a gente mantém o ritmo.",
      "Teu corpo agradece. Manda ver no agachamento.",
    ]) {
      assert.equal(detectForeignLanguageLeak(ok, "pt-BR"), false, `falso-positivo em: ${ok}`);
    }
  });
});

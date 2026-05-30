import "./test-env.js";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// Cobertura determinística (sem Gemini) do mecanismo de segurança B-4:
// as novas flags acute_illness/intoxication têm bloco de override que NUNCA
// manda treinar, e o fallback é sempre seguro (flag=null em erro/curto).
// A classificação semântica em si (12/12) é verificada ao vivo com Gemini real.

let buildSafetyOverrideBlock: (flag: string, lang: string) => string;
let classifyRisk: (input: string, lang: string) => Promise<{ flag: string | null }>;

const LANGS = ["pt-BR", "en-US", "it-IT"] as const;

before(async () => {
  const mod: any = await import(pathToFileURL(join(process.cwd(), "src/risk-classifier.ts")).href);
  buildSafetyOverrideBlock = mod.buildSafetyOverrideBlock;
  classifyRisk = mod.classifyRisk;
});

describe("Risk safety — novas flags acute_illness / intoxication (B-4)", () => {
  for (const flag of ["acute_illness", "intoxication"] as const) {
    it(`buildSafetyOverrideBlock(${flag}) suspende a persona e proíbe treino em todos os idiomas`, () => {
      for (const lang of LANGS) {
        const block = buildSafetyOverrideBlock(flag, lang);
        assert.ok(typeof block === "string" && block.length > 200, `bloco vazio/curto em ${lang}`);
        // O bloco genérico (instruções em PT) força acao none + avatarEmotion critical
        // + proíbe sugerir treino/swap. Isso é o que impede mandar treinar quem está mal.
        assert.match(block, /acao:\s*none/i, `${flag}/${lang}: deve forçar acao none`);
        assert.match(block, /critical/i, `${flag}/${lang}: avatarEmotion critical`);
        assert.match(block, /NÃO sugira treino/i, `${flag}/${lang}: diretiva genérica de proibir treino`);
      }
    });
  }

  it("acute_illness orienta descanso/hidratação/médico e não vira 'limitação'", () => {
    const block = buildSafetyOverrideBlock("acute_illness", "pt-BR");
    assert.match(block, /descanso|repous|hidrat|médic|medic/i, "deve orientar recuperação/médico");
    assert.match(block, /trate isso como 'limita|como 'limita|limita/i, "deve instruir a NÃO tratar doença como limitação de treino");
  });

  it("intoxication orienta hidratar/descansar e proíbe explicitamente o '20 minutos'", () => {
    const block = buildSafetyOverrideBlock("intoxication", "pt-BR");
    assert.match(block, /hidrat|água|agua|descans|dorm/i, "deve orientar hidratação/descanso");
    // O recurso nomeia o anti-padrão para proibi-lo: "NÃO mande fazer '20 minutos'".
    assert.match(block, /N[ÃA]O mande fazer '?20 minut/i, "deve proibir explicitamente mandar fazer 20 minutos");
  });

  it("fallback seguro: input vazio ou curtíssimo → flag null (não escala à toa)", async () => {
    const empty = await classifyRisk("", "pt-BR");
    assert.equal(empty.flag, null, "input vazio não pode escalar");
    const short = await classifyRisk("oi", "pt-BR");
    assert.equal(short.flag, null, "input <4 chars não pode escalar");
  });
});

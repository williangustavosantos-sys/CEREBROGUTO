import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

describe("GUTO firme sem coerção emocional", () => {
  it("não contém as diretivas legadas de culpa, abandono ou dependência", () => {
    const prohibitedLegacyDirectives = [
      /use (?:o )?vínculo da dupla como alavanca psicológica/i,
      /guto perde força/i,
      /voc[eê] quebrou o pacto/i,
      /evoluem ou regridem juntos/i,
      /n[aã]o foi isso que prometemos/i,
      /ameace (?:o )?abandono/i,
    ];

    for (const directive of prohibitedLegacyDirectives) {
      assert.doesNotMatch(serverSource, directive);
    }
  });

  it("mantém a escada: direção, adaptação e respeito da decisão", () => {
    assert.match(serverSource, /ESTÁGIO 1 — primeira recusa do dia/);
    assert.match(serverSource, /Puxe para uma ação mínima segura/);
    assert.match(serverSource, /ESTÁGIO 2 — o usuário já recusou uma vez/);
    assert.match(serverSource, /MUDE A ROTA/);
    assert.match(serverSource, /O usuário já decidiu\. PARE de empurrar\. Respeite a decisão/);
    assert.match(serverSource, /Doença, Dor ou Lesão: Proteja/);
  });
});

import "./test-env.js";
// Força o caminho determinístico local (sem IA) — é o que roda em produção
// quando a quota/chave do resolver semântico está indisponível e é o que os
// real-user-scenarios exercitam (GEMINI_API_KEY vazio).
process.env.GEMINI_API_KEY = "";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveKnownPathologyLocally,
  resolveProfileFreeFields,
} from "../src/dirty-data-resolver.js";

const NOW = "2026-06-12T00:00:00.000Z";

describe("dirty-data-resolver — regressão real-user-scenarios", () => {
  // RC1: "senza dolore" (it-IT "sem dor") precisa fechar como SEM limitação.
  // Antes só "senza dolori" (plural) estava na lista, então Giulia/Marco caíam
  // em needs_confirmation → o GUTO pedia esclarecimento de um dado já calibrado
  // e travava treino/XP/arena em cascata.
  it("RC1 — 'senza dolore' fecha como sem limitação (não pede esclarecimento)", () => {
    for (const value of ["senza dolore", "Senza dolore", "senza dolori", "nessun dolore", "sem dor", "no pain"]) {
      const resolved = resolveKnownPathologyLocally(value, NOW);
      assert.ok(resolved, `esperava resolução para "${value}"`);
      assert.equal(resolved!.status, "clear", `"${value}" deveria ser clear`);
      assert.equal(resolved!.normalizedValue, "no_limitation", `"${value}" deveria ser no_limitation`);
    }
  });

  it("RC1 — limitação real continua sendo protegida (não vira 'sem limitação')", () => {
    assert.equal(resolveKnownPathologyLocally("ginocchio", NOW)?.normalizedValue, "knee_sensitive");
    assert.equal(resolveKnownPathologyLocally("spalla", NOW)?.normalizedValue, "shoulder_sensitive");
    assert.equal(resolveKnownPathologyLocally("dor leve no joelho", NOW)?.normalizedValue, "knee_sensitive");
  });

  // RC5: vegetariano/vegana/vegetariana são escolhas dietéticas conhecidas —
  // NÃO restrições confusas. Antes não eram reconhecidas pelo resolver local,
  // então a dieta retornava 422 FOOD_RESTRICTION_NEEDS_CLARIFICATION.
  it("RC5 — vegetariano/vegana/vegetariana resolvem como restrição clara", async () => {
    const cases: Array<[string, string]> = [
      ["vegetariano", "vegetarian"],
      ["vegetariana", "vegetarian"],
      ["vegan", "vegan"],
      ["vegana", "vegan"],
    ];
    for (const [raw, expected] of cases) {
      const result = await resolveProfileFreeFields({ foodRestriction: raw });
      assert.ok(result.foodRestriction, `esperava foodRestriction resolvido para "${raw}"`);
      assert.equal(result.foodRestriction!.status, "clear", `"${raw}" deveria ser clear`);
      assert.equal(result.foodRestriction!.normalizedValue, expected, `"${raw}" → ${expected}`);
    }
  });

  it("RC5 — restrições estruturadas anteriores seguem funcionando", async () => {
    const lactose = await resolveProfileFreeFields({ foodRestriction: "senza lattosio" });
    assert.equal(lactose.foodRestriction?.normalizedValue, "lactose_intolerance");
    // "como de tudo" / "mangio tutto" não é restrição — não bloqueia dieta.
    const none = await resolveProfileFreeFields({ foodRestriction: "mangio tutto" });
    assert.equal(none.foodRestriction, undefined);
  });
});

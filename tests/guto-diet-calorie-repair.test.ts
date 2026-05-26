import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scaleDietToTarget, validateDietCalories, type DietMeal } from "../src/nutrition";

// Fase 3 (estabilização) — BUG 1: a dieta caía em "calorias e macros não fecharam"
// porque o total diário do cérebro saía fora de ±80 kcal e NÃO havia reparo antes
// de bloquear. scaleDietToTarget escala o plano para fechar a meta (kcal+macros+porção),
// só falhando quando é estruturalmente impossível.

function food(name: string, kcal: number, quantity = "100g") {
  return { name, quantity, kcal, proteinG: Math.round(kcal * 0.1), carbsG: Math.round(kcal * 0.12), fatG: Math.round(kcal * 0.03) };
}
function meal(id: string, foods: ReturnType<typeof food>[]): DietMeal {
  return { id, name: id, time: "08:00", gutoNote: "", foods, totalKcal: foods.reduce((s, f) => s + f.kcal, 0) };
}

describe("Fase 3 — BUG 1: scaleDietToTarget (reparo de calorias)", () => {
  it("escala um plano levemente fora da meta para dentro de ±80 kcal", () => {
    const target = 2000;
    const meals = [
      meal("cafe", [food("Aveia", 700), food("Banana", 200)]),
      meal("almoco", [food("Arroz", 800), food("Frango", 600)]),
      // total = 2300 → +300 da meta (fora de ±80, mas reparável)
    ];
    const repaired = scaleDietToTarget(meals, target);
    assert.ok(repaired, "deve reparar (não retornar null)");
    const check = validateDietCalories(repaired!, target);
    assert.ok(check.valid, `após reparo o total (${check.dailyTotal}) deve fechar com ±80 da meta (${target})`);
    // a porção acompanha a kcal (coerência): a primeira comida encolheu
    assert.notEqual(repaired![0].foods[0].quantity, "100g");
    assert.ok(repaired![0].foods[0].kcal < 700, "kcal deve ter sido escalada para baixo");
  });

  it("não altera um plano que já está dentro de ±80 kcal", () => {
    const target = 2000;
    const meals = [meal("cafe", [food("Aveia", 1000), food("Arroz", 1050)])]; // 2050 → +50 (dentro)
    const repaired = scaleDietToTarget(meals, target);
    assert.equal(repaired, meals, "plano já válido deve ser retornado sem alteração");
  });

  it("retorna null quando o desvio é estruturalmente fora (fator absurdo)", () => {
    // total 600 para meta 2000 → fator 3.33 (>1.7) → falha honesta, não inventa.
    assert.equal(scaleDietToTarget([meal("cafe", [food("Aveia", 600)])], 2000), null);
    // total 4000 para meta 1600 → fator 0.4 (<0.6) → falha honesta.
    assert.equal(scaleDietToTarget([meal("cafe", [food("Doce", 4000)])], 1600), null);
  });

  it("retorna null para entradas inválidas (vazio / meta zero)", () => {
    assert.equal(scaleDietToTarget([], 2000), null);
    assert.equal(scaleDietToTarget([meal("cafe", [food("Aveia", 2000)])], 0), null);
  });
});

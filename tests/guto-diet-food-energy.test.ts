import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateMacros,
  estimateDietFoodKcal,
  normalizeMealCalories,
  validateAndCorrectPortions,
  validateDietCalories,
  validateDietFoodEnergy,
  type DietMeal,
} from "../src/nutrition.js";

function meal(id: string, foods: DietMeal["foods"]): DietMeal {
  return { id, name: id, time: "10:00", foods, totalKcal: foods.reduce((sum, food) => sum + food.kcal, 0), gutoNote: "" };
}

describe("diet food energy consistency", () => {
  it("rejeita 2 maçãs + 80g de pasta de amendoim declaradas como 200 kcal", () => {
    const invalid = meal("lanche1", [
      { name: "Maçã", quantity: "2 unidades", kcal: 100 },
      { name: "Pasta de amendoim", quantity: "80g", kcal: 100 },
    ]);
    const result = validateDietFoodEnergy([invalid]);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => /Maçã.*~190 kcal.*100 kcal/.test(issue)));
    assert.ok(result.issues.some((issue) => /Pasta de amendoim.*~470 kcal.*100 kcal/.test(issue)));
  });

  it("calcula energia por identidade e quantidade para unidades e gramas", () => {
    assert.equal(estimateDietFoodKcal({ name: "Maçã", quantity: "2 unidades" }), 190);
    assert.equal(estimateDietFoodKcal({ name: "Pasta de amendoim", quantity: "80g" }), 470);
    assert.equal(estimateDietFoodKcal({ name: "Bolachas de arroz", quantity: "100g" }), 387);
    assert.equal(estimateDietFoodKcal({ name: "Atum em conserva (em óleo)", quantity: "100g" }), 198);
  });

  it("corrige deterministicamente as kcal antes de publicar a refeição", () => {
    const impossible = meal("lanche1", [
      { name: "Maçã", quantity: "2 unidades", kcal: 100 },
      { name: "Pasta de amendoim", quantity: "80g", kcal: 100 },
    ]);
    const corrected = validateAndCorrectPortions([impossible]).correctedMeals;
    assert.deepEqual(corrected[0].foods.map((food) => food.kcal), [190, 470]);
  });

  it("mantém a soma da refeição igual à soma dos alimentos", () => {
    const normalized = normalizeMealCalories([
      { ...meal("lanche1", [{ name: "Maçã", quantity: "2 unidades", kcal: 190 }, { name: "Pasta de amendoim", quantity: "20g", kcal: 118 }]), totalKcal: 1 },
    ]);
    assert.equal(normalized[0].totalKcal, 308);
    assert.equal(validateDietCalories(normalized, 308).valid, true);
  });

  it("mantém a soma diária dentro da tolerância da meta", () => {
    const meals = [
      meal("cafe", [{ name: "Aveia", quantity: "80g", kcal: 311 }]),
      meal("lanche1", [{ name: "Maçã", quantity: "2 unidades", kcal: 190 }]),
      meal("almoco", [{ name: "Frango", quantity: "200g", kcal: 330 }, { name: "Arroz cozido", quantity: "180g", kcal: 230 }]),
      meal("lanche2", [{ name: "Pasta de amendoim", quantity: "40g", kcal: 235 }]),
      meal("jantar", [{ name: "Carne magra", quantity: "200g", kcal: 400 }, { name: "Batata cozida", quantity: "300g", kcal: 261 }, { name: "Azeite", quantity: "15g", kcal: 133 }]),
    ];
    const result = validateDietCalories(meals, 2192);
    assert.equal(result.dailyTotal, 2090);
    assert.equal(result.valid, false);

    meals[4].foods[1] = { name: "Batata cozida", quantity: "385g", kcal: 335 };
    meals[4] = normalizeMealCalories([meals[4]])[0];
    const repaired = validateDietCalories(meals, 2192);
    assert.equal(Math.abs(repaired.dailyTotal - 2192) <= 80, true);
    assert.equal(repaired.valid, true);
  });

  it("preserva a fórmula atual de meta e fecha energia dos macros", () => {
    const macros = calculateMacros({
      biologicalSex: "female",
      userAge: 26,
      heightCm: 165,
      weightKg: 68,
      trainingLevel: "returning",
      trainingGoal: "muscle_gain",
      foodRestrictions: "sem lactose",
    });
    assert.equal(macros.targetKcal, 2192);
    assert.deepEqual({ proteinG: macros.proteinG, carbsG: macros.carbsG, fatG: macros.fatG }, { proteinG: 129, carbsG: 271, fatG: 66 });
    assert.equal(Math.abs(macros.proteinG * 4 + macros.carbsG * 4 + macros.fatG * 9 - macros.targetKcal) <= 5, true);
  });

  it("rejeita alimento ou medida fora da referência em vez de publicar contradição", () => {
    const unknown = meal("lanche", [{ name: "Alimento inventado", quantity: "1 porção", kcal: 200 }]);
    assert.equal(validateDietFoodEnergy([unknown]).valid, false);
  });
});

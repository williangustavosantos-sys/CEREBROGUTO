import { V3Error } from "./errors.js";
import type { FoodReplacement } from "./repository.js";
import type { CandidateOption, DietItem, DietPlan } from "./types.js";

export interface NutritionValidation {
  valid: boolean;
  method: "item_sum_and_4_4_9_v1";
  totals: {
    calories: number;
    proteinGrams: number;
    carbsGrams: number;
    fatGrams: number;
    macroCalories: number;
  };
  diagnostics: string[];
}

export interface NutritionTolerance {
  mealToPlanKcal: number;
  macroToPlanKcal: number;
}

const DEFAULT_TOLERANCE: NutritionTolerance = {
  mealToPlanKcal: Number(process.env.GUTO_V3_NUTRITION_SUM_TOLERANCE_KCAL || 2),
  macroToPlanKcal: Number(process.env.GUTO_V3_NUTRITION_MACRO_TOLERANCE_KCAL || 20),
};

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sum(items: number[]): number { return round(items.reduce((total, value) => total + value, 0)); }

export function calculateNutritionPlan(plan: DietPlan): NutritionValidation["totals"] {
  const items = plan.meals.flatMap((meal) => meal.items);
  const proteinGrams = sum(items.map((item) => item.proteinGrams));
  const carbsGrams = sum(items.map((item) => item.carbsGrams));
  const fatGrams = sum(items.map((item) => item.fatGrams));
  return {
    calories: sum(items.map((item) => item.calories)),
    proteinGrams,
    carbsGrams,
    fatGrams,
    macroCalories: round(proteinGrams * 4 + carbsGrams * 4 + fatGrams * 9),
  };
}

export function validateNutritionPlan(
  plan: DietPlan,
  tolerance: NutritionTolerance = DEFAULT_TOLERANCE,
): NutritionValidation {
  const diagnostics: string[] = [];
  const totals = calculateNutritionPlan(plan);
  for (const meal of plan.meals) {
    const itemCalories = sum(meal.items.map((item) => item.calories));
    if (Math.abs(itemCalories - meal.calories) > tolerance.mealToPlanKcal) {
      diagnostics.push(`MEAL_TOTAL_MISMATCH:${meal.id}:${meal.calories}:${itemCalories}`);
    }
  }
  const mealCalories = sum(plan.meals.map((meal) => meal.calories));
  if (Math.abs(mealCalories - plan.totalCalories) > tolerance.mealToPlanKcal) {
    diagnostics.push(`PLAN_MEAL_TOTAL_MISMATCH:${plan.totalCalories}:${mealCalories}`);
  }
  if (Math.abs(totals.calories - plan.totalCalories) > tolerance.mealToPlanKcal) {
    diagnostics.push(`PLAN_ITEM_TOTAL_MISMATCH:${plan.totalCalories}:${totals.calories}`);
  }
  if (Math.abs(totals.proteinGrams - plan.proteinGrams) > 0.5) diagnostics.push("PLAN_PROTEIN_MISMATCH");
  if (Math.abs(totals.carbsGrams - plan.carbsGrams) > 0.5) diagnostics.push("PLAN_CARBS_MISMATCH");
  if (Math.abs(totals.fatGrams - plan.fatGrams) > 0.5) diagnostics.push("PLAN_FAT_MISMATCH");
  if (Math.abs(totals.macroCalories - plan.totalCalories) > tolerance.macroToPlanKcal) {
    diagnostics.push(`MACRO_ENERGY_MISMATCH:${plan.totalCalories}:${totals.macroCalories}`);
  }
  return { valid: diagnostics.length === 0, method: "item_sum_and_4_4_9_v1", totals, diagnostics };
}

function candidateNutrient(candidate: CandidateOption, key: string): number {
  const value = Number(candidate.metadata[key]);
  if (!Number.isFinite(value) || value < 0) {
    throw new V3Error("V3_FOOD_NUTRITION_DATA_MISSING", `Dados nutricionais ausentes para ${candidate.id}.`, 409, { key });
  }
  return value;
}

export function calculateFoodReplacement(target: DietItem, candidate: CandidateOption): FoodReplacement {
  if (candidate.kind !== "food") throw new V3Error("V3_INVALID_FOOD_CANDIDATE", "Candidato não é alimento.", 409);
  const kcalPer100 = candidateNutrient(candidate, "caloriesPer100g");
  if (kcalPer100 <= 0) throw new V3Error("V3_INVALID_FOOD_ENERGY", "Energia do alimento candidato é inválida.", 409);
  const quantityGrams = round((target.calories / kcalPer100) * 100, 1);
  if (quantityGrams < 5 || quantityGrams > 1_000) {
    throw new V3Error("V3_FOOD_REPLACEMENT_QUANTITY_UNSAFE", "A quantidade calculada não é operacionalmente válida.", 409);
  }
  const factor = quantityGrams / 100;
  const proteinGrams = round(candidateNutrient(candidate, "proteinPer100g") * factor);
  const carbsGrams = round(candidateNutrient(candidate, "carbsPer100g") * factor);
  const fatGrams = round(candidateNutrient(candidate, "fatPer100g") * factor);
  return {
    candidate,
    quantityGrams,
    calories: round(proteinGrams * 4 + carbsGrams * 4 + fatGrams * 9),
    proteinGrams,
    carbsGrams,
    fatGrams,
  };
}

export function applyFoodReplacement(plan: DietPlan, itemId: string, replacement: FoodReplacement): DietPlan {
  let found = false;
  const meals = plan.meals.map((meal) => {
    const items = meal.items.map((item) => {
      if (item.id !== itemId) return { ...item };
      found = true;
      return {
        ...item,
        foodId: replacement.candidate.id,
        name: replacement.candidate.label,
        quantityGrams: replacement.quantityGrams,
        calories: replacement.calories,
        proteinGrams: replacement.proteinGrams,
        carbsGrams: replacement.carbsGrams,
        fatGrams: replacement.fatGrams,
      };
    });
    return { ...meal, items, calories: sum(items.map((item) => item.calories)) };
  });
  if (!found) throw new V3Error("V3_DIET_ITEM_NOT_FOUND", "Alimento oficial não encontrado.", 409);
  const draft: DietPlan = { ...plan, meals };
  const totals = calculateNutritionPlan(draft);
  return {
    ...draft,
    totalCalories: totals.calories,
    proteinGrams: totals.proteinGrams,
    carbsGrams: totals.carbsGrams,
    fatGrams: totals.fatGrams,
  };
}

export function assertNutritionPlanValid(plan: DietPlan, tolerance: NutritionTolerance = DEFAULT_TOLERANCE): void {
  const validation = validateNutritionPlan(plan, tolerance);
  if (!validation.valid) {
    throw new V3Error("V3_NUTRITION_INVARIANT_FAILED", "A dieta não passou pela validação determinística.", 409, {
      method: validation.method,
      diagnostics: validation.diagnostics,
    });
  }
}

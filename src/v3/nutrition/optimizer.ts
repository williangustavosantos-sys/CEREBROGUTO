import { V3Error } from "../errors.js";
import { optimizeNutrition, reoptimizeNutrition, type FoodCatalogItem, type OptimizationResult, type NutritionTarget } from "../nutrition-optimizer/spike/index.js";
import { selectCandidateFoods, type OfficialFoodCatalogItem } from "./catalog.js";

export type { NutritionTarget, OptimizationResult };

function toSolverFood(food: OfficialFoodCatalogItem): FoodCatalogItem {
  return { id: food.id, name: food.canonicalName, role: food.role, minGrams: food.minGrams, maxGrams: food.maxGrams, mealAffinity: food.mealAffinity, nutritionPer100g: { calories: food.nutritionPer100g.calories, proteinGrams: food.nutritionPer100g.protein, carbsGrams: food.nutritionPer100g.carbs, fatGrams: food.nutritionPer100g.fat, fiberGrams: food.nutritionPer100g.fiber } };
}

export function nutritionTargetFromProfile(target: ReturnType<typeof import("./target-policy.js").calculateNutritionTarget>): NutritionTarget {
  return { calories: { min: Math.round(target.targetCalories * 0.97), target: target.targetCalories, max: Math.round(target.targetCalories * 1.03) }, proteinGrams: { min: target.protein.min, target: target.protein.target, max: target.protein.max }, fatGrams: { min: target.fat.min, target: target.fat.target, max: target.fat.max }, carbsGrams: { min: target.carbs.min, target: target.carbs.target, max: target.carbs.max }, fiberGrams: { min: target.fiber.min } };
}

export async function generateOfficialNutrition(target: NutritionTarget, excludedIds: readonly string[] = []): Promise<OptimizationResult> {
  const foods = selectCandidateFoods(excludedIds).map(toSolverFood);
  const result = await optimizeNutrition({ target, foods, formulation: "simple_lp", roundingGrams: 5 });
  if (result.status === "INFEASIBLE") throw new V3Error("NUTRITION_PLAN_INFEASIBLE", "Não foi possível montar uma dieta compatível com as metas.", 409, result.solverMetadata);
  if (result.status === "TIME_LIMIT") throw new V3Error("NUTRITION_SOLVER_TIME_LIMIT", "A otimização nutricional excedeu o tempo seguro.", 503, result.solverMetadata);
  if (result.status !== "OPTIMAL") throw new V3Error("NUTRITION_SOLVER_ERROR", "A otimização nutricional falhou com segurança.", 503, result.solverMetadata);
  return result;
}

export async function reoptimizeOfficialNutrition(previous: OptimizationResult, target: NutritionTarget, excludedIds: readonly string[] = []): Promise<OptimizationResult> {
  const foods = selectCandidateFoods(excludedIds).map(toSolverFood);
  const result = await reoptimizeNutrition({ previousPlan: previous, target, foods, excludedFoodIds: [...excludedIds], roundingGrams: 5 });
  if (result.status === "INFEASIBLE") throw new V3Error("NUTRITION_PLAN_INFEASIBLE", "Não foi possível substituir o alimento sem quebrar as metas.", 409, result.solverMetadata);
  if (result.status === "TIME_LIMIT") throw new V3Error("NUTRITION_SOLVER_TIME_LIMIT", "A substituição nutricional excedeu o tempo seguro.", 503, result.solverMetadata);
  if (result.status !== "OPTIMAL") throw new V3Error("NUTRITION_SOLVER_ERROR", "A substituição nutricional falhou com segurança.", 503, result.solverMetadata);
  return result;
}

import { solveNutritionOptimization } from "../../nutrition/optimization-model.js";

export type {
  FoodRole,
  NutritionRange,
  NutritionTarget,
  FoodCatalogItem,
  OptimizationResult,
  OptimizationMode,
} from "../../nutrition/optimization-model.js";
export { buildNutritionOptimizationProblem, calculateNutritionTotals } from "../../nutrition/optimization-model.js";

export interface OptimizationRequest {
  target: NutritionTarget;
  foods: FoodCatalogItem[];
  excludedFoodIds?: string[];
  previousPlan?: OptimizationResult;
  roleRequirements?: Partial<Record<FoodRole, number>>;
  rolePolicy?: "rigid_filter" | "penalty";
  rolePenalty?: Partial<Record<FoodRole, number>>;
  deviationWeights?: Record<string, number>;
  timeLimitSeconds?: number;
  roundingGrams?: number;
  formulation?: "simple_lp" | "weighted_absolute_deviation_lp";
  targetWeights?: { calories?: number; protein?: number; fat?: number; carbs?: number };
  typicalPortions?: Record<string, number>;
  includePortionRegularization?: boolean;
}

export interface ReoptimizationRequest extends OptimizationRequest {
  previousPlan: OptimizationResult;
  excludedFoodIds: string[];
}

import type { FoodCatalogItem, FoodRole, NutritionTarget, OptimizationResult } from "../../nutrition/optimization-model.js";

/**
 * TEST_FIXTURE_ONLY: synthetic values; never use as the official food catalog.
 * Shared mathematical types live in the optimization model; this fixture is
 * only a nutritional payload.
 */
export const TEST_FIXTURE_ONLY_FOODS: FoodCatalogItem[] = [
  { id: "oats", name: "oats", role: "carb_primary", nutritionPer100g: { calories: 389, proteinGrams: 16.9, carbsGrams: 66.3, fatGrams: 6.9, fiberGrams: 10.6 }, minGrams: 0, maxGrams: 300 },
  { id: "rice", name: "rice", role: "carb_primary", nutritionPer100g: { calories: 130, proteinGrams: 2.7, carbsGrams: 28.2, fatGrams: 0.3, fiberGrams: 2.3 }, minGrams: 0, maxGrams: 700 },
  { id: "potato", name: "potato", role: "carb_primary", nutritionPer100g: { calories: 87, proteinGrams: 1.9, carbsGrams: 20, fatGrams: 0.1, fiberGrams: 1.9 }, minGrams: 0, maxGrams: 700 },
  { id: "chicken", name: "chicken", role: "protein_primary", nutritionPer100g: { calories: 165, proteinGrams: 31, carbsGrams: 0, fatGrams: 3.6 }, minGrams: 0, maxGrams: 500 },
  { id: "beans", name: "beans", role: "legume", nutritionPer100g: { calories: 127, proteinGrams: 8.9, carbsGrams: 22.9, fatGrams: 0.5, fiberGrams: 7.6 }, minGrams: 0, maxGrams: 500 },
  { id: "olive_oil", name: "olive oil", role: "fat", nutritionPer100g: { calories: 884, proteinGrams: 0, carbsGrams: 0, fatGrams: 100 }, minGrams: 0, maxGrams: 30 },
  { id: "banana", name: "banana", role: "fruit", nutritionPer100g: { calories: 89, proteinGrams: 1.1, carbsGrams: 22.8, fatGrams: 0.3, fiberGrams: 2.6 }, minGrams: 0, maxGrams: 300 },
];

/** @deprecated kept only for backwards compatibility with the spike naming. */
export async function optimizeNutrition(request: OptimizationRequest): Promise<OptimizationResult> {
  const foods = request.foods.filter((food) => !(request.excludedFoodIds ?? []).includes(food.id));
  if (request.rolePolicy === "rigid_filter" && Object.keys(request.roleRequirements ?? {}).some((role) => !foods.some((food) => food.role === role))) {
    return { status: "INFEASIBLE", foods: [], totals: { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, fiberGrams: 0 }, solverMetadata: { durationMs: 0, formulation: request.previousPlan ? "weighted_absolute_deviation_lp" : "simple_lp", message: "Required role unavailable" } };
  }
  return solveNutritionOptimization({
    mode: request.previousPlan ? "REOPTIMIZE" : "INITIAL",
    target: request.target,
    foods: request.foods,
    excludedFoodIds: request.excludedFoodIds,
    previousPlan: request.previousPlan,
    roleRequirements: request.roleRequirements,
    deviationWeights: request.deviationWeights,
    targetWeights: request.targetWeights,
    typicalPortions: request.typicalPortions,
    includePortionRegularization: request.includePortionRegularization,
    timeLimitSeconds: request.timeLimitSeconds,
    roundingGrams: request.roundingGrams,
  });
}

export function reoptimizeNutrition(request: ReoptimizationRequest) {
  return solveNutritionOptimization({
    mode: "REOPTIMIZE",
    target: request.target,
    foods: request.foods,
    excludedFoodIds: request.excludedFoodIds,
    previousPlan: request.previousPlan,
    roleRequirements: request.roleRequirements,
    deviationWeights: request.deviationWeights,
    timeLimitSeconds: request.timeLimitSeconds,
    roundingGrams: request.roundingGrams,
  });
}
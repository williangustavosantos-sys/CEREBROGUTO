import loadHighs from "highs";

export type FoodRole = "carb_primary" | "protein_primary" | "mixed" | "fruit" | "fat" | "vegetable" | "dairy" | "legume";
export interface NutritionRange { min: number; target?: number; max: number; }
export interface NutritionTarget { calories: NutritionRange; proteinGrams: NutritionRange; fatGrams: NutritionRange; carbsGrams: NutritionRange; fiberGrams?: { min: number; max?: number }; }
export interface FoodCatalogItem { id: string; name: string; nutritionPer100g: { calories: number; proteinGrams: number; carbsGrams: number; fatGrams: number; fiberGrams?: number }; role: FoodRole; minGrams: number; maxGrams: number; mealAffinity?: string[]; }
export interface OptimizationResult { status: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "TIME_LIMIT" | "ERROR"; foods: Array<{ foodId: string; grams: number }>; totals: { calories: number; proteinGrams: number; carbsGrams: number; fatGrams: number; fiberGrams?: number }; solverMetadata: { durationMs: number; objectiveValue?: number; message?: string; formulation?: "simple_lp" | "weighted_absolute_deviation_lp" }; }
export interface OptimizationRequest { target: NutritionTarget; foods: FoodCatalogItem[]; excludedFoodIds?: string[]; previousPlan?: OptimizationResult; roleRequirements?: Partial<Record<FoodRole, number>>; rolePolicy?: "rigid_filter" | "penalty"; rolePenalty?: Partial<Record<FoodRole, number>>; deviationWeights?: Record<string, number>; timeLimitSeconds?: number; roundingGrams?: number; formulation?: "simple_lp" | "weighted_absolute_deviation_lp"; }
export interface ReoptimizationRequest { previousPlan: OptimizationResult; target: NutritionTarget; foods: FoodCatalogItem[]; excludedFoodIds: string[]; roleRequirements?: Partial<Record<FoodRole, number>>; rolePolicy?: "rigid_filter" | "penalty"; rolePenalty?: Partial<Record<FoodRole, number>>; deviationWeights?: Record<string, number>; timeLimitSeconds?: number; roundingGrams?: number; }

/** TEST_FIXTURE_ONLY: synthetic values; never use as the official food catalog. */
export const TEST_FIXTURE_ONLY_FOODS: FoodCatalogItem[] = [
  { id: "oats", name: "oats", role: "carb_primary", nutritionPer100g: { calories: 389, proteinGrams: 16.9, carbsGrams: 66.3, fatGrams: 6.9, fiberGrams: 10.6 }, minGrams: 0, maxGrams: 300 },
  { id: "rice", name: "rice", role: "carb_primary", nutritionPer100g: { calories: 130, proteinGrams: 2.7, carbsGrams: 28.2, fatGrams: 0.3, fiberGrams: 2.3 }, minGrams: 0, maxGrams: 700 },
  { id: "potato", name: "potato", role: "carb_primary", nutritionPer100g: { calories: 87, proteinGrams: 1.9, carbsGrams: 20, fatGrams: 0.1, fiberGrams: 1.9 }, minGrams: 0, maxGrams: 700 },
  { id: "chicken", name: "chicken", role: "protein_primary", nutritionPer100g: { calories: 165, proteinGrams: 31, carbsGrams: 0, fatGrams: 3.6 }, minGrams: 0, maxGrams: 500 },
  { id: "beans", name: "beans", role: "legume", nutritionPer100g: { calories: 127, proteinGrams: 8.9, carbsGrams: 22.9, fatGrams: 0.5, fiberGrams: 7.6 }, minGrams: 0, maxGrams: 500 },
  { id: "olive_oil", name: "olive oil", role: "fat", nutritionPer100g: { calories: 884, proteinGrams: 0, carbsGrams: 0, fatGrams: 100 }, minGrams: 0, maxGrams: 30 },
  { id: "banana", name: "banana", role: "fruit", nutritionPer100g: { calories: 89, proteinGrams: 1.1, carbsGrams: 22.8, fatGrams: 0.3, fiberGrams: 2.6 }, minGrams: 0, maxGrams: 300 },
];

type Nutrient = "calories" | "proteinGrams" | "fatGrams" | "carbsGrams" | "fiberGrams";
const nutrientValue = (food: FoodCatalogItem, nutrient: Nutrient) => food.nutritionPer100g[nutrient] ?? 0;
const round = (value: number) => Number(value.toFixed(2));

function calculateTotals(foods: FoodCatalogItem[], amounts: Map<string, number>) {
  const totals = { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, fiberGrams: 0 };
  for (const food of foods) { const factor = (amounts.get(food.id) ?? 0) / 100; totals.calories += nutrientValue(food, "calories") * factor; totals.proteinGrams += nutrientValue(food, "proteinGrams") * factor; totals.carbsGrams += nutrientValue(food, "carbsGrams") * factor; totals.fatGrams += nutrientValue(food, "fatGrams") * factor; totals.fiberGrams += nutrientValue(food, "fiberGrams") * factor; }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round(value)])) as typeof totals;
}

function withinTarget(target: NutritionTarget, totals: ReturnType<typeof calculateTotals>) {
  const ranges: Array<[number, NutritionRange]> = [[totals.calories, target.calories], [totals.proteinGrams, target.proteinGrams], [totals.fatGrams, target.fatGrams], [totals.carbsGrams, target.carbsGrams]];
  if (ranges.some(([value, range]) => value < range.min - 0.01 || value > range.max + 0.01)) return false;
  return !target.fiberGrams || (totals.fiberGrams >= target.fiberGrams.min - 0.01 && (target.fiberGrams.max === undefined || totals.fiberGrams <= target.fiberGrams.max + 0.01));
}

function buildModel(request: OptimizationRequest, foods: FoodCatalogItem[]): string {
  const previous = new Map((request.previousPlan?.foods ?? []).map((food) => [food.foodId, food.grams]));
  const expression = (nutrient: Nutrient) => foods.map((food) => `${nutrientValue(food, nutrient) / 100} ${food.id}`).join(" + ");
  const lines = ["Minimize", " objective: " + (request.formulation === "weighted_absolute_deviation_lp" ? foods.map((food) => `d_${food.id}`).join(" + ") : foods.map((food) => `${food.maxGrams * 0.000001 + (request.rolePenalty?.[food.role] ?? 0)} ${food.id}`).join(" + ") || "0"), "Subject To"];
  const range = (name: string, nutrient: Nutrient, bounds: { min: number; max?: number }) => { lines.push(`${name}_min: ${expression(nutrient)} >= ${bounds.min}`); if (bounds.max !== undefined) lines.push(`${name}_max: ${expression(nutrient)} <= ${bounds.max}`); };
  range("calories", "calories", request.target.calories); range("protein", "proteinGrams", request.target.proteinGrams); range("fat", "fatGrams", request.target.fatGrams); range("carbs", "carbsGrams", request.target.carbsGrams); if (request.target.fiberGrams) range("fiber", "fiberGrams", request.target.fiberGrams);
  for (const [role, minimum] of Object.entries(request.roleRequirements ?? {})) { const roleFoods = foods.filter((food) => food.role === role); lines.push(`role_${role}: ${roleFoods.length ? roleFoods.map((food) => food.id).join(" + ") : "0"} >= ${minimum}`); }
  if (request.formulation === "weighted_absolute_deviation_lp") for (const food of foods) { const previousGrams = previous.get(food.id) ?? 0; lines.push(`dev_pos_${food.id}: ${food.id} - d_${food.id} <= ${previousGrams}`); lines.push(`dev_neg_${food.id}: d_${food.id} + ${food.id} >= ${previousGrams}`); }
  lines.push("Bounds", ...foods.map((food) => `${food.minGrams} <= ${food.id} <= ${food.maxGrams}`), ...(request.formulation === "weighted_absolute_deviation_lp" ? foods.map((food) => `0 <= d_${food.id}`) : []), "End");
  return lines.join("\n");
}

function statusOf(status: string): OptimizationResult["status"] { if (status === "Infeasible" || status === "Primal infeasible or unbounded") return "INFEASIBLE"; if (status === "Time limit reached" || status === "Iteration limit reached") return "TIME_LIMIT"; return status === "Optimal" ? "OPTIMAL" : "ERROR"; }
function empty(status: OptimizationResult["status"], started: number, message: string, formulation: OptimizationResult["solverMetadata"]["formulation"]): OptimizationResult { return { status, foods: [], totals: { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, fiberGrams: 0 }, solverMetadata: { durationMs: round(performance.now() - started), message, formulation } }; }

export async function optimizeNutrition(request: OptimizationRequest): Promise<OptimizationResult> {
  const started = performance.now(); const excluded = new Set(request.excludedFoodIds ?? []); const foods = request.foods.filter((food) => !excluded.has(food.id)); const formulation = request.formulation ?? (request.previousPlan ? "weighted_absolute_deviation_lp" : "simple_lp");
  if (!foods.length) return empty("INFEASIBLE", started, "No eligible foods", formulation);
  try {
    if (request.rolePolicy === "rigid_filter" && Object.keys(request.roleRequirements ?? {}).some((role) => !foods.some((food) => food.role === role))) return empty("INFEASIBLE", started, "Required role unavailable", formulation);
    const highs = await loadHighs(); const solved = highs.solve(buildModel({ ...request, formulation }, foods), { output_flag: false, time_limit: request.timeLimitSeconds ?? 5 }); const status = statusOf(solved.Status); if (status !== "OPTIMAL") return empty(status, started, solved.Status, formulation);
    const raw = new Map(foods.map((food) => { const column = solved.Columns[food.id]; return [food.id, column && "Primal" in column ? column.Primal : 0]; }));
    for (const step of [request.roundingGrams ?? 5, 1, 10]) { const rounded = new Map(foods.map((food) => [food.id, Math.min(food.maxGrams, Math.max(food.minGrams, Math.round((raw.get(food.id) ?? 0) / step) * step))])); const totals = calculateTotals(foods, rounded); if (withinTarget(request.target, totals)) return { status: "OPTIMAL", foods: foods.map((food) => ({ foodId: food.id, grams: rounded.get(food.id) ?? 0 })).filter((food) => food.grams > 0), totals, solverMetadata: { durationMs: round(performance.now() - started), objectiveValue: solved.ObjectiveValue, formulation } }; }
    return empty("ERROR", started, "Rounded solution violates constraints after bounded repair", formulation);
  } catch (error) { return empty("ERROR", started, error instanceof Error ? error.message : String(error), formulation); }
}

export function reoptimizeNutrition(request: ReoptimizationRequest) { return optimizeNutrition({ ...request, previousPlan: request.previousPlan, formulation: "weighted_absolute_deviation_lp" }); }

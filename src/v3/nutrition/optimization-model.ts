import loadHighs from "highs";

/**
 * Single shared LP formulation for GUTO nutrition.
 *
 * This is the ONE source of the optimization mathematics. Both the spike tests
 * and the official optimizer call this builder; no second math formulation may
 * live elsewhere.
 *
 * Modes:
 *  - INITIAL:      hard nutrient envelope + weighted normalized target deviation
 *                  objective (optionally a linear absolute portion term).
 *  - REOPTIMIZE:   hard nutrient envelope + per-food weighted deviation from the
 *                  previous plan. Unavailable foods are hard-zeroed; everything
 *                  else is free to move.
 */

export type FoodRole = "carb_primary" | "protein_primary" | "mixed" | "fruit" | "fat" | "vegetable" | "dairy" | "legume";

export interface NutritionRange {
  min: number;
  target?: number;
  max: number;
}

export interface NutritionTarget {
  calories: NutritionRange;
  proteinGrams: NutritionRange;
  fatGrams: NutritionRange;
  carbsGrams: NutritionRange;
  fiberGrams?: { min: number; target?: number; max?: number };
}

export interface FoodCatalogItem {
  id: string;
  name: string;
  nutritionPer100g: {
    calories: number;
    proteinGrams: number;
    carbsGrams: number;
    fatGrams: number;
    fiberGrams?: number;
  };
  role: FoodRole;
  minGrams: number;
  maxGrams: number;
  mealAffinity?: string[];
}

export interface OptimizationResult {
  status: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "TIME_LIMIT" | "ERROR";
  foods: Array<{ foodId: string; grams: number }>;
  totals: {
    calories: number;
    proteinGrams: number;
    carbsGrams: number;
    fatGrams: number;
    fiberGrams?: number;
  };
  solverMetadata: {
    durationMs: number;
    objectiveValue?: number;
    message?: string;
    formulation?: "simple_lp" | "weighted_absolute_deviation_lp";
  };
}

export type OptimizationMode = "INITIAL" | "REOPTIMIZE";

export interface BuildNutritionOptimizationProblemInput {
  mode: OptimizationMode;
  /** Eligible (already restriction-filtered) foods. */
  foods: FoodCatalogItem[];
  target: NutritionTarget;
  roleRequirements?: Partial<Record<FoodRole, number>>;
  previousPlan?: OptimizationResult;
  /** Food ids that must end at 0 grams. */
  unavailableFoodIds?: string[];
  /** REOPTIMIZE only: per-food weight for moving away from the previous plan. */
  deviationWeights?: Record<string, number>;
  /** INITIAL only: relative weight of each nutrient target (default 1 each). */
  targetWeights?: { calories?: number; protein?: number; fat?: number; carbs?: number };
  /** INITIAL only: optional portion regularization (absolute linear term). */
  typicalPortions?: Record<string, number>;
  includePortionRegularization?: boolean;
}

export interface OptimizationSolverInput {
  mode: OptimizationMode;
  foods: FoodCatalogItem[];
  target: NutritionTarget;
  roleRequirements?: Partial<Record<FoodRole, number>>;
  excludedFoodIds?: readonly string[];
  previousPlan?: OptimizationResult;
  deviationWeights?: Record<string, number>;
  targetWeights?: { calories?: number; protein?: number; fat?: number; carbs?: number };
  typicalPortions?: Record<string, number>;
  includePortionRegularization?: boolean;
  timeLimitSeconds?: number;
  roundingGrams?: number;
}

type Nutrient = "calories" | "proteinGrams" | "fatGrams" | "carbsGrams" | "fiberGrams";

const nutrientValue = (food: FoodCatalogItem, nutrient: Nutrient): number => food.nutritionPer100g[nutrient] ?? 0;

/** Format a numeric coefficient keeping LP text readable yet lossless for HiGHS. */
const fmt = (value: number): string => {
  if (!Number.isFinite(value)) return "0";
  const rounded = Number(value.toFixed(12));
  return rounded === 0 ? "0" : String(rounded);
};

function calculateTotals(foods: FoodCatalogItem[], amounts: Map<string, number>) {
  const totals = { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, fiberGrams: 0 };
  for (const food of foods) {
    const factor = (amounts.get(food.id) ?? 0) / 100;
    totals.calories += nutrientValue(food, "calories") * factor;
    totals.proteinGrams += nutrientValue(food, "proteinGrams") * factor;
    totals.carbsGrams += nutrientValue(food, "carbsGrams") * factor;
    totals.fatGrams += nutrientValue(food, "fatGrams") * factor;
    totals.fiberGrams += nutrientValue(food, "fiberGrams") * factor;
  }
  return totals;
}

const round2 = (value: number): number => Number(value.toFixed(2));

export function calculateNutritionTotals(foods: FoodCatalogItem[], amounts: Map<string, number>) {
  const totals = calculateTotals(foods, amounts);
  return {
    calories: round2(totals.calories),
    proteinGrams: round2(totals.proteinGrams),
    carbsGrams: round2(totals.carbsGrams),
    fatGrams: round2(totals.fatGrams),
    fiberGrams: round2(totals.fiberGrams),
  };
}

function withinTarget(target: NutritionTarget, totals: ReturnType<typeof calculateTotals>): boolean {
  const ranges: Array<[number, NutritionRange]> = [
    [totals.calories, target.calories],
    [totals.proteinGrams, target.proteinGrams],
    [totals.fatGrams, target.fatGrams],
    [totals.carbsGrams, target.carbsGrams],
  ];
  if (ranges.some(([value, range]) => value < range.min - 0.01 || value > range.max + 0.01)) return false;
  if (!target.fiberGrams) return true;
  return totals.fiberGrams >= target.fiberGrams.min - 0.01 && (target.fiberGrams.max === undefined || totals.fiberGrams <= target.fiberGrams.max + 0.01);
}

/**
 * Build the LP model as HiGHS LP-format text. Single shared mathematical
 * formulation for BOTH modes.
 */
export function buildNutritionOptimizationProblem(input: BuildNutritionOptimizationProblemInput): string {
  const { mode, foods } = input;
  const previous = new Map((input.previousPlan?.foods ?? []).map((food) => [food.foodId, food.grams]));
  const unavailable = new Set(input.unavailableFoodIds ?? []);
  const activeFoods = foods.filter((food) => !unavailable.has(food.id));
  const inactiveFoods = foods.filter((food) => unavailable.has(food.id));

  const expression = (nutrients: Nutrient[], pool = activeFoods) =>
    nutrients
      .map((nutrient) =>
        pool
          .map((food) => `${fmt(nutrientValue(food, nutrient) / 100)} ${food.id}`)
          .join(" + ")
      )
      .join(" + ") || "0";

  const lines: string[] = ["Minimize", " objective:"];
  const objective: string[] = [];

  if (mode === "INITIAL") {
    const w = {
      calories: input.targetWeights?.calories ?? 1,
      protein: input.targetWeights?.protein ?? 1,
      fat: input.targetWeights?.fat ?? 1,
      carbs: input.targetWeights?.carbs ?? 1,
    };
    const ref = {
      calories: input.target.calories.target ?? input.target.calories.min,
      protein: input.target.proteinGrams.target ?? input.target.proteinGrams.min,
      fat: input.target.fatGrams.target ?? input.target.fatGrams.min,
      carbs: input.target.carbsGrams.target ?? input.target.carbsGrams.min,
    };
    const push = (name: string, weight: number, target: number) => {
      objective.push(`${fmt(weight / (target === 0 ? 1 : target))} ${name}_deviation`);
    };
    push("calorie", w.calories, ref.calories);
    push("protein", w.protein, ref.protein);
    push("fat", w.fat, ref.fat);
    push("carbs", w.carbs, ref.carbs);
    objective.push("0.000001 total_grams");
    lines.push("  " + (objective.length ? objective.join(" + ") : "0"));

    if (input.includePortionRegularization && input.typicalPortions) {
      const portionObjective = activeFoods
        .filter((food) => (input.typicalPortions?.[food.id] ?? 0) > 0)
        .map((food) => `${fmt(1)} p_${food.id}`);
      if (portionObjective.length) lines.push("  + " + portionObjective.join(" + "));
    }
  } else {
    // REOPTIMIZE: weighted per-food deviation from previous plan.
    objective.push(...activeFoods.map((food) => `${fmt(input.deviationWeights?.[food.id] ?? 1)} d_${food.id}`));
    lines.push("  " + (objective.length ? objective.join(" + ") : "0"));
  }

  lines.push("Subject To");

  const range = (name: string, expression: string, bounds: { min: number; max?: number }) => {
    lines.push(`  ${name}_min: ${expression} >= ${fmt(bounds.min)}`);
    if (bounds.max !== undefined) lines.push(`  ${name}_max: ${expression} <= ${fmt(bounds.max)}`);
  };
  const cExpr = expression(["calories"]);
  const pExpr = expression(["proteinGrams"]);
  const fExpr = expression(["fatGrams"]);
  const cbExpr = expression(["carbsGrams"]);
  const fiberExpr = expression(["fiberGrams"]);

  range("calories", cExpr, input.target.calories);
  range("protein", pExpr, input.target.proteinGrams);
  range("fat", fExpr, input.target.fatGrams);
  range("carbs", cbExpr, input.target.carbsGrams);
  if (input.target.fiberGrams) range("fiber", fiberExpr, input.target.fiberGrams);

  if (mode === "INITIAL") lines.push(`  total_grams_def: ${activeFoods.map((food) => food.id).join(" + ") || "0"} - total_grams = 0`);

  if (mode === "INITIAL") {
    const targetCal = input.target.calories.target ?? input.target.calories.min;
    const targetProt = input.target.proteinGrams.target ?? input.target.proteinGrams.min;
    const targetFat = input.target.fatGrams.target ?? input.target.fatGrams.min;
    const targetCarb = input.target.carbsGrams.target ?? input.target.carbsGrams.min;
    const deviation = (name: string, expr: string, target: number) => {
      lines.push(`  ${name}_dev_above: ${expr} - ${name}_deviation <= ${fmt(target)}`);
      lines.push(`  ${name}_dev_below: ${expr} + ${name}_deviation >= ${fmt(target)}`);
    };
    deviation("calorie", cExpr, targetCal);
    deviation("protein", pExpr, targetProt);
    deviation("fat", fExpr, targetFat);
    deviation("carbs", cbExpr, targetCarb);

    if (input.includePortionRegularization && input.typicalPortions) {
      for (const food of activeFoods) {
        const typical = input.typicalPortions[food.id] ?? 0;
        if (typical > 0) {
          lines.push(`  port_above_${food.id}: ${food.id} - p_${food.id} <= ${fmt(typical)}`);
          lines.push(`  port_below_${food.id}: ${food.id} + p_${food.id} >= ${fmt(typical)}`);
        }
      }
    }
  } else {
    for (const food of activeFoods) {
      const previousGrams = previous.get(food.id) ?? 0;
      lines.push(`  dev_pos_${food.id}: ${food.id} - d_${food.id} <= ${fmt(previousGrams)}`);
      lines.push(`  dev_neg_${food.id}: d_${food.id} + ${food.id} >= ${fmt(previousGrams)}`);
    }
  }

  for (const [role, minimum] of Object.entries(input.roleRequirements ?? {})) {
    const roleFoods = activeFoods.filter((food) => food.role === role);
    lines.push(`  role_${role}: ${roleFoods.length ? roleFoods.map((food) => food.id).join(" + ") : "0"} >= ${fmt(minimum)}`);
  }

  lines.push("Bounds");
  for (const food of activeFoods) lines.push(`  ${fmt(food.minGrams)} <= ${food.id} <= ${fmt(food.maxGrams)}`);
  for (const food of inactiveFoods) lines.push(`  0 <= ${food.id} <= 0`);

  if (mode === "INITIAL") {
    lines.push("  0 <= calorie_deviation", "  0 <= protein_deviation", "  0 <= fat_deviation", "  0 <= carbs_deviation", "  0 <= total_grams");
    if (input.includePortionRegularization && input.typicalPortions) {
      for (const food of activeFoods) if ((input.typicalPortions[food.id] ?? 0) > 0) lines.push(`  0 <= p_${food.id}`);
    }
  } else {
    for (const food of activeFoods) lines.push(`  0 <= d_${food.id}`);
  }
  lines.push("End");

  return lines.join("\n");
}

/**
 * Greedy bounded repair of a rounded solution. Starting from `amounts` (already
 * rounded to `step`), repeatedly nudge one food by +/- one step to close the
 * most-violated envelope bound, until the plan fits the target or no move helps.
 * Ensures the reported plan (integer gram multiples) never silently violates the
 * hard constraints that the continuous LP guaranteed.
 */
function repairRounded(
  foods: FoodCatalogItem[],
  amounts: Map<string, number>,
  target: NutritionTarget,
  unavailableFoodIds: readonly string[],
  step: number
): Map<string, number> | null {
  const active = foods.filter((food) => !unavailableFoodIds.includes(food.id));
  const current = new Map(amounts);
  for (const id of unavailableFoodIds) current.set(id, 0);
  type RepairBound = { min: number; max?: number };
  const bounds: Array<[RepairBound, (t: ReturnType<typeof calculateTotals>) => number]> = [
    [target.calories, (t) => t.calories],
    [target.proteinGrams, (t) => t.proteinGrams],
    [target.fatGrams, (t) => t.fatGrams],
    [target.carbsGrams, (t) => t.carbsGrams],
  ];
  if (target.fiberGrams) bounds.push([target.fiberGrams, (t) => t.fiberGrams]);

  const violationOf = (totals: ReturnType<typeof calculateTotals>): number => {
    let violation = 0;
    for (const [range, value] of bounds) {
      if (value(totals) < range.min - 0.01) violation += range.min - value(totals);
      if (range.max !== undefined && value(totals) > range.max + 0.01) violation += value(totals) - range.max;
    }
    return violation;
  };

  if (violationOf(calculateTotals(active, current)) === 0) return current;
  // Cap iterations to bound runtime; a local climb reaches a feasible lattice
  // point fast for the small catalogs we solve.
  const iterations = active.length * 20 + 40;
  for (let it = 0; it < iterations; it++) {
    const totals = calculateTotals(active, current);
    const baseViolation = violationOf(totals);
    if (baseViolation === 0) return current;

    let best: Map<string, number> | null = null;
    let bestViolation = baseViolation;
    // Choose the direction of the most-violated bound.
    let wantMoreGrams = false;
    for (const [range, value] of bounds) {
      if (value(totals) < range.min - 0.01) { wantMoreGrams = true; break; }
    }
    for (const food of active) {
      const cur = current.get(food.id) ?? 0;
      if (food.minGrams >= food.maxGrams) continue;
      const candidates: number[] = [];
      if (wantMoreGrams && cur + step <= food.maxGrams) candidates.push(cur + step);
      if (!wantMoreGrams && cur - step >= food.minGrams) candidates.push(cur - step);
      for (const candidate of candidates) {
        const trial = new Map(current);
        trial.set(food.id, candidate);
        const v = violationOf(calculateTotals(active, trial));
        if (v < bestViolation) { bestViolation = v; best = trial; }
      }
    }
    if (!best || bestViolation >= baseViolation) break;
    current.clear();
    for (const [key, value] of best) current.set(key, value);
  }
  return violationOf(calculateTotals(active, current)) === 0 ? current : null;
}

function statusOf(status: string): OptimizationResult["status"] {
  if (status === "Infeasible" || status === "Primal infeasible or unbounded") return "INFEASIBLE";
  if (status === "Time limit reached" || status === "Iteration limit reached") return "TIME_LIMIT";
  return status === "Optimal" ? "OPTIMAL" : "ERROR";
}

function empty(status: OptimizationResult["status"], started: number, message: string, formulation: OptimizationResult["solverMetadata"]["formulation"]): OptimizationResult {
  return {
    status,
    foods: [],
    totals: { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, fiberGrams: 0 },
    solverMetadata: { durationMs: round2(performance.now() - started), message, formulation },
  };
}

/**
 * Solve the shared LP. Used by the spike, the official optimizer and any
 * reoptimization path — one math, one solver.
 */
export async function solveNutritionOptimization(input: OptimizationSolverInput): Promise<OptimizationResult> {
  const started = performance.now();
  const excluded = new Set(input.excludedFoodIds ?? []);
  const eligibleFoods = input.foods.filter((food) => !excluded.has(food.id));
  const unavailableFoodIds: string[] = [...(input.excludedFoodIds ?? [])];
  const formulation: OptimizationResult["solverMetadata"]["formulation"] = input.mode === "INITIAL" ? "simple_lp" : "weighted_absolute_deviation_lp";

  if (!eligibleFoods.length) return empty("INFEASIBLE", started, "No eligible foods", formulation);

  try {
    const highs = await loadHighs();
    const lp = buildNutritionOptimizationProblem({
      mode: input.mode,
      foods: eligibleFoods,
      target: input.target,
      roleRequirements: input.roleRequirements,
      previousPlan: input.previousPlan,
      unavailableFoodIds,
      deviationWeights: input.deviationWeights,
      targetWeights: input.targetWeights,
      typicalPortions: input.typicalPortions,
      includePortionRegularization: input.includePortionRegularization,
    });
    const solved = highs.solve(lp, { output_flag: false, time_limit: input.timeLimitSeconds ?? 5 });
    const status = statusOf(solved.Status);
    if (status !== "OPTIMAL") return empty(status, started, solved.Status, formulation);

    const raw = new Map(
      eligibleFoods.map((food) => {
        const column = solved.Columns[food.id];
        return [food.id, column && "Primal" in column ? column.Primal : 0];
      })
    );

    for (const step of [input.roundingGrams ?? 5, 1, 10]) {
      const rounded = new Map(
        eligibleFoods.map((food) => [
          food.id,
          Math.min(food.maxGrams, Math.max(food.minGrams, Math.round((raw.get(food.id) ?? 0) / step) * step)),
        ])
      );
      for (const id of unavailableFoodIds) rounded.set(id, 0);
      const repaired = repairRounded(eligibleFoods, rounded, input.target, unavailableFoodIds, step);
      if (repaired) {
        return {
          status: "OPTIMAL",
          foods: eligibleFoods.map((food) => ({ foodId: food.id, grams: repaired.get(food.id) ?? 0 })).filter((food) => food.grams > 0),
          totals: calculateNutritionTotals(eligibleFoods, repaired),
          solverMetadata: { durationMs: round2(performance.now() - started), objectiveValue: solved.ObjectiveValue, formulation },
        };
      }
    }
    return empty("ERROR", started, "Rounded solution violates constraints after bounded repair", formulation);
  } catch (error) {
    return empty("ERROR", started, error instanceof Error ? error.message : String(error), formulation);
  }
}


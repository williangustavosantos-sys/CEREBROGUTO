import { V3Error } from "../errors.js";
import type { OptimizationResult, NutritionTarget } from "./optimizer.js";

export function validateOfficialNutrition(result: OptimizationResult, target: NutritionTarget): void {
  if (result.status !== "OPTIMAL" && result.status !== "FEASIBLE") throw new V3Error("NUTRITION_VALIDATION_FAILED", "A dieta não possui resultado otimizado válido.", 409, { status: result.status });
  const checks: Array<[string, number, { min: number; max?: number }]> = [
    ["calories", result.totals.calories, target.calories],
    ["protein", result.totals.proteinGrams, target.proteinGrams],
    ["fat", result.totals.fatGrams, target.fatGrams],
    ["carbs", result.totals.carbsGrams, target.carbsGrams],
  ];
  if (target.fiberGrams) checks.push(["fiber", result.totals.fiberGrams ?? 0, target.fiberGrams]);
  const violations = checks.filter(([, value, range]) => value < range.min - 0.01 || (range.max !== undefined && value > range.max + 0.01)).map(([name, value, range]) => `${name}:${value} not in ${range.min}-${range.max ?? "∞"}`);
  if (violations.length) throw new V3Error("NUTRITION_VALIDATION_FAILED", "A dieta não passou pelas metas nutricionais.", 409, { violations });
}

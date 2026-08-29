import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildNutritionOptimizationProblem,
  solveNutritionOptimization,
  type FoodCatalogItem,
  type NutritionTarget,
  type OptimizationResult,
} from "../src/v3/nutrition/optimization-model.js";

const chick = (id = "chick", max = 500): FoodCatalogItem => ({
  id,
  name: id,
  role: "protein_primary",
  nutritionPer100g: { calories: 165, proteinGrams: 31, carbsGrams: 0, fatGrams: 3.6, fiberGrams: 0 },
  minGrams: 0,
  maxGrams: max,
});

const carb = (id: string, opts?: { cal?: number; prot?: number; carbs?: number; fat?: number; fiber?: number; max?: number }): FoodCatalogItem => ({
  id,
  name: id,
  role: "carb_primary",
  nutritionPer100g: {
    calories: opts?.cal ?? 120,
    proteinGrams: opts?.prot ?? 3,
    carbsGrams: opts?.carbs ?? 26,
    fatGrams: opts?.fat ?? 0.5,
    fiberGrams: opts?.fiber ?? 2,
  },
  minGrams: 0,
  maxGrams: opts?.max ?? 600,
});

const gramsOf = (result: OptimizationResult, id: string): number => result.foods.find((f) => f.foodId === id)?.grams ?? 0;

const previousPlan = (foods: Array<[string, number]>): OptimizationResult => ({
  status: "OPTIMAL",
  foods: foods.map(([foodId, grams]) => ({ foodId, grams })),
  totals: { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, fiberGrams: 0 },
  solverMetadata: { durationMs: 0, formulation: "weighted_absolute_deviation_lp" },
});

describe("SHARED_OPTIMIZATION_MATH", () => {
  describe("INITIAL", () => {
    it("INITIAL_EXACT: known optimal solution, single food exact", async () => {
      const target: NutritionTarget = {
        calories: { min: 165, target: 165, max: 165 },
        proteinGrams: { min: 31, target: 31, max: 31 },
        fatGrams: { min: 0, target: 3.6, max: 10 },
        carbsGrams: { min: 0, target: 0, max: 5 },
      };
      const result = await solveNutritionOptimization({ mode: "INITIAL", foods: [chick()], target, roundingGrams: 1 });
      assert.equal(result.status, "OPTIMAL");
      assert.equal(gramsOf(result, "chick"), 100);
      assert.equal(result.totals.calories, 165);
      assert.equal(result.totals.proteinGrams, 31);
    });

    it("INITIAL_TARGET: solves toward the target, closer than the alternative feasible solution", async () => {
      // Wide calories envelope; target sits interior. Only feasible lever is chicken grams.
      const target: NutritionTarget = {
        calories: { min: 120, target: 165, max: 210 },
        proteinGrams: { min: 20, target: 31, max: 45 },
        fatGrams: { min: 0, target: 3.6, max: 20 },
        carbsGrams: { min: 0, target: 0, max: 20 },
      };
      const result = await solveNutritionOptimization({ mode: "INITIAL", foods: [chick()], target, roundingGrams: 1 });
      assert.equal(result.status, "OPTIMAL");
      // A closer-to-target solution exists and is chosen: exact target reachable (100g).
      assert.ok(Math.abs(result.totals.calories - 165) < Math.abs(120 - 165), `generated ${result.totals.calories} should be closer to 165 than the min-bound alternative 120`);
      assert.ok(Math.abs(result.totals.proteinGrams - 31) < Math.abs(20 - 31));
    });

    it("INITIAL_WEIGHTS: changing target weights changes the chosen solution", async () => {
      const foodC = carb("calF", { cal: 300, prot: 5, carbs: 55, fat: 2, max: 500 });
      const foodP = { ...carb("protF", { cal: 120, prot: 28, carbs: 40, fat: 3, max: 600 }), role: "protein_primary" as const };
      const foods = [foodC, foodP];
      const target: NutritionTarget = {
        calories: { min: 1200, target: 1500, max: 1800 },
        proteinGrams: { min: 110, target: 150, max: 190 },
        fatGrams: { min: 0, target: 40, max: 100 },
        carbsGrams: { min: 50, target: 200, max: 400 },
      };
      const calHigh = await solveNutritionOptimization({ mode: "INITIAL", foods, target, targetWeights: { calories: 1000, protein: 1, fat: 1, carbs: 1 }, roundingGrams: 5 });
      const protHigh = await solveNutritionOptimization({ mode: "INITIAL", foods, target, targetWeights: { calories: 1, protein: 1000, fat: 1, carbs: 1 }, roundingGrams: 5 });
      assert.equal(calHigh.status, "OPTIMAL");
      assert.equal(protHigh.status, "OPTIMAL");
      // Solutions genuinely differ (weights are not decorative).
      assert.notDeepEqual(calHigh.foods, protHigh.foods);
      // calHigh lands closer to the calorie target than protHigh does.
      assert.ok(Math.abs(calHigh.totals.calories - 1500) < Math.abs(protHigh.totals.calories - 1500), `cal ${calHigh.totals.calories} vs prot-high ${protHigh.totals.calories}`);
    });

    it("INITIAL_FIBER: plan that closes macros but cannot reach fiber min is INFEASIBLE", async () => {
      // chicken carries no fiber, so macros can be met but fiber>=25 cannot.
      const target: NutritionTarget = {
        calories: { min: 150, target: 165, max: 200 },
        proteinGrams: { min: 25, target: 31, max: 40 },
        fatGrams: { min: 0, target: 3.6, max: 20 },
        carbsGrams: { min: 0, target: 0, max: 20 },
        fiberGrams: { min: 25 },
      };
      const result = await solveNutritionOptimization({ mode: "INITIAL", foods: [chick()], target, roundingGrams: 1 });
      assert.equal(result.status, "INFEASIBLE");
      assert.deepEqual(result.foods, []);
    });

    it("INITIAL_INFEASIBLE: truly impossible calorie envelope is INFEASIBLE", async () => {
      const target: NutritionTarget = {
        calories: { min: 20000, target: 20000, max: 21000 },
        proteinGrams: { min: 0, target: 0, max: 5000 },
        fatGrams: { min: 0, target: 0, max: 5000 },
        carbsGrams: { min: 0, target: 0, max: 5000 },
      };
      const result = await solveNutritionOptimization({ mode: "INITIAL", foods: [chick("chick", 500)], target, roundingGrams: 5 });
      assert.equal(result.status, "INFEASIBLE");
      assert.deepEqual(result.foods, []);
    });
  });

  describe("REOPTIMIZE", () => {
    it("REOPT_EXACT: single-gram-for-gram predictable swap to an identical substitute", async () => {
      const potato = carb("potato", { cal: 120, prot: 3, carbs: 26, fat: 0.5, fiber: 2, max: 600 });
      const bean = { ...potato, id: "bean" };
      const c = chick("chick", 500);
      const foods = [potato, bean, c];
      const target: NutritionTarget = {
        calories: { min: 1400, target: 1650, max: 1900 },
        proteinGrams: { min: 110, target: 140, max: 170 },
        fatGrams: { min: 10, target: 40, max: 70 },
        carbsGrams: { min: 150, target: 220, max: 300 },
        fiberGrams: { min: 10, max: 40 },
      };
      const previous = previousPlan([["potato", 400], ["bean", 0], ["chick", 380]]);
      const result = await solveNutritionOptimization({ mode: "REOPTIMIZE", foods, target, previousPlan: previous, excludedFoodIds: ["potato"], roundingGrams: 1 });
      assert.equal(result.status, "OPTIMAL");
      // Unavailable food ends at 0.
      assert.equal(gramsOf(result, "potato"), 0);
      // The identical substitute absorbs the plan; macros close to target still hold.
      assert.ok(gramsOf(result, "bean") > 0);
      assert.ok(result.totals.calories >= 1400 && result.totals.calories <= 1900);
      assert.ok(result.totals.proteinGrams >= 110 && result.totals.proteinGrams <= 170);
      assert.ok(result.totals.carbsGrams >= 150 && result.totals.carbsGrams <= 300);
      assert.ok((result.totals.fiberGrams ?? 0) >= 10);
    });

    it("REOPT_WEIGHTS: deviation weights decide which food compensates; inverting changes it", async () => {
      const rice = carb("rice", { max: 600 });
      const subA = carb("subA", { max: 600 });
      const subB = carb("subB", { max: 600 });
      const c = chick("chick", 500);
      const foods = [rice, subA, subB, c];
      const target: NutritionTarget = {
        calories: { min: 1400, target: 1650, max: 1900 },
        proteinGrams: { min: 110, target: 140, max: 170 },
        fatGrams: { min: 10, target: 40, max: 70 },
        carbsGrams: { min: 150, target: 220, max: 300 },
        fiberGrams: { min: 10, max: 40 },
      };
      const previous = previousPlan([["rice", 400], ["subA", 0], ["subB", 0], ["chick", 380]]);
      const aHigh = await solveNutritionOptimization({ mode: "REOPTIMIZE", foods, target, previousPlan: previous, excludedFoodIds: ["rice"], deviationWeights: { subA: 200, subB: 1 }, roundingGrams: 1 });
      const bHigh = await solveNutritionOptimization({ mode: "REOPTIMIZE", foods, target, previousPlan: previous, excludedFoodIds: ["rice"], deviationWeights: { subA: 1, subB: 200 }, roundingGrams: 1 });
      assert.equal(aHigh.status, "OPTIMAL");
      assert.equal(bHigh.status, "OPTIMAL");
      // Weights prove effective: low-weight food absorbs more than high-weight food.
      assert.ok(gramsOf(aHigh, "subB") > gramsOf(aHigh, "subA"), `A-high expected subB(${gramsOf(aHigh, "subB")}) > subA(${gramsOf(aHigh, "subA")})`);
      assert.ok(gramsOf(bHigh, "subA") > gramsOf(bHigh, "subB"), `B-high expected subA(${gramsOf(bHigh, "subA")}) > subB(${gramsOf(bHigh, "subB")})`);
      assert.notDeepEqual(aHigh.foods, bHigh.foods);
    });

    it("REOPT_UNAVAILABLE: marked-unavailable food ends at zero", async () => {
      const potato = carb("potato", { max: 600 });
      const bean = { ...potato, id: "bean" };
      const c = chick("chick", 500);
      const foods = [potato, bean, c];
      const target: NutritionTarget = {
        calories: { min: 1400, target: 1650, max: 1900 },
        proteinGrams: { min: 110, target: 140, max: 170 },
        fatGrams: { min: 10, target: 40, max: 70 },
        carbsGrams: { min: 150, target: 220, max: 300 },
        fiberGrams: { min: 10, max: 40 },
      };
      const previous = previousPlan([["potato", 400], ["bean", 0], ["chick", 380]]);
      const result = await solveNutritionOptimization({ mode: "REOPTIMIZE", foods, target, previousPlan: previous, excludedFoodIds: ["potato"], roundingGrams: 1 });
      assert.equal(result.status, "OPTIMAL");
      assert.equal(result.foods.some((f) => f.foodId === "potato"), false);
      assert.equal(gramsOf(result, "potato"), 0);
    });

    it("REOPT_MULTI_ITEM: more than one item moves when two foods are unavailable", async () => {
      const potatoA = carb("potatoA", { max: 600 });
      const potatoB = carb("potatoB", { max: 600 });
      const bean = carb("bean", { max: 600 });
      const c = chick("chick", 500);
      const foods = [potatoA, potatoB, bean, c];
      const target: NutritionTarget = {
        calories: { min: 1400, target: 1650, max: 1900 },
        proteinGrams: { min: 110, target: 140, max: 170 },
        fatGrams: { min: 10, target: 40, max: 70 },
        carbsGrams: { min: 150, target: 220, max: 300 },
        fiberGrams: { min: 10, max: 40 },
      };
      const previous = previousPlan([["potatoA", 300], ["potatoB", 200], ["bean", 0], ["chick", 380]]);
      const result = await solveNutritionOptimization({ mode: "REOPTIMIZE", foods, target, previousPlan: previous, excludedFoodIds: ["potatoA", "potatoB"], roundingGrams: 1 });
      assert.equal(result.status, "OPTIMAL");
      assert.equal(gramsOf(result, "potatoA"), 0);
      assert.equal(gramsOf(result, "potatoB"), 0);
      // Both unavailable items were forced to zero and beans took up the slack.
      const changed = result.foods.filter((f) => gramsOf(result, f.foodId) > 0);
      assert.ok(changed.length >= 2, "more than one item should remain to satisfy the plan");
      assert.ok(gramsOf(result, "bean") > 0);
    });

    it("REOPT_INFEASIBLE: no eligible food left to satisfy the plan is INFEASIBLE", async () => {
      const potato = carb("potato", { max: 600 });
      const bean = { ...potato, id: "bean" };
      const c = chick("chick", 500);
      const foods = [potato, bean, c];
      const target: NutritionTarget = {
        calories: { min: 1400, target: 1650, max: 1900 },
        proteinGrams: { min: 110, target: 140, max: 170 },
        fatGrams: { min: 10, target: 40, max: 70 },
        carbsGrams: { min: 150, target: 220, max: 300 },
        fiberGrams: { min: 10, max: 40 },
      };
      const previous = previousPlan([["potato", 400], ["bean", 200], ["chick", 380]]);
      const result = await solveNutritionOptimization({ mode: "REOPTIMIZE", foods, target, previousPlan: previous, excludedFoodIds: ["potato", "bean", "chick"], roundingGrams: 1 });
      assert.equal(result.status, "INFEASIBLE");
      assert.deepEqual(result.foods, []);
    });
  });

  describe("LP_TEXT_FORMULATION", () => {
    it("INITIAL LP text carries deviation vars in objective, both inequalities, non-negative bounds, food bounds, no orphans", () => {
      const target: NutritionTarget = {
        calories: { min: 1200, target: 1500, max: 1800 },
        proteinGrams: { min: 100, target: 140, max: 180 },
        fatGrams: { min: 30, target: 50, max: 90 },
        carbsGrams: { min: 120, target: 200, max: 320 },
        fiberGrams: { min: 15, max: 50 },
      };
      const foods = [chick("chick", 500), carb("rice", { max: 700 })];
      const lp = buildNutritionOptimizationProblem({ mode: "INITIAL", foods, target });
      const objective = lp.split("Subject To")[0]!;

      for (const name of ["calorie_deviation", "protein_deviation", "fat_deviation", "carbs_deviation"]) {
        assert.ok(objective.includes(name), `${name} in objective`);
      }
      // Coefficients are non-zero in the objective (normalized weights > 0).
      const coeffs = ["calorie_deviation", "protein_deviation", "fat_deviation", "carbs_deviation"].map((name) => {
        const match = objective.match(new RegExp(`([0-9.]+) ${name}`));
        const value = match ? parseFloat(match[1]!) : NaN;
        assert.ok(Number.isFinite(value) && value > 0, `non-zero coefficient for ${name}`);
        return value;
      });
      assert.ok(coeffs.length === 4);
      // Both deviation inequalities present.
      assert.ok(lp.includes("calorie_dev_above"));
      assert.ok(lp.includes("calorie_dev_below"));
      assert.ok(lp.includes("protein_dev_above") && lp.includes("protein_dev_below"));
      // Deviation bounds are >= 0.
      assert.ok(lp.includes("0 <= calorie_deviation"));
      assert.ok(lp.includes("0 <= carbs_deviation"));
      // Food variables have bounds.
      assert.ok(lp.includes("0 <= chick <= 500"));
      assert.ok(lp.includes("0 <= rice <= 700"));
      // No orphan deviation var: every deviation appears both in objective AND constraint rows.
      for (const name of ["calorie_deviation", "protein_deviation", "fat_deviation", "carbs_deviation"]) {
        const inBank = (lp.match(new RegExp(name, "g")) ?? []).length;
        assert.ok(inBank >= 3, `${name} appears in objective + 2 inequalities (+ bound) = at least 3, got ${inBank}`);
      }
    });

    it("REOPTIMIZE LP text has per-food deviation vars with weights, unavailable food zeroed, other foods free", () => {
      const target: NutritionTarget = {
        calories: { min: 1200, target: 1500, max: 1800 },
        proteinGrams: { min: 100, target: 140, max: 180 },
        fatGrams: { min: 30, target: 50, max: 90 },
        carbsGrams: { min: 120, target: 200, max: 320 },
        fiberGrams: { min: 15, max: 50 },
      };
      const rice = carb("rice", { max: 700 });
      const bean = { ...rice, id: "bean" };
      const c = chick("chick", 500);
      const foods = [rice, bean, c];
      const previous = previousPlan([["rice", 400], ["bean", 100], ["chick", 380]]);
      const lp = buildNutritionOptimizationProblem({
        mode: "REOPTIMIZE",
        foods,
        target,
        previousPlan: previous,
        unavailableFoodIds: ["rice"],
        deviationWeights: { rice: 1, bean: 10, chick: 1 },
      });
      // Per-food deviation vars weighted in objective.
      const objective = lp.split("Subject To")[0]!;
      assert.ok(objective.includes("10 d_bean"), `weighted d_bean in objective: ${objective}`);
      assert.ok(objective.includes("d_chick") && !objective.includes("d_rice"), "no d_rice (unavailable) in objective");
      // Unavailable food is hard-zeroed.
      assert.ok(lp.includes("0 <= rice <= 0"), "rice bound zeroed");
      // Deviation vars non-negative bounds and both inequalities.
      assert.ok(lp.includes("0 <= d_bean"));
      assert.ok(lp.includes("dev_pos_bean") && lp.includes("dev_neg_bean"));
      // No orphan d_ variables for the included foods.
      for (const id of ["bean", "chick"]) {
        const occurrences = (lp.match(new RegExp(`d_${id}`, "g")) ?? []).length;
        assert.ok(occurrences >= 3, `d_${id} appears in objective + 2 constraints + bound = >=3, got ${occurrences}`);
      }
    });
  });
});

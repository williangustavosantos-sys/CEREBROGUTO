import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateNutritionTarget } from "../src/v3/nutrition/target-policy.js";
import { generateOfficialDietDraft } from "../src/v3/nutrition/official-engine.js";
import { selectCandidateFoods } from "../src/v3/nutrition/catalog.js";
import { validateNutritionPlan } from "../src/v3/nutrition-engine.js";
import type { OfficialSnapshot } from "../src/v3/types.js";

function generatedFiberOf(draft: Awaited<ReturnType<typeof generateOfficialDietDraft>>): number {
  const catalog = selectCandidateFoods();
  let fiber = 0;
  for (const meal of draft.meals) {
    for (const item of meal.items) {
      const food = catalog.find((c) => c.id === item.foodId);
      if (food) fiber += (food.nutritionPer100g.fiber * item.quantityGrams) / 100;
    }
  }
  return Number(fiber.toFixed(2));
}

type ProfileInput = {
  weightKg: number;
  age: number;
  heightCm: number;
  weeklyFrequencyDaysPerWeek: number;
};

const snapshotFor = (profile: ProfileInput): OfficialSnapshot => ({
  actor: { tenantId: "t", userId: "u", externalSubject: "u", role: "student" },
  memoryVersion: 1,
  profile: {
    version: 1,
    language: "pt-BR",
    country: "Brazil",
    biologicalSex: "male",
    age: profile.age,
    weightKg: profile.weightKg,
    heightCm: profile.heightCm,
    trainingStatus: "returning",
    trainingLocation: "gym",
    weeklyFrequencyDaysPerWeek: profile.weeklyFrequencyDaysPerWeek,
  },
  goal: { version: 1, code: "muscle_gain" },
  preferences: { version: 1, dietStyle: "omnivore" },
  healthConstraints: [],
  firstContact: { status: "COMPLETED", step: "completed", foodDeclaration: "nenhuma", limitationDeclaration: "nenhuma", startedAt: null, completedAt: null, currentPrompt: null, summary: null, confirmedContextVersion: 1 },
  confirmedContext: { id: "ctx", version: 1, confirmedAt: new Date().toISOString(), foodDeclaration: "nenhuma", limitationDeclaration: "nenhuma", profileVersion: 1, goalVersion: 1, weeklyFrequencyDaysPerWeek: profile.weeklyFrequencyDaysPerWeek, trainingLocation: "gym" },
  workout: null,
  diet: null,
});

function validationOf(draft: Awaited<ReturnType<typeof generateOfficialDietDraft>>) {
  return validateNutritionPlan({
    id: "draft",
    version: 1,
    status: "draft",
    totalCalories: draft.totalCalories,
    proteinGrams: draft.proteinGrams,
    carbsGrams: draft.carbsGrams,
    fatGrams: draft.fatGrams,
    meals: draft.meals.map((meal, i) => ({
      ...meal,
      id: `m${i}`,
      items: meal.items.map((item, j) => ({ ...item, id: `i${i}${j}` })),
    })),
  });
}

type ProfileReport = {
  tdee: number;
  targetCalories: number;
  generatedCalories: number;
  calorieDeviationPct: number;
  targetProtein: number;
  generatedProtein: number;
  proteinDeviationPct: number;
  targetFat: number;
  generatedFat: number;
  targetCarbs: number;
  generatedCarbs: number;
  fiberMin: number;
  generatedFiber: number;
};

test("PROFILE_A and PROFILE_B generate muscle_gain plans above TDEE with validated macros", async () => {
  const profiles: Array<[string, number]> = [
    ["PROFILE_A", 74.8],
    ["PROFILE_B", 90],
  ];
  const reports: Array<ProfileReport & { name: string; draft?: Awaited<ReturnType<typeof generateOfficialDietDraft>> }> = [];

  for (const [name, weightKg] of profiles) {
    const snapshot = snapshotFor({ weightKg, age: 34, heightCm: 188, weeklyFrequencyDaysPerWeek: 6 });
    const target = calculateNutritionTarget(snapshot.profile, snapshot.goal);
    const draft = await generateOfficialDietDraft(snapshot);
    const validation = validationOf(draft);
    assert.equal(validation.valid, true, `${name} validation: ${validation.diagnostics.join(", ")}`);
    const report: ProfileReport & { name: string } = {
      name,
      tdee: target.tdee,
      targetCalories: target.targetCalories,
      generatedCalories: draft.totalCalories,
      calorieDeviationPct: Number((((draft.totalCalories - target.targetCalories) / target.targetCalories) * 100).toFixed(2)),
      targetProtein: target.protein.target,
      generatedProtein: draft.proteinGrams,
      proteinDeviationPct: Number((((draft.proteinGrams - target.protein.target) / target.protein.target) * 100).toFixed(2)),
      targetFat: target.fat.target,
      generatedFat: draft.fatGrams,
      targetCarbs: target.carbs.target,
      generatedCarbs: draft.carbsGrams,
      fiberMin: target.fiber.min,
      generatedFiber: generatedFiberOf(draft),
    };
    reports.push(report);

    assert.ok(draft.totalCalories > target.tdee, `${name} MUSCLE_GAIN_ABOVE_TDEE: generated ${draft.totalCalories} must exceed tdee ${target.tdee}`);
    assert.ok(draft.proteinGrams >= target.protein.min, `${name} protein ${draft.proteinGrams} >= min ${target.protein.min}`);
  }

  // Emit a machine-readable report line for the gate.
  const out = reports
    .map((r) => `${JSON.stringify({ name: r.name, tdee: r.tdee, targetCalories: r.targetCalories, generatedCalories: r.generatedCalories, calorieDeviationPct: r.calorieDeviationPct, targetProtein: r.targetProtein, generatedProtein: r.generatedProtein, proteinDeviationPct: r.proteinDeviationPct, targetFat: r.targetFat, generatedFat: r.generatedFat, targetCarbs: r.targetCarbs, generatedCarbs: r.generatedCarbs, fiberMin: r.fiberMin, generatedFiber: r.generatedFiber })}`)
    .join("\n");
  console.log("PROFILE_AB_REPORT\n" + out);
});
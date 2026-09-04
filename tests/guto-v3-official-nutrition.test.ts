import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateNutritionTarget } from "../src/v3/nutrition/target-policy.js";
import { OFFICIAL_FOOD_CATALOG, selectCandidateFoods } from "../src/v3/nutrition/catalog.js";
import { generateOfficialDietDraft } from "../src/v3/nutrition/official-engine.js";
import { filterFoodsByRestrictions } from "../src/v3/nutrition/restrictions.js";
import { validateNutritionPlan } from "../src/v3/nutrition-engine.js";
import type { OfficialSnapshot } from "../src/v3/types.js";

test("TARGET_POLICY uses frequency and produces hypertrophy targets", () => {
  const target = calculateNutritionTarget({ version: 1, language: "pt-BR", biologicalSex: "male", age: 34, weightKg: 74.8, heightCm: 188, trainingStatus: "returning", trainingLocation: "gym", weeklyFrequencyDaysPerWeek: 6 }, { version: 1, code: "hypertrophy" });
  assert.ok(target.bmr >= 1757 && target.bmr <= 1758);
  assert.equal(target.activityFactor, 1.65);
  assert.ok(target.tdee > 2372);
  assert.ok(target.targetCalories > target.tdee);
  assert.ok(target.protein.min >= 74.8 * 1.6 && target.protein.max <= 74.8 * 2.2 + 1);
  assert.equal(target.calculationMethod, "mifflin_st_jeor_frequency_policy_v2");
});

test("CATALOG_PROVENANCE and candidate pool are bounded and deterministic", () => {
  assert.ok(OFFICIAL_FOOD_CATALOG.length >= 12);
  assert.ok(OFFICIAL_FOOD_CATALOG.every((food) => food.source === "USDA_FOODDATA_CENTRAL" && food.sourceLicense === "CC0_1.0" && food.enabled));
  assert.ok(selectCandidateFoods(["rice"]).every((food) => food.id !== "rice"));
  assert.ok(selectCandidateFoods().length <= 50);
});

test("RESTRICTION_FILTER maps semantic dietary restrictions deterministically", () => {
  const declaration = "Não como carne, ovo nem glúten e tenho intolerância à lactose.";
  const eligible = new Set(filterFoodsByRestrictions(OFFICIAL_FOOD_CATALOG, declaration).map((food) => food.id));
  for (const id of ["oats", "wholegrain_bread", "pasta", "eggs", "chicken", "yogurt"]) assert.equal(eligible.has(id), false, id);
  for (const id of ["rice", "potato", "banana"]) assert.equal(eligible.has(id), true, id);
});

test("RESTRICTION_FILTER vegetarian declaration excludes meat and fish, keeps eggs/dairy", () => {
  const vegetarian = new Set(filterFoodsByRestrictions(OFFICIAL_FOOD_CATALOG, "Vegetariano.").map((food) => food.id));
  for (const id of ["chicken", "tuna"]) assert.equal(vegetarian.has(id), false, id);
  for (const id of ["eggs", "yogurt", "lentils", "rice"]) assert.equal(vegetarian.has(id), true, id);
});

test("RESTRICTION_FILTER vegan declaration excludes meat, fish, eggs and dairy", () => {
  const vegan = new Set(filterFoodsByRestrictions(OFFICIAL_FOOD_CATALOG, "Sou vegano.").map((food) => food.id));
  for (const id of ["chicken", "tuna", "eggs", "yogurt"]) assert.equal(vegan.has(id), false, id);
  for (const id of ["lentils", "beans", "rice", "banana"]) assert.equal(vegan.has(id), true, id);
});

test("RESTRICTION_FILTER plain no-meat keeps fish (pescatarian) while dropping chicken", () => {
  const noMeat = new Set(filterFoodsByRestrictions(OFFICIAL_FOOD_CATALOG, "Não como carne.").map((food) => food.id));
  assert.equal(noMeat.has("chicken"), false);
  assert.equal(noMeat.has("tuna"), true);
});

function vegetarianSnapshot(): OfficialSnapshot {
  return { actor: { tenantId: "t", userId: "u", externalSubject: "u", role: "student" }, memoryVersion: 1, profile: { version: 1, language: "pt-BR", country: "Brazil", biologicalSex: "male", age: 34, weightKg: 75, heightCm: 181, trainingStatus: "returning", trainingLocation: "gym", weeklyFrequencyDaysPerWeek: 4 }, goal: { version: 1, code: "muscle_gain" }, preferences: { version: 1 }, healthConstraints: [{ id: "c1", kind: "food_restriction", description: "Vegetariano.", severity: "unknown", confirmed: true }], firstContact: { status: "COMPLETED", step: "completed", foodDeclaration: "Vegetariano.", limitationDeclaration: "nenhuma", startedAt: null, completedAt: null, currentPrompt: null, summary: null, confirmedContextVersion: 1 }, confirmedContext: { id: "ctx", version: 1, confirmedAt: new Date().toISOString(), foodDeclaration: "Vegetariano.", limitationDeclaration: "nenhuma", profileVersion: 1, goalVersion: 1, weeklyFrequencyDaysPerWeek: 4, trainingLocation: "gym" }, workout: null, diet: null } as OfficialSnapshot;
}

test("OFFICIAL_DIET vegetarian draft never contains meat or fish", async () => {
  const draft = await generateOfficialDietDraft(vegetarianSnapshot());
  const ids = draft.meals.flatMap((meal) => meal.items.map((item) => item.foodId));
  for (const id of ["chicken", "tuna"]) assert.equal(ids.includes(id), false, id);
  assert.ok(ids.some((id) => ["eggs", "lentils", "beans"].includes(id)), "plano vegetariano precisa de fonte proteica");
});

test("DIET_PROFILE_COherence no longer returns the legacy fixed 1719/80 result", async () => {
  const snapshot = { actor: { tenantId: "t", userId: "u", externalSubject: "u", role: "student" }, memoryVersion: 1, profile: { version: 1, language: "pt-BR", country: "South Africa", biologicalSex: "male", age: 34, weightKg: 74.8, heightCm: 188, trainingStatus: "returning", trainingLocation: "gym", weeklyFrequencyDaysPerWeek: 6 }, goal: { version: 1, code: "hypertrophy" }, preferences: { version: 1, dietStyle: "vegetarian" }, healthConstraints: [], firstContact: { status: "COMPLETED", step: "completed", foodDeclaration: "sou vegetariano", limitationDeclaration: "nenhuma", startedAt: null, completedAt: null, currentPrompt: null, summary: null, confirmedContextVersion: 1 }, confirmedContext: { id: "ctx", version: 1, confirmedAt: new Date().toISOString(), foodDeclaration: "sou vegetariano", limitationDeclaration: "nenhuma", profileVersion: 1, goalVersion: 1, weeklyFrequencyDaysPerWeek: 6, trainingLocation: "gym" }, workout: null, diet: null } as OfficialSnapshot;
  const draft = await generateOfficialDietDraft(snapshot);
  assert.ok(draft.totalCalories > 0);
  assert.ok(draft.proteinGrams > 80);
  assert.equal(draft.generatedFrom.language, "pt-BR");
  assert.equal(draft.generatedFrom.country, "South Africa");
  const validation = validateNutritionPlan({ id: "draft", version: 1, status: "draft", totalCalories: draft.totalCalories, proteinGrams: draft.proteinGrams, carbsGrams: draft.carbsGrams, fatGrams: draft.fatGrams, meals: draft.meals.map((meal, i) => ({ ...meal, id: `m${i}`, items: meal.items.map((item, j) => ({ ...item, id: `i${i}${j}` })) })) });
  assert.equal(validation.valid, true, validation.diagnostics.join(","));
});

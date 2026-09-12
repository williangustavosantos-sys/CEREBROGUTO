import { currentFoodDeclaration } from "../current-food-state.js";
import { V3Error } from "../errors.js";
import type { DietPlanDraft } from "../repository.js";
import type { DietItem } from "../types.js";
import type { OfficialSnapshot } from "../types.js";
import { selectCandidateFoods, officialFoodName } from "./catalog.js";
import { filterFoodsByDeclaration } from "./restrictions.js";
import { calculateNutritionTarget } from "./target-policy.js";
import { generateOfficialNutrition, nutritionTargetFromProfile } from "./optimizer.js";
import { validateOfficialNutrition } from "./validator.js";

function locale(value: string): "pt-BR" | "en-US" | "it-IT" {
  return value === "it-IT" || value === "en-US" ? value : "pt-BR";
}


function item(foodId: string, grams: number, position: number, language: ReturnType<typeof locale>): DietItem {
  const food = selectCandidateFoods().find((candidate) => candidate.id === foodId);
  if (!food || !Number.isFinite(grams) || grams <= 0) throw new V3Error("NUTRITION_VALIDATION_FAILED", `Item inválido no plano oficial: ${foodId}.`, 409);
  const factor = grams / 100;
  const proteinGrams = Number((food.nutritionPer100g.protein * factor).toFixed(2));
  const carbsGrams = Number((food.nutritionPer100g.carbs * factor).toFixed(2));
  const fatGrams = Number((food.nutritionPer100g.fat * factor).toFixed(2));
  return {
    id: `draft-${foodId}-${position}`,
    foodId,
    name: officialFoodName(foodId, language),
    quantityGrams: grams,
    calories: Number((proteinGrams * 4 + carbsGrams * 4 + fatGrams * 9).toFixed(2)),
    proteinGrams,
    carbsGrams,
    fatGrams,
    position,
  };
}

export async function generateOfficialDietDraft(snapshot: OfficialSnapshot): Promise<DietPlanDraft> {
  if (!snapshot.confirmedContext) throw new V3Error("V3_CONFIRMED_CONTEXT_REQUIRED", "Contexto confirmado necessário para gerar dieta.", 409);
  const target = calculateNutritionTarget(snapshot.profile, snapshot.goal);
  const declaration = currentFoodDeclaration(snapshot);
  const eligible = filterFoodsByDeclaration(selectCandidateFoods(), declaration);
  if (!eligible.length) throw new V3Error("NUTRITION_PLAN_INFEASIBLE", "Nenhum alimento elegível para a dieta.", 409);
  const eligibleIds = new Set(eligible.map((food) => food.id));
  const solverTarget = nutritionTargetFromProfile(target);
  const result = await generateOfficialNutrition(solverTarget, selectCandidateFoods().filter((food) => !eligibleIds.has(food.id)).map((food) => food.id));
  validateOfficialNutrition(result, solverTarget);
  const language = locale(snapshot.profile.language);
  const solverItems = result.foods.map((food, position) => item(food.foodId, food.grams, position, language));
  if (!solverItems.length) throw new V3Error("NUTRITION_PLAN_INFEASIBLE", "O solver não produziu itens para a dieta.", 409);
  const mealNames = language === "pt-BR" ? ["Plano oficial"] : language === "it-IT" ? ["Piano ufficiale"] : ["Official plan"];
  const meal = { id: "draft-meal-0", name: mealNames[0], position: 0, calories: Number(solverItems.reduce((sum, current) => sum + current.calories, 0).toFixed(2)), items: solverItems };
  const totals = {
    totalCalories: Number(solverItems.reduce((sum, current) => sum + current.calories, 0).toFixed(2)),
    proteinGrams: Number(solverItems.reduce((sum, current) => sum + current.proteinGrams, 0).toFixed(2)),
    carbsGrams: Number(solverItems.reduce((sum, current) => sum + current.carbsGrams, 0).toFixed(2)),
    fatGrams: Number(solverItems.reduce((sum, current) => sum + current.fatGrams, 0).toFixed(2)),
  };
  return {
    ...totals,
    calculationMethod: target.calculationMethod,
    generatedFrom: {
      ...target,
      country: snapshot.profile.country ?? null,
      city: snapshot.profile.city ?? null,
      language: snapshot.profile.language,
      catalogVersion: "guto_food_catalog_usda_curated_v1",
      candidateCount: eligible.length,
      solverStatus: result.status,
      solverTimeMs: result.solverMetadata.durationMs,
      method: "highs_official_lp_v2",
      confirmedContextId: snapshot.confirmedContext.id,
      confirmedContextVersion: snapshot.confirmedContext.version,
    },
    meals: [meal],
  };
}

import { type CatalogLanguage } from "../../exercise-catalog.js";
import { type FoodLanguage } from "../food-catalog.js";
import { currentFoodDeclaration } from "./current-food-state.js";
import { literalTerm, normalizeDeclaration } from "./declaration-semantics.js";
import { filterFoodsByDeclaration } from "./nutrition/restrictions.js";
import { decideExerciseSubstitution, decideFoodSubstitution } from "./substitution-engine.js";
import { selectCandidateFoods, officialFoodName } from "./nutrition/catalog.js";
import type { ActiveContext, CandidateOption, OfficialSnapshot } from "./types.js";

export interface CandidateProvider {
  getCandidates(snapshot: OfficialSnapshot, activeContext: ActiveContext | null, message: string): Promise<CandidateOption[]>;
}

interface FoodNutritionReference {
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
}

// Compatibility export derived from the official nutrition authority.
export const V3_FOOD_NUTRITION: Record<string, FoodNutritionReference> = Object.fromEntries(selectCandidateFoods().map(food => [food.id, {
  caloriesPer100g: food.nutritionPer100g.calories, proteinPer100g: food.nutritionPer100g.protein,
  carbsPer100g: food.nutritionPer100g.carbs, fatPer100g: food.nutritionPer100g.fat,
}]));

function language(value: string): CatalogLanguage & FoodLanguage {
  return value === "it-IT" || value === "en-US" ? value : "pt-BR";
}
function foodCandidate(foodId: string, locale: FoodLanguage): CandidateOption {
  const food = selectCandidateFoods().find(food => food.id === foodId)!;
  return { id: food.id, label: officialFoodName(food.id, locale), kind: "food", purpose: food.role,
    metadata: { category: food.role, ...V3_FOOD_NUTRITION[food.id] } };
}

// Catalogs are immutable reference data only; this provider never reads or
// writes V1/V2 state and is the sole candidate source for V3 executors.
export class ConservativeCatalogCandidateProviderV3 implements CandidateProvider {
  async getCandidates(snapshot: OfficialSnapshot, activeContext: ActiveContext | null, message: string): Promise<CandidateOption[]> {
    if (!activeContext) return [];
    const locale = language(snapshot.profile.language);
    const rejected = new Set(activeContext.rejectedCandidateIds || []);
    if (activeContext.kind === "workout" && snapshot.workout?.id === activeContext.planId) {
      const current = snapshot.workout.items.find((item) => item.id === activeContext.itemId);
      if (!current) return [];
      return decideExerciseSubstitution({ snapshot, current, rejectedIds: [...rejected] }).candidates.slice(0, 8)
        .map((candidate) => ({ ...candidate, purpose: current.purpose, metadata: { ...candidate.metadata, purpose: current.purpose } }));
    }

    if (activeContext.kind === "diet" && snapshot.diet?.id === activeContext.planId) {
      const current = snapshot.diet.meals.flatMap((meal) => meal.items).find((item) => item.id === activeContext.itemId);
      if (!current) return [];
      const currentFood = selectCandidateFoods().find(food => food.id === current.foodId);
      if (!currentFood) return [];
      const normalizedMessage = normalizeDeclaration(message);
      const eligible = filterFoodsByDeclaration(selectCandidateFoods(), currentFoodDeclaration(snapshot))
        .filter(food => food.role === currentFood.role && food.id !== current.foodId && !rejected.has(food.id));
      const explicitlyProposed = eligible.find(food => [food.id, food.canonicalName, ...food.aliases]
        .some(name => literalTerm(name).test(normalizedMessage)));
      const ordered = explicitlyProposed ? [explicitlyProposed, ...eligible.filter(food => food.id !== explicitlyProposed.id)] : eligible;
      const candidates = ordered.slice(0, 8).map(food => foodCandidate(food.id, locale));
      return decideFoodSubstitution({ snapshot, current, message, candidates }).candidates;
    }
    return [];
  }
}

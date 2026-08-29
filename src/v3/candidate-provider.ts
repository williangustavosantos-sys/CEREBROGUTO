import { type CatalogLanguage } from "../../exercise-catalog.js";
import { getFoodById, resolveFoodIdByName, type FoodLanguage } from "../food-catalog.js";
import { suggestFoodSubstitutes } from "../food-availability.js";
import { conflictsWithFoodDeclaration } from "./food-declaration-policy.js";
import { decideExerciseSubstitution, decideFoodSubstitution } from "./substitution-engine.js";
import { selectCandidateFoods } from "./nutrition/catalog.js";
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

export const V3_FOOD_NUTRITION: Record<string, FoodNutritionReference> = {
  banana: { caloriesPer100g: 89, proteinPer100g: 1.1, carbsPer100g: 22.8, fatPer100g: 0.3 },
  apple: { caloriesPer100g: 52, proteinPer100g: 0.3, carbsPer100g: 13.8, fatPer100g: 0.2 },
  berries: { caloriesPer100g: 57, proteinPer100g: 0.7, carbsPer100g: 14.5, fatPer100g: 0.3 },
  wholegrain_bread: { caloriesPer100g: 247, proteinPer100g: 13, carbsPer100g: 41, fatPer100g: 4.2 },
  oats: { caloriesPer100g: 389, proteinPer100g: 16.9, carbsPer100g: 66.3, fatPer100g: 6.9 },
  rice: { caloriesPer100g: 128, proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3 },
  potato: { caloriesPer100g: 87, proteinPer100g: 1.9, carbsPer100g: 20.1, fatPer100g: 0.1 },
  sweet_potato: { caloriesPer100g: 86, proteinPer100g: 1.6, carbsPer100g: 20.1, fatPer100g: 0.1 },
  eggs: { caloriesPer100g: 143, proteinPer100g: 12.6, carbsPer100g: 0.7, fatPer100g: 9.5 },
  tofu: { caloriesPer100g: 120, proteinPer100g: 12, carbsPer100g: 2.9, fatPer100g: 7 },
  lentils: { caloriesPer100g: 116, proteinPer100g: 9, carbsPer100g: 20, fatPer100g: 0.4 },
  beans: { caloriesPer100g: 127, proteinPer100g: 8.7, carbsPer100g: 22.8, fatPer100g: 0.5 },
};

function language(value: string): CatalogLanguage & FoodLanguage {
  return value === "it-IT" || value === "en-US" ? value : "pt-BR";
}

function foodCandidate(foodId: string, locale: FoodLanguage): CandidateOption | null {
  const food = getFoodById(foodId);
  const nutrition = V3_FOOD_NUTRITION[foodId];
  // Only candidates the shared LP solver can actually place may be offered:
  // the solver pool is the V3 official catalog, which is a strict subset of
  // the legacy availability catalog. Offering a food absent from it makes the
  // solver report a false INFEASIBLE for a candidate it can never select.
  if (!food || !nutrition || !selectCandidateFoods().some((item) => item.id === foodId)) return null;
  return {
    id: food.id,
    label: food.names[locale] || food.names["en-US"],
    kind: "food",
    purpose: food.category,
    metadata: { category: food.category, ...nutrition },
  };
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
      const explicitlyProposed = resolveFoodIdByName(message);
      const suggested = suggestFoodSubstitutes({ originalFoodId: current.foodId, useContext: "meal_substitution" });
      const ids = [explicitlyProposed, ...suggested.map((food) => food.id)]
        .filter((id): id is string => Boolean(id))
        .filter((id, index, all) => all.indexOf(id) === index && !rejected.has(id))
        .filter((id) => !conflictsWithFoodDeclaration(id, snapshot.confirmedContext?.foodDeclaration || ""));
      const candidates = ids.map((id) => foodCandidate(id, locale)).filter((item): item is CandidateOption => item !== null).slice(0, 8);
      return decideFoodSubstitution({ snapshot, current, message, candidates }).candidates;
    }
    return [];
  }
}

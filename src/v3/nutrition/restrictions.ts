import type { OfficialFoodCatalogItem } from "./catalog.js";

import { interpretFoodDeclaration, namedFoodExcluded, type FoodRestriction } from "../declaration-semantics.js";

export type DietaryRestriction = FoodRestriction;
const FLESH_FOOD_IDS = new Set(["chicken", "tuna"]);

export function normalizeDietaryRestrictions(declaration: string): Set<DietaryRestriction> {
  return interpretFoodDeclaration(declaration).restrictions;
}

export function isFoodEligibleForRestrictions(food: OfficialFoodCatalogItem, restrictions: ReadonlySet<DietaryRestriction>): boolean {
  if (restrictions.has("gluten_free") && !food.dietaryProperties.strictGlutenFreeEligible) return false;
  if (restrictions.has("lactose_free") && food.dietaryProperties.containsLactose) return false;
  if (restrictions.has("no_egg") && food.dietaryProperties.containsEgg) return false;
  if (restrictions.has("no_meat") && food.dietaryProperties.containsMeat) return false;
  if (restrictions.has("no_fish") && FLESH_FOOD_IDS.has(food.id)) return false;
  return true;
}

export function filterFoodsByRestrictions(foods: readonly OfficialFoodCatalogItem[], declaration: string): OfficialFoodCatalogItem[] {
  return foods.filter((food) => isFoodEligibleForRestrictions(food, normalizeDietaryRestrictions(declaration)));
}

/**
 * Named-food exclusion over the official catalog. A declaration that literally
 * names a food (e.g. "não como batata") must remove it, even when no macro
 * restriction is implied, so FOOD_EXCLUSION facts keep their authority.
 * ID, canonical name and aliases are normalized and matched against the
 * declaration. Only declarations with an explicit exclusion/avoidance signal
 * trigger the named check (a bare mention never does).
 */
export function declarationExcludesFood(food: OfficialFoodCatalogItem, declaration: string): boolean {
  return namedFoodExcluded(declaration, [food.id, food.canonicalName,
    ...Object.values(food.aliases).filter((value): value is string => Boolean(value))]);
}

export function filterFoodsByDeclaration(foods: readonly OfficialFoodCatalogItem[], declaration: string): OfficialFoodCatalogItem[] {
  const restricted = filterFoodsByRestrictions(foods, declaration);
  return restricted.filter((food) => !declarationExcludesFood(food, declaration));
}

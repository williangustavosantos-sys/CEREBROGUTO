import type { OfficialFoodCatalogItem } from "./catalog.js";

export type DietaryRestriction = "gluten_free" | "lactose_free" | "no_egg" | "no_meat";

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function normalizeDietaryRestrictions(declaration: string): Set<DietaryRestriction> {
  const text = normalize(declaration);
  const restrictions = new Set<DietaryRestriction>();
  if (/\b(gluten|glúten|celiac|celiaco|celiaca)\b/u.test(text)) restrictions.add("gluten_free");
  if (/\b(lactose|lattosio|intolerancia a lactose|leite|latte|milk|dairy)\b/u.test(text)) restrictions.add("lactose_free");
  if (/\b(ovo|ovos|egg|eggs|uovo|uova)\b/u.test(text)) restrictions.add("no_egg");
  if (/\b(carne|meat|carne vermelha|frango|pollo|chicken|turkey|peru)\b/u.test(text)) restrictions.add("no_meat");
  return restrictions;
}

export function isFoodEligibleForRestrictions(food: OfficialFoodCatalogItem, restrictions: ReadonlySet<DietaryRestriction>): boolean {
  if (restrictions.has("gluten_free") && !food.dietaryProperties.strictGlutenFreeEligible) return false;
  if (restrictions.has("lactose_free") && food.dietaryProperties.containsLactose) return false;
  if (restrictions.has("no_egg") && food.dietaryProperties.containsEgg) return false;
  if (restrictions.has("no_meat") && food.dietaryProperties.containsMeat) return false;
  return true;
}

export function filterFoodsByRestrictions(foods: readonly OfficialFoodCatalogItem[], declaration: string): OfficialFoodCatalogItem[] {
  return foods.filter((food) => isFoodEligibleForRestrictions(food, normalizeDietaryRestrictions(declaration)));
}

import type { OfficialFoodCatalogItem } from "./catalog.js";

export type DietaryRestriction = "gluten_free" | "lactose_free" | "no_egg" | "no_meat" | "no_fish";

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Official catalog flesh foods (per food-declaration-policy semantics). */
const FLESH_FOOD_IDS = new Set(["chicken", "tuna"]);

export function normalizeDietaryRestrictions(declaration: string): Set<DietaryRestriction> {
  const text = normalize(declaration);
  const restrictions = new Set<DietaryRestriction>();
  const vegan = /\b(vegan|vegano|vegana)\b/u.test(text);
  // Veg* explícito: exclui carne E peixe (mesma semântica do
  // conflictsWithFoodDeclaration usado pelo substitution engine).
  const vegetarian = vegan || /\b(vegetarian|vegetariano|vegetariana)\b/u.test(text);
  if (/\b(gluten|glúten|celiac|celiaco|celiaca)\b/u.test(text)) restrictions.add("gluten_free");
  if (/\b(lactose|lattosio|intolerancia a lactose|leite|latte|milk|dairy)\b/u.test(text) || vegan) restrictions.add("lactose_free");
  if (/\b(ovo|ovos|egg|eggs|uovo|uova)\b/u.test(text) || vegan) restrictions.add("no_egg");
  if (/\b(carne|meat|carne vermelha|frango|pollo|chicken|turkey|peru)\b/u.test(text) || vegetarian) restrictions.add("no_meat");
  if (vegetarian) restrictions.add("no_fish");
  return restrictions;
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
  const declared = normalize(declaration);
  if (!declared) return false;
  const isExclusion = /\b(nao como|nao consumo|nao[ -]?posso|sem|evito|evita|excluo|intoler|alerg|evitar)\b/u.test(declared);
  if (!isExclusion) return false;
  const mentions = [food.id, food.canonicalName, ...Object.values(food.aliases)]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalize(value))
    .filter((value) => value.length >= 3);
  return mentions.some((name) => new RegExp(`\\b${name}s?\\b`, "u").test(declared));
}

export function filterFoodsByDeclaration(foods: readonly OfficialFoodCatalogItem[], declaration: string): OfficialFoodCatalogItem[] {
  const restricted = filterFoodsByRestrictions(foods, declaration);
  return restricted.filter((food) => !declarationExcludesFood(food, declaration));
}

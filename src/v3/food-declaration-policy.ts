import { getFoodById } from "../food-catalog.js";

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const NONE_DECLARED = /^\s*(sem restricoes?( alimentares?)?( declaradas?)?|nenhuma restricao( alimentar)?|no restrictions?( declared)?|none|nessuna restrizione( alimentare)?)([.!])?\s*$/u;
const RESTRICTION_MARKER = /\b(nao como|nao consumo|evito|evitar|sem|alerg|intoler|non mangio|senza|avoid|allerg|intoler)\b/u;

/** Pure, deterministic enforcement over the user's literal declaration. */
export function conflictsWithFoodDeclaration(foodId: string, declaration: string): boolean {
  const food = getFoodById(foodId);
  if (!food) return true;
  const declared = normalize(declaration);
  if (NONE_DECLARED.test(declared)) return false;

  const vegan = /\b(vegan|vegano|vegana)\b/u.test(declared);
  const vegetarian = /\b(vegetarian|vegetariano|vegetariana|nao (como|consumo) carne|non mangio carne|no meat)\b/u.test(declared);
  const avoidsEgg = /\b(ovo|ovos|egg|eggs|uovo|uova)\b/u.test(declared);
  const avoidsGluten = /\b(gluten|celiac|celiaco|celiaca)\b/u.test(declared);
  const avoidsMilk = /\b(lactose|lattosio|leite|latte|milk|dairy)\b/u.test(declared);
  const avoidsFish = /\b(peixe|peixes|fish|pesce|atum|tuna|tonno)\b/u.test(declared);

  if (vegan && (food.category === "dairy" || ["eggs", "chicken_breast", "tuna_canned", "white_fish", "bresaola"].includes(food.id))) return true;
  if (vegetarian && ["chicken_breast", "tuna_canned", "white_fish", "bresaola"].includes(food.id)) return true;
  if (avoidsEgg && food.allergens?.includes("egg")) return true;
  if (avoidsGluten && food.allergens?.includes("gluten")) return true;
  if (avoidsMilk && (food.category === "dairy" || food.allergens?.includes("milk"))) return true;
  if (avoidsFish && food.allergens?.includes("fish")) return true;
  if (!RESTRICTION_MARKER.test(declared)) return false;

  const names = [food.id.replaceAll("_", " "), ...Object.values(food.names), ...Object.values(food.aliases || {}).flat()]
    .filter((name): name is string => Boolean(name))
    .map(normalize)
    .filter((name) => name.length >= 3);
  return names.some((name) => declared.includes(name));
}

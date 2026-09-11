import { getFoodById } from "../food-catalog.js";
import { interpretFoodDeclaration, namedFoodExcluded } from "./declaration-semantics.js";

/** Both catalog adapters consume the same interpreted restriction state. */
export function conflictsWithFoodDeclaration(foodId: string, declaration: string): boolean {
  const food = getFoodById(foodId);
  if (!food) return true;
  const { restrictions } = interpretFoodDeclaration(declaration);
  if (restrictions.has("no_meat") && ["chicken_breast", "bresaola"].includes(food.id)) return true;
  if (restrictions.has("no_fish") && ["tuna_canned", "white_fish"].includes(food.id)) return true;
  if (restrictions.has("no_egg") && food.allergens?.includes("egg")) return true;
  if (restrictions.has("gluten_free") && food.allergens?.includes("gluten")) return true;
  if (restrictions.has("lactose_free") && (food.category === "dairy" || food.allergens?.includes("milk"))) return true;
  return namedFoodExcluded(declaration, [food.id.replaceAll("_", " "), ...Object.values(food.names),
    ...Object.values(food.aliases || {}).flat()].filter((name): name is string => Boolean(name)));
}

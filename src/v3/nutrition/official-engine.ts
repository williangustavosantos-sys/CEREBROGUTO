import { V3Error } from "../errors.js";
import type { DietPlanDraft } from "../repository.js";
import type { OfficialSnapshot } from "../types.js";
import { selectCandidateFoods } from "./catalog.js";
import { filterFoodsByRestrictions } from "./restrictions.js";
import { calculateNutritionTarget } from "./target-policy.js";

function locale(value: string) { return value === "it-IT" || value === "en-US" ? value : "pt-BR"; }
function excluded(declaration: string, food: { id: string; aliases: string[] }) { const text = declaration.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); return food.aliases.concat(food.id).some((alias) => text.includes(alias.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase())); }

export function generateOfficialDietDraft(snapshot: OfficialSnapshot): DietPlanDraft {
  if (!snapshot.confirmedContext) throw new V3Error("V3_CONFIRMED_CONTEXT_REQUIRED", "Contexto confirmado necessário para gerar dieta.", 409);
  const target = calculateNutritionTarget(snapshot.profile, snapshot.goal);
  const declaration = snapshot.confirmedContext.foodDeclaration || "";
  const candidates = filterFoodsByRestrictions(selectCandidateFoods(), declaration).filter((food) => !excluded(declaration, food)).slice(0, 50);
  if (!candidates.length) throw new V3Error("NUTRITION_PLAN_INFEASIBLE", "Nenhum alimento seguro disponível para a dieta.", 409);
  const protein = candidates.find((food) => food.role === "protein_primary" && !excluded(declaration, food)) || candidates.find((food) => food.role === "protein_primary");
  const carb = candidates.find((food) => food.role === "carb_primary" && !excluded(declaration, food)) || candidates.find((food) => food.role === "carb_primary");
  const fruit = candidates.find((food) => food.role === "fruit" && !excluded(declaration, food)) || candidates.find((food) => food.role === "fruit");
  const fat = candidates.find((food) => food.role === "fat");
  if (!protein || !carb || !fruit || !fat) throw new V3Error("NUTRITION_PLAN_INFEASIBLE", "Catálogo insuficiente para a dieta.", 409);
  const language = locale(snapshot.profile.language);
  const names: Record<string, Record<string, string>> = { oats: { "pt-BR": "Aveia", "it-IT": "Avena", "en-US": "Oats" }, rice: { "pt-BR": "Arroz", "it-IT": "Riso", "en-US": "Rice" }, potato: { "pt-BR": "Batata", "it-IT": "Patata", "en-US": "Potato" }, pasta: { "pt-BR": "Massa", "it-IT": "Pasta", "en-US": "Pasta" }, wholegrain_bread: { "pt-BR": "Pão integral", "it-IT": "Pane integrale", "en-US": "Whole grain bread" }, chicken: { "pt-BR": "Frango", "it-IT": "Pollo", "en-US": "Chicken" }, eggs: { "pt-BR": "Ovos", "it-IT": "Uova", "en-US": "Eggs" }, tuna: { "pt-BR": "Atum", "it-IT": "Tonno", "en-US": "Tuna" }, banana: { "pt-BR": "Banana", "it-IT": "Banana", "en-US": "Banana" }, apple: { "pt-BR": "Maçã", "it-IT": "Mela", "en-US": "Apple" }, orange: { "pt-BR": "Laranja", "it-IT": "Arancia", "en-US": "Orange" }, olive_oil: { "pt-BR": "Azeite", "it-IT": "Olio d'oliva", "en-US": "Olive oil" } };
  const item = (food: typeof protein, grams: number, position: number) => { const n = food.nutritionPer100g; const f = grams / 100; const p = Number((n.protein * f).toFixed(2)); const c = Number((n.carbs * f).toFixed(2)); const fatG = Number((n.fat * f).toFixed(2)); return { foodId: food.id, name: names[food.id]?.[language] || food.canonicalName, quantityGrams: grams, calories: Number((p * 4 + c * 4 + fatG * 9).toFixed(2)), proteinGrams: p, carbsGrams: c, fatGrams: fatG, position }; };
  const foods = [item(carb, 100, 0), item(fruit, 150, 1), item(protein, 180, 0), item(carb, 250, 1), item(fat, 10, 2), item(fruit, 150, 0), item(protein, 180, 1), item(carb, 250, 2), item(fat, 10, 3)];
  const mealNames = language === "pt-BR" ? ["Café da manhã", "Almoço", "Lanche", "Jantar"] : language === "it-IT" ? ["Colazione", "Pranzo", "Spuntino", "Cena"] : ["Breakfast", "Lunch", "Snack", "Dinner"];
  const groups = [[foods[0], foods[1]], [foods[2], foods[3], foods[4]], [foods[5]], [foods[6], foods[7], foods[8]]];
  const meals = groups.map((items, position) => ({ name: mealNames[position], position, calories: Number(items.reduce((sum, i) => sum + i.calories, 0).toFixed(2)), items }));
  const all = meals.flatMap((meal) => meal.items); const sum = (key: "calories" | "proteinGrams" | "carbsGrams" | "fatGrams") => Number(all.reduce((total, current) => total + current[key], 0).toFixed(2));
  return { totalCalories: sum("calories"), proteinGrams: sum("proteinGrams"), carbsGrams: sum("carbsGrams"), fatGrams: sum("fatGrams"), calculationMethod: target.calculationMethod, generatedFrom: { ...target, country: snapshot.profile.country ?? null, city: snapshot.profile.city ?? null, language: snapshot.profile.language, catalogVersion: "guto_food_catalog_usda_curated_v1", candidateCount: candidates.length, method: "guto_target_policy_curated_catalog_v1", confirmedContextId: snapshot.confirmedContext.id, confirmedContextVersion: snapshot.confirmedContext.version }, meals };
}

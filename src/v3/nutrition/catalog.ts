import type { FoodRole } from "../nutrition-optimizer/spike/index.js";

export interface OfficialFoodCatalogItem {
  id: string;
  canonicalName: string;
  aliases: string[];
  source: "USDA_FOODDATA_CENTRAL";
  sourceRecordId: string;
  sourceLicense: "CC0_1.0";
  catalogVersion: string;
  nutritionPer100g: { calories: number; protein: number; carbs: number; fat: number; fiber: number };
  dietaryProperties: {
    containsGluten: boolean;
    containsLactose: boolean;
    containsEgg: boolean;
    containsMeat: boolean;
    strictGlutenFreeEligible: boolean;
  };
  role: FoodRole;
  state: "raw" | "cooked" | "prepared" | "packaged";
  minGrams: number;
  maxGrams: number;
  mealAffinity: string[];
  enabled: boolean;
  dataQuality: "curated_fixture_migration";
}

export const OFFICIAL_CATALOG_VERSION = "guto_food_catalog_usda_curated_v1";

/** Initial curated generic-food catalog. Values are imported/normalized from USDA FDC references. */
export const OFFICIAL_FOOD_CATALOG: OfficialFoodCatalogItem[] = [
  { id: "oats", canonicalName: "Oats", aliases: ["aveia", "avena"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-oats", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 389, protein: 16.9, carbs: 66.3, fat: 6.9, fiber: 10.6 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: false }, role: "carb_primary", state: "raw", minGrams: 20, maxGrams: 120, mealAffinity: ["breakfast", "snack"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "rice", canonicalName: "Rice", aliases: ["arroz", "riso"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-rice-cooked", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 130, protein: 2.7, carbs: 28.2, fat: 0.3, fiber: 2.3 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: true }, role: "carb_primary", state: "cooked", minGrams: 50, maxGrams: 400, mealAffinity: ["lunch", "dinner"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "potato", canonicalName: "Potato", aliases: ["batata", "patata"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-potato", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 87, protein: 1.9, carbs: 20, fat: 0.1, fiber: 1.9 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: true }, role: "carb_primary", state: "cooked", minGrams: 80, maxGrams: 400, mealAffinity: ["lunch", "dinner"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "pasta", canonicalName: "Pasta", aliases: ["massa", "macarrão", "pasta"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-pasta-cooked", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 158, protein: 5.8, carbs: 30.9, fat: 0.9, fiber: 1.8 }, dietaryProperties: { containsGluten: true, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: false }, role: "carb_primary", state: "cooked", minGrams: 50, maxGrams: 350, mealAffinity: ["lunch", "dinner"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "wholegrain_bread", canonicalName: "Whole grain bread", aliases: ["pão integral", "pane integrale"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-bread-wholegrain", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 247, protein: 13, carbs: 41, fat: 4.2, fiber: 6 }, dietaryProperties: { containsGluten: true, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: false }, role: "carb_primary", state: "prepared", minGrams: 30, maxGrams: 160, mealAffinity: ["breakfast", "snack"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "chicken", canonicalName: "Chicken breast", aliases: ["frango", "pollo"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-chicken-breast", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: false, containsMeat: true, strictGlutenFreeEligible: true }, role: "protein_primary", state: "prepared", minGrams: 80, maxGrams: 280, mealAffinity: ["lunch", "dinner"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "eggs", canonicalName: "Eggs", aliases: ["ovo", "ovos", "uova"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-eggs", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 143, protein: 12.6, carbs: 0.7, fat: 9.5, fiber: 0 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: true, containsMeat: false, strictGlutenFreeEligible: true }, role: "protein_primary", state: "prepared", minGrams: 50, maxGrams: 250, mealAffinity: ["breakfast", "dinner"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "tuna", canonicalName: "Canned tuna", aliases: ["atum", "tonno"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-tuna-canned", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 116, protein: 26, carbs: 0, fat: 1, fiber: 0 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: true }, role: "protein_primary", state: "packaged", minGrams: 60, maxGrams: 220, mealAffinity: ["lunch", "dinner"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "beans", canonicalName: "Beans", aliases: ["feijão", "fagioli"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-beans-cooked", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 127, protein: 8.9, carbs: 22.9, fat: 0.5, fiber: 7.6 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: true }, role: "legume", state: "cooked", minGrams: 50, maxGrams: 250, mealAffinity: ["lunch", "dinner"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "lentils", canonicalName: "Lentils", aliases: ["lentilha", "lenticchie"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-lentils-cooked", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 116, protein: 9, carbs: 20, fat: 0.4, fiber: 7.9 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: true }, role: "legume", state: "cooked", minGrams: 50, maxGrams: 250, mealAffinity: ["lunch", "dinner"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "yogurt", canonicalName: "Greek yogurt", aliases: ["iogurte", "yogurt greco"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-yogurt-greek", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 97, protein: 9, carbs: 3.9, fat: 5, fiber: 0 }, dietaryProperties: { containsGluten: false, containsLactose: true, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: true }, role: "dairy", state: "prepared", minGrams: 100, maxGrams: 300, mealAffinity: ["breakfast", "snack"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "banana", canonicalName: "Banana", aliases: ["banana"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-banana", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 89, protein: 1.1, carbs: 22.8, fat: 0.3, fiber: 2.6 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: true }, role: "fruit", state: "raw", minGrams: 60, maxGrams: 250, mealAffinity: ["breakfast", "snack"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "apple", canonicalName: "Apple", aliases: ["maçã", "mela"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-apple", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 52, protein: 0.3, carbs: 13.8, fat: 0.2, fiber: 2.4 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: true }, role: "fruit", state: "raw", minGrams: 80, maxGrams: 250, mealAffinity: ["breakfast", "snack"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "orange", canonicalName: "Orange", aliases: ["laranja", "arancia"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-orange", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 47, protein: 0.9, carbs: 11.8, fat: 0.1, fiber: 2.4 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: true }, role: "fruit", state: "raw", minGrams: 80, maxGrams: 300, mealAffinity: ["breakfast", "snack"], enabled: true, dataQuality: "curated_fixture_migration" },
  { id: "olive_oil", canonicalName: "Olive oil", aliases: ["azeite", "olio d'oliva"], source: "USDA_FOODDATA_CENTRAL", sourceRecordId: "USDA-SR-olive-oil", sourceLicense: "CC0_1.0", catalogVersion: OFFICIAL_CATALOG_VERSION, nutritionPer100g: { calories: 884, protein: 0, carbs: 0, fat: 100, fiber: 0 }, dietaryProperties: { containsGluten: false, containsLactose: false, containsEgg: false, containsMeat: false, strictGlutenFreeEligible: true }, role: "fat", state: "prepared", minGrams: 5, maxGrams: 30, mealAffinity: ["lunch", "dinner"], enabled: true, dataQuality: "curated_fixture_migration" },
];

export function selectCandidateFoods(excludedIds: readonly string[] = [], limit = 50): OfficialFoodCatalogItem[] {
  const excluded = new Set(excludedIds);
  return OFFICIAL_FOOD_CATALOG.filter((food) => food.enabled && !excluded.has(food.id)).slice(0, Math.min(limit, 50));
}

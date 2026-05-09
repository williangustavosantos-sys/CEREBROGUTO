/**
 * GUTO Food Catalog
 *
 * Lista validada de alimentos com identificadores estáveis, nomes em 4 idiomas
 * e disponibilidade por país. Esse arquivo é DADO, não lógica — toda a decisão
 * sobre o que pode entrar na dieta vive em `food-availability.ts`.
 *
 * Princípio: language escreve, country alimenta. Os nomes em 4 idiomas servem
 * só para renderização. As bases de cada país controlam o que vai pro plano.
 */

export type FoodLanguage = "pt-BR" | "it-IT" | "en-US" | "es-ES";

export type FoodCountry =
  | "italy"
  | "brazil"
  | "spain"
  | "portugal"
  | "usa"
  | "uk"
  | "germany"
  | "france"
  | "argentina";

export type FoodCategory =
  | "protein"
  | "carb"
  | "fat"
  | "vegetable"
  | "fruit"
  | "dairy"
  | "legume"
  | "snack";

export type FoodAvailability = "common" | "available" | "rare" | "avoid";

export interface FoodItem {
  id: string;
  category: FoodCategory;
  names: Record<FoodLanguage, string>;
  aliases?: Partial<Record<FoodLanguage, string[]>>;
  countries: Partial<Record<FoodCountry, FoodAvailability>>;
  /** Free-form tags useful for meal block selection (e.g. "breakfast", "high_protein", "gluten_free"). */
  tags?: string[];
  /** Stable allergen identifiers (e.g. "milk", "egg", "peanut", "gluten", "soy", "shellfish"). */
  allergens?: string[];
  /**
   * Resolved restriction tags that should EXCLUDE this food. Examples:
   * "lactose_intolerance", "milk_allergy", "vegan", "no_pork".
   */
  avoidIf?: string[];
  /** Default substitute IDs grouped by category. Optional — availability lookup is the canonical fallback. */
  substitutes?: string[];
}

// ─── Catálogo seed ────────────────────────────────────────────────────────────
// Suficiente para café/almoço/jantar e cobertura BR + IT + ES + PT.
// Não é a lista final — é a semente. Adicione mais conforme as MealBlocks crescerem.

export const foodCatalog: FoodItem[] = [
  // ── Proteínas ──────────────────────────────────────────────────────────────
  {
    id: "chicken_breast",
    category: "protein",
    names: {
      "pt-BR": "frango grelhado",
      "it-IT": "pollo grigliato",
      "en-US": "grilled chicken",
      "es-ES": "pollo a la plancha",
    },
    aliases: {
      "pt-BR": ["frango", "peito de frango"],
      "it-IT": ["pollo", "petto di pollo"],
      "en-US": ["chicken", "chicken breast"],
      "es-ES": ["pollo", "pechuga de pollo"],
    },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["high_protein", "lean", "lunch", "dinner"],
    substitutes: ["tuna_canned", "eggs", "white_fish"],
  },
  {
    id: "tuna_canned",
    category: "protein",
    names: {
      "pt-BR": "atum em conserva",
      "it-IT": "tonno in scatola",
      "en-US": "canned tuna",
      "es-ES": "atún en conserva",
    },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "available", france: "common", argentina: "common" },
    tags: ["high_protein", "fast", "lunch"],
    allergens: ["fish"],
    substitutes: ["chicken_breast", "eggs"],
  },
  {
    id: "eggs",
    category: "protein",
    names: { "pt-BR": "ovos", "it-IT": "uova", "en-US": "eggs", "es-ES": "huevos" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["high_protein", "breakfast", "snack"],
    allergens: ["egg"],
    substitutes: ["greek_yogurt", "tuna_canned"],
  },
  {
    id: "white_fish",
    category: "protein",
    names: { "pt-BR": "peixe branco", "it-IT": "pesce bianco", "en-US": "white fish", "es-ES": "pescado blanco" },
    countries: { italy: "common", brazil: "available", spain: "common", portugal: "common", usa: "available", uk: "common", germany: "available", france: "common", argentina: "available" },
    tags: ["high_protein", "lean", "dinner"],
    allergens: ["fish"],
    substitutes: ["chicken_breast", "tuna_canned"],
  },
  {
    id: "bresaola",
    category: "protein",
    names: { "pt-BR": "bresaola", "it-IT": "bresaola", "en-US": "bresaola", "es-ES": "bresaola" },
    countries: { italy: "common", brazil: "rare", spain: "available", portugal: "rare", usa: "rare", uk: "available", germany: "available", france: "available", argentina: "rare" },
    tags: ["high_protein", "snack"],
    substitutes: ["chicken_breast", "tuna_canned"],
  },

  // ── Carboidratos ───────────────────────────────────────────────────────────
  {
    id: "rice",
    category: "carb",
    names: { "pt-BR": "arroz", "it-IT": "riso", "en-US": "rice", "es-ES": "arroz" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["lunch", "dinner"],
    substitutes: ["pasta", "potato", "oats"],
  },
  {
    id: "pasta",
    category: "carb",
    names: { "pt-BR": "macarrão", "it-IT": "pasta", "en-US": "pasta", "es-ES": "pasta" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["lunch", "dinner"],
    allergens: ["gluten"],
    substitutes: ["rice", "potato"],
  },
  {
    id: "oats",
    category: "carb",
    names: { "pt-BR": "aveia", "it-IT": "avena", "en-US": "oats", "es-ES": "avena" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["breakfast", "fiber"],
    allergens: ["gluten"],
    substitutes: ["wholegrain_bread", "rice_cakes"],
  },
  {
    id: "wholegrain_bread",
    category: "carb",
    names: { "pt-BR": "pão integral", "it-IT": "pane integrale", "en-US": "whole grain bread", "es-ES": "pan integral" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["breakfast", "snack"],
    allergens: ["gluten"],
    substitutes: ["oats", "rice_cakes", "potato"],
  },
  {
    id: "potato",
    category: "carb",
    names: { "pt-BR": "batata", "it-IT": "patata", "en-US": "potato", "es-ES": "patata" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["lunch", "dinner"],
    substitutes: ["rice", "sweet_potato"],
  },
  {
    id: "sweet_potato",
    category: "carb",
    names: { "pt-BR": "batata-doce", "it-IT": "patata dolce", "en-US": "sweet potato", "es-ES": "batata" },
    countries: { italy: "available", brazil: "common", spain: "available", portugal: "available", usa: "common", uk: "common", germany: "available", france: "available", argentina: "common" },
    tags: ["lunch", "dinner"],
    substitutes: ["potato", "rice"],
  },
  {
    id: "tapioca",
    category: "carb",
    names: { "pt-BR": "tapioca", "it-IT": "tapioca", "en-US": "tapioca", "es-ES": "tapioca" },
    countries: { italy: "rare", brazil: "common", spain: "rare", portugal: "available", usa: "rare", uk: "rare", germany: "rare", france: "rare", argentina: "rare" },
    tags: ["breakfast", "gluten_free"],
    substitutes: ["oats", "wholegrain_bread", "rice_cakes"],
  },

  // ── Laticínios ─────────────────────────────────────────────────────────────
  {
    id: "greek_yogurt",
    category: "dairy",
    names: { "pt-BR": "iogurte grego", "it-IT": "yogurt greco", "en-US": "Greek yogurt", "es-ES": "yogur griego" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "available" },
    tags: ["breakfast", "snack", "high_protein"],
    allergens: ["milk"],
    avoidIf: ["lactose_intolerance", "milk_allergy", "vegan"],
    substitutes: ["soy_yogurt", "eggs"],
  },
  {
    id: "soy_yogurt",
    category: "dairy",
    names: { "pt-BR": "iogurte de soja", "it-IT": "yogurt di soia", "en-US": "soy yogurt", "es-ES": "yogur de soja" },
    countries: { italy: "available", brazil: "available", spain: "available", portugal: "available", usa: "available", uk: "available", germany: "common", france: "available", argentina: "rare" },
    tags: ["breakfast", "snack"],
    allergens: ["soy"],
    substitutes: ["greek_yogurt"],
  },
  {
    id: "cottage_cheese",
    category: "dairy",
    names: { "pt-BR": "cottage", "it-IT": "ricotta", "en-US": "cottage cheese", "es-ES": "queso fresco" },
    countries: { italy: "common", brazil: "available", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "available" },
    tags: ["breakfast", "snack", "high_protein"],
    allergens: ["milk"],
    avoidIf: ["lactose_intolerance", "milk_allergy", "vegan"],
    substitutes: ["greek_yogurt", "eggs"],
  },

  // ── Frutas / verduras / leguminosas / gorduras ─────────────────────────────
  {
    id: "banana",
    category: "fruit",
    names: { "pt-BR": "banana", "it-IT": "banana", "en-US": "banana", "es-ES": "plátano" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["breakfast", "snack"],
    substitutes: ["apple", "berries"],
  },
  {
    id: "apple",
    category: "fruit",
    names: { "pt-BR": "maçã", "it-IT": "mela", "en-US": "apple", "es-ES": "manzana" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["snack"],
    substitutes: ["banana", "berries"],
  },
  {
    id: "berries",
    category: "fruit",
    names: { "pt-BR": "frutas vermelhas", "it-IT": "frutti di bosco", "en-US": "berries", "es-ES": "frutos rojos" },
    countries: { italy: "common", brazil: "available", spain: "common", portugal: "available", usa: "common", uk: "common", germany: "common", france: "common", argentina: "available" },
    tags: ["breakfast", "snack"],
    substitutes: ["banana", "apple"],
  },
  {
    id: "zucchini",
    category: "vegetable",
    names: { "pt-BR": "abobrinha", "it-IT": "zucchine", "en-US": "zucchini", "es-ES": "calabacín" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["lunch", "dinner"],
    substitutes: ["broccoli", "spinach"],
  },
  {
    id: "broccoli",
    category: "vegetable",
    names: { "pt-BR": "brócolis", "it-IT": "broccoli", "en-US": "broccoli", "es-ES": "brócoli" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["lunch", "dinner"],
    substitutes: ["zucchini", "spinach"],
  },
  {
    id: "spinach",
    category: "vegetable",
    names: { "pt-BR": "espinafre", "it-IT": "spinaci", "en-US": "spinach", "es-ES": "espinacas" },
    countries: { italy: "common", brazil: "available", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "available" },
    tags: ["lunch", "dinner"],
    substitutes: ["broccoli", "zucchini"],
  },
  {
    id: "lentils",
    category: "legume",
    names: { "pt-BR": "lentilha", "it-IT": "lenticchie", "en-US": "lentils", "es-ES": "lentejas" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["lunch", "dinner", "fiber"],
    substitutes: ["chickpeas", "beans"],
  },
  {
    id: "beans",
    category: "legume",
    names: { "pt-BR": "feijão", "it-IT": "fagioli", "en-US": "beans", "es-ES": "frijoles" },
    countries: { italy: "available", brazil: "common", spain: "common", portugal: "common", usa: "available", uk: "available", germany: "available", france: "available", argentina: "common" },
    tags: ["lunch", "fiber"],
    substitutes: ["lentils", "chickpeas"],
  },
  {
    id: "chickpeas",
    category: "legume",
    names: { "pt-BR": "grão-de-bico", "it-IT": "ceci", "en-US": "chickpeas", "es-ES": "garbanzos" },
    countries: { italy: "common", brazil: "available", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "available" },
    tags: ["lunch", "fiber"],
    substitutes: ["lentils", "beans"],
  },
  {
    id: "olive_oil",
    category: "fat",
    names: { "pt-BR": "azeite de oliva", "it-IT": "olio d'oliva", "en-US": "olive oil", "es-ES": "aceite de oliva" },
    countries: { italy: "common", brazil: "common", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "common" },
    tags: ["lunch", "dinner"],
    substitutes: ["avocado"],
  },
  {
    id: "avocado",
    category: "fat",
    names: { "pt-BR": "abacate", "it-IT": "avocado", "en-US": "avocado", "es-ES": "aguacate" },
    countries: { italy: "available", brazil: "common", spain: "common", portugal: "available", usa: "common", uk: "common", germany: "available", france: "available", argentina: "available" },
    tags: ["breakfast", "snack"],
    substitutes: ["olive_oil"],
  },
  {
    id: "almonds",
    category: "fat",
    names: { "pt-BR": "amêndoas", "it-IT": "mandorle", "en-US": "almonds", "es-ES": "almendras" },
    countries: { italy: "common", brazil: "available", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "available" },
    tags: ["snack"],
    allergens: ["tree_nut"],
    substitutes: ["avocado"],
  },
  {
    id: "rice_cakes",
    category: "carb",
    names: { "pt-BR": "biscoito de arroz", "it-IT": "gallette di riso", "en-US": "rice cakes", "es-ES": "tortitas de arroz" },
    countries: { italy: "common", brazil: "available", spain: "common", portugal: "common", usa: "common", uk: "common", germany: "common", france: "common", argentina: "available" },
    tags: ["snack", "gluten_free"],
    substitutes: ["wholegrain_bread", "oats"],
  },
];

// ─── Meal blocks ──────────────────────────────────────────────────────────────

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

export interface MealBlock {
  id: string;
  mealType: MealType;
  ingredientIds: string[];
  countryCompatibility: FoodCountry[];
  goalCompatibility: Array<"fat_loss" | "muscle_gain" | "conditioning" | "consistency" | "mobility_health">;
  tags?: string[];
  /** Resolved restriction tags that exclude the WHOLE block. */
  avoidIf?: string[];
}

export const mealBlocks: MealBlock[] = [
  // Breakfasts
  {
    id: "breakfast_yogurt_oats_banana",
    mealType: "breakfast",
    ingredientIds: ["greek_yogurt", "oats", "banana"],
    countryCompatibility: ["italy", "brazil", "spain", "portugal", "usa", "uk", "germany", "france", "argentina"],
    goalCompatibility: ["fat_loss", "muscle_gain", "consistency", "conditioning"],
    tags: ["fast", "balanced"],
    avoidIf: ["lactose_intolerance", "milk_allergy"],
  },
  {
    id: "breakfast_eggs_bread_avocado",
    mealType: "breakfast",
    ingredientIds: ["eggs", "wholegrain_bread", "avocado"],
    countryCompatibility: ["italy", "brazil", "spain", "portugal", "usa", "uk", "germany", "france", "argentina"],
    goalCompatibility: ["muscle_gain", "fat_loss", "consistency"],
    tags: ["high_protein"],
    avoidIf: ["egg_allergy"],
  },
  {
    id: "breakfast_tapioca_eggs",
    mealType: "breakfast",
    ingredientIds: ["tapioca", "eggs"],
    countryCompatibility: ["brazil", "portugal"],
    goalCompatibility: ["fat_loss", "muscle_gain", "consistency"],
    tags: ["gluten_free", "high_protein"],
    avoidIf: ["egg_allergy"],
  },
  {
    id: "breakfast_oats_berries",
    mealType: "breakfast",
    ingredientIds: ["oats", "berries", "almonds"],
    countryCompatibility: ["italy", "spain", "portugal", "usa", "uk", "germany", "france", "argentina"],
    goalCompatibility: ["fat_loss", "consistency", "mobility_health"],
    tags: ["fiber"],
    avoidIf: ["tree_nut_allergy"],
  },

  // Lunches
  {
    id: "lunch_chicken_rice_zucchini",
    mealType: "lunch",
    ingredientIds: ["chicken_breast", "rice", "zucchini", "olive_oil"],
    countryCompatibility: ["italy", "brazil", "spain", "portugal", "usa", "uk", "germany", "france", "argentina"],
    goalCompatibility: ["muscle_gain", "fat_loss", "conditioning", "consistency"],
    tags: ["balanced"],
  },
  {
    id: "lunch_pasta_tuna_broccoli",
    mealType: "lunch",
    ingredientIds: ["pasta", "tuna_canned", "broccoli", "olive_oil"],
    countryCompatibility: ["italy", "spain", "portugal", "usa", "uk", "germany", "france", "argentina", "brazil"],
    goalCompatibility: ["muscle_gain", "consistency", "conditioning"],
    avoidIf: ["fish_allergy", "celiac"],
  },
  {
    id: "lunch_beans_rice_chicken",
    mealType: "lunch",
    ingredientIds: ["beans", "rice", "chicken_breast"],
    countryCompatibility: ["brazil", "argentina", "portugal"],
    goalCompatibility: ["muscle_gain", "consistency"],
    tags: ["balanced", "fiber"],
  },
  {
    id: "lunch_lentils_potato_olive",
    mealType: "lunch",
    ingredientIds: ["lentils", "potato", "spinach", "olive_oil"],
    countryCompatibility: ["italy", "spain", "portugal", "france", "germany", "uk"],
    goalCompatibility: ["fat_loss", "mobility_health", "consistency"],
    tags: ["fiber", "vegetarian_friendly"],
  },

  // Dinners
  {
    id: "dinner_fish_potato_spinach",
    mealType: "dinner",
    ingredientIds: ["white_fish", "potato", "spinach", "olive_oil"],
    countryCompatibility: ["italy", "spain", "portugal", "france", "germany", "uk", "usa", "argentina", "brazil"],
    goalCompatibility: ["fat_loss", "muscle_gain", "consistency"],
    avoidIf: ["fish_allergy"],
  },
  {
    id: "dinner_chicken_sweet_potato_broccoli",
    mealType: "dinner",
    ingredientIds: ["chicken_breast", "sweet_potato", "broccoli"],
    countryCompatibility: ["brazil", "usa", "uk", "argentina", "italy", "spain"],
    goalCompatibility: ["muscle_gain", "fat_loss"],
  },

  // Snacks
  {
    id: "snack_yogurt_almonds",
    mealType: "snack",
    ingredientIds: ["greek_yogurt", "almonds"],
    countryCompatibility: ["italy", "brazil", "spain", "portugal", "usa", "uk", "germany", "france", "argentina"],
    goalCompatibility: ["muscle_gain", "consistency", "fat_loss"],
    avoidIf: ["lactose_intolerance", "milk_allergy", "tree_nut_allergy"],
  },
  {
    id: "snack_apple_almonds",
    mealType: "snack",
    ingredientIds: ["apple", "almonds"],
    countryCompatibility: ["italy", "brazil", "spain", "portugal", "usa", "uk", "germany", "france", "argentina"],
    goalCompatibility: ["fat_loss", "consistency"],
    avoidIf: ["tree_nut_allergy"],
  },
  {
    id: "snack_bresaola_rice_cakes",
    mealType: "snack",
    ingredientIds: ["bresaola", "rice_cakes"],
    countryCompatibility: ["italy"],
    goalCompatibility: ["muscle_gain", "fat_loss"],
    tags: ["high_protein"],
  },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────────

const foodById = new Map(foodCatalog.map((f) => [f.id, f]));

export function getFoodById(id: string): FoodItem | undefined {
  return foodById.get(id);
}

export function getMealBlockById(id: string): MealBlock | undefined {
  return mealBlocks.find((b) => b.id === id);
}

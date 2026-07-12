/**
 * GUTO Nutrition Engine
 *
 * Calcula BMR (Mifflin-St Jeor), TDEE e macros baseados no perfil do usuário.
 * Valida porções geradas pela IA para evitar absurdos nutricionais.
 * NÃO delega cálculos para a IA — todos os números vêm daqui.
 */

export type NutritionGoal =
  | "fat_loss"
  | "muscle_gain"
  | "conditioning"
  | "mobility_health"
  | "consistency";

export type TrainingLevel = "beginner" | "returning" | "consistent" | "advanced";
export type BiologicalSex = "male" | "female";

export interface NutritionProfile {
  biologicalSex: BiologicalSex;
  userAge: number;
  heightCm: number;
  weightKg: number;
  trainingLevel: TrainingLevel;
  trainingGoal: NutritionGoal;
  country?: string;
  countryCode?: string;
  city?: string;
  foodRestrictions?: string;
}

export interface DietMacros {
  bmr: number;
  tdee: number;
  targetKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  goal: NutritionGoal;
}

// ─── BMR / TDEE ───────────────────────────────────────────────────────────────

function calculateBMR(
  sex: BiologicalSex,
  weightKg: number,
  heightCm: number,
  age: number
): number {
  // Mifflin-St Jeor
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  if (sex === "female") return Math.round(base - 161);
  return Math.round(base + 5);
}

const ACTIVITY_FACTOR: Record<TrainingLevel, number> = {
  beginner: 1.25,
  returning: 1.35,
  consistent: 1.50,
  advanced: 1.55,
};

function calculateTDEE(bmr: number, level: TrainingLevel): number {
  return Math.round(bmr * ACTIVITY_FACTOR[level]);
}

// ─── Caloric target ───────────────────────────────────────────────────────────

function calculateTargetKcal(tdee: number, goal: NutritionGoal): number {
  switch (goal) {
    case "fat_loss":
      return Math.round(tdee - 400); // middle of -300/-500 range
    case "muscle_gain":
      return Math.round(tdee + 275); // middle of +200/+350 range
    case "conditioning":
    case "mobility_health":
      return tdee;
    case "consistency":
      return Math.round(tdee - 100);
    default:
      return tdee;
  }
}

function applySafeCalorieFloor(profile: NutritionProfile, targetKcal: number, tdee: number): number {
  // GUTO is not a medical/nutrition prescription. Avoid unsafe aggressive deficits,
  // especially for teens and very light/older users.
  if (profile.userAge < 18) return Math.max(targetKcal, tdee);
  const floor = profile.biologicalSex === "female" ? 1200 : 1400;
  return Math.max(targetKcal, floor);
}

// ─── Protein per kg ───────────────────────────────────────────────────────────

const PROTEIN_PER_KG: Record<NutritionGoal, number> = {
  fat_loss: 1.8,
  muscle_gain: 1.9, // midpoint of 1.8-2.0
  conditioning: 1.5,
  mobility_health: 1.4,
  consistency: 1.5,
};

// ─── Macros ───────────────────────────────────────────────────────────────────

export function calculateMacros(profile: NutritionProfile): DietMacros {
  const bmr = calculateBMR(
    profile.biologicalSex,
    profile.weightKg,
    profile.heightCm,
    profile.userAge
  );
  const tdee = calculateTDEE(bmr, profile.trainingLevel);
  const targetKcal = applySafeCalorieFloor(
    profile,
    calculateTargetKcal(tdee, profile.trainingGoal),
    tdee
  );

  const proteinG = Math.round(profile.weightKg * PROTEIN_PER_KG[profile.trainingGoal]);
  const proteinKcal = proteinG * 4;

  // Fat = 25-30% of target kcal
  const fatG = Math.round((targetKcal * 0.27) / 9);
  const fatKcal = fatG * 9;

  // Carbs fill the rest
  const carbsG = Math.max(0, Math.round((targetKcal - proteinKcal - fatKcal) / 4));

  return {
    bmr,
    tdee,
    targetKcal,
    proteinG,
    carbsG,
    fatG,
    goal: profile.trainingGoal,
  };
}

// ─── Portion validation ───────────────────────────────────────────────────────

interface PortionLimit {
  unit: "g" | "units";
  min: number;
  max: number;
}

const PORTION_LIMITS: { keywords: string[]; limits: PortionLimit }[] = [
  {
    keywords: ["frango", "carne", "peixe", "chicken", "meat", "fish", "pollo", "carne", "pollo", "poulet", "manzo"],
    limits: { unit: "g", min: 100, max: 220 },
  },
  {
    keywords: ["ovo", "egg", "uovo", "huevo"],
    limits: { unit: "units", min: 2, max: 4 },
  },
  {
    keywords: ["arroz", "rice", "riso"],
    limits: { unit: "g", min: 80, max: 180 },
  },
  {
    keywords: ["massa", "macarrão", "pasta", "macaroni", "spaghetti"],
    limits: { unit: "g", min: 80, max: 180 },
  },
  {
    keywords: ["batata", "potato", "patata"],
    limits: { unit: "g", min: 150, max: 300 },
  },
  {
    keywords: ["feijão", "lentilha", "bean", "lentil", "fagiolo", "lenticchia", "frijol"],
    limits: { unit: "g", min: 80, max: 160 },
  },
  {
    keywords: ["aveia", "oat", "avena"],
    limits: { unit: "g", min: 30, max: 80 },
  },
  {
    keywords: ["iogurte", "yogurt", "yoghurt"],
    limits: { unit: "g", min: 150, max: 250 },
  },
  {
    keywords: ["fruta", "fruit", "frutto", "fruta", "maçã", "banana", "laranja"],
    limits: { unit: "units", min: 1, max: 2 },
  },
  {
    keywords: ["azeite", "olive oil", "olio", "aceite"],
    limits: { unit: "g", min: 5, max: 15 },
  },
];

export interface PortionValidationResult {
  valid: boolean;
  issues: string[];
  corrected?: { name: string; quantity: string }[];
}

function parseQuantityValue(quantity: string): { value: number; unit: string } | null {
  const match = quantity.match(/(\d+(?:\.\d+)?)\s*(g|ml|units?|un|unidades?|pcs?)?/i);
  if (!match) return null;
  return {
    value: parseFloat(match[1]),
    unit: (match[2] || "g").toLowerCase(),
  };
}

function findPortionRule(foodName: string): { unit: "g" | "units"; min: number; max: number } | null {
  const lower = foodName.toLowerCase();
  for (const rule of PORTION_LIMITS) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.limits;
    }
  }
  return null;
}

export interface DietFood {
  name: string;
  quantity: string;
  kcal: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  notes?: string;
}

export interface DietMeal {
  id: string;
  name: string;
  time: string;
  foods: DietFood[];
  totalKcal: number;
  gutoNote: string;
  alternatives?: string[];
}

export interface DietPlan {
  userId: string;
  /** Opaque revision changed on every persisted write for optimistic locking. */
  revision?: string;
  /** Hash dos dados nutricionais usados na geração; impede servir plano stale. */
  profileFingerprint?: string;
  title?: string;
  // Idioma em que o conteúdo visível (refeições/alimentos/notas) foi gerado.
  // Usado para invalidar/regenerar quando o idioma do usuário muda ("idioma é lei").
  language?: string;
  generatedAt: string;
  country: string;
  countryCode?: string;
  city?: string;
  macros: DietMacros;
  meals: DietMeal[];
  goal?: string;
  coachNotes?: string;
  restrictions?: string;
  foodRestrictions?: string;
  manualOverride?: boolean;
  editedBy?: string;
  editedAt?: string;
  editReason?: string;
  planSource?: "ai_generated" | "admin_override" | "coach_override";
  source?: "guto_generated" | "coach_manual" | "mixed";
  lockedByCoach?: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

function normalizeKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

const COUNTRY_FOOD_HINTS_BY_CODE: Record<string, string> = {
  BR: "Use foods commonly sold in Brazilian supermarkets and markets: arroz, feijão, frango, carne bovina, ovo, aveia, batata-doce, banana, mandioca, legumes, azeite. Regional Brazilian staples are allowed when the user lives in Brazil.",
  IT: "Use foods commonly sold in Italian supermarkets and markets: pasta, risotto rice, mozzarella, ricotta, parmigiano, prosciutto, bresaola, eggs, seasonal vegetables, legumes (incl. beans/fagioli), olive oil, tuna in oil, yogurt, bread. Avoid hard-to-find Brazilian staples in Italy: tapioca, açaí, cuscuz nordestino, queijo coalho, farinha de mandioca, cupuaçu.",
  US: "Use foods commonly sold in US supermarkets: chicken breast, eggs, oats, Greek yogurt, brown rice, whole wheat bread, broccoli, spinach, sweet potato, tuna, cottage cheese, peanut butter.",
  ES: "Use foods commonly sold in Spanish supermarkets and markets: pollo, huevos, arroz, legumbres, pescado, aceite de oliva, verduras frescas, pan integral, jamón serrano, yogur.",
  PT: "Use foods commonly sold in Portuguese supermarkets and markets: bacalhau, frango, arroz, leguminosas, azeite, ovos, pão, legumes, frutas da época, iogurte.",
  DE: "Use foods commonly sold in German supermarkets: Hähnchen, Eier, Haferflocken, Vollkornbrot, Kartoffeln, Quark, Hüttenkäse, Gemüse, Lachs, Linsen.",
  FR: "Use foods commonly sold in French supermarkets: poulet, œufs, riz, légumes, fromage blanc, yaourt, pain complet, légumineuses, poisson, huile d'olive.",
  GB: "Use foods commonly sold in UK supermarkets: chicken breast, eggs, oats, Greek yogurt, potatoes, wholemeal bread, beans, tuna, salmon, vegetables.",
  CA: "Use foods commonly sold in Canadian supermarkets: chicken breast, eggs, oats, Greek yogurt, rice, potatoes, whole grain bread, tuna, salmon, vegetables.",
  AU: "Use foods commonly sold in Australian supermarkets: chicken breast, eggs, oats, Greek yogurt, rice, potatoes, wholemeal bread, tuna, lean beef, vegetables.",
  MX: "Use foods commonly sold in Mexican supermarkets and markets: pollo, huevos, arroz, frijoles, tortillas de maíz, aguacate, queso fresco, verduras, atún.",
  AR: "Use foods commonly sold in Argentine supermarkets: carne magra, pollo, huevos, arroz, lentejas, avena, papa, yogur, verduras, frutas.",
  JP: "Use foods commonly sold in Japanese supermarkets: rice, eggs, tofu, fish, chicken, natto, miso soup, vegetables, seaweed, yogurt.",
};

function resolveCountryFoodHint(country: string, countryCode?: string): string {
  const code = countryCode?.trim().toUpperCase();
  if (code && COUNTRY_FOOD_HINTS_BY_CODE[code]) return COUNTRY_FOOD_HINTS_BY_CODE[code];

  const countryKey = normalizeKey(country);
  const legacyCountryToCode: Record<string, string> = {
    brasil: "BR",
    brazil: "BR",
    italia: "IT",
    italy: "IT",
    statiunitidamerica: "US",
    estadosunidos: "US",
    unitedstates: "US",
    usa: "US",
    eua: "US",
    espanha: "ES",
    spain: "ES",
    portugal: "PT",
    alemanha: "DE",
    germany: "DE",
    franca: "FR",
    france: "FR",
    reinounido: "GB",
    unitedkingdom: "GB",
    canada: "CA",
    australia: "AU",
    mexico: "MX",
    argentina: "AR",
    japao: "JP",
    japan: "JP",
  };
  const fallbackCode = legacyCountryToCode[countryKey];
  if (fallbackCode && COUNTRY_FOOD_HINTS_BY_CODE[fallbackCode]) return COUNTRY_FOOD_HINTS_BY_CODE[fallbackCode];

  return `Use foods that are easy to find in normal supermarkets and markets in ${country}. The residence country controls food availability; do not choose foods just because they are common in the app language or the user's native culture.`;
}

/**
 * Validates and optionally corrects portions in a list of meals.
 * Returns issues found and corrected foods.
 */
export function validateAndCorrectPortions(meals: DietMeal[]): {
  correctedMeals: DietMeal[];
  issues: string[];
} {
  const issues: string[] = [];
  const correctedMeals = meals.map((meal) => ({
    ...meal,
    foods: meal.foods.map((food) => {
      const rule = findPortionRule(food.name);
      if (!rule) return food;

      const parsed = parseQuantityValue(food.quantity);
      if (!parsed) return food;

      const isUnits = rule.unit === "units";
      const val = parsed.value;

      if (val < rule.min) {
        const corrected = `${rule.min}${isUnits ? " un" : "g"}`;
        issues.push(`${food.name}: ${food.quantity} → corrigido para ${corrected} (mínimo)`);
        return { ...food, quantity: corrected };
      }

      if (val > rule.max) {
        const corrected = `${rule.max}${isUnits ? " un" : "g"}`;
        issues.push(`${food.name}: ${food.quantity} → corrigido para ${corrected} (máximo)`);
        return { ...food, quantity: corrected };
      }

      return food;
    }),
  }));

  return { correctedMeals, issues };
}

export function normalizeMealCalories(meals: DietMeal[]): DietMeal[] {
  return meals.map((meal) => ({
    ...meal,
    totalKcal: meal.foods.reduce((sum, food) => sum + Math.round(Number(food.kcal) || 0), 0),
  }));
}

export function validateDietCalories(meals: DietMeal[], targetKcal: number): { valid: boolean; dailyTotal: number; issues: string[] } {
  const issues: string[] = [];
  meals.forEach((meal) => {
    const inputTotal = Math.round(Number(meal.totalKcal) || 0);
    const foodTotal = meal.foods.reduce((sum, food) => sum + Math.round(Number(food.kcal) || 0), 0);
    if (inputTotal !== foodTotal) {
      issues.push(`${meal.id || meal.name}: totalKcal (${inputTotal}) diferente da soma dos alimentos (${foodTotal})`);
    }
  });

  const normalizedMeals = normalizeMealCalories(meals);
  const dailyTotal = normalizedMeals.reduce((sum, meal) => sum + meal.totalKcal, 0);
  const targetDelta = Math.abs(dailyTotal - targetKcal);
  if (targetDelta > 80) {
    issues.push(`Total diário (${dailyTotal}) fora da meta (${targetKcal}) por ${targetDelta} kcal`);
  }

  return { valid: issues.length === 0, dailyTotal, issues };
}

/**
 * Reparo determinístico de calorias (Fase 3 — estabilização da dieta).
 *
 * O cérebro escolhe os alimentos certos, mas erra a ARITMÉTICA do total diário.
 * Em vez de bloquear o aluno num loop de "regenerar", escalamos o plano inteiro
 * proporcionalmente (kcal + macros + porção) para fechar a meta calórica. Mantém
 * o plano COERENTE — a porção acompanha a kcal, então o aluno vê números reais.
 *
 * Retorna `null` apenas quando o desvio é grande demais para ser arredondamento
 * (fator de escala fora de [0.6, 1.7]), ou seja, estruturalmente inseguro/impossível.
 * Aí sim a falha é honesta. Não inventa alimento, não esconde erro.
 */
export function scaleDietToTarget(meals: DietMeal[], targetKcal: number): DietMeal[] | null {
  if (!Array.isArray(meals) || meals.length === 0 || targetKcal <= 0) return null;

  const dailyTotal = meals.reduce(
    (sum, meal) => sum + meal.foods.reduce((acc, food) => acc + Math.round(Number(food.kcal) || 0), 0),
    0
  );
  if (dailyTotal <= 0) return null;

  // Já dentro da margem segura (±80 kcal) → nada a reparar.
  if (Math.abs(dailyTotal - targetKcal) <= 80) return meals;

  const factor = targetKcal / dailyTotal;
  // Fator absurdo = não é arredondamento; é plano estruturalmente fora. Falha honesta.
  if (factor < 0.6 || factor > 1.7) return null;

  const scaleQuantity = (quantity: string): string => {
    const parsed = parseQuantityValue(quantity);
    if (!parsed || parsed.value <= 0) return quantity;
    const isUnit = /^(un|unit|unidade|pcs?)/i.test(parsed.unit);
    const scaled = parsed.value * factor;
    if (isUnit) {
      return `${Math.max(1, Math.round(scaled))} ${parsed.unit}`;
    }
    // gramas/ml: arredonda para múltiplo de 5, mínimo 5
    return `${Math.max(5, Math.round(scaled / 5) * 5)}${parsed.unit}`;
  };

  return meals.map((meal) => {
    const foods = meal.foods.map((food) => ({
      ...food,
      kcal: Math.round((Number(food.kcal) || 0) * factor),
      proteinG: typeof food.proteinG === "number" ? Math.round(food.proteinG * factor) : food.proteinG,
      carbsG: typeof food.carbsG === "number" ? Math.round(food.carbsG * factor) : food.carbsG,
      fatG: typeof food.fatG === "number" ? Math.round(food.fatG * factor) : food.fatG,
      quantity: scaleQuantity(food.quantity),
    }));
    return { ...meal, foods, totalKcal: foods.reduce((acc, food) => acc + food.kcal, 0) };
  });
}

// ─── Gemini prompt builder ─────────────────────────────────────────────────────

export function buildDietPrompt(
  profile: NutritionProfile,
  macros: DietMacros,
  language: string,
  /**
   * Reforço de retry (Fase 3J): quando a tentativa anterior foi rejeitada por
   * localidade ou restrição, regeneramos com instruções mais restritas em vez
   * de repetir o mesmo prompt. Anexado ao final do prompt base.
   */
  reinforcement?: string
): string {
  // App language — all text output must be in this language
  const langLabel =
    language === "pt-BR"
      ? "Português do Brasil"
      : language === "en-US"
      ? "English (US)"
      : language === "it-IT"
      ? "Italiano"
      : "Español";

  // Goal label in the app language
  const goalLabels: Record<string, Record<string, string>> = {
    "pt-BR": {
      fat_loss: "Perda de gordura",
      muscle_gain: "Hipertrofia",
      conditioning: "Condicionamento",
      mobility_health: "Saúde e mobilidade",
      consistency: "Consistência",
    },
    "en-US": {
      fat_loss: "Fat loss",
      muscle_gain: "Muscle gain",
      conditioning: "Conditioning",
      mobility_health: "Health and mobility",
      consistency: "Consistency",
    },
    "it-IT": {
      fat_loss: "Dimagrimento",
      muscle_gain: "Ipertrofia",
      conditioning: "Condizionamento",
      mobility_health: "Salute e mobilità",
      consistency: "Costanza",
    },
  };
  const goalLabel = goalLabels[language]?.[profile.trainingGoal] ?? profile.trainingGoal;

  const country = profile.country || "Brasil";
  const countryCode = profile.countryCode?.trim().toUpperCase();
  const city = profile.city?.trim();
  const foodRestrictions = profile.foodRestrictions?.trim();
  const restrictions = foodRestrictions || "none";

  const foodHint = resolveCountryFoodHint(country, countryCode);

  return `You are the nutrition engine of GUTO. Generate a weekly meal plan (representative daily plan).

USER:
- Sex: ${profile.biologicalSex}, Age: ${profile.userAge}, Height: ${profile.heightCm}cm, Weight: ${profile.weightKg}kg
- Country of residence: ${country}
- Country code: ${countryCode || "unknown"}
- City/region: ${city || "unknown"}
- Goal: ${goalLabel}
- Food restrictions/allergies: ${restrictions}

MACROS (pre-calculated — use exactly):
- Target: ${macros.targetKcal} kcal/day (±80 kcal)
- Protein: ${macros.proteinG}g | Carbs: ${macros.carbsG}g | Fat: ${macros.fatG}g

FOOD SELECTION — CRITICAL:
${foodHint}
Use the country code and city/region as structured location context. Do not infer food availability from the app language, user name, accent, slang, or native culture.
Food restrictions must be strictly respected: ${restrictions}.

OUTPUT LANGUAGE — CRITICAL:
Write ALL text (meal names, food names, notes) in ${langLabel}.
The country determines WHICH foods, not the language. Translate food names into ${langLabel}.
Examples: [Italy + Portuguese] "macarrão" not "pasta"; "manteiga" not "burro"; "atum em conserva" not "tonno".
Examples: [USA + Spanish] "pollo" not "chicken"; "avena" not "oats"; "batata dulce" not "sweet potato".

STRUCTURE:
Return a JSON object with a root key named exactly "meals" (NOT "mealPlan") containing an array of exactly 5 meal objects.
IDs must be exactly: "cafe", "lanche1", "almoco", "lanche2", "jantar".
Each meal: id (string), name (string), time (string), foods (array of 2-4 objects with name/quantity/kcal), totalKcal (number), gutoNote (string).
CALORIE CONSISTENCY — CRITICAL:
For every meal, totalKcal MUST equal the exact sum of foods[].kcal.
The sum of all meal totalKcal values MUST be within ±80 kcal of ${macros.targetKcal}.
gutoNote: max 12 words, direct friend tone, in ${langLabel}.
Example structure: {"meals": [{"id":"cafe","name":"...","time":"08:00","foods":[{"name":"...","quantity":"...","kcal":0}],"totalKcal":0,"gutoNote":"..."}]}${
    reinforcement
      ? `\n\nRETRY REINFORCEMENT — the previous attempt was rejected. Fix exactly this before answering:\n${reinforcement}`
      : ""
  }`;
}

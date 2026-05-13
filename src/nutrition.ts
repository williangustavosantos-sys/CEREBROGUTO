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
export type BiologicalSex = "male" | "female" | "prefer_not_to_say";

export interface NutritionProfile {
  biologicalSex: BiologicalSex;
  userAge: number;
  heightCm: number;
  weightKg: number;
  trainingLevel: TrainingLevel;
  trainingGoal: NutritionGoal;
  country?: string;
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
  return Math.round(base + 5); // male and prefer_not_to_say use male formula
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
  const targetKcal = calculateTargetKcal(tdee, profile.trainingGoal);

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
  title?: string;
  generatedAt: string;
  country: string;
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

// ─── Gemini prompt builder ─────────────────────────────────────────────────────

export function buildDietPrompt(
  profile: NutritionProfile,
  macros: DietMacros,
  language: string
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
  const restrictions = profile.foodRestrictions
    ? profile.foodRestrictions.trim()
    : "none";

  // Country-specific food notes to guide local availability
  const countryFoodHints: Record<string, string> = {
    italia: "Use Italian supermarket staples: pasta, risotto rice, mozzarella, prosciutto, bresaola, eggs, seasonal vegetables, legumes, olive oil, tuna in oil, yogurt, bread. Avoid: tapioca, açaí, cuscuz nordestino, feijão preto, queijo coalho, farinha de mandioca.",
    italy: "Use Italian supermarket staples: pasta, risotto rice, mozzarella, prosciutto, bresaola, eggs, seasonal vegetables, legumes, olive oil, tuna in oil, yogurt, bread. Avoid: tapioca, açaí, feijão preto, queijo coalho.",
    brasil: "Use Brazilian supermarket staples: arroz, feijão, frango, carne bovina, ovo, aveia, batata-doce, banana, mandioca, legumes, azeite. Typical Brazilian diet.",
    brazil: "Use Brazilian supermarket staples: rice, beans, chicken, beef, eggs, oats, sweet potato, banana, cassava, vegetables, olive oil.",
    eua: "Use US supermarket staples: chicken breast, eggs, oats, Greek yogurt, brown rice, whole wheat bread, broccoli, spinach, sweet potato, tuna, cottage cheese, peanut butter.",
    usa: "Use US supermarket staples: chicken breast, eggs, oats, Greek yogurt, brown rice, whole wheat bread, broccoli, spinach, sweet potato, tuna, cottage cheese.",
    espanha: "Use Spanish supermarket staples: pollo, huevos, arroz, legumbres, pescado, aceite de oliva, verduras frescas, pan integral, jamón serrano, yogur.",
    spain: "Use Spanish supermarket staples: chicken, eggs, rice, legumes, fish, olive oil, fresh vegetables, whole bread, serrano ham, yogurt.",
    portugal: "Use Portuguese supermarket staples: bacalhau, frango, arroz, leguminosas, azeite, ovos, pão, legumes, frutas da época.",
    alemanha: "Use German supermarket staples: Hühnchen, Eier, Haferflocken, Vollkornbrot, Kartoffeln, Hüttenkäse, Quark, Gemüse, Lachs, Linsen.",
    germany: "Use German supermarket staples: chicken, eggs, oats, whole grain bread, potatoes, quark, cottage cheese, vegetables, salmon, lentils.",
    franca: "Use French supermarket staples: poulet, œufs, riz, légumes, fromage blanc, yaourt, pain complet, légumineuses, poisson, huile d'olive.",
    france: "Use French supermarket staples: chicken, eggs, rice, vegetables, fromage blanc, yogurt, whole bread, legumes, fish, olive oil.",
  };

  const countryKey = country.toLowerCase().replace(/[^a-záéíóúàèìòùãõâêîôûäëïöüç]/g, "");
  const foodHint = countryFoodHints[countryKey] || `Use foods that are easy to find in local supermarkets in ${country}.`;

  return `You are the nutrition engine of GUTO. Generate a weekly meal plan (representative daily plan).

USER:
- Sex: ${profile.biologicalSex}, Age: ${profile.userAge}, Height: ${profile.heightCm}cm, Weight: ${profile.weightKg}kg
- Country of residence: ${country}
- Goal: ${goalLabel}
- Food restrictions/allergies: ${restrictions}

MACROS (pre-calculated — use exactly):
- Target: ${macros.targetKcal} kcal/day (±80 kcal)
- Protein: ${macros.proteinG}g | Carbs: ${macros.carbsG}g | Fat: ${macros.fatG}g

FOOD SELECTION — CRITICAL:
${foodHint}
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
gutoNote: max 12 words, direct friend tone, in ${langLabel}.
Example structure: {"meals": [{"id":"cafe","name":"...","time":"08:00","foods":[{"name":"...","quantity":"...","kcal":0}],"totalKcal":0,"gutoNote":"..."}]}`;
}

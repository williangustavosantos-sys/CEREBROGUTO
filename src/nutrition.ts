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
}

export interface DietMeal {
  id: string;
  name: string;
  time: string;
  foods: DietFood[];
  totalKcal: number;
  gutoNote: string;
}

export interface DietPlan {
  userId: string;
  generatedAt: string;
  country: string;
  macros: DietMacros;
  meals: DietMeal[];
  foodRestrictions?: string;
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
  const langLabel =
    language === "pt-BR"
      ? "Português do Brasil"
      : language === "en-US"
      ? "English"
      : language === "it-IT"
      ? "Italiano"
      : "Español";

  const goalLabel =
    profile.trainingGoal === "fat_loss"
      ? "Perda de gordura"
      : profile.trainingGoal === "muscle_gain"
      ? "Hipertrofia"
      : profile.trainingGoal === "conditioning"
      ? "Condicionamento"
      : profile.trainingGoal === "mobility_health"
      ? "Saúde e mobilidade"
      : "Consistência";

  const restrictions = profile.foodRestrictions
    ? `\n- Restrições alimentares: ${profile.foodRestrictions}`
    : "";

  return `Você é o motor nutricional do GUTO, um assistente de evolução humana. Sua função é gerar um plano diário de refeições representativo da semana inteira.

PERFIL DO USUÁRIO:
- Sexo biológico: ${profile.biologicalSex}
- Idade: ${profile.userAge} anos
- Altura: ${profile.heightCm} cm
- Peso: ${profile.weightKg} kg
- País / culinária base: ${profile.country || "Brasil"}
- Objetivo: ${goalLabel}${restrictions}

CÁLCULOS JÁ REALIZADOS — USE EXATAMENTE ESTES VALORES, NÃO RECALCULE:
- Alvo calórico diário: ${macros.targetKcal} kcal
- Proteína: ${macros.proteinG}g/dia
- Carboidratos: ${macros.carbsG}g/dia
- Gordura: ${macros.fatG}g/dia

REGRAS ABSOLUTAS:
1. Escreva TODO o conteúdo no idioma: ${langLabel}
2. Use alimentos reais, acessíveis e típicos do país do usuário
3. Respeite TODAS as restrições alimentares mencionadas
4. NÃO invente quantidades — use apenas os limites abaixo:
   - Frango / carne / peixe: 100–220g por refeição
   - Ovos: 2–4 unidades
   - Arroz cozido: 80–180g
   - Massa cozida: 80–180g
   - Batata: 150–300g
   - Feijão / lentilha: 80–160g
   - Aveia: 30–80g
   - Iogurte: 150–250g
   - Fruta: 1–2 unidades
   - Azeite: 5–15g
5. A soma total de calorias dos alimentos deve aproximar-se de ${macros.targetKcal} kcal (±100 kcal)
6. O campo "gutoNote" deve ser curto (máx 15 palavras), no estilo de melhor amigo direto — sem julgamento, sem militar

RESPONDA APENAS COM JSON PURO (sem markdown, sem código, sem explicação):
{
  "meals": [
    {
      "id": "cafe",
      "name": "...",
      "time": "07:00",
      "foods": [
        { "name": "...", "quantity": "...g", "kcal": 000 }
      ],
      "totalKcal": 000,
      "gutoNote": "..."
    }
  ]
}

Gere 5 refeições: café da manhã, lanche da manhã, almoço, lanche da tarde, jantar.`;
}

/**
 * GUTO Food Availability + Contextual Override
 *
 * Plano base = realidade média do país.
 * Chat = realidade real do usuário naquele momento.
 *
 * Funções puras. Sem classes. Sem chamadas externas.
 *
 *   getBaseFoodsForCountry(country) → alimentos common/available para o plano semanal
 *   canUseFood({food, country, useContext, userConfirmedAvailable, restrictions})
 *   suggestFoodSubstitutes({originalFoodId, country, restrictions, userConfirmedFoods})
 *   filterMealBlocksForUser({country, goal, restrictions})
 *   renderMealBlock(block, language) → texto traduzido
 *   buildBaseDietPlan({country, goal, restrictions, language}) → blocos por refeição
 *
 * Nada aqui tenta inferir país a partir de string crua. Esperamos o
 * normalizedValue do dirty-data-resolver. Se não houver, devolvemos o conjunto
 * cheio (modo conservador) e quem chama decide fallback.
 */

import {
  foodCatalog,
  mealBlocks,
  getFoodById,
  type FoodItem,
  type FoodCountry,
  type FoodLanguage,
  type MealBlock,
  type MealType,
} from "./food-catalog.js";

export type FoodUseContext =
  | "weekly_base_plan"     // montagem do plano semanal
  | "daily_adaptation"     // ajuste do dia
  | "meal_substitution"    // troca de uma refeição específica
  | "chat_question";       // resposta de pergunta no chat

export type FoodDecisionReason =
  | "common_in_country"
  | "available_in_country"
  | "user_confirmed_available"
  | "rare_not_for_base_plan"
  | "blocked_by_restriction"
  | "blocked_by_allergen"
  | "country_unknown_default_pass";

export interface FoodDecision {
  foodId: string;
  allowed: boolean;
  reason: FoodDecisionReason;
}

export interface UserFoodConstraints {
  /**
   * Tags de restrição vindas do dirty-data-resolver (ex: "lactose_intolerance",
   * "milk_allergy", "vegan", "no_pork"). Se vazio, nada é bloqueado por
   * restrição.
   */
  restrictions?: string[];
  /**
   * Alergias declaradas (ex: "milk", "egg", "peanut"). Bate contra
   * food.allergens.
   */
  allergens?: string[];
}

// ─── Country base ─────────────────────────────────────────────────────────────

/**
 * Returns the foods marked as `common` or `available` in the user's country.
 * If the country is undefined / unknown, returns the full catalog — plan
 * builders should treat that as conservative mode.
 */
export function getBaseFoodsForCountry(country: FoodCountry | undefined): FoodItem[] {
  if (!country) return [...foodCatalog];
  return foodCatalog.filter((food) => {
    const a = food.countries[country];
    return a === "common" || a === "available";
  });
}

// ─── canUseFood ───────────────────────────────────────────────────────────────

export function canUseFood(params: {
  foodId: string;
  country?: FoodCountry;
  useContext: FoodUseContext;
  userConfirmedAvailable?: boolean;
  constraints?: UserFoodConstraints;
}): FoodDecision {
  const food = getFoodById(params.foodId);
  if (!food) {
    return { foodId: params.foodId, allowed: false, reason: "blocked_by_restriction" };
  }

  // SAFETY first — never lifted by chat context.
  const restrictionTags = (params.constraints?.restrictions ?? []).map((t) => t.toLowerCase());
  if (food.avoidIf?.some((tag) => restrictionTags.includes(tag.toLowerCase()))) {
    return { foodId: food.id, allowed: false, reason: "blocked_by_restriction" };
  }
  const userAllergens = (params.constraints?.allergens ?? []).map((a) => a.toLowerCase());
  if (food.allergens?.some((a) => userAllergens.includes(a.toLowerCase()))) {
    return { foodId: food.id, allowed: false, reason: "blocked_by_allergen" };
  }

  if (!params.country) {
    return { foodId: food.id, allowed: true, reason: "country_unknown_default_pass" };
  }

  const availability = food.countries[params.country];

  if (availability === "common") {
    return { foodId: food.id, allowed: true, reason: "common_in_country" };
  }
  if (availability === "available") {
    return { foodId: food.id, allowed: true, reason: "available_in_country" };
  }
  // Rare/unmapped foods only enter when the user confirmed having it AND we are
  // adapting an existing meal — never for the weekly base plan and never for a
  // generic chat question (which has no concrete meal slot to attach to).
  const isAdaptiveContext =
    params.useContext === "daily_adaptation" || params.useContext === "meal_substitution";
  if ((availability === "rare" || !availability) && isAdaptiveContext && params.userConfirmedAvailable) {
    return { foodId: food.id, allowed: true, reason: "user_confirmed_available" };
  }
  return { foodId: food.id, allowed: false, reason: "rare_not_for_base_plan" };
}

// ─── Substitutes ──────────────────────────────────────────────────────────────

/**
 * Suggests substitute foods for `originalFoodId`, preserving nutritional
 * function (same category). Filters by country availability and user
 * restrictions.
 */
export function suggestFoodSubstitutes(params: {
  originalFoodId: string;
  country?: FoodCountry;
  constraints?: UserFoodConstraints;
  userConfirmedFoodIds?: string[];
  useContext?: FoodUseContext;
}): FoodItem[] {
  const original = getFoodById(params.originalFoodId);
  if (!original) return [];
  const useContext = params.useContext ?? "meal_substitution";

  // Prefer explicit substitutes; fall back to same-category catalog.
  const explicitIds = original.substitutes ?? [];
  const explicit = explicitIds
    .map((id) => getFoodById(id))
    .filter((f): f is FoodItem => Boolean(f));

  const fallback = foodCatalog.filter(
    (f) => f.id !== original.id && f.category === original.category
  );

  const candidates = explicit.length > 0 ? explicit : fallback;

  return candidates.filter((food) => {
    const decision = canUseFood({
      foodId: food.id,
      country: params.country,
      useContext,
      userConfirmedAvailable: params.userConfirmedFoodIds?.includes(food.id) ?? false,
      constraints: params.constraints,
    });
    return decision.allowed;
  });
}

// ─── Meal blocks ──────────────────────────────────────────────────────────────

export function filterMealBlocksForUser(params: {
  country?: FoodCountry;
  goal?: "fat_loss" | "muscle_gain" | "conditioning" | "consistency" | "mobility_health";
  constraints?: UserFoodConstraints;
}): MealBlock[] {
  const restrictionTags = (params.constraints?.restrictions ?? []).map((t) => t.toLowerCase());

  return mealBlocks.filter((block) => {
    // 1) Block-level restriction
    if (block.avoidIf?.some((t) => restrictionTags.includes(t.toLowerCase()))) return false;

    // 2) Country gate (if known)
    if (params.country && !block.countryCompatibility.includes(params.country)) return false;

    // 3) Goal gate
    if (params.goal && !block.goalCompatibility.includes(params.goal)) return false;

    // 4) Every ingredient must pass canUseFood for the WEEKLY plan
    return block.ingredientIds.every((id) => {
      const decision = canUseFood({
        foodId: id,
        country: params.country,
        useContext: "weekly_base_plan",
        constraints: params.constraints,
      });
      return decision.allowed;
    });
  });
}

// ─── Contextual override ──────────────────────────────────────────────────────

/**
 * Receives a base meal (set of ingredientIds) and a list of foods the user
 * just declared they have at home (from the chat). Returns the adjusted meal
 * for THIS occasion only — the weekly plan is untouched.
 *
 * Safety overrides are NEVER lifted: a `rare` food that the user confirmed
 * having at home is allowed; a food blocked by restriction stays blocked.
 */
export function applyContextualFoodOverride(params: {
  baseIngredientIds: string[];
  userConfirmedFoodIds: string[];
  country?: FoodCountry;
  constraints?: UserFoodConstraints;
}): {
  adjustedIngredientIds: string[];
  notes: string[];
} {
  const notes: string[] = [];
  const baseSet = new Set(params.baseIngredientIds);
  const adjusted = new Set<string>(params.baseIngredientIds);

  // Step 1: drop base ingredients that are blocked by restriction (paranoid recheck).
  for (const id of params.baseIngredientIds) {
    const decision = canUseFood({
      foodId: id,
      country: params.country,
      useContext: "meal_substitution",
      constraints: params.constraints,
    });
    if (!decision.allowed && (decision.reason === "blocked_by_restriction" || decision.reason === "blocked_by_allergen")) {
      adjusted.delete(id);
      notes.push(`removed:${id}:${decision.reason}`);
    }
  }

  // Step 2: add user-confirmed foods, replacing base ingredients of same category.
  for (const id of params.userConfirmedFoodIds) {
    const candidate = getFoodById(id);
    if (!candidate) continue;
    const decision = canUseFood({
      foodId: id,
      country: params.country,
      useContext: "meal_substitution",
      userConfirmedAvailable: true,
      constraints: params.constraints,
    });
    if (!decision.allowed) {
      notes.push(`rejected:${id}:${decision.reason}`);
      continue;
    }
    // Replace base ingredient of same category, if any.
    let replaced = false;
    for (const baseId of Array.from(adjusted)) {
      if (baseId === id) { replaced = true; break; }
      const baseFood = getFoodById(baseId);
      if (baseFood && baseFood.category === candidate.category && baseSet.has(baseId)) {
        adjusted.delete(baseId);
        adjusted.add(id);
        notes.push(`swap:${baseId}->${id}`);
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      adjusted.add(id);
      notes.push(`added:${id}`);
    }
  }

  return {
    adjustedIngredientIds: Array.from(adjusted),
    notes,
  };
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

const MEAL_TITLES: Record<FoodLanguage, Record<MealType, string>> = {
  "pt-BR": { breakfast: "Café da manhã", lunch: "Almoço", dinner: "Jantar", snack: "Lanche" },
  "it-IT": { breakfast: "Colazione", lunch: "Pranzo", dinner: "Cena", snack: "Spuntino" },
  "en-US": { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" },
  "es-ES": { breakfast: "Desayuno", lunch: "Almuerzo", dinner: "Cena", snack: "Merienda" },
};

export interface RenderedMeal {
  blockId: string;
  mealType: MealType;
  title: string;
  ingredients: Array<{ id: string; name: string }>;
}

export function renderMealBlock(params: {
  block: MealBlock;
  ingredientIds?: string[]; // override (post-context). defaults to block.ingredientIds
  language: FoodLanguage;
}): RenderedMeal {
  const ids = params.ingredientIds ?? params.block.ingredientIds;
  const ingredients = ids
    .map((id) => {
      const food = getFoodById(id);
      if (!food) return null;
      return { id: food.id, name: food.names[params.language] };
    })
    .filter((x): x is { id: string; name: string } => x !== null);

  return {
    blockId: params.block.id,
    mealType: params.block.mealType,
    title: MEAL_TITLES[params.language][params.block.mealType],
    ingredients,
  };
}

// ─── Convenience: build the base diet skeleton ────────────────────────────────

/**
 * Returns up to N rendered meal blocks per meal type, already filtered by
 * country / goal / restrictions. Caller still owns macro calculation
 * (delegated to `nutrition.ts`).
 */
export function buildBaseDietSkeleton(params: {
  country?: FoodCountry;
  goal?: "fat_loss" | "muscle_gain" | "conditioning" | "consistency" | "mobility_health";
  constraints?: UserFoodConstraints;
  language: FoodLanguage;
  limitPerType?: number;
}): RenderedMeal[] {
  const limit = params.limitPerType ?? 2;
  const eligible = filterMealBlocksForUser({
    country: params.country,
    goal: params.goal,
    constraints: params.constraints,
  });
  const grouped: Record<MealType, MealBlock[]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
    snack: [],
  };
  for (const b of eligible) grouped[b.mealType].push(b);

  const result: RenderedMeal[] = [];
  (Object.keys(grouped) as MealType[]).forEach((type) => {
    grouped[type].slice(0, limit).forEach((block) => {
      result.push(renderMealBlock({ block, language: params.language }));
    });
  });
  return result;
}

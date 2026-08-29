import {
  ValidatedExerciseCatalog,
  getExerciseLocations,
  getExerciseName,
  getExerciseRiskTags,
  type CatalogLanguage,
  type CatalogLocation,
  type CatalogMuscleGroup,
} from "../../exercise-catalog.js";
import { getFoodById, type FoodLanguage } from "../food-catalog.js";
import { V3_FOOD_NUTRITION } from "./candidate-provider.js";
import { V3Error } from "./errors.js";
import { generateOfficialDietDraft } from "./nutrition/official-engine.js";
import { conflictsWithFoodDeclaration } from "./food-declaration-policy.js";
import { WORKOUT_PRESCRIPTION_POLICY_VERSION, frequencySplitFor, prescriptionContext, sessionTemplateFor, templateFocus } from "./workout-prescription.js";
import type { DietPlanDraft, WorkoutPlanDraft } from "./repository.js";
import type { OfficialSnapshot } from "./types.js";

function locale(value: string): CatalogLanguage & FoodLanguage {
  return value === "en-US" || value === "it-IT" ? value : "pt-BR";
}

function trainingLocation(value: string): CatalogLocation {
  const normalized = value.toLowerCase();
  if (normalized.includes("home") || normalized.includes("casa")) return "home";
  if (normalized.includes("park") || normalized.includes("parque")) return "park";
  return "gym";
}

function riskTokens(snapshot: OfficialSnapshot): Set<string> {
  const declaredFacts = (snapshot.currentFacts || [])
    .filter((fact) => fact.factType === "PHYSICAL_CONSTRAINT")
    .map((fact) => String(fact.value.declaration || fact.canonicalValue));
  const declared = [snapshot.confirmedContext?.limitationDeclaration || "", ...declaredFacts].join(" ");
  const normalized = declared.toLocaleLowerCase("pt-BR");
  const operationalAliases = [
    [/joelh|knee/iu, ["knee", "knee_load", "knee_sensitive"]],
    [/lombar|lower back|schiena bassa/iu, ["lower_back", "spine_compression"]],
    [/ombro|shoulder|spalla/iu, ["shoulder", "shoulder_overhead"]],
    [/tornozel|ankle|caviglia/iu, ["ankle", "high_impact"]],
  ] as const;
  return new Set([...snapshot.healthConstraints.flatMap((constraint) => [
    constraint.bodyRegion?.toLowerCase(),
    ...constraint.description.toLowerCase().split(/[^a-z0-9_]+/),
  ]), ...normalized.split(/[^a-z0-9_]+/), ...operationalAliases.flatMap(([pattern, tags]) => pattern.test(normalized) ? tags : [])]
    .filter((value): value is string => Boolean(value)));
}

export function generateWorkoutDraft(snapshot: OfficialSnapshot, options: { sessionIndex?: number } = {}): WorkoutPlanDraft {
  if (!snapshot.confirmedContext) throw new V3Error("V3_CONFIRMED_CONTEXT_REQUIRED", "Contexto confirmado necessário para gerar treino.", 409);
  const language = locale(snapshot.profile.language);
  const location = trainingLocation(snapshot.profile.trainingLocation);
  const risks = riskTokens(snapshot);
  const frequency = snapshot.profile.weeklyFrequencyDaysPerWeek ?? snapshot.confirmedContext.weeklyFrequencyDaysPerWeek ?? 3;
  const ctx = prescriptionContext({
    trainingStatus: snapshot.profile.trainingStatus,
    goalCode: snapshot.goal.code,
    frequency,
    sessionIndex: options.sessionIndex ?? 0,
  });
  const template = sessionTemplateFor(ctx.frequency, ctx.sessionIndex);
  const focusGroups = templateFocus(template, ctx.experience);
  const eligibleFor = (group: CatalogMuscleGroup): (typeof ValidatedExerciseCatalog)[number][] =>
    ValidatedExerciseCatalog.filter((exercise) =>
      exercise.muscleGroup === group &&
      getExerciseLocations(exercise).includes(location) &&
      !getExerciseRiskTags(exercise).some((risk) => risks.has(risk)));
  const preferredId = location === "gym" && focusGroups.includes("peito") ? "supino_reto_maquina" : null;
  // Session variety for repeated templates (e.g. Upper x2 on 4x): rotate the
  // selection index per session so the same focus group picks a different
  // eligible exercise on the second occurrence.
  const pick = (group: CatalogMuscleGroup, occurrence: number): (typeof ValidatedExerciseCatalog)[number] | undefined => {
    const pool = eligibleFor(group);
    if (pool.length === 0) return undefined;
    return pool[occurrence % pool.length];
  };
  const selected: (typeof ValidatedExerciseCatalog)[number][] = [];
  // Aquecimento is always first; focus groups follow, respecting experience volume.
  const warmup = pick("aquecimento", 0);
  if (warmup) selected.push(warmup);
  for (let i = 0; i < focusGroups.length; i += 1) {
    const group = focusGroups[i];
    if (group === "aquecimento") continue;
    // Preferred exercise for the peito group on gym (keeps the canonical first
    // peito move stable); otherwise rotate within the eligible pool.
    if (group === "peito" && preferredId) {
      const preferred = ValidatedExerciseCatalog.find((exercise) => exercise.id === preferredId && eligibleFor("peito").some((candidate) => candidate.id === exercise.id));
      if (preferred && !selected.some((entry) => entry.id === preferred.id)) {
        selected.push(preferred);
        continue;
      }
    }
    const exercise = pick(group, ctx.sessionIndex + i);
    if (exercise && !selected.some((entry) => entry.id === exercise.id)) selected.push(exercise);
  }
  // Accessories: extra exercises for the largest focus group when the
  // experience tier allows them (deterministic, catalog-only).
  const accessoryCount = ctx.experience.accessoryCount;
  if (accessoryCount > 0) {
    const primary = focusGroups.find((group) => group !== "aquecimento");
    if (primary) {
      const pool = eligibleFor(primary);
      for (let i = 0; i < accessoryCount; i += 1) {
        const candidate = pool[i % pool.length];
        if (candidate && !selected.some((entry) => entry.id === candidate.id)) selected.push(candidate);
      }
    }
  }
  if (selected.length < 4) {
    throw new V3Error("V3_WORKOUT_CATALOG_INSUFFICIENT", "Catálogo seguro insuficiente para gerar o treino.", 409);
  }
  const sets = ctx.experience.sets;
  return {
    title: snapshot.goal.code === "hypertrophy" ? "Treino de hipertrofia" : "Treino oficial GUTO",
    generatedFrom: {
      goalCode: snapshot.goal.code,
      profileVersion: snapshot.profile.version,
      location,
      healthConstraintIds: snapshot.healthConstraints.map((constraint) => constraint.id),
      method: WORKOUT_PRESCRIPTION_POLICY_VERSION,
      policyVersion: WORKOUT_PRESCRIPTION_POLICY_VERSION,
      frequency: ctx.frequency,
      splitName: ctx.splitName,
      sessionIndex: ctx.sessionIndex,
      sessionCount: frequencySplitFor(ctx.frequency).sessions.length,
      sessionLabel: ctx.sessionLabel,
      experience: ctx.experience.label,
      confirmedContextId: snapshot.confirmedContext.id,
      confirmedContextVersion: snapshot.confirmedContext.version,
    },
    items: selected.map((exercise, position) => ({
      exerciseId: exercise.id,
      name: getExerciseName(exercise.id, language),
      purpose: exercise.movementPattern || exercise.muscleGroup,
      muscleGroup: exercise.muscleGroup,
      position,
      sets: position === 0 ? 1 : sets,
      reps: position === 0 ? "5-8 min" : ctx.repRange,
      canonicalNamePt: exercise.canonicalNamePt,
      rest: position === 0 ? "0:30min" : "1:30min",
      cue: exercise.movementPattern ? `Executa ${exercise.movementPattern} com controle e sem dor.` : "Execução controlada e sem dor.",
      note: "A técnica manda. Interrompe se houver dor.",
      videoUrl: exercise.videoUrl,
      sourceFileName: exercise.sourceFileName,
    })),
  };
}

interface FoodSeed { foodId: string; grams: number }

function foodItem(foodId: string, grams: number, position: number, language: FoodLanguage) {
  const food = getFoodById(foodId);
  const nutrition = V3_FOOD_NUTRITION[foodId];
  if (!food || !nutrition) throw new V3Error("V3_DIET_CATALOG_INCOMPLETE", `Alimento sem dados V3: ${foodId}.`, 409);
  const factor = grams / 100;
  const proteinGrams = Number((nutrition.proteinPer100g * factor).toFixed(2));
  const carbsGrams = Number((nutrition.carbsPer100g * factor).toFixed(2));
  const fatGrams = Number((nutrition.fatPer100g * factor).toFixed(2));
  const calories = Number((proteinGrams * 4 + carbsGrams * 4 + fatGrams * 9).toFixed(2));
  return {
    foodId,
    name: food.names[language] || food.names["en-US"],
    quantityGrams: grams,
    calories,
    proteinGrams,
    carbsGrams,
    fatGrams,
    position,
  };
}

export async function generateDietDraft(snapshot: OfficialSnapshot): Promise<DietPlanDraft> {
  if (!snapshot.confirmedContext) throw new V3Error("V3_CONFIRMED_CONTEXT_REQUIRED", "Contexto confirmado necessário para gerar dieta.", 409);
  const language = locale(snapshot.profile.language);
  const declaration = [
    snapshot.confirmedContext.foodDeclaration,
    ...(snapshot.currentFacts || [])
      .filter((fact) => fact.factType === "FOOD_CONSTRAINT" || fact.factType === "FOOD_EXCLUSION")
      .map((fact) => String(fact.value.declaration || fact.canonicalValue)),
  ].join(" ");
  const pick = (ids: string[], purpose: string): string => {
    const selected = ids.find((id) => !conflictsWithFoodDeclaration(id, declaration));
    if (!selected) throw new V3Error("V3_FOOD_DECLARATION_CLARIFICATION_REQUIRED", `Não há opção segura no catálogo V3 para ${purpose}.`, 409);
    return selected;
  };
  const proteinFood = pick(["eggs", "lentils", "beans"], "a proteína declarada");
  const breakfastCarb = pick(["oats", "rice", "potato", "sweet_potato"], "o carboidrato do café da manhã");
  const snackCarb = pick(["wholegrain_bread", "potato", "rice", "sweet_potato"], "o carboidrato do lanche");
  const breakfastFruit = pick(["banana", "apple", "berries"], "a fruta do café da manhã");
  const snackFruit = pick(["apple", "banana", "berries"], "a fruta do lanche");
  const lunchCarb = pick(["rice", "potato", "sweet_potato"], "o carboidrato do almoço");
  const dinnerCarb = pick(["potato", "rice", "sweet_potato"], "o carboidrato do jantar");
  const plantProtein = proteinFood !== "eggs";
  const officialDraft = await generateOfficialDietDraft(snapshot);
  if (snapshot.profile.country || snapshot.profile.city) officialDraft.generatedFrom = { ...officialDraft.generatedFrom, country: snapshot.profile.country ?? null, city: snapshot.profile.city ?? null };
  return officialDraft;
  /*
  const seeds: Array<{ name: string; items: FoodSeed[] }> = [
    { name: language === "pt-BR" ? "Café da manhã" : language === "it-IT" ? "Colazione" : "Breakfast", items: [{ foodId: breakfastCarb, grams: 80 }, { foodId: breakfastFruit, grams: 100 }] },
    { name: language === "pt-BR" ? "Almoço" : language === "it-IT" ? "Pranzo" : "Lunch", items: [{ foodId: lunchCarb, grams: 220 }, { foodId: proteinFood, grams: plantProtein ? 220 : 180 }] },
    { name: language === "pt-BR" ? "Lanche" : language === "it-IT" ? "Spuntino" : "Snack", items: [{ foodId: snackCarb, grams: 80 }, { foodId: snackFruit, grams: 150 }] },
    { name: language === "pt-BR" ? "Jantar" : language === "it-IT" ? "Cena" : "Dinner", items: [{ foodId: dinnerCarb, grams: 300 }, { foodId: proteinFood, grams: plantProtein ? 200 : 160 }] },
  ];
  const meals = seeds.map((meal, position) => {
    const items = meal.items.map((item, itemPosition) => foodItem(item.foodId, item.grams, itemPosition, language));
    return { name: meal.name, position, calories: Number(items.reduce((sum, item) => sum + item.calories, 0).toFixed(2)), items };
  });
  const items = meals.flatMap((meal) => meal.items);
  const sum = (values: number[]) => Number(values.reduce((total, value) => total + value, 0).toFixed(2));
  return {
    calculationMethod: "item_sum_and_4_4_9_v1",
    generatedFrom: {
      goalCode: snapshot.goal.code,
      profileVersion: snapshot.profile.version,
      country: snapshot.profile.country ?? null,
      city: snapshot.profile.city ?? null,
      language: snapshot.profile.language,
      dietStyle: snapshot.preferences.dietStyle || null,
      method: "catalog_macros_v1",
      confirmedContextId: snapshot.confirmedContext.id,
      confirmedContextVersion: snapshot.confirmedContext.version,
    },
    totalCalories: sum(items.map((item) => item.calories)),
    proteinGrams: sum(items.map((item) => item.proteinGrams)),
    carbsGrams: sum(items.map((item) => item.carbsGrams)),
    fatGrams: sum(items.map((item) => item.fatGrams)),
    meals,
  };
  */
}

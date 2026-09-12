import { activePhysicalDeclaration } from "./declaration-semantics.js";
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
import { dropSetEligibility, restPauseEligibility, supersetEligibility } from "./beta1-progression.js";
import { WORKOUT_PRESCRIPTION_POLICY_VERSION, frequencySplitFor, prescriptionContext, sessionTemplateFor, templateFocus } from "./workout-prescription.js";
import type { DietPlanDraft, WorkoutPlanDraft } from "./repository.js";
import type { OfficialSnapshot, WorkoutItem } from "./types.js";

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
    .filter((fact) => fact.factType === "PHYSICAL_CONSTRAINT" && fact.value.active !== false)
    .map((fact) => String(fact.value.declaration || fact.canonicalValue));
  const declared = [snapshot.confirmedContext?.limitationDeclaration || "", ...declaredFacts].map(activePhysicalDeclaration).join(" ");
  const normalized = declared.toLocaleLowerCase("pt-BR");
  const operationalAliases = [
    [/joelh|knee/iu, ["knee", "knee_load", "knee_sensitive"]],
    [/lombar|lower back|schiena bassa/iu, ["lower_back", "spine_compression"]],
    [/ombro|shoulder|spalla/iu, ["shoulder", "shoulder_overhead"]],
    [/tornozel|ankle|caviglia/iu, ["ankle", "high_impact"]],
  ] as const;
  return new Set([...snapshot.healthConstraints.flatMap((constraint) => [
    constraint.bodyRegion?.toLowerCase(),
    ...activePhysicalDeclaration(constraint.description).split(/[^a-z0-9_]+/),
  ]), ...normalized.split(/[^a-z0-9_]+/), ...operationalAliases.flatMap(([pattern, tags]) => pattern.test(normalized) ? tags : [])]
    .filter((value): value is string => Boolean(value)));
}

/** BETA1: curated memories may exclude exercises (e.g. academia sem hack squat). */
function excludedExerciseIdsFromMemories(snapshot: OfficialSnapshot): Set<string> {
  const excluded = new Set<string>();
  const EQUIPMENT_ALIASES: ReadonlyArray<[RegExp, string]> = [
    [/hack|hack squat/iu, "hack_squat"],
    [/smith/iu, "smith_machine"],
    [/leg\s?press|legpress/iu, "leg_press"],
    [/poli|cable/iu, "cable_station"],
  ];
  for (const memory of snapshot.relevantMemories || []) {
    if (memory.category !== "TRAINING_ENVIRONMENT" || memory.status !== "ACTIVE") continue;
    const equipment = String(memory.value.equipment || "");
    const available = memory.value.available === true;
    if (!equipment || available) continue;
    const alias = EQUIPMENT_ALIASES.find(([pattern]) => pattern.test(equipment))?.[1] || equipment;
    for (const exercise of ValidatedExerciseCatalog) {
      const haystack = `${exercise.id} ${exercise.canonicalNamePt || ""} ${Object.values(exercise.namesByLanguage || {}).join(" ")}`;
      if (haystack.toLowerCase().includes(alias.replace(/_/g, " ")) || haystack.toLowerCase().includes(alias)) {
        excluded.add(exercise.id);
      }
    }
  }
  return excluded;
}

export function generateWorkoutDraft(snapshot: OfficialSnapshot, options: { sessionIndex?: number } = {}): WorkoutPlanDraft {
  if (!snapshot.confirmedContext) throw new V3Error("V3_CONFIRMED_CONTEXT_REQUIRED", "Contexto confirmado necessário para gerar treino.", 409);
  const language = locale(snapshot.profile.language);
  const location = trainingLocation(snapshot.profile.trainingLocation);
  const risks = riskTokens(snapshot);
  const environmentExclusions = excludedExerciseIdsFromMemories(snapshot);
  const frequency = snapshot.profile.weeklyFrequencyDaysPerWeek ?? snapshot.confirmedContext.weeklyFrequencyDaysPerWeek ?? 3;
  const ctx = prescriptionContext({
    trainingStatus: snapshot.profile.trainingStatus,
    goalCode: snapshot.goal.code,
    frequency,
    // P0 (session rotation): the next logical session index is derived from
    // durable state (count of completed sessions) by the repository and
    // surfaced on the snapshot. Explicit options.sessionIndex (used by tests
    // and callers that already know the index) takes precedence.
    sessionIndex: options.sessionIndex ?? (snapshot as { nextSessionIndex?: number }).nextSessionIndex ?? 0,
  });
  const template = sessionTemplateFor(ctx.frequency, ctx.sessionIndex);
  const focusGroups = templateFocus(template, ctx.experience);
  const eligibleFor = (group: CatalogMuscleGroup): (typeof ValidatedExerciseCatalog)[number][] =>
    ValidatedExerciseCatalog.filter((exercise) =>
      exercise.muscleGroup === group &&
      getExerciseLocations(exercise).includes(location) &&
      !getExerciseRiskTags(exercise).some((risk) => risks.has(risk)) &&
      !environmentExclusions.has(exercise.id));
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
  // BETA1 advanced techniques: structured objects with deterministic policy —
  // NEVER a free-text note. At most ONE intensifier (DROP_SET or REST_PAUSE)
  // per session; machines/cables/isolators only; never for beginners.
  // SUPERSET pairs the two accessory-like items when eligible (A1/A2). The
  // base straight work keeps progression authority; technique extensions are
  // recorded separately (technique_type) and excluded from progression input.
  const items: WorkoutPlanDraft["items"] = selected.map((exercise, position) => ({
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
  }));
  const techniqueCandidates = items.filter((item) => item.position > 0);
  const dropSetCandidate = techniqueCandidates.find((item) =>
    dropSetEligibility(item as WorkoutItem, snapshot.profile.trainingStatus).eligible);
  const restPauseCandidate = techniqueCandidates.find((item) =>
    restPauseEligibility(item as WorkoutItem, snapshot.profile.trainingStatus).eligible);
  // Deterministic rotation keeps both intensifiers reachable while preserving
  // the one-intensifier cap. Odd logical sessions prefer REST_PAUSE; even
  // sessions prefer DROP_SET, with a safe fallback when only one is eligible.
  const preferRestPause = ctx.sessionIndex % 2 === 1;
  const intensifier = preferRestPause
    ? (restPauseCandidate ?? dropSetCandidate)
    : (dropSetCandidate ?? restPauseCandidate);
  if (intensifier) {
    const canRestPause = restPauseEligibility(intensifier as WorkoutItem, snapshot.profile.trainingStatus).eligible;
    const canDropSet = dropSetEligibility(intensifier as WorkoutItem, snapshot.profile.trainingStatus).eligible;
    if (preferRestPause && canRestPause) {
      intensifier.technique = { type: "REST_PAUSE", baseSetTarget: ctx.repRange, pauseSeconds: "15-20", miniSets: 1, miniSetTarget: "3-5" };
    } else if (canDropSet) {
      intensifier.technique = { type: "DROP_SET", applyOn: "LAST_SET", drops: 1, loadReductionPercent: 20, targetRepsAfterDrop: ctx.repRange };
    } else if (canRestPause) {
      intensifier.technique = { type: "REST_PAUSE", baseSetTarget: ctx.repRange, pauseSeconds: "15-20", miniSets: 1, miniSetTarget: "3-5" };
    }
  }
  if (supersetEligibility(snapshot.profile.trainingStatus).eligible && techniqueCandidates.length >= 2 && !intensifier) {
    const [a1, a2] = techniqueCandidates;
    a1.technique = { type: "SUPERSET", groupId: "SS-A", orderWithinGroup: 1 };
    a2.technique = { type: "SUPERSET", groupId: "SS-A", orderWithinGroup: 2 };
  }
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
    items,
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
  const officialDraft = await generateOfficialDietDraft(snapshot);
  if (snapshot.profile.country || snapshot.profile.city) officialDraft.generatedFrom = { ...officialDraft.generatedFrom, country: snapshot.profile.country ?? null, city: snapshot.profile.city ?? null };
  return officialDraft;
}

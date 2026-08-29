import { getCatalogById, getExerciseLocations, suggestExerciseSubstitutes, type CatalogLocation } from "../../exercise-catalog.js";
import { V3Error } from "./errors.js";
import type { OfficialSnapshot, WorkoutItem, WorkoutPlan } from "./types.js";

/**
 * SessionWorkout (P0#3) — separates the BASE workout (official prescription)
 * from the SESSION workout (what is executed today). Adaptations for "hoje em
 * casa", "só tenho 20 minutos" and "máquina ocupada" are computed as a derived
 * session and NEVER mutate the base plan.
 */
export type SessionAdaptationReason = "MACHINE_OCCUPIED" | "HOME_LOCATION" | "TIME_BUDGET" | "NONE";

export interface SessionWorkout {
  baseWorkoutId: string;
  baseWorkoutVersion: number;
  sessionId: string;
  sessionIndex: number;
  effectiveLocation: CatalogLocation;
  availableMinutes?: number;
  adaptationReasons: SessionAdaptationReason[];
  items: WorkoutItem[];
  status: "ready" | "adapted" | "insufficient";
}

export interface BuildSessionWorkoutInput {
  baseWorkout: WorkoutPlan;
  snapshot: OfficialSnapshot;
  sessionIndex?: number;
  effectiveLocation?: CatalogLocation;
  availableMinutes?: number;
  unavailableExerciseIds?: string[];
  rejectedCandidateIds?: string[];
}

/** Movement patterns considered "main" for a 20-minute priority cut. */
const MAIN_MOVEMENT_PATTERNS = new Set(["empurrar", "puxar", "agachamento", "extensao", "extensao-quadril", "elevacao", "unilateral"]);
const ACCESSORY_GROUPS = new Set(["bracos", "abdomen", "aquecimento"]);

function deriveLocation(snapshot: OfficialSnapshot): CatalogLocation {
  const raw = snapshot.confirmedContext?.trainingLocation || snapshot.profile.trainingLocation || "gym";
  const normalized = String(raw).toLowerCase();
  if (normalized.includes("home") || normalized.includes("casa")) return "home";
  if (normalized.includes("park") || normalized.includes("parque")) return "park";
  return "gym";
}

function cloneItem(item: WorkoutItem): WorkoutItem {
  return { ...item, id: `${item.id}-session`, position: item.position };
}

/** Deterministic estimated session duration (minutes) from sets, reps, rest. */
export function estimateSessionMinutes(items: WorkoutItem[]): number {
  const parseReps = (reps: string | undefined): number => {
    if (!reps) return 10;
    if (reps.includes("min")) return 6;
    const match = reps.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (match) return (Number(match[1]) + Number(match[2])) / 2;
    const single = Number(reps);
    return Number.isFinite(single) && single > 0 ? single : 10;
  };
  return Math.round(items.reduce((total, item) => {
    const sets = item.sets ?? 3;
    const reps = parseReps(item.reps);
    const restMinutes = item.rest === "0:30min" ? 0.5 : 1.5;
    return total + sets * (reps / 30 + restMinutes);
  }, 0));
}

/**
 * Builds the session workout for today from the base plan. The base plan is
 * never modified: all adaptations are applied to cloned items.
 */
export function buildSessionWorkout(input: BuildSessionWorkoutInput): SessionWorkout {
  const { baseWorkout, snapshot } = input;
  const effectiveLocation = input.effectiveLocation ?? deriveLocation(snapshot);
  // The base plan was generated for the profile/context location; the session
  // may override it (e.g. "hoje vou treinar em casa").
  const baseLocation = deriveLocation(snapshot);
  const sessionIndex = input.sessionIndex ?? 0;
  const reasons = new Set<SessionAdaptationReason>();
  const rejected = new Set(input.rejectedCandidateIds || []);
  const unavailable = new Set(input.unavailableExerciseIds || []);

  let items: WorkoutItem[] = baseWorkout.items.map(cloneItem);

  // 1. MACHINE OCCUPIED — substitute each unavailable exercise with a
  //    same-stimulus candidate (movement-pattern first, catalog-only, video).
  if (unavailable.size > 0) {
    reasons.add("MACHINE_OCCUPIED");
    items = items.map((item) => {
      if (!unavailable.has(item.exerciseId)) return item;
      const candidates = suggestExerciseSubstitutes(item.exerciseId, {
        location: effectiveLocation,
        userBodyRegion: [snapshot.confirmedContext?.limitationDeclaration || "", ...(snapshot.currentFacts || [])
          .filter((fact) => fact.factType === "PHYSICAL_CONSTRAINT")
          .map((fact) => String(fact.value.bodyRegion || fact.value.declaration || ""))].join(" "),
      }).filter((id) => !rejected.has(id) && id !== item.exerciseId);
      const replacement = candidates[0];
      if (!replacement) return item; // keep original if no safe substitute (validator decides)
      const catalog = getCatalogById(replacement);
      return {
        ...item,
        exerciseId: replacement,
        name: catalog ? catalog.namesByLanguage["pt-BR"] : replacement,
        purpose: catalog?.movementPattern || item.purpose,
        muscleGroup: catalog?.muscleGroup || item.muscleGroup,
        videoUrl: catalog?.videoUrl || item.videoUrl,
        sourceFileName: catalog?.sourceFileName || item.sourceFileName,
        canonicalNamePt: catalog?.canonicalNamePt || item.canonicalNamePt,
      };
    });
  }

  // 2. HOME / PARK — filter to exercises playable at the effective location.
  if (effectiveLocation !== baseLocation) {
    reasons.add("HOME_LOCATION");
    const filtered: WorkoutItem[] = [];
    for (const item of items) {
      const catalog = getCatalogById(item.exerciseId);
      const compatible = catalog && getExerciseLocations(catalog).includes(effectiveLocation);
      if (compatible) {
        filtered.push(item);
        continue;
      }
      // Try a same-stimulus substitute available at the effective location.
      const candidates = suggestExerciseSubstitutes(item.exerciseId, {
        location: effectiveLocation,
        userBodyRegion: [snapshot.confirmedContext?.limitationDeclaration || "", ...(snapshot.currentFacts || [])
          .filter((fact) => fact.factType === "PHYSICAL_CONSTRAINT")
          .map((fact) => String(fact.value.bodyRegion || fact.value.declaration || ""))].join(" "),
      }).filter((id) => !rejected.has(id));
      const replacement = candidates[0];
      if (replacement) {
        const catalogExercise = getCatalogById(replacement);
        filtered.push({
          ...item,
          exerciseId: replacement,
          name: catalogExercise?.namesByLanguage["pt-BR"] || replacement,
          purpose: catalogExercise?.movementPattern || item.purpose,
          muscleGroup: catalogExercise?.muscleGroup || item.muscleGroup,
          videoUrl: catalogExercise?.videoUrl || item.videoUrl,
          sourceFileName: catalogExercise?.sourceFileName || item.sourceFileName,
          canonicalNamePt: catalogExercise?.canonicalNamePt || item.canonicalNamePt,
        });
      }
      // No safe substitute at this location -> the item is dropped from the session.
    }
    items = filtered;
  }

  // 3. ONLY 20 MINUTES — priority cut: keep main movements, drop accessories,
  //    reduce sets. Deterministic, base untouched.
  if (input.availableMinutes !== undefined && input.availableMinutes < 30) {
    reasons.add("TIME_BUDGET");
    const main = items.filter((item) => {
      const catalog = getCatalogById(item.exerciseId);
      const pattern = catalog?.movementPattern || item.purpose;
      return MAIN_MOVEMENT_PATTERNS.has(pattern) && !ACCESSORY_GROUPS.has(item.muscleGroup);
    });
    const fallback = items.filter((item) => !main.includes(item));
    const prioritized = main.length >= 3 ? main : [...main, ...fallback];
    items = prioritized.map((item, index) => ({ ...item, position: index, sets: Math.min(item.sets ?? 3, 3) }));
  }

  if (items.length < 3) {
    throw new V3Error("V3_WORKOUT_CATALOG_INSUFFICIENT", "Catálogo seguro insuficiente para adaptar a sessão de hoje.", 409);
  }

  return {
    baseWorkoutId: baseWorkout.id,
    baseWorkoutVersion: baseWorkout.version,
    sessionId: `${baseWorkout.id}-session-${sessionIndex}`,
    sessionIndex,
    effectiveLocation,
    availableMinutes: input.availableMinutes,
    adaptationReasons: [...reasons],
    items: items.map((item, position) => ({ ...item, position })),
    status: reasons.size > 0 ? "adapted" : "ready",
  };
}

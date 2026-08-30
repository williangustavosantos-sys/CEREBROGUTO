import {
  getCatalogById,
  getExerciseLocations,
  validateExerciseSubstitute,
  filterExercisesBySafety,
  type CatalogLocation,
} from "../../exercise-catalog.js";
import { V3Error } from "./errors.js";
import type { OfficialSnapshot, WorkoutExerciseSessionEvent, WorkoutPlan } from "./types.js";

/**
 * Session-adapted execution policy (P0: adapted workout execution).
 *
 * SessionWorkout derives temporary adapted exercises (machine occupied, home
 * location, time budget) WITHOUT mutating the base plan, so an adapted
 * exerciseId is intentionally absent from guto_v3.workout_plan_items. The
 * execution recorder must therefore accept adapted exercises — but only when
 * the client can PROVE the adaptation is legitimate. Accepting any
 * exerciseId that merely declares `substitutedFromExerciseId` would let a
 * client record arbitrary exercises; accepting none would reject real
 * adapted executions (the P0 bug).
 *
 * An adapted execution event is accepted only when ALL of the following hold:
 *   1. `substitutedFromExerciseId` belongs to the official active base plan;
 *   2. `exerciseId` exists in the official catalog;
 *   3. `exerciseId` carries a valid catalog video;
 *   4. `exerciseId` is a valid deterministic substitute for
 *      `substitutedFromExerciseId` (target + movement compatibility);
 *   5. the substitute passes the deterministic safety filter for the user's
 *      current body-region constraints;
 *   6. the substitute is playable at the session's effective location;
 *   7. the base plan is never mutated by this path.
 *
 * Non-adapted events (no `substitutedFromExerciseId`) keep the strict base
 * plan membership rule in the repository.
 */

export interface SessionExecutionValidationInput {
  event: WorkoutExerciseSessionEvent;
  basePlan: WorkoutPlan;
  snapshot: OfficialSnapshot;
  effectiveLocation?: CatalogLocation;
}

function userBodyRegionText(snapshot: OfficialSnapshot): string {
  return [
    snapshot.confirmedContext?.limitationDeclaration || "",
    ...(snapshot.currentFacts || [])
      .filter((fact) => fact.factType === "PHYSICAL_CONSTRAINT")
      .map((fact) => String(fact.value.bodyRegion || fact.value.declaration || "")),
  ].join(" ");
}

/** Canonical session locations (matches CatalogLocation). */
const CANONICAL_LOCATIONS: ReadonlySet<string> = new Set(["gym", "home", "park"]);

/**
 * Resolves the effective location for an adapted-execution event.
 *
 * Authority order (P0: session location authority):
 *   1. `event.context.effectiveLocation` — explicit session override, but only
 *      accepted when it is a canonical value (gym/home/park). Any arbitrary
 *      string is IGNORED (never widens permissions), falling back to the next
 *      authority level.
 *   2. the session's effective location derived by the caller (SessionWorkout).
 *   3. the base/default profile location (confirmed context, then profile).
 */
export function resolveSessionEffectiveLocation(
  event: WorkoutExerciseSessionEvent,
  sessionLocation?: CatalogLocation,
  profileLocation?: string,
): CatalogLocation {
  const raw = event.context?.effectiveLocation;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (CANONICAL_LOCATIONS.has(normalized)) return normalized as CatalogLocation;
  }
  if (sessionLocation) return sessionLocation;
  const normalizedProfile = String(profileLocation || "").toLowerCase();
  if (normalizedProfile.includes("home") || normalizedProfile.includes("casa")) return "home";
  if (normalizedProfile.includes("park") || normalizedProfile.includes("parque")) return "park";
  return "gym";
}

/**
 * Validates an ADAPTED execution event (the event declares
 * `substitutedFromExerciseId`). Throws a 4xx V3Error on any violation.
 * Deterministic: no model, no network, catalog + base plan only.
 */
export function assertValidAdaptedExecution(input: SessionExecutionValidationInput): void {
  const { event, basePlan, snapshot } = input;

  // 1. The claimed source exercise must belong to the official base plan.
  const sourceItem = basePlan.items.find((item) => item.exerciseId === event.substitutedFromExerciseId);
  if (!sourceItem) {
    throw new V3Error(
      "V3_WORKOUT_EXERCISE_NOT_ACTIVE",
      "O exercício de origem da substituição não pertence ao treino oficial ativo.",
      409,
    );
  }

  // 2. The adapted exercise must exist in the official catalog.
  const adapted = getCatalogById(event.exerciseId);
  if (!adapted) {
    throw new V3Error("V3_WORKOUT_EXERCISE_NOT_ACTIVE", "Exercício adaptado não existe no catálogo oficial.", 409);
  }

  // 3. Video is mandatory for every official exercise.
  if (!adapted.videoUrl) {
    throw new V3Error("V3_WORKOUT_VIDEO_REQUIRED", "Exercício adaptado não possui vídeo validado.", 409);
  }

  // 4. Deterministic substitution validity (target + movement compatibility).
  const substitutedFromId = event.substitutedFromExerciseId as string; // non-null: guarded above
  const source = getCatalogById(substitutedFromId);
  if (!source || !validateExerciseSubstitute(source, adapted).valid) {
    throw new V3Error(
      "V3_WORKOUT_INVALID_SUBSTITUTION",
      "Exercício adaptado não é uma substituição válida do exercício oficial.",
      409,
    );
  }

  // 5. Safety filter for the user's current physical constraints.
  const bodyRegionText = userBodyRegionText(snapshot);
  const safeCandidates = filterExercisesBySafety([event.exerciseId], { userBodyRegion: bodyRegionText });
  if (!safeCandidates.includes(event.exerciseId)) {
    throw new V3Error(
      "V3_WORKOUT_SAFETY_BLOCKED",
      "Exercício adaptado não é seguro para as limitações físicas declaradas.",
      409,
    );
  }

  // 6. Effective session location. Authority order: explicit session
  //    override (event context, canonical values only) -> session location
  //    derived by the caller -> base/default profile location.
  const baseLocationRaw = snapshot.confirmedContext?.trainingLocation || snapshot.profile.trainingLocation || "gym";
  const effectiveLocation = resolveSessionEffectiveLocation(event, input.effectiveLocation, baseLocationRaw);
  if (!getExerciseLocations(adapted).includes(effectiveLocation)) {
    throw new V3Error(
      "V3_WORKOUT_LOCATION_INCOMPATIBLE",
      "Exercício adaptado não pode ser executado no local da sessão atual.",
      409,
    );
  }
}

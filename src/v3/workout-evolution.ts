import type { WorkoutEvolutionDecision, WorkoutExerciseSessionEvent, WorkoutNextPrescription } from "./types.js";

/**
 * Deterministic slice of the evolution engine (P0#4). The decision is computed
 * from the current event PLUS the recent execution history of the same
 * exercise, so PROGRESS requires 2+ consecutive easy completed sessions —
 * never a single isolated easy set. The decision never mutates a plan by
 * itself; it produces a concrete NEXT PRESCRIPTION (rep/load/set delta) that
 * the executor may apply to the next session.
 */

const EASY_DIFFICULTY_MAX = 7;
const HARD_DIFFICULTY_MIN = 9;
const TOP_REP_MIN = 12;
const MIN_SETS_COMPLETED = 3;
const CONSECUTIVE_EASY_REQUIRED = 2;

function isEasyCompleted(event: WorkoutExerciseSessionEvent): boolean {
  return event.completed === true &&
    (event.perceivedDifficulty ?? 10) <= EASY_DIFFICULTY_MAX &&
    (event.repetitions ?? 0) >= TOP_REP_MIN &&
    (event.setsCompleted ?? 0) >= MIN_SETS_COMPLETED;
}

function consecutiveEasyCount(history: WorkoutExerciseSessionEvent[], current: WorkoutExerciseSessionEvent): number {
  const events = [...history, current];
  let count = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (isEasyCompleted(events[i])) count += 1;
    else break;
  }
  return count;
}

function nextPrescriptionFor(
  exerciseId: string,
  decision: WorkoutEvolutionDecision["decision"],
  event: WorkoutExerciseSessionEvent,
  reason: string,
): WorkoutNextPrescription {
  switch (decision) {
    case "PROGRESS": {
      // Deterministic increment: +2 target reps when reps were recorded,
      // otherwise suggest a small load increase when a load is registered.
      if (event.repetitions) {
        return { exerciseId, action: "add_reps", targetReps: (event.repetitions || 12) + 2, reason };
      }
      if (event.loadValue) {
        return { exerciseId, action: "increase_load", loadDeltaKg: Number((event.loadValue * 0.05).toFixed(1)), reason };
      }
      return { exerciseId, action: "add_reps", targetReps: 12, reason };
    }
    case "REGRESS": {
      // Deterministic reduction: -2 target reps or -10% load.
      if (event.repetitions) {
        return { exerciseId, action: "reduce_reps", targetReps: Math.max(6, (event.repetitions || 10) - 2), reason };
      }
      if (event.loadValue) {
        return { exerciseId, action: "reduce_load", loadDeltaKg: Number((event.loadValue * -0.1).toFixed(1)), reason };
      }
      return { exerciseId, action: "review", reason };
    }
    case "REVIEW":
      return { exerciseId, action: "review", reason };
    case "SUBSTITUTE":
      return { exerciseId, action: "maintain", reason: "Substituição registrada; dose mantida." };
    default:
      return { exerciseId, action: "maintain", reason };
  }
}

/**
 * Decides the evolution of one exercise from the current event and its recent
 * history. `history` must contain prior events of the SAME exerciseId,
 * ordered oldest -> newest.
 */
export function decideWorkoutEvolution(
  event: WorkoutExerciseSessionEvent,
  history: WorkoutExerciseSessionEvent[] = [],
): WorkoutEvolutionDecision {
  if (event.substitutedFromExerciseId) {
    return { exerciseId: event.exerciseId, decision: "SUBSTITUTE", reasonCode: "SESSION_SUBSTITUTION_RECORDED", nextPrescription: nextPrescriptionFor(event.exerciseId, "SUBSTITUTE", event, "") };
  }
  if (!event.completed) {
    return { exerciseId: event.exerciseId, decision: "REVIEW", reasonCode: "EXERCISE_NOT_COMPLETED", nextPrescription: nextPrescriptionFor(event.exerciseId, "REVIEW", event, "Execução não completada; revisar antes de progredir.") };
  }
  if ((event.perceivedDifficulty || 0) >= HARD_DIFFICULTY_MIN) {
    return { exerciseId: event.exerciseId, decision: "REGRESS", reasonCode: "HIGH_PERCEIVED_DIFFICULTY", nextPrescription: nextPrescriptionFor(event.exerciseId, "REGRESS", event, "Esforço muito alto; reduzir a dose na próxima sessão.") };
  }
  // Pain is a safety concern, not high RPE: a PHYSICAL_CONSTRAINT context
  // always lands on REVIEW so the executor never auto-progresses.
  if (event.context?.safetyConcern === true) {
    return { exerciseId: event.exerciseId, decision: "REVIEW", reasonCode: "PAIN_OR_SAFETY_CONCERN", nextPrescription: nextPrescriptionFor(event.exerciseId, "REVIEW", event, "Dor ou desconforto relatado; não progredir até avaliação.") };
  }
  const easy = isEasyCompleted(event);
  if (easy) {
    if (consecutiveEasyCount(history, event) >= CONSECUTIVE_EASY_REQUIRED) {
      return { exerciseId: event.exerciseId, decision: "PROGRESS", reasonCode: "CONSISTENT_LOW_DIFFICULTY_COMPLETION", nextPrescription: nextPrescriptionFor(event.exerciseId, "PROGRESS", event, "Duas execuções fáceis consecutivas; aumentar a dose.") };
    }
    return { exerciseId: event.exerciseId, decision: "MAINTAIN", reasonCode: "SINGLE_EASY_SESSION_NOT_ENOUGH", nextPrescription: nextPrescriptionFor(event.exerciseId, "MAINTAIN", event, "Uma sessão fácil não é suficiente; manter a dose.") };
  }
  return { exerciseId: event.exerciseId, decision: "MAINTAIN", reasonCode: "CURRENT_DOSE_APPROPRIATE", nextPrescription: nextPrescriptionFor(event.exerciseId, "MAINTAIN", event, "Dose atual adequada.") };
}

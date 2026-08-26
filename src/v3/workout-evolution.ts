import type { WorkoutEvolutionDecision, WorkoutExerciseSessionEvent } from "./types.js";

/**
 * First deterministic slice of the evolution engine. It intentionally makes
 * no medical inference and never changes a plan by itself; the executor owns
 * any later plan mutation.
 */
export function decideWorkoutEvolution(event: WorkoutExerciseSessionEvent): WorkoutEvolutionDecision {
  if (event.substitutedFromExerciseId) {
    return { exerciseId: event.exerciseId, decision: "SUBSTITUTE", reasonCode: "SESSION_SUBSTITUTION_RECORDED" };
  }
  if (!event.completed) return { exerciseId: event.exerciseId, decision: "REVIEW", reasonCode: "EXERCISE_NOT_COMPLETED" };
  if ((event.perceivedDifficulty || 0) >= 9) return { exerciseId: event.exerciseId, decision: "REGRESS", reasonCode: "HIGH_PERCEIVED_DIFFICULTY" };
  if ((event.perceivedDifficulty || 10) <= 6 && (event.repetitions || 0) >= 12 && (event.setsCompleted || 0) >= 3) {
    return { exerciseId: event.exerciseId, decision: "PROGRESS", reasonCode: "CONSISTENT_LOW_DIFFICULTY_COMPLETION" };
  }
  return { exerciseId: event.exerciseId, decision: "MAINTAIN", reasonCode: "CURRENT_DOSE_APPROPRIATE" };
}

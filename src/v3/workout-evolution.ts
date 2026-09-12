import { decideDoubleProgression, mapLegacyDifficulty, toWorkoutEvolutionDecision, type ProgressionEvidence } from "./beta1-progression.js";
import type { WorkoutEvolutionDecision, WorkoutExerciseSessionEvent, WorkoutItem } from "./types.js";

/** Compatibility adapter, not a second progression engine.
 * Aggregate summaries never stand in for recorded work sets. Repository callers
 * supply server-loaded evidence; absent evidence means review, not invented reps.
 */
export function decideWorkoutEvolution(
  event: WorkoutExerciseSessionEvent,
  history: WorkoutExerciseSessionEvent[] = [],
  item?: WorkoutItem,
  evidence?: ProgressionEvidence,
): WorkoutEvolutionDecision {
  const safety = [...history, event].slice(-2).some(entry =>
    entry.context?.safetyConcern === true || entry.context?.pain === true || mapLegacyDifficulty(entry.perceivedDifficulty) === "DOR",
  ) || evidence?.sessions.slice(-2).some(entry => entry.pain || entry.difficultyLabel === "DOR");
  if (safety) return {
    exerciseId: event.exerciseId, decision: "REVIEW", reasonCode: "PAIN_SAFETY_BRANCH",
    nextPrescription: { exerciseId: event.exerciseId, action: "review", reason: "Dor recente registrada; revisar antes de alterar a dose." },
  };
  if (event.substitutedFromExerciseId) return {
    exerciseId: event.exerciseId, decision: "SUBSTITUTE", reasonCode: "SESSION_SUBSTITUTION_RECORDED",
    nextPrescription: { exerciseId: event.exerciseId, action: "maintain", reason: "Substituição registrada; dose mantida." },
  };
  if (!item || !evidence || evidence.exerciseId !== event.exerciseId || item.exerciseId !== event.exerciseId || !event.completed) return {
    exerciseId: event.exerciseId, decision: "REVIEW", reasonCode: "INSUFFICIENT_DATA",
    nextPrescription: { exerciseId: event.exerciseId, action: "review", reason: "Prescrição e séries completas são necessárias para avaliar a próxima dose." },
  };
  return toWorkoutEvolutionDecision(decideDoubleProgression(evidence, item));
}

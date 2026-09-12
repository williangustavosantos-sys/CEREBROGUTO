import type { WorkoutItem, WorkoutEvolutionDecision, WorkoutNextPrescription } from "./types.js";

/**
 * BETA1 deterministic progression engine + advanced-technique policy.
 *
 * The DECISION is fully deterministic (double progression over structured
 * execution evidence); the LLM may only EXPLAIN it afterwards from
 * WorkoutEvolutionDecision rows. Pain is a safety branch: never auto-progress.
 * Advanced techniques are structured objects with eligibility metadata — never
 * a free-text note — and their extension sets (drop/rest-pause) are excluded
 * from progression evidence so extensions are never read as work sets.
 */

export type DifficultyLabel = "FACIL" | "BOA" | "PESADA" | "DOR";
export type TechniqueType = "STRAIGHT_SET" | "SUPERSET" | "DROP_SET" | "REST_PAUSE";

export interface ExerciseProgressSnapshot {
  exerciseId: string;
  trend: "IMPROVING" | "STABLE" | "REGRESSING" | "INSUFFICIENT_DATA";
  reasonCodes: string[];
  sessionsConsidered: number;
  latestLoadKg: number | null;
  latestRepsPerSet: number[];
  avgDifficultyLabel: DifficultyLabel | null;
}

export interface SetExecutionInput {
  setNumber: number;
  loadKg?: number;
  reps?: number;
  techniqueType: TechniqueType;
  techniqueGroup?: string;
}

export interface ExerciseExecutionInput {
  exerciseId: string;
  completed: boolean;
  difficultyLabel: DifficultyLabel;
  pain?: boolean;
  sets: SetExecutionInput[];
  substitutedFromExerciseId?: string;
  substitutionReason?: string;
}

// ─── Difficulty → approximate effort (subjective, structured) ────────────────

export function difficultyLabelToRpe(label: DifficultyLabel): number {
  switch (label) {
    case "FACIL": return 6.5;
    case "BOA": return 8;
    case "PESADA": return 9.5;
    case "DOR": return 10;
  }
}

export function mapLegacyDifficulty(perceivedDifficulty: number | undefined): DifficultyLabel | null {
  if (perceivedDifficulty == null) return null;
  if (perceivedDifficulty <= 7) return "FACIL";
  if (perceivedDifficulty <= 8) return "BOA";
  if (perceivedDifficulty <= 9) return "PESADA";
  return "DOR";
}

/** Inverse mapping so the legacy 1-10 perceived_difficulty column stays filled. */
export function mapLegacyDifficultyInverse(label: DifficultyLabel): number {
  switch (label) {
    case "FACIL": return 7;
    case "BOA": return 8;
    case "PESADA": return 9;
    case "DOR": return 10;
  }
}

// ─── Advanced techniques: structured objects + deterministic policy ──────────

export interface TechniquePrescription {
  type: TechniqueType;
  applyOn?: "LAST_SET";
  drops?: number;
  loadReductionPercent?: number;
  targetRepsAfterDrop?: string;
  baseSetTarget?: string;
  pauseSeconds?: string;
  miniSets?: number;
  miniSetTarget?: string;
  groupId?: string;
  orderWithinGroup?: number;
}

export interface TechniqueEligibility {
  eligible: boolean;
  reasonCode: string;
}

/** Machines/cables/isolators tolerate fast load reduction; free heavy bars do not. */
const DROP_SET_SAFE_PATTERNS = [
  /poli/iu, /cable/iu, /maquina|machine/iu, /peitoral/iu, /crucifixo/iu,
  /eleva/iu, /rosca/iu, /triceps?/iu, /panturrilha|calf/iu, /abd/iu,
  /legpress|leg\s?press/iu, /hack/iu, /pulldown|pulldown/iu, /remada\s+m(á|a)quina/iu,
];

export function dropSetEligibility(item: WorkoutItem, trainingStatus: string): TechniqueEligibility {
  if (trainingStatus === "beginner" || trainingStatus === "returning") {
    return { eligible: false, reasonCode: "BEGINNER_NOT_ELIGIBLE" };
  }
  const haystack = `${item.name} ${item.purpose} ${item.canonicalNamePt || ""}`;
  if (!DROP_SET_SAFE_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { eligible: false, reasonCode: "EXERCISE_NOT_DROP_SAFE" };
  }
  return { eligible: true, reasonCode: "ELIGIBLE_MACHINE_CABLE_ISOLATION" };
}

export function supersetEligibility(trainingStatus: string): TechniqueEligibility {
  if (trainingStatus === "beginner") {
    return { eligible: false, reasonCode: "BEGINNER_NOT_ELIGIBLE" };
  }
  return { eligible: true, reasonCode: "ELIGIBLE_TIME_EFFICIENT_PAIRING" };
}

export function restPauseEligibility(item: WorkoutItem, trainingStatus: string): TechniqueEligibility {
  if (trainingStatus === "beginner" || trainingStatus === "returning") {
    return { eligible: false, reasonCode: "BEGINNER_NOT_ELIGIBLE" };
  }
  const haystack = `${item.name} ${item.purpose} ${item.canonicalNamePt || ""}`;
  if (!DROP_SET_SAFE_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { eligible: false, reasonCode: "EXERCISE_NOT_REST_PAUSE_SAFE" };
  }
  return { eligible: true, reasonCode: "ELIGIBLE_MACHINE_CABLE_ISOLATION" };
}

export const MAX_INTENSIFIER_TECHNIQUES_PER_SESSION = 1;

/** Plausible load increments per equipment class (never assume 2.5 kg for all). */
export function loadIncrementKg(item: WorkoutItem, currentLoad: number): number {
  const haystack = `${item.name} ${item.purpose} ${item.canonicalNamePt || ""}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/halter|dumbbell/iu.test(haystack)) {
    return currentLoad < 10 ? 1 : currentLoad < 20 ? 2 : 2.5;
  }
  if (/poli|cable|anilha|maquina|machine|smith|legpress/iu.test(haystack)) {
    return currentLoad < 40 ? 2.5 : 5;
  }
  return 2.5;
}

// ─── Double progression (Beta 1 core rules) ──────────────────────────────────

export interface ProgressionEvidence {
  exerciseId: string;
  repRangeLow: number;
  repRangeHigh: number;
  /** Oldest → newest, STRAIGHT_SET work only (never technique extensions). */
  sessions: Array<{
    loadKg: number | null;
    repsPerSet: number[];
    difficultyLabel: DifficultyLabel | null;
    pain: boolean;
    completed: boolean;
  }>;
}

export type ProgressionDecisionType = "PROGRESS" | "MAINTAIN" | "REGRESS" | "SUBSTITUTE" | "DELOAD" | "REVIEW";
export type ProgressionReasonCode =
  | "REP_RANGE_TOP_REACHED_CONSISTENTLY"
  | "SINGLE_TOP_SESSION_NOT_ENOUGH"
  | "REPS_WITHIN_RANGE_APPROPRIATE_DOSE"
  | "REPS_FAILING_BELOW_RANGE"
  | "HIGH_EFFORT_RECURRENT"
  | "PAIN_SAFETY_BRANCH"
  | "INSUFFICIENT_DATA";

export interface ProgressionDecision {
  exerciseId: string;
  decision: ProgressionDecisionType;
  reasonCode: ProgressionReasonCode;
  fromLoadKg: number | null;
  toLoadKg: number | null;
  explanation: string;
  evidenceSessionCount: number;
}

const CONSECUTIVE_TOP_REQUIRED = 2;
const PAIN_RECENT_WINDOW = 2;

export function decideDoubleProgression(evidence: ProgressionEvidence, item: WorkoutItem): ProgressionDecision {
  const { exerciseId, repRangeHigh, repRangeLow } = evidence;
  const recentSafety = evidence.sessions
    .slice(-PAIN_RECENT_WINDOW)
    .some((session) => session.pain || session.difficultyLabel === "DOR");
  if (recentSafety) {
    return { exerciseId, decision: "REVIEW", reasonCode: "PAIN_SAFETY_BRANCH", fromLoadKg: latestLoad(evidence), toLoadKg: null, explanation: "Dor recente registrada; não progredir até nova avaliação (safety policy).", evidenceSessionCount: evidence.sessions.length };
  }
  // Keep interruptions in the sequence: filtering them out would manufacture a streak.
  const sessions = evidence.sessions;
  const requiredSets = item.sets;
  const hasWork = (session: ProgressionEvidence["sessions"][number]) =>
    session.completed && session.difficultyLabel != null &&
    session.loadKg != null && Number.isFinite(session.loadKg) && session.loadKg >= 0 &&
    Number.isInteger(requiredSets) && requiredSets! > 0 && session.repsPerSet.length === requiredSets &&
    session.repsPerSet.every(rep => Number.isInteger(rep) && rep >= 0);
  if (sessions.length === 0 || !hasWork(sessions[sessions.length - 1]) ||
      !Number.isFinite(repRangeLow) || !Number.isFinite(repRangeHigh) || repRangeLow <= 0 || repRangeHigh < repRangeLow) {
    return { exerciseId, decision: "REVIEW", reasonCode: "INSUFFICIENT_DATA", fromLoadKg: null, toLoadKg: null, explanation: "Sem execuções completas registradas; nada a decidir ainda.", evidenceSessionCount: evidence.sessions.length };
  }
  const current = sessions[sessions.length - 1];
  const fromLoad = current.loadKg;
  const atTop = (reps: number[]) => reps.length > 0 && reps.every((rep) => rep >= repRangeHigh);
  const belowRange = (reps: number[]) => reps.length > 0 && reps.filter((rep) => rep < repRangeLow).length >= Math.ceil(reps.length / 2);

  const topStreak = countTrailingWhere(sessions, (session) => hasWork(session) &&
    session.loadKg === fromLoad && fromLoad != null && fromLoad > 0 &&
    atTop(session.repsPerSet) && session.difficultyLabel !== "PESADA");
  if (topStreak >= CONSECUTIVE_TOP_REQUIRED && fromLoad != null) {
    const increment = loadIncrementKg(item, fromLoad);
    return { exerciseId, decision: "PROGRESS", reasonCode: "REP_RANGE_TOP_REACHED_CONSISTENTLY", fromLoadKg: fromLoad, toLoadKg: Number((fromLoad + increment).toFixed(1)), explanation: `Topo da faixa ${repRangeLow}-${repRangeHigh} atingido em ${topStreak} sessões consecutivas com esforço controlado; subir ${increment} kg.`, evidenceSessionCount: evidence.sessions.length };
  }
  if (topStreak === 1) {
    return { exerciseId, decision: "MAINTAIN", reasonCode: "SINGLE_TOP_SESSION_NOT_ENOUGH", fromLoadKg: fromLoad, toLoadKg: fromLoad, explanation: `Um único topo de faixa não é suficiente; manter ${fromLoad} kg e progredir reps.`, evidenceSessionCount: evidence.sessions.length };
  }
  if (belowRange(current.repsPerSet) || current.difficultyLabel === "PESADA") {
    const reduction = fromLoad != null ? Number((fromLoad * 0.9).toFixed(1)) : null;
    return { exerciseId, decision: "REGRESS", reasonCode: current.difficultyLabel === "PESADA" ? "HIGH_EFFORT_RECURRENT" : "REPS_FAILING_BELOW_RANGE", fromLoadKg: fromLoad, toLoadKg: reduction, explanation: `Reps abaixo da faixa ou esforço alto; reduzir carga (~10%) e reconstruir reps na faixa.`, evidenceSessionCount: evidence.sessions.length };
  }
  return { exerciseId, decision: "MAINTAIN", reasonCode: "REPS_WITHIN_RANGE_APPROPRIATE_DOSE", fromLoadKg: fromLoad, toLoadKg: fromLoad, explanation: `Reps dentro da faixa com esforço apropriado; dose atual mantida.`, evidenceSessionCount: evidence.sessions.length };
}

/** Only repetition prescriptions qualify; minutes/seconds are not rep ranges. */
export function progressionRepRange(item: WorkoutItem): { repRangeLow: number; repRangeHigh: number } | null {
  const match = /^\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*(?:reps?|repetições|ripetizioni)?\s*$/iu.exec(item.reps || "");
  if (!match) return null;
  const low = Number(match[1]);
  const high = Number(match[2] || match[1]);
  return low > 0 && high >= low ? { repRangeLow: low, repRangeHigh: high } : null;
}

/** One mapping for every public adapter. Absolute targets prevent delta replay. */
export function toWorkoutEvolutionDecision(progression: ProgressionDecision): WorkoutEvolutionDecision {
  const decision = ["PROGRESS", "REGRESS", "MAINTAIN", "REVIEW"].includes(progression.decision)
    ? progression.decision as WorkoutEvolutionDecision["decision"] : "REVIEW";
  const nextPrescription: WorkoutNextPrescription = {
    exerciseId: progression.exerciseId,
    action: decision === "REVIEW" ? "review" : "maintain",
    reason: progression.explanation,
  };
  if ((decision === "PROGRESS" || decision === "REGRESS") && progression.fromLoadKg != null && progression.toLoadKg != null) {
    nextPrescription.action = decision === "PROGRESS" ? "increase_load" : "reduce_load";
    nextPrescription.loadDeltaKg = Number((progression.toLoadKg - progression.fromLoadKg).toFixed(1));
    nextPrescription.targetLoadKg = progression.toLoadKg;
    nextPrescription.fromLoadKg = progression.fromLoadKg;
  }
  return { exerciseId: progression.exerciseId, decision, reasonCode: progression.reasonCode, nextPrescription };
}

function latestLoad(evidence: ProgressionEvidence): number | null {
  for (let index = evidence.sessions.length - 1; index >= 0; index -= 1) {
    const load = evidence.sessions[index]?.loadKg;
    if (load != null) return load;
  }
  return null;
}

function countTrailingWhere(sessions: ProgressionEvidence["sessions"], predicate: (session: ProgressionEvidence["sessions"][number]) => boolean): number {
  let count = 0;
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    if (predicate(sessions[index])) count += 1;
    else break;
  }
  return count;
}

/** Volume/sign trend over the last N sessions for ExerciseProgressSnapshot. */
export function buildExerciseProgressSnapshot(
  exerciseId: string,
  evidence: ProgressionEvidence,
): ExerciseProgressSnapshot {
  const completedSessions = evidence.sessions.filter((session) => session.completed && !session.pain);
  if (completedSessions.length < 2) {
    return { exerciseId, trend: "INSUFFICIENT_DATA", reasonCodes: ["INSUFFICIENT_DATA"], sessionsConsidered: evidence.sessions.length, latestLoadKg: latestLoad(evidence), latestRepsPerSet: completedSessions[completedSessions.length - 1]?.repsPerSet || [], avgDifficultyLabel: completedSessions[completedSessions.length - 1]?.difficultyLabel || null };
  }
  const loadTrend = linearTrend(completedSessions.map((session) => session.loadKg ?? 0));
  const repTrend = linearTrend(completedSessions.map((session) => session.repsPerSet.reduce((sum, rep) => sum + rep, 0) / Math.max(1, session.repsPerSet.length)));
  if (loadTrend > 0.01 || repTrend > 0.3) return { exerciseId, trend: "IMPROVING", reasonCodes: [...(loadTrend > 0.01 ? ["LOAD_TREND_UP"] : []), ...(repTrend > 0.3 ? ["REPS_TREND_UP"] : [])], sessionsConsidered: evidence.sessions.length, latestLoadKg: latestLoad(evidence), latestRepsPerSet: completedSessions[completedSessions.length - 1]?.repsPerSet || [], avgDifficultyLabel: completedSessions[completedSessions.length - 1]?.difficultyLabel || null };
  if (loadTrend < -0.01 || repTrend < -0.3) return { exerciseId, trend: "REGRESSING", reasonCodes: [...(loadTrend < -0.01 ? ["LOAD_TREND_DOWN"] : []), ...(repTrend < -0.3 ? ["REPS_TREND_DOWN"] : [])], sessionsConsidered: evidence.sessions.length, latestLoadKg: latestLoad(evidence), latestRepsPerSet: completedSessions[completedSessions.length - 1]?.repsPerSet || [], avgDifficultyLabel: completedSessions[completedSessions.length - 1]?.difficultyLabel || null };
  return { exerciseId, trend: "STABLE", reasonCodes: ["STABLE_DOSE"], sessionsConsidered: evidence.sessions.length, latestLoadKg: latestLoad(evidence), latestRepsPerSet: completedSessions[completedSessions.length - 1]?.repsPerSet || [], avgDifficultyLabel: completedSessions[completedSessions.length - 1]?.difficultyLabel || null };
}

function linearTrend(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (index - meanX) * (values[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

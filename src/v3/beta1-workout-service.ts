import { createHash } from "node:crypto";
import { Beta1CurationService } from "./beta1-curation-service.js";
import { V3Error } from "./errors.js";
import { buildExerciseProgressSnapshot, type DifficultyLabel, type SetExecutionInput } from "./beta1-progression.js";
import { buildSessionFacts, decideSessionOutcome, computeFeedbackTrend, classifyCauseExplanation, buildSessionPresence, type SessionPresenceSummary } from "./beta1-presence.js";
import type { ActorContext, OfficialSnapshot, WorkoutEvolutionDecision } from "./types.js";

/**
 * BETA1 workout orchestration: self-report completion + post-completion
 * learning. After the session is completed exactly once, the backend derives
 * what the next decision needs WITHOUT another chat: pain becomes a curated
 * TRAINING_LIMITATIONS memory (source=workout_execution) and per-exercise
 * progress snapshots are computed from structured set evidence.
 */

export interface Beta1WorkoutRepository {
  startOrResumeBeta1WorkoutSession(input: { actor: ActorContext; requestId: string }): Promise<{ workoutSessionId: string; resumed: boolean }>;
  completeBeta1WorkoutSession(input: {
    actor: ActorContext;
    requestId: string;
    workoutSessionId: string;
    completionMode: "self_report";
  }): Promise<{ status: "completed"; xpGranted: boolean; xpAmount: number; nextSessionIndex: number }>;
  recordBeta1ExecutionFeedback(input: {
    actor: ActorContext;
    requestId: string;
    workoutSessionId: string;
    exerciseId: string;
    difficultyLabel: DifficultyLabel;
    pain?: boolean;
    sets: SetExecutionInput[];
    substitutedFromExerciseId?: string;
    substitutionReason?: string;
    techniqueGroup?: string;
  }): Promise<{ decision: WorkoutEvolutionDecision; setCount: number }>;
  recordBeta1SessionFeedback(input: {
    actor: ActorContext;
    requestId: string;
    workoutSessionId: string;
    overallDifficulty: "FACIL" | "BOA" | "PESADA" | "DOR";
    pain: boolean;
    causeExplanation: string | null;
    causeCategory: "user_state" | "training" | null;
  }): Promise<{ duplicate: boolean }>;

  loadBeta1SessionFeedbackHistory(actor: ActorContext, limit?: number): Promise<Array<{
    workoutSessionId: string; overallDifficulty: "FACIL" | "BOA" | "PESADA" | "DOR"; pain: boolean;
    causeExplanation: string | null; causeCategory: "user_state" | "training" | null; createdAt: string;
  }>>;

  loadSessionExecutionFeedback(actor: ActorContext, workoutSessionId: string): Promise<Array<{
    exerciseId: string;
    difficultyLabel: DifficultyLabel | null;
    pain: boolean;
    completed: boolean;
    setRows: Array<{ setNumber: number; loadKg: number | null; reps: number | null; techniqueType: string }>;
    repRangeLow: number;
    repRangeHigh: number;
  }>>;
  loadWorkoutItem(actor: ActorContext, planId: string, exerciseId: string): Promise<{
    id: string;
    exerciseId: string;
    name: string;
    purpose: string;
    muscleGroup: string;
    position: number;
    reps?: string;
    canonicalNamePt?: string;
  } | null>;
  persistCuratedMemory(input: {
    actor: ActorContext;
    requestId: string;
    candidate: { category: "TRAINING_LIMITATIONS"; key: string; value: Record<string, unknown>; confidence: "explicit" };
    sourceType: "workout_execution";
  }): Promise<unknown>;
}

export interface Beta1CompletionOutcome {
  status: "completed";
  xpGranted: boolean;
  xpAmount: number;
  nextSessionIndex: number;
  painMemoriesPersisted: number;
  progressSnapshots: Array<{ exerciseId: string; trend: string; reasonCodes: string[] }>;
  presence: SessionPresenceSummary | null;
}

// Child request ids must remain VALID UUIDs (guto_events.request_id is
// uuid NOT NULL) while staying deterministic per (requestId, suffix) so that
// retries dedupe on the same event identity.
const CHILD_REQUEST = (requestId: string, suffix: string): string => {
  const digest = createHash("sha256").update(`${requestId}:${suffix}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

export class Beta1WorkoutService {
  constructor(
    private readonly repository: Beta1WorkoutRepository,
    private readonly curation: Beta1CurationService,
  ) {}

  /** Backend-owned session identity: start once, resume across reload/new clients. */
  async startOrResumeSession(input: { actor: ActorContext; requestId: string }): Promise<{ workoutSessionId: string; resumed: boolean }> {
    return this.repository.startOrResumeBeta1WorkoutSession(input);
  }

  /** One execution = one exercise of the session, with REAL set rows. */
  async recordExecution(input: {
    actor: ActorContext;
    requestId: string;
    workoutSessionId: string;
    exerciseId: string;
    difficultyLabel: DifficultyLabel;
    pain?: boolean;
    sets: SetExecutionInput[];
    substitutedFromExerciseId?: string;
    substitutionReason?: string;
    techniqueGroup?: string;
  }): Promise<{ decision: WorkoutEvolutionDecision; setCount: number }> {
    if (input.sets.length < 1) {
      throw new V3Error("V3_BETA1_SETS_REQUIRED", "Registre pelo menos uma série real antes de concluir o exercício.", 409);
    }
    return this.repository.recordBeta1ExecutionFeedback(input);
  }

  /**
   * Golden Path Beta 1 conclusion: completion authority is EXECUTION REGISTERED
   * + EXPLICIT USER CONFIRMATION. Selfie is NOT required (BETA_2_PRESERVED).
   * After the exactly-once flip, pain feedback becomes durable memory and the
   * progress snapshots are derived from structured evidence.
   */
  async completeWorkout(input: {
    actor: ActorContext;
    requestId: string;
    workoutSessionId: string;
  }): Promise<Beta1CompletionOutcome> {
    const outcome = await this.repository.completeBeta1WorkoutSession({
      actor: input.actor,
      requestId: input.requestId,
      workoutSessionId: input.workoutSessionId,
      completionMode: "self_report",
    });
    // Post-completion learning is best-effort: completion already committed;
    // derivation failures must not roll the authoritative state back.
    let painMemoriesPersisted = 0;
    const progressSnapshots: Array<{ exerciseId: string; trend: string; reasonCodes: string[] }> = [];
    try {
      const feedback = await this.repository.loadSessionExecutionFeedback(input.actor, input.workoutSessionId);
      for (const entry of feedback) {
        if (entry.pain) {
          const region = /\b(joelho|knee)\b/iu.test(entry.exerciseId) ? "knee"
            : /\b(ombro|shoulder)\b/iu.test(entry.exerciseId) ? "shoulder"
            : /\b(lombar|lower.?back)\b/iu.test(entry.exerciseId) ? "lower_back"
            : "unspecified";
          try {
            await this.repository.persistCuratedMemory({
              actor: input.actor,
              requestId: CHILD_REQUEST(input.requestId, `pain:${entry.exerciseId}`),
              candidate: {
                category: "TRAINING_LIMITATIONS",
                key: `body_region_${region}`,
                value: { bodyRegion: region, exerciseId: entry.exerciseId, sessionId: input.workoutSessionId, declaration: `Dor ou desconforto registrado durante ${entry.exerciseId}.` },
                confidence: "explicit",
              },
              sourceType: "workout_execution",
            });
            painMemoriesPersisted += 1;
          } catch { /* duplicate same-day memory is fine */ }
        }
        const straightSets = entry.setRows.filter((set) => set.techniqueType === "STRAIGHT_SET" && set.reps != null);
        if (straightSets.length > 0 && entry.difficultyLabel) {
          const snapshot = buildExerciseProgressSnapshot(entry.exerciseId, {
            exerciseId: entry.exerciseId,
            repRangeLow: entry.repRangeLow,
            repRangeHigh: entry.repRangeHigh,
            sessions: [{
              loadKg: straightSets[0]?.loadKg ?? null,
              repsPerSet: straightSets.map((set) => set.reps ?? 0),
              difficultyLabel: entry.difficultyLabel,
              pain: entry.pain,
              completed: entry.completed,
            }],
          });
          progressSnapshots.push({ exerciseId: snapshot.exerciseId, trend: snapshot.trend, reasonCodes: snapshot.reasonCodes });
        }
      }
    } catch { /* learning is additive; completion stays authoritative */ }

    // Presence layer (deterministic): sessionFacts + outcome + the ONE
    // contextual question for the only unknown. Never blocks completion.
    let presence: SessionPresenceSummary | null = null;
    try {
      const entries = await this.repository.loadSessionExecutionFeedback(input.actor, input.workoutSessionId);
      const history = await this.repository.loadBeta1SessionFeedbackHistory(input.actor, 12);
      presence = buildSessionPresence({
        facts: buildSessionFacts(entries),
        history,
      });
    } catch { /* presence is additive; completion stays authoritative */ }
    return { ...outcome, painMemoriesPersisted, progressSnapshots, presence };
  }

  /**
   * Session-level subjective feedback (the part GUTO cannot sense). The
   * contextual answer closes the INVESTIGATE loop: training → ADAPT,
   * user state → MAINTAIN. Persistence is idempotent per requestId.
   */
  async recordSessionFeedback(input: {
    actor: ActorContext;
    requestId: string;
    workoutSessionId: string;
    overallDifficulty: "FACIL" | "BOA" | "PESADA" | "DOR";
    pain: boolean;
    causeExplanation?: string;
    causeCategory?: "user_state" | "training";
  }): Promise<SessionPresenceSummary> {
    // PRESENCE 5/6: a free-text clarification is classified by the
    // deterministic keyword policy (never the LLM, never a new preference).
    const causeCategory = input.causeCategory ?? (input.causeExplanation ? classifyCauseExplanation(input.causeExplanation) : null);
    await this.repository.recordBeta1SessionFeedback({
      actor: input.actor,
      requestId: input.requestId,
      workoutSessionId: input.workoutSessionId,
      overallDifficulty: input.overallDifficulty,
      pain: input.pain,
      causeExplanation: input.causeExplanation ?? null,
      causeCategory: causeCategory ?? null,
    });
    const history = await this.repository.loadBeta1SessionFeedbackHistory(input.actor, 12);
    const today = history.find((entry) => entry.workoutSessionId === input.workoutSessionId) ?? {
      workoutSessionId: input.workoutSessionId,
      overallDifficulty: input.overallDifficulty,
      pain: input.pain,
      causeExplanation: input.causeExplanation ?? null,
      causeCategory: causeCategory ?? null,
      createdAt: new Date().toISOString(),
    };
    // General effort feedback does not retract pain recorded in an exercise.
    const execution = await this.repository.loadSessionExecutionFeedback(input.actor, input.workoutSessionId);
    const executionPain = execution.some((entry) => entry.pain || entry.difficultyLabel === "DOR");
    const outcome = decideSessionOutcome({
      todayFeedback: { overallDifficulty: today.overallDifficulty, pain: today.pain || executionPain },
      history: history.filter((entry) => entry.workoutSessionId !== input.workoutSessionId),
      cause: today.causeCategory
        ? { category: today.causeCategory, explanation: today.causeExplanation ?? "" }
        : null,
    });
    return {
      outcome: outcome.decision.decision,
      reasonCode: outcome.decision.reasonCode,
      contextualQuestion: outcome.contextualQuestion,
      trend: computeFeedbackTrend(history),
      knownFactsEcho: outcome.knownFactsEcho,
    };
  }
}

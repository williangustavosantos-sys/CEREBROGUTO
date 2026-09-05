import type { CalibrationMutation } from "./contracts.js";
import type { ConversationDecisionState, ConversationKnownFact } from "./conversation-state.js";
import type { FactChange, RecordedFact } from "./facts.js";
import type {
  ActorContext,
  CalibrationResult,
  CandidateOption,
  ConfirmedUserContext,
  DietPlan,
  OfficialSnapshot,
  V3AppState,
  XpReasonCode,
} from "./types.js";

export interface FoodReplacement {
  candidate: CandidateOption;
  quantityGrams: number;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
}

export interface FullDietPlanMutation {
  planId: string;
  expectedPlanVersion: number;
  contextVersion: number;
  items: Array<{ id: string; foodId: string; name: string; quantityGrams: number; calories: number; proteinGrams: number; carbsGrams: number; fatGrams: number; position: number; mealId?: string }>;
  totals: { calories: number; proteinGrams: number; carbsGrams: number; fatGrams: number };
  replacement: { previousFoodId: string; candidateId: string };
}

export interface WorkoutPlanDraft {
  title: string;
  generatedFrom: Record<string, unknown>;
  items: Array<Omit<import("./types.js").WorkoutItem, "id">>;
}

export interface DietPlanDraft {
  totalCalories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  calculationMethod: string;
  generatedFrom: Record<string, unknown>;
  meals: Array<{
    name: string;
    position: number;
    calories: number;
    items: Array<Omit<import("./types.js").DietItem, "id">>;
  }>;
}

export interface OfficialStateRepository {
  health(): Promise<{ ok: boolean; latencyMs: number }>;
  resolveActor(externalSubject: string, role: ActorContext["role"]): Promise<ActorContext | null>;
  provisionActor(input: {
    externalSubject: string;
    role: ActorContext["role"];
    tenantKey: string;
    tenantName: string;
    displayName?: string;
  }): Promise<ActorContext>;
  loadOfficialSnapshot(actor: ActorContext): Promise<OfficialSnapshot>;
  loadAppState(actor: ActorContext): Promise<V3AppState>;
  persistJourney(input: {
    actor: ActorContext;
    requestId: string;
    displayName?: string;
    preferredLanguage?: "pt-BR" | "en-US" | "it-IT";
    acceptConsent?: boolean;
    confirmName?: boolean;
    initialXpRewardSeen?: boolean;
  }): Promise<void>;
  persistCalibration(actor: ActorContext, input: CalibrationMutation): Promise<CalibrationResult>;
  /** Persiste país/cidade vindos de /guto/v3/memory (V3MemoryMutation.country/city). No-op sem perfil. trainingLocation NÃO entra aqui: o local oficial fica fixado no contexto confirmado ("gym") — hint de sessão não muta o perfil. */
  persistProfileLocation(actor: ActorContext, input: { requestId: string; country?: string; city?: string }): Promise<void>;
  startFirstContact(input: { actor: ActorContext; requestId: string }): Promise<void>;
  respondFirstContact(input: { actor: ActorContext; requestId: string; expectedStep: "food_restrictions" | "training_limitations"; answer: string }): Promise<void>;
  /** Updates food/limitation declarations during First Contact, before
   * confirmation, without advancing the step. Idempotent on requestId. */
  updateFirstContactDeclarations(input: {
    actor: ActorContext;
    requestId: string;
    foodDeclaration?: string | null;
    limitationDeclaration?: string | null;
  }): Promise<void>;
  confirmFirstContact(input: {
    actor: ActorContext;
    requestId: string;
    contextId: string;
    contextVersion: number;
    expectedProfileVersion: number;
    expectedGoalVersion: number;
    confirmedSnapshot: Record<string, unknown>;
    workoutDraft: WorkoutPlanDraft;
    dietDraft: DietPlanDraft;
  }): Promise<ConfirmedUserContext>;
  /** P1 (post-completion calibration recovery): persistCalibration advances the
   * official profile/goal of a COMPLETED user, which makes the confirmed
   * context stale and makes every operational V3 surface reject with
   * V3_CONTEXT_RECONFIRMATION_REQUIRED. This is the explicit authority that
   * closes that loop: it mints the NEXT confirmed context bound to the CURRENT
   * profile/goal (carrying the previous context's declarations forward, without
   * re-recording declaration facts) and atomically supersedes/regenerates
   * workout + diet at the new profile. Guarded: COMPLETED users only; rejects
   * when the context is already current (V3_CONTEXT_ALREADY_CURRENT);
   * idempotent on requestId. */
  reconfirmContext(input: {
    actor: ActorContext;
    requestId: string;
    contextId: string;
    contextVersion: number;
    expectedProfileVersion: number;
    expectedGoalVersion: number;
    workoutDraft: WorkoutPlanDraft;
    dietDraft: DietPlanDraft;
  }): Promise<ConfirmedUserContext>;
  completePact(input: {
    actor: ActorContext;
    requestId: string;
    displayName: string;
  }): Promise<void>;
  recordXp(input: {
    actor: ActorContext;
    requestId: string;
    reasonCode: XpReasonCode;
    sourceKey: string;
  }): Promise<void>;
  replaceWorkoutPlan(input: { actor: ActorContext; requestId: string; context: ConfirmedUserContext; draft: WorkoutPlanDraft }): Promise<import("./types.js").WorkoutPlan>;
  replaceDietPlan(input: { actor: ActorContext; requestId: string; context: ConfirmedUserContext; draft: DietPlanDraft }): Promise<DietPlan>;
  /** Writes append-only bitemporal facts, confirms a new context and only
   * re-evaluates the engines declared by the deterministic impact map. */
  applyFactChanges(input: {
    actor: ActorContext;
    requestId: string;
    changes: FactChange[];
    expectedContextVersion: number;
  }): Promise<{ context: ConfirmedUserContext; facts: RecordedFact[]; affectedDomains: string[] }>;
  listFactHistory(actor: ActorContext): Promise<RecordedFact[]>;
  recordWorkoutExerciseEvent(input: { actor: ActorContext; requestId: string; event: import("./types.js").WorkoutExerciseSessionEvent }): Promise<import("./types.js").WorkoutEvolutionDecision>;
  /** P0 (session completion): the single authority that marks a logical
   * workout session as COMPLETED. Exercise events only add history under a
   * session (status 'started'); this call flips it to 'completed', which is
   * what the rotation counter observes. Idempotent on requestId. */
  completeWorkoutSession(input: { actor: ActorContext; requestId: string; workoutSessionId: string }): Promise<void>;
  /** P0 (workout validation authority / founder gate): the SINGLE authority
   * that completes a workout session AND records its XP atomically, requiring
   * selfie evidence. It validates actor/tenant/session ownership, plan
   * binding, official context currency and evidence; completes the session;
   * grants complete_daily_mission XP exactly once; and returns the next
   * session index. Idempotent on requestId AND on the session (a replay or a
   * different requestId for the same completed session is a no-op). */
  validateAndCompleteWorkoutSession(input: {
    actor: ActorContext;
    requestId: string;
    workoutSessionId: string;
    evidence: import("./workout-validation-evidence.js").WorkoutValidationEvidence;
  }): Promise<{ status: "completed"; xpGranted: boolean; nextSessionIndex: number }>;
  /** Counts officially completed workout sessions for rotation (durable, derived
   * from workout_sessions — the "session really happened" source of truth). */
  countCompletedWorkoutSessions(actor: ActorContext): Promise<number>;
  swapExercise(input: {
    actor: ActorContext;
    requestId: string;
    planId: string;
    expectedPlanVersion: number;
    itemId: string;
    candidate: CandidateOption;
  }): Promise<{ planVersion: number }>;
  swapFood(input: {
    actor: ActorContext;
    requestId: string;
    plan: DietPlan;
    mutation: FullDietPlanMutation;
  }): Promise<{ planVersion: number }>;
  recordTurn(input: {
    actor: ActorContext;
    requestId: string;
    action: string;
    resultCode: string;
  }): Promise<void>;
  /** Reads the current official relationship lifecycle record (null if never
   * evaluated). Deterministic, tenant-scoped. */
  getRelationshipLifecycle(actor: ActorContext): Promise<import("./relationship-lifecycle.js").RelationshipLifecycleRecord | null>;
  /** Evaluates the relationship lifecycle deterministically from official data
   * (last presence/interaction day) + time/absence + policy. Idempotent on
   * requestId; concurrency-safe (row lock/CAS). Returns the persisted record. */
  evaluateRelationshipLifecycle(input: {
    actor: ActorContext;
    requestId: string;
  }): Promise<import("./relationship-lifecycle.js").RelationshipLifecycleRecord>;
}

export interface ConversationStateRepository {
  loadConversationDecisionState(actor: ActorContext, threadKey?: string): Promise<ConversationDecisionState>;
  recordConversationDecision(input: {
    actor: ActorContext;
    requestId: string;
    state: ConversationDecisionState;
    interactionId?: string;
    decisionId: string;
    resolvedFacts: ConversationKnownFact[];
  }): Promise<void>;
}

export function supportsConversationState(repository: OfficialStateRepository): repository is OfficialStateRepository & ConversationStateRepository {
  const candidate = repository as Partial<ConversationStateRepository>;
  return typeof candidate.loadConversationDecisionState === "function" && typeof candidate.recordConversationDecision === "function";
}

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

import type { CalibrationMutation } from "./contracts.js";
import type { ConversationDecisionState, ConversationKnownFact } from "./conversation-state.js";
import type {
  ActorContext,
  CalibrationResult,
  CandidateOption,
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
  completePact(input: {
    actor: ActorContext;
    requestId: string;
    displayName: string;
    workoutDraft: WorkoutPlanDraft;
    dietDraft: DietPlanDraft;
  }): Promise<void>;
  recordXp(input: {
    actor: ActorContext;
    requestId: string;
    reasonCode: XpReasonCode;
    sourceKey: string;
  }): Promise<void>;
  replaceWorkoutPlan(input: { actor: ActorContext; requestId: string; draft: WorkoutPlanDraft }): Promise<import("./types.js").WorkoutPlan>;
  replaceDietPlan(input: { actor: ActorContext; requestId: string; draft: DietPlanDraft }): Promise<DietPlan>;
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
    itemId: string;
    replacement: FoodReplacement;
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

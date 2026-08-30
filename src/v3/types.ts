import type { DecisionEnvelope } from "./contracts.js";
import type { ConversationDecisionState } from "./conversation-state.js";
import type { FactImpactDomain, RecordedFact } from "./facts.js";

export type ActorRole = "student" | "coach" | "admin" | "super_admin";

export interface ActorContext {
  tenantId: string;
  userId: string;
  externalSubject: string;
  role: ActorRole;
}

export interface OfficialProfile {
  version: number;
  displayName?: string;
  language: "pt-BR" | "en-US" | "it-IT";
  city?: string;
  country?: string;
  biologicalSex: string;
  age: number;
  weightKg: number;
  heightCm: number;
  trainingStatus: string;
  trainingLocation: string;
  weeklyFrequencyDaysPerWeek: number | null;
}

export type FirstContactStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
export type FirstContactStep = "food_restrictions" | "training_limitations" | "confirmation" | "completed";

export interface FirstContactState {
  status: FirstContactStatus;
  step: FirstContactStep;
  foodDeclaration: string | null;
  limitationDeclaration: string | null;
  startedAt: string | null;
  completedAt: string | null;
  currentPrompt: string | null;
  summary: string | null;
  confirmedContextVersion: number | null;
}

export interface ConfirmedUserContext {
  id: string;
  version: number;
  confirmedAt: string;
  foodDeclaration: string;
  limitationDeclaration: string;
  profileVersion: number;
  goalVersion: number;
  weeklyFrequencyDaysPerWeek: number;
  trainingLocation: "gym";
  /** Immutable operational facts included when this context was confirmed. */
  factIds?: string[];
}

export interface OfficialGoal {
  version: number;
  code: string;
}

export interface OfficialPreferences {
  version: number;
  dietStyle?: string;
}

export interface HealthConstraint {
  id: string;
  kind: "limitation" | "injury" | "illness" | "allergy" | "food_restriction";
  bodyRegion?: string;
  description: string;
  severity: "low" | "medium" | "high" | "unknown";
  confirmed: boolean;
}

export interface WorkoutItem {
  id: string;
  exerciseId: string;
  name: string;
  purpose: string;
  muscleGroup: string;
  position: number;
  sets?: number;
  reps?: string;
  canonicalNamePt?: string;
  rest?: string;
  cue?: string;
  note?: string;
  videoUrl?: string;
  sourceFileName?: string;
}

export interface WorkoutPlan {
  id: string;
  version: number;
  title: string;
  status: "draft" | "active" | "completed" | "superseded";
  confirmedContextVersion?: number | null;
  items: WorkoutItem[];
}

export interface DietItem {
  id: string;
  foodId: string;
  name: string;
  quantityGrams: number;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  position: number;
}

export interface DietMeal {
  id: string;
  name: string;
  position: number;
  calories: number;
  items: DietItem[];
}

export interface DietPlan {
  id: string;
  version: number;
  status: "draft" | "active" | "completed" | "superseded";
  confirmedContextVersion?: number | null;
  totalCalories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  meals: DietMeal[];
}

export interface ActiveContext {
  id: string;
  version: number;
  kind: "workout" | "diet";
  planId: string;
  planVersion: number;
  itemId: string;
  itemLabel: string;
  rejectedCandidateIds?: string[];
  updatedAt: string;
}

export interface OfficialSnapshot {
  actor: ActorContext;
  memoryVersion: number;
  profile: OfficialProfile;
  goal: OfficialGoal;
  preferences: OfficialPreferences;
  healthConstraints: HealthConstraint[];
  /** Current official operational facts. Relationship memory is not included. */
  currentFacts?: RecordedFact[];
  firstContact: FirstContactState;
  confirmedContext: ConfirmedUserContext | null;
  workout: WorkoutPlan | null;
  diet: DietPlan | null;
  /** P0 (session rotation): next logical session index derived from durable
   * state (count of completed sessions). 0 for a brand-new user; advances only
   * when a real session completion is recorded. Optional: repositories that
   * don't populate it leave rotation falling back to index 0. */
  nextSessionIndex?: number;
}

export interface JourneyState {
  preferredLanguage: "pt-BR" | "en-US" | "it-IT";
  consentAcceptedAt: string | null;
  sovereignNameConfirmedAt: string | null;
  pactAcceptedAt: string | null;
  initialXpRewardSeen: boolean;
}

export type XpReasonCode =
  | "grant_initial_xp"
  | "complete_daily_mission"
  | "accept_adapted_mission"
  | "apply_daily_miss_penalty"
  | "legacy_balance_migration";

export interface XpLedgerEntry {
  id: string;
  reasonCode: XpReasonCode;
  amount: number;
  sourceKey: string;
  createdAt: string;
}

export interface ProgressionState {
  totalXp: number;
  evolutionStage: "baby" | "teen" | "adult" | "elite";
  trainedToday: boolean;
  adaptedMissionToday: boolean;
  xpEvents: XpLedgerEntry[];
}

export interface WorkoutExerciseSessionEvent {
  exerciseId: string;
  loadValue?: number;
  repetitions?: number;
  setsCompleted?: number;
  completed: boolean;
  perceivedDifficulty?: number;
  substitutedFromExerciseId?: string;
  substitutionReason?: string;
  context?: Record<string, unknown>;
}

export type WorkoutEvolutionDecisionCode = "MAINTAIN" | "PROGRESS" | "REGRESS" | "SUBSTITUTE" | "REVIEW";

export type WorkoutNextPrescriptionAction =
  | "add_reps"
  | "increase_load"
  | "reduce_reps"
  | "reduce_load"
  | "review"
  | "maintain";

export interface WorkoutNextPrescription {
  exerciseId: string;
  action: WorkoutNextPrescriptionAction;
  targetReps?: number;
  loadDeltaKg?: number;
  reason: string;
}

export interface WorkoutEvolutionDecision {
  exerciseId: string;
  decision: WorkoutEvolutionDecisionCode;
  reasonCode: string;
  /** Concrete next-session dose produced by the decision (P0#4). */
  nextPrescription?: WorkoutNextPrescription;
}

export interface V3AppState {
  actor: ActorContext;
  memoryVersion: number;
  displayName: string;
  journey: JourneyState;
  profile: OfficialProfile | null;
  goal: OfficialGoal | null;
  preferences: OfficialPreferences;
  healthConstraints: HealthConstraint[];
  firstContact: FirstContactState;
  confirmedContext: Pick<ConfirmedUserContext, "id" | "version" | "confirmedAt"> | null;
  currentFacts: RecordedFact[];
  workout: WorkoutPlan | null;
  diet: DietPlan | null;
  progression: ProgressionState;
  /** P0 (session rotation): next logical session index derived from durable
   * state (count of completed sessions). */
  nextSessionIndex?: number;
}

export interface CandidateOption {
  id: string;
  label: string;
  kind: "exercise" | "food";
  purpose: string;
  metadata: Record<string, string | number | boolean>;
}

export interface RelationshipMemory {
  id: string;
  text: string;
  score?: number;
}

export interface TurnEnvelope {
  brainVersion: "guto-cerebro-v3";
  requestId: string;
  actor: Pick<ActorContext, "tenantId" | "userId" | "role">;
  message: string;
  official: {
    profile: OfficialProfile;
    goal: OfficialGoal;
    preferences: OfficialPreferences;
    healthConstraints: HealthConstraint[];
    confirmedContext: Pick<ConfirmedUserContext, "id" | "version" | "confirmedAt" | "foodDeclaration" | "limitationDeclaration">;
    workout?: Pick<WorkoutPlan, "id" | "version" | "title">;
    diet?: Pick<DietPlan, "id" | "version" | "totalCalories" | "proteinGrams" | "carbsGrams" | "fatGrams">;
  };
  activeContext: ActiveContext | null;
  conversation: ConversationDecisionState;
  relationshipMemories: RelationshipMemory[];
  candidates: CandidateOption[];
}

export interface PolicyGateResult {
  authorized: boolean;
  code: string;
  decision: DecisionEnvelope;
}

export interface ExecutorResult {
  status: "confirmed" | "not_executed" | "rejected";
  code: string;
  message: string;
  planVersion?: number;
  activeContextVersion?: number;
  factContextVersion?: number;
  affectedDomains?: FactImpactDomain[];
  sessionWorkout?: unknown;
}

export interface V3TurnResponse {
  speech: string;
  action: DecisionEnvelope["action"];
  requestId: string;
  traceId: string;
  brainVersion: "guto-cerebro-v3";
  execution: ExecutorResult;
  sessionWorkout?: unknown;
  versions: {
    memoryVersion: number;
    activeContextVersion: number | null;
    planVersion: number | null;
  };
}

export interface CalibrationResult {
  status: "confirmed";
  requestId: string;
  profileVersion: number;
  memoryVersion: number;
}

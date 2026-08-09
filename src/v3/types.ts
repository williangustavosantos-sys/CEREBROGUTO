import type { DecisionEnvelope } from "./contracts.js";

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
  city: string;
  country: string;
  biologicalSex: string;
  age: number;
  weightKg: number;
  heightCm: number;
  trainingStatus: string;
  trainingLocation: string;
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
  workout: WorkoutPlan | null;
  diet: DietPlan | null;
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

export interface V3AppState {
  actor: ActorContext;
  memoryVersion: number;
  displayName: string;
  journey: JourneyState;
  profile: OfficialProfile | null;
  goal: OfficialGoal | null;
  preferences: OfficialPreferences;
  healthConstraints: HealthConstraint[];
  workout: WorkoutPlan | null;
  diet: DietPlan | null;
  progression: ProgressionState;
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
    workout?: Pick<WorkoutPlan, "id" | "version" | "title">;
    diet?: Pick<DietPlan, "id" | "version" | "totalCalories" | "proteinGrams" | "carbsGrams" | "fatGrams">;
  };
  activeContext: ActiveContext | null;
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
}

export interface V3TurnResponse {
  speech: string;
  action: DecisionEnvelope["action"];
  requestId: string;
  traceId: string;
  brainVersion: "guto-cerebro-v3";
  execution: ExecutorResult;
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

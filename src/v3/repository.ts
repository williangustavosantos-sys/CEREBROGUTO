import type { CalibrationMutation } from "./contracts.js";
import type {
  ActorContext,
  CalibrationResult,
  CandidateOption,
  DietPlan,
  OfficialSnapshot,
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
  persistCalibration(actor: ActorContext, input: CalibrationMutation): Promise<CalibrationResult>;
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

import type { Language, RiskObservation } from "./types.js";
import type { BrainHistoryItem } from "./decide-turn.js";

export interface WorldStateV2WorkoutExercise {
  id?: string;
  name?: string;
  muscleGroup?: string;
  sets?: number | string;
  reps?: string;
  rest?: string;
  alternatives?: string[];
}

export interface WorldStateV2Workout {
  currentPlan?: {
    title?: string;
    focus?: string;
    focusKey?: string;
    scheduledFor?: string;
    location?: string;
    locationMode?: string;
    exercises?: WorldStateV2WorkoutExercise[];
    lockedByCoach?: boolean;
  } | null;
  recentFeedback?: string[];
  nextFocus?: string | null;
}

export interface WorldStateV2Diet {
  hasPlan: boolean;
  status?: string | null;
  restrictions?: string | null;
  country?: string | null;
  city?: string | null;
  lockedByCoach?: boolean;
}

export interface WorldStateV2Proactivity {
  context?: string | null;
  activePrompt?: unknown | null;
  pendingMemories?: unknown[];
  resolver?: unknown | null;
}

export interface WorldStateV2Catalog {
  activeExercise?: unknown | null;
  workoutSubstitutes?: unknown[];
  foodSubstitutes?: Array<{
    id: string;
    name: string;
    nutritionalRole?: string;
    quantityHint?: string;
  }>;
  foodConstraints?: unknown | null;
}

export interface WorldStateV2ActiveContextItem {
  id: string;
  name: string;
  position?: number;
  workoutId?: string;
  mealId?: string;
  mealName?: string;
  quantity?: string;
  nutritionalRole?: string;
  sets?: number;
  reps?: string;
  rest?: string;
}

export interface WorldStateV2ActiveContext {
  id: string;
  version: number;
  type: "workout" | "diet";
  sourceSurface: "mission" | "diet";
  originalItem: WorldStateV2ActiveContextItem;
  currentItem: WorldStateV2ActiveContextItem;
  lastSuggestedItem: WorldStateV2ActiveContextItem | null;
  rejectedItems: WorldStateV2ActiveContextItem[];
  acceptedItem: WorldStateV2ActiveContextItem | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorldStateV2SubstitutionContext {
  kind: "exercise" | "food";
  originalId: string;
  originalName: string;
  lastSuggestedId?: string;
  rejectedIds: string[];
  mealName?: string;
  updatedAt: string;
}

export interface WorldStateV2ConversationContext {
  kind: string;
  source: string;
  relatedMemoryId?: string;
  originalId?: string;
  dateParsed?: string;
  updatedAt: string;
}

export interface WorldStateV2DailyContext {
  dateKey?: string;
  weekday?: string;
  hour?: number;
  raw?: unknown | null;
}

export interface WorldStateV2 {
  version: "v2";
  userId: string;
  language: Language;
  memory: {
    name?: string;
    country?: string;
    countryCode?: string;
    city?: string;
    trainingGoal?: string;
    trainingStatus?: string;
    trainingLevel?: string;
    trainingLocation?: string;
    preferredTrainingLocation?: string;
    trainingLimitations?: string;
    trainingPathology?: string;
    biologicalSex?: string;
    userAge?: number;
    heightCm?: number;
    weightKg?: number;
    foodRestrictions?: string;
    trainedToday?: boolean;
    lastActiveAt?: string;
  };
  risk: RiskObservation | null;
  workout: WorldStateV2Workout;
  diet: WorldStateV2Diet;
  activeExercise: unknown | null;
  activeContext: WorldStateV2ActiveContext | null;
  substitutionContext: WorldStateV2SubstitutionContext | null;
  activeConversationContext: WorldStateV2ConversationContext | null;
  proactivity: WorldStateV2Proactivity;
  pendingCards: unknown[];
  dailyContext: WorldStateV2DailyContext;
  catalog: WorldStateV2Catalog;
  missingFields: string[];
  recentHistory: BrainHistoryItem[];
  contextSignals: Record<string, unknown>;
}

export interface AssembleWorldStateV2Input {
  userId: string;
  language: Language;
  memory: WorldStateV2["memory"];
  risk?: RiskObservation | null;
  workout?: WorldStateV2Workout;
  diet?: WorldStateV2Diet;
  activeExercise?: unknown | null;
  activeContext?: WorldStateV2ActiveContext | null;
  substitutionContext?: WorldStateV2SubstitutionContext | null;
  activeConversationContext?: WorldStateV2ConversationContext | null;
  proactivity?: WorldStateV2Proactivity;
  pendingCards?: unknown[];
  dailyContext?: WorldStateV2DailyContext;
  catalog?: WorldStateV2Catalog;
  missingFields?: string[];
  recentHistory?: BrainHistoryItem[];
  contextSignals?: Record<string, unknown>;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value && value.trim()).map((value) => value.trim()))];
}

export function deriveWorldStateV2MissingFields(input: {
  memory: WorldStateV2["memory"];
  includeDiet?: boolean;
}): string[] {
  const { memory } = input;
  const missing: string[] = [];

  if (!memory.trainingStatus && !memory.trainingLevel) missing.push("trainingStatus");
  if (!memory.userAge) missing.push("userAge");
  if (!memory.trainingLimitations && !memory.trainingPathology) missing.push("trainingLimitations");

  if (input.includeDiet) {
    if (!memory.biologicalSex) missing.push("biologicalSex");
    if (!memory.heightCm) missing.push("heightCm");
    if (!memory.weightKg) missing.push("weightKg");
    if (!memory.country) missing.push("country");
    if (!memory.countryCode) missing.push("countryCode");
    if (!memory.trainingGoal) missing.push("trainingGoal");
  }

  return unique(missing);
}

export function assembleWorldStateV2(input: AssembleWorldStateV2Input): WorldStateV2 {
  const baseMissing = deriveWorldStateV2MissingFields({ memory: input.memory, includeDiet: true });
  return {
    version: "v2",
    userId: input.userId,
    language: input.language,
    memory: input.memory,
    risk: input.risk ?? null,
    workout: input.workout ?? {},
    diet: input.diet ?? { hasPlan: false },
    activeExercise: input.activeExercise ?? null,
    activeContext: input.activeContext ?? null,
    substitutionContext: input.substitutionContext ?? null,
    activeConversationContext: input.activeConversationContext ?? null,
    proactivity: input.proactivity ?? {},
    pendingCards: input.pendingCards ?? [],
    dailyContext: input.dailyContext ?? {},
    catalog: input.catalog ?? {},
    missingFields: unique([...(input.missingFields ?? []), ...baseMissing]),
    recentHistory: (input.recentHistory ?? []).slice(-12),
    contextSignals: input.contextSignals ?? {},
  };
}

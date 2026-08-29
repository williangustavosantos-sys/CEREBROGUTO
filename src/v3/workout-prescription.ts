import type { CatalogLocation, CatalogMuscleGroup } from "../../exercise-catalog.js";

/**
 * Workout Prescription V2 — deterministic, versioned split policy.
 *
 * P0#1 fix: `weeklyFrequencyDaysPerWeek` now governs the prescription. Each
 * frequency maps to a split of session templates; a session template carries
 * the muscle-group focus for that day. Volume and exercise count come from
 * experience; rep ranges come from the goal. The catalog remains the only
 * authority: every item is selected from ValidatedExerciseCatalog.
 */
export const WORKOUT_PRESCRIPTION_POLICY_VERSION = "catalog_rules_v2";

export interface WorkoutSessionTemplate {
  sessionIndex: number;
  label: string;
  focus: CatalogMuscleGroup[];
}

export interface FrequencySplit {
  frequency: number;
  splitName: string;
  sessions: WorkoutSessionTemplate[];
}

const FULL_BODY_A: CatalogMuscleGroup[] = ["peito", "costas", "pernas", "abdomen"];
const FULL_BODY_B: CatalogMuscleGroup[] = ["costas", "pernas", "peito", "bracos"];
const UPPER: CatalogMuscleGroup[] = ["peito", "costas", "ombro", "bracos"];
const LOWER: CatalogMuscleGroup[] = ["pernas", "abdomen"];
const PUSH: CatalogMuscleGroup[] = ["peito", "ombro", "bracos"];
const PULL: CatalogMuscleGroup[] = ["costas", "bracos"];
const LEGS: CatalogMuscleGroup[] = ["pernas", "abdomen"];

function split(frequency: number, splitName: string, focusPerSession: CatalogMuscleGroup[][]): FrequencySplit {
  return {
    frequency,
    splitName,
    sessions: focusPerSession.map((focus, sessionIndex) => ({ sessionIndex, label: splitLabel(splitName, sessionIndex, focusPerSession.length), focus })),
  };
}

function splitLabel(splitName: string, sessionIndex: number, count: number): string {
  if (splitName === "full_body_ab") return sessionIndex === 0 ? "Full Body A" : "Full Body B";
  if (splitName === "full_body_upper_lower") return ["Full Body", "Upper", "Lower"][sessionIndex] || `Sessão ${sessionIndex + 1}`;
  if (splitName === "upper_lower") return sessionIndex % 2 === 0 ? "Upper" : "Lower";
  if (splitName === "upper_lower_push_pull_legs") return ["Upper", "Lower", "Push", "Pull", "Legs"][sessionIndex] || `Sessão ${sessionIndex + 1}`;
  if (splitName === "push_pull_legs") return ["Push", "Pull", "Legs"][sessionIndex % 3] || `Sessão ${sessionIndex + 1}`;
  return `Sessão ${sessionIndex + 1}/${count}`;
}

/** Versioned deterministic splits for frequencies 2..6. */
export const FREQUENCY_SPLITS: FrequencySplit[] = [
  split(2, "full_body_ab", [FULL_BODY_A, FULL_BODY_B]),
  split(3, "full_body_upper_lower", [FULL_BODY_A, UPPER, LOWER]),
  split(4, "upper_lower", [UPPER, LOWER, UPPER, LOWER]),
  split(5, "upper_lower_push_pull_legs", [UPPER, LOWER, PUSH, PULL, LEGS]),
  split(6, "push_pull_legs", [PUSH, PULL, LEGS, PUSH, PULL, LEGS]),
];

export function frequencySplitFor(frequency: number): FrequencySplit {
  const normalized = Math.min(6, Math.max(2, Math.round(frequency) || 3));
  return FREQUENCY_SPLITS.find((candidate) => candidate.frequency === normalized) || FREQUENCY_SPLITS[1];
}

export function sessionTemplateFor(frequency: number, sessionIndex: number): WorkoutSessionTemplate {
  const split = frequencySplitFor(frequency);
  return split.sessions[sessionIndex % split.sessions.length];
}

export interface ExperienceVolume {
  label: string;
  /** Sets per working exercise (aquecimento always 1). */
  sets: number;
  /** How many focus groups are kept after aquecimento (drop accessories). */
  keepFocusGroups: number;
  /** Extra accessory exercises drawn from the largest focus group. */
  accessoryCount: number;
}

export function experienceVolume(trainingStatus: string): ExperienceVolume {
  switch (trainingStatus) {
    case "beginner": return { label: "beginner", sets: 3, keepFocusGroups: 3, accessoryCount: 0 };
    case "active": return { label: "intermediate", sets: 4, keepFocusGroups: 5, accessoryCount: 1 };
    case "advanced": return { label: "advanced", sets: 4, keepFocusGroups: 5, accessoryCount: 2 };
    default: return { label: "returning", sets: 3, keepFocusGroups: 4, accessoryCount: 0 };
  }
}

/** Rep range by goal. Beta scope: muscle_gain/hypertrophy vs fat_loss/conditioning. */
export function repRangeForGoal(goalCode: string): string {
  if (goalCode === "hypertrophy" || goalCode === "muscle_gain") return "8-12";
  if (goalCode === "fat_loss" || goalCode === "conditioning") return "10-15";
  return "10-15";
}

export interface WorkoutPrescriptionContext {
  frequency: number;
  sessionIndex: number;
  splitName: string;
  sessionLabel: string;
  experience: ExperienceVolume;
  repRange: string;
  goalCode: string;
}

export function prescriptionContext(input: {
  trainingStatus: string;
  goalCode: string;
  frequency: number;
  sessionIndex?: number;
}): WorkoutPrescriptionContext {
  const split = frequencySplitFor(input.frequency);
  const sessionIndex = input.sessionIndex ?? 0;
  const template = split.sessions[sessionIndex % split.sessions.length];
  return {
    frequency: split.frequency,
    sessionIndex,
    splitName: split.splitName,
    sessionLabel: template.label,
    experience: experienceVolume(input.trainingStatus),
    repRange: repRangeForGoal(input.goalCode),
    goalCode: input.goalCode,
  };
}

export function templateFocus(template: WorkoutSessionTemplate, volume: ExperienceVolume): CatalogMuscleGroup[] {
  return template.focus.slice(0, volume.keepFocusGroups);
}

export type { CatalogLocation, CatalogMuscleGroup };

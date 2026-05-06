import { getCatalogById, type CatalogExercise, type CatalogLanguage } from "../exercise-catalog";

const LOCAL_VIDEO_PREFIX = "/exercise/visuals/";

export type WorkoutCatalogValidationCode =
  | "INVALID_WORKOUT_EXERCISE_CATALOG_ID"
  | "WORKOUT_EXERCISE_VIDEO_REQUIRED"
  | "EXTERNAL_WORKOUT_VIDEO_NOT_ALLOWED"
  | "WORKOUT_EXERCISE_VIDEO_MISMATCH"
  | "WORKOUT_PLAN_EXERCISES_REQUIRED";

export interface WorkoutCatalogValidationIssue {
  code: WorkoutCatalogValidationCode;
  message: string;
  exerciseId?: string;
  index?: number;
}

export interface CatalogBackedWorkoutExercise {
  id: string;
  name?: string;
  canonicalNamePt?: string;
  muscleGroup?: string;
  videoUrl?: string;
  videoProvider?: string;
  sourceFileName?: string;
  [key: string]: unknown;
}

export class WorkoutCatalogValidationError extends Error {
  readonly status = 400;
  readonly code: WorkoutCatalogValidationCode;
  readonly issues: WorkoutCatalogValidationIssue[];

  constructor(issues: WorkoutCatalogValidationIssue[]) {
    const first = issues[0];
    super(first?.message || "Workout exercise catalog validation failed.");
    this.name = "WorkoutCatalogValidationError";
    this.code = first?.code || "INVALID_WORKOUT_EXERCISE_CATALOG_ID";
    this.issues = issues;
  }
}

function issue(
  code: WorkoutCatalogValidationCode,
  message: string,
  exerciseId?: string,
  index?: number
): WorkoutCatalogValidationIssue {
  return { code, message, exerciseId, index };
}

function asExercise(value: unknown): CatalogBackedWorkoutExercise | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CatalogBackedWorkoutExercise)
    : null;
}

function isValidCatalogVideo(entry: CatalogExercise): boolean {
  return (
    entry.videoProvider === "local" &&
    typeof entry.videoUrl === "string" &&
    entry.videoUrl.trim().startsWith(LOCAL_VIDEO_PREFIX)
  );
}

export function validateWorkoutExerciseAgainstCatalog(
  rawExercise: unknown,
  language: CatalogLanguage = "pt-BR",
  index?: number
): { valid: boolean; errors: WorkoutCatalogValidationIssue[]; normalizedExercise?: CatalogBackedWorkoutExercise } {
  const exercise = asExercise(rawExercise);
  const id = typeof exercise?.id === "string" ? exercise.id.trim() : "";

  if (!exercise || !id) {
    return {
      valid: false,
      errors: [
        issue(
          "INVALID_WORKOUT_EXERCISE_CATALOG_ID",
          "Todo exercício do treino precisa de id válido do catálogo oficial.",
          id || undefined,
          index
        ),
      ],
    };
  }

  const entry = getCatalogById(id);
  if (!entry) {
    return {
      valid: false,
      errors: [
        issue(
          "INVALID_WORKOUT_EXERCISE_CATALOG_ID",
          `Exercise "${id}" is not in the official catalog.`,
          id,
          index
        ),
      ],
    };
  }

  const errors: WorkoutCatalogValidationIssue[] = [];
  const submittedVideoUrl = typeof exercise.videoUrl === "string" ? exercise.videoUrl.trim() : "";
  const submittedProvider = typeof exercise.videoProvider === "string" ? exercise.videoProvider.trim() : "";

  if (!isValidCatalogVideo(entry)) {
    errors.push(
      issue(
        "WORKOUT_EXERCISE_VIDEO_REQUIRED",
        `Catalog exercise "${id}" does not have a valid local videoUrl.`,
        id,
        index
      )
    );
  }

  if (!submittedVideoUrl) {
    errors.push(
      issue("WORKOUT_EXERCISE_VIDEO_REQUIRED", `Exercise "${id}" has no submitted videoUrl.`, id, index)
    );
  } else if (!submittedVideoUrl.startsWith(LOCAL_VIDEO_PREFIX)) {
    errors.push(
      issue(
        "EXTERNAL_WORKOUT_VIDEO_NOT_ALLOWED",
        `Exercise "${id}" is trying to use a non-local videoUrl.`,
        id,
        index
      )
    );
  } else if (submittedVideoUrl !== entry.videoUrl) {
    errors.push(
      issue(
        "WORKOUT_EXERCISE_VIDEO_MISMATCH",
        `Exercise "${id}" videoUrl does not match the official catalog.`,
        id,
        index
      )
    );
  }

  if (submittedProvider && submittedProvider !== "local") {
    errors.push(
      issue(
        "EXTERNAL_WORKOUT_VIDEO_NOT_ALLOWED",
        `Exercise "${id}" is trying to use provider "${submittedProvider}".`,
        id,
        index
      )
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    normalizedExercise: {
      ...exercise,
      id: entry.id,
      name: entry.namesByLanguage[language] ?? entry.canonicalNamePt,
      canonicalNamePt: entry.canonicalNamePt,
      muscleGroup: entry.muscleGroup,
      videoUrl: entry.videoUrl,
      videoProvider: "local",
      sourceFileName: entry.sourceFileName,
    },
  };
}

export function normalizeWorkoutPlanAgainstCatalog<T extends Record<string, unknown>>(
  plan: T,
  language: CatalogLanguage = "pt-BR"
): T {
  const exercisesInput = Array.isArray(plan.exercises) ? plan.exercises : [];
  const issues: WorkoutCatalogValidationIssue[] = [];

  if (exercisesInput.length === 0) {
    issues.push(
      issue("WORKOUT_PLAN_EXERCISES_REQUIRED", "Workout plan must contain at least one catalog-backed exercise.")
    );
  }

  const exercises = exercisesInput.map((exercise, index) => {
    const result = validateWorkoutExerciseAgainstCatalog(exercise, language, index);
    if (!result.valid || !result.normalizedExercise) {
      issues.push(...result.errors);
      return exercise;
    }
    return result.normalizedExercise;
  });

  const blocks = Array.isArray(plan.blocks)
    ? plan.blocks.map((rawBlock) => {
        const block = rawBlock && typeof rawBlock === "object" && !Array.isArray(rawBlock)
          ? (rawBlock as Record<string, unknown>)
          : {};
        const blockExercises = Array.isArray(block.exercises) ? block.exercises : [];
        return {
          ...block,
          exercises: blockExercises.map((exercise, index) => {
            const result = validateWorkoutExerciseAgainstCatalog(exercise, language, index);
            if (!result.valid || !result.normalizedExercise) {
              issues.push(...result.errors);
              return exercise;
            }
            return result.normalizedExercise;
          }),
        };
      })
    : undefined;

  if (issues.length > 0) {
    throw new WorkoutCatalogValidationError(issues);
  }

  return {
    ...plan,
    exercises,
    ...(blocks ? { blocks } : {}),
  } as T;
}

export function isWorkoutCatalogValidationError(error: unknown): error is WorkoutCatalogValidationError {
  return error instanceof WorkoutCatalogValidationError;
}

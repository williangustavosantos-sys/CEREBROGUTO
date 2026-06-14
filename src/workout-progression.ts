import {
  filterExercisesBySafety,
  getCatalogById,
  suggestExerciseSubstitutes,
  type CatalogLanguage,
  type CatalogLocation,
} from "../exercise-catalog";

export type WorkoutFocus =
  | "chest_triceps"
  | "back_biceps"
  | "legs_core"
  | "shoulders_abs"
  | "full_body";

export type WorkoutLocationMode = "gym" | "home" | "park";
export type WorkoutFeedbackDifficulty = "easy" | "ok" | "hard" | "pain";
export type WorkoutFeedbackEnergy = "low" | "normal" | "high";
export type ProgressionSignal = "progress" | "hold" | "deload";

export interface WorkoutFeedbackRecord {
  id: string;
  userId: string;
  createdAt: string;
  workoutFocus: WorkoutFocus;
  workoutLabel: string;
  locationMode: WorkoutLocationMode;
  difficulty: WorkoutFeedbackDifficulty;
  energy?: WorkoutFeedbackEnergy;
  painArea?: string;
  note?: string;
  exerciseIds: string[];
}

export interface ProgressionWorkoutExercise {
  id: string;
  name: string;
  canonicalNamePt: string;
  muscleGroup: string;
  sets: number;
  reps: string;
  rest: string;
  restSeconds?: number;
  cue: string;
  note: string;
  alternatives?: string[];
  order?: number;
  videoUrl: string;
  videoProvider: "local";
  sourceFileName: string;
}

export interface ProgressionWorkoutPlan {
  focus: string;
  focusKey?: WorkoutFocus;
  dateLabel: string;
  scheduledFor: string;
  summary: string;
  exercises: ProgressionWorkoutExercise[];
  difficulty?: string;
  coachNotes?: string;
}

export function normalizeWorkoutFeedback(input: {
  userId: string;
  workoutFocus?: string;
  workoutLabel?: string;
  locationMode?: string;
  difficulty?: string;
  energy?: string;
  painArea?: string;
  note?: string;
  exerciseIds?: unknown;
  createdAt?: string;
}): WorkoutFeedbackRecord | null {
  if (!isWorkoutFocus(input.workoutFocus)) return null;
  if (!isLocationMode(input.locationMode)) return null;
  if (!isDifficulty(input.difficulty)) return null;

  const rawExerciseIds = Array.isArray(input.exerciseIds) ? input.exerciseIds : [];
  const exerciseIds = rawExerciseIds
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 12);

  return {
    id: crypto.randomUUID(),
    userId: input.userId,
    createdAt: input.createdAt || new Date().toISOString(),
    workoutFocus: input.workoutFocus,
    workoutLabel: String(input.workoutLabel || "").trim().slice(0, 120),
    locationMode: input.locationMode,
    difficulty: input.difficulty,
    energy: isEnergy(input.energy) ? input.energy : undefined,
    painArea: cleanOptionalText(input.painArea, 80),
    note: cleanOptionalText(input.note, 240),
    exerciseIds,
  };
}

export function appendWorkoutFeedback(
  history: WorkoutFeedbackRecord[] | undefined,
  record: WorkoutFeedbackRecord,
  limit = 12
): WorkoutFeedbackRecord[] {
  const current = Array.isArray(history) ? history : [];
  return [...current, record].slice(-limit);
}

export function getProgressionSignal(history: WorkoutFeedbackRecord[] | undefined): ProgressionSignal {
  const recent = (history || []).slice(-3);
  if (recent.length === 0) return "hold";

  const last = recent[recent.length - 1];
  if (last.difficulty === "pain" || Boolean(last.painArea)) return "deload";

  const hardSignals = recent.filter((item) => item.difficulty === "hard" || item.energy === "low").length;
  if (hardSignals >= 2 || last.difficulty === "hard") return "deload";

  const lastTwo = recent.slice(-2);
  if (
    lastTwo.length >= 2 &&
    lastTwo.every((item) => item.difficulty === "easy" && item.energy !== "low")
  ) {
    return "progress";
  }

  return "hold";
}

export function summarizeWorkoutFeedback(history: WorkoutFeedbackRecord[] | undefined): string {
  const recent = (history || []).slice(-4);
  if (recent.length === 0) return "";
  const signal = getProgressionSignal(recent);
  const readable = recent
    .map((item) => {
      const pain = item.painArea ? `, dor: ${item.painArea}` : "";
      const energy = item.energy ? `, energia: ${item.energy}` : "";
      return `${item.createdAt.slice(0, 10)} ${item.workoutFocus}: ${item.difficulty}${energy}${pain}`;
    })
    .join(" | ");
  return `Sinal V1: ${signal}. Feedback recente: ${readable}`;
}

export function applyWorkoutProgression<T extends ProgressionWorkoutPlan>(
  plan: T,
  history: WorkoutFeedbackRecord[] | undefined
): T {
  const signal = getProgressionSignal(history);
  if (signal === "hold") return plan;
  const lastLocation = (history || []).slice(-1)[0]?.locationMode;

  let changed = false;
  const exercises = plan.exercises.map((exercise) => {
    if (exercise.muscleGroup === "aquecimento") return exercise;

    if (signal === "progress" && !changed) {
      changed = true;
      const currentSets = Math.max(1, Number(exercise.sets) || 3);
      return {
        ...exercise,
        sets: Math.min(5, currentSets + 1),
        note: appendNote(
          exercise.note,
          `Progressao GUTO: hoje sobe uma serie porque os treinos validados ficaram leves. ${progressionTechnique(lastLocation)}`
        ),
      };
    }

    if (signal === "deload") {
      return {
        ...exercise,
        sets: Math.max(2, (Number(exercise.sets) || 3) - 1),
        rest: increaseRest(exercise.rest),
        note: appendNote(exercise.note, "Ajuste GUTO: dose reduzida para evoluir sem brigar com dor ou fadiga."),
      };
    }

    return exercise;
  });

  return {
    ...plan,
    exercises,
    difficulty: signal === "progress" ? "progressive" : "conservative",
    summary: appendSummary(plan.summary, signal),
  };
}

function progressionTechnique(locationMode?: WorkoutLocationMode) {
  if (locationMode === "gym") {
    return "Na ultima serie, back-off seguro: reduz 15-20% da carga e fecha 6-8 reps limpas. Se a forma cair, para.";
  }
  if (locationMode === "park") {
    return "No parque, progride com pausa isometrica de 2s no ponto mais dificil, sem inventar carga.";
  }
  if (locationMode === "home") {
    return "Em casa, progride com descida de 3s e pausa de 1s, mantendo controle total.";
  }
  return "Progressao tecnica liberada so se a execucao continuar limpa.";
}

function substitutionNote(language?: CatalogLanguage, bodyRegion?: string): string {
  const region = bodyRegion || (language === "it-IT" ? "la tua limitazione" : language === "en-US" ? "your limitation" : "sua limitação");
  if (language === "it-IT") return `Sostituito da GUTO per rispettare ${region}.`;
  if (language === "en-US") return `Substituted by GUTO to respect ${region}.`;
  return `Substituído pelo GUTO para respeitar ${region}.`;
}

export function applySafeExerciseSubstitutions<T extends ProgressionWorkoutPlan>(
  plan: T,
  options: {
    location?: CatalogLocation;
    userRiskTags?: string[];
    userBodyRegion?: string;
    language?: CatalogLanguage;
  }
): T {
  const ids = plan.exercises.map((exercise) => exercise.id);
  const safeIds = new Set(filterExercisesBySafety(ids, options));
  const used = new Set<string>();
  const exercises: ProgressionWorkoutExercise[] = [];

  for (const exercise of plan.exercises) {
    if (safeIds.has(exercise.id)) {
      used.add(exercise.id);
      exercises.push(exercise);
      continue;
    }

    const substituteId = suggestExerciseSubstitutes(exercise.id, options).find((id) => !used.has(id));
    const entry = substituteId ? getCatalogById(substituteId) : undefined;
    if (!entry) continue;

    used.add(entry.id);
    exercises.push({
      ...exercise,
      id: entry.id,
      name: entry.namesByLanguage[options.language || "pt-BR"] ?? entry.canonicalNamePt,
      canonicalNamePt: entry.canonicalNamePt,
      muscleGroup: entry.muscleGroup,
      videoUrl: entry.videoUrl,
      videoProvider: "local",
      sourceFileName: entry.sourceFileName,
      note: appendNote(exercise.note, substitutionNote(options.language, options.userBodyRegion)),
    });
  }

  return {
    ...plan,
    exercises,
  };
}

function isWorkoutFocus(value?: string): value is WorkoutFocus {
  return (
    value === "chest_triceps" ||
    value === "back_biceps" ||
    value === "legs_core" ||
    value === "shoulders_abs" ||
    value === "full_body"
  );
}

function isLocationMode(value?: string): value is WorkoutLocationMode {
  return value === "gym" || value === "home" || value === "park";
}

function isDifficulty(value?: string): value is WorkoutFeedbackDifficulty {
  return value === "easy" || value === "ok" || value === "hard" || value === "pain";
}

function isEnergy(value?: string): value is WorkoutFeedbackEnergy {
  return value === "low" || value === "normal" || value === "high";
}

function cleanOptionalText(value: unknown, maxLength: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : undefined;
}

function appendNote(note: string, addition: string) {
  const base = note?.trim();
  return base ? `${base} ${addition}` : addition;
}

function appendSummary(summary: string, signal: ProgressionSignal) {
  if (signal === "progress") return `${summary} GUTO aumentou a dose porque voce respondeu bem.`;
  if (signal === "deload") return `${summary} GUTO reduziu a dose hoje para proteger sua evolucao.`;
  return summary;
}

function increaseRest(rest: string) {
  const seconds = Number(String(rest || "").match(/\d+/)?.[0] || 0);
  if (!seconds) return rest || "60s";
  return `${Math.min(120, seconds + 15)}s`;
}

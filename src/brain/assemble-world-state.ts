import { getProgressionSignal } from "../workout-progression.js";
import type { WorkoutFeedbackRecord } from "../workout-progression.js";
import type { ReducedWorldState, Language, FeedbackDifficulty } from "./types.js";

const VALID_LANGUAGES = new Set<Language>(["pt-BR", "en-US", "it-IT"]);
const VALID_DIFFICULTIES = new Set<FeedbackDifficulty>(["easy", "ok", "hard", "pain"]);
const RECENT_FEEDBACK_WINDOW = 5;

/**
 * Subconjunto do perfil/memória passado para assembleWorldState.
 * Espelha os campos relevantes de GutoMemory sem importar server.ts.
 */
export interface WorldStateInput {
  userId: string;
  name?: string;
  language?: string;
  country?: string;
  city?: string;
  trainingGoal?: string;
  trainingLimitations?: string;
  trainingStatus?: string;
  trainingLocation?: string;
  /** Subconjunto de GutoMemory.lastWorkoutPlan (apenas o que o cérebro usa). */
  lastWorkoutPlan?: { focus?: string; title?: string; scheduledFor?: string } | null;
  /** Presença de plano de dieta: não copiamos a estrutura inteira. */
  weeklyDietPlan?: unknown;
  workoutFeedbackHistory?: WorkoutFeedbackRecord[];
}

function normalizeLanguage(raw: string | undefined): Language {
  if (VALID_LANGUAGES.has(raw as Language)) return raw as Language;
  return "pt-BR";
}

function extractDifficulties(history: WorkoutFeedbackRecord[]): FeedbackDifficulty[] {
  return history
    .slice(-RECENT_FEEDBACK_WINDOW)
    .map((r) => r.difficulty)
    .filter((d): d is FeedbackDifficulty => VALID_DIFFICULTIES.has(d as FeedbackDifficulty));
}

/**
 * Monta o ReducedWorldState a partir do perfil/memória do usuário.
 *
 * Função PURA:
 *  - Sem I/O (não acessa banco, não chama Gemini, não lê arquivos).
 *  - Sem efeitos colaterais.
 *  - Determinística: mesmo input → mesmo output.
 *  - Não inclui campos fora do escopo da Fatia 1 (DuoHealth, risco, Arena, XP, etc.).
 */
export function assembleWorldState(input: WorldStateInput): ReducedWorldState {
  const history = Array.isArray(input.workoutFeedbackHistory)
    ? input.workoutFeedbackHistory
    : [];

  const ws: ReducedWorldState = {
    userId: input.userId,
    language: normalizeLanguage(input.language),
    recentDifficulty: extractDifficulties(history),
    // null honesto quando não há feedback: "hold" pressupõe dados neutros, null é ausência de sinal.
    feedbackSignal: history.length > 0 ? getProgressionSignal(history) : null,
  };

  if (input.name !== undefined) ws.name = input.name;
  if (input.country !== undefined) ws.country = input.country;
  if (input.city !== undefined) ws.city = input.city;
  if (input.trainingGoal !== undefined) ws.trainingGoal = input.trainingGoal;
  if (input.trainingLimitations !== undefined) ws.trainingLimitations = input.trainingLimitations;
  if (input.trainingStatus !== undefined) ws.trainingStatus = input.trainingStatus;
  if (input.trainingLocation !== undefined) ws.trainingLocation = input.trainingLocation;

  if (input.lastWorkoutPlan !== undefined) {
    ws.todayWorkout = input.lastWorkoutPlan
      ? {
          focus: input.lastWorkoutPlan.focus,
          title: input.lastWorkoutPlan.title,
          scheduledFor: input.lastWorkoutPlan.scheduledFor,
        }
      : null;
  }

  if (input.weeklyDietPlan !== undefined) {
    ws.hasDietPlan = input.weeklyDietPlan !== null;
  }

  return ws;
}

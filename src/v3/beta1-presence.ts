import type { DifficultyLabel } from "./beta1-progression.js";

/**
 * BETA1 PRESENCE LAYER (deterministic).
 *
 * Product definition: GUTO OBSERVA + LEMBRA + PERGUNTA.
 * - GUTO NÃO EXECUTA SEM ENTENDER.
 * - GUTO NÃO TEM VERGONHA DE PERGUNTAR.
 * - GUTO NÃO PERGUNTA O QUE JÁ SABE.
 * - GUTO NÃO ENTREVISTA: uma pergunta adaptativa, nunca um questionário.
 * - GUTO NÃO INVENTA CAUSA: sinais recorrentes viram INVESTIGATE (conversa),
 *   nunca um ajuste automático de treino.
 *
 * Everything here derives from RECORDED evidence (workout_set_executions,
 * workout_session_exercises, session feedback history). The LLM may only
 * phrase the question from these facts; it never decides which facts are true.
 */

export type SessionDifficulty = DifficultyLabel;

/** Deterministic facts computed from execution rows. Never LLM-produced. */
export interface SessionFacts {
  totalExercises: number;
  completedExercises: number;
  skippedExercises: number;
  substitutedExercises: number;
  loadIncreases: number;
  loadReductions: number;
  intensityTechniques: number;
  painExercises: number;
}

export interface HistoryFact {
  previousDifficulty: SessionDifficulty | null;
  recentDifficulties: SessionDifficulty[];
  /** IMPROVING | STABLE | WORSENING | NEEDS_INVESTIGATION | INSUFFICIENT_DATA */
  recentTrend: string;
}

/** PROGRESS | MAINTAIN | REGRESS | INVESTIGATE | ADAPT | SAFETY */
export type SessionOutcomeDecision =
  | { decision: "PROGRESS"; reasonCode: "EVIDENCE_SUFFICIENT" }
  | { decision: "MAINTAIN"; reasonCode: "APPROPRIATE_DOSE" }
  | { decision: "REGRESS"; reasonCode: "HEAVY_BEYOND_DOUBT" }
  | { decision: "INVESTIGATE"; reasonCode: "RECURRED_HARD_WITHOUT_CAUSE" | "PAIN_JUST_REPORTED" }
  | { decision: "ADAPT"; reasonCode: "CAUSE_IDENTIFIED_TRAINING" }
  | { decision: "SAFETY"; reasonCode: "PAIN_REPORTED" };

export interface SessionOutcome {
  decision: SessionOutcomeDecision;
  /** GUTO-first contextual question for the ONLY unknown of this session. */
  contextualQuestion: string | null;
  knownFactsEcho: string[];
}

export interface SessionFeedbackRecord {
  workoutSessionId: string;
  overallDifficulty: SessionDifficulty;
  pain: boolean;
  causeExplanation: string | null;
  causeCategory: "user_state" | "training" | null;
  createdAt: string;
}

export type FeedbackTrend =
  | "IMPROVING"
  | "STABLE"
  | "NEEDS_INVESTIGATION"
  | "INSUFFICIENT_DATA";

export const HARD_SESSIONS_FOR_INVESTIGATE = 2;

// ─── Session facts (deterministic, from execution rows) ─────────────────────

export function buildSessionFacts(entries: Array<{
  exerciseId: string;
  difficultyLabel: string | null;
  pain: boolean;
  completed: boolean;
  setRows: Array<{ setNumber: number; loadKg: number | null; reps: number | null; techniqueType: string }>;
}>): SessionFacts {
  let completedExercises = 0;
  let painExercises = 0;
  let loadIncreases = 0;
  let loadReductions = 0;
  let intensityTechniques = 0;
  for (const entry of entries) {
    if (entry.completed) completedExercises += 1;
    if (entry.pain) painExercises += 1;
    const straight = entry.setRows.filter((set) => set.techniqueType === "STRAIGHT_SET");
    // Session-local comparison, chronological by setNumber: the session's
    // working load is where it STARTED; if the user moved it UP mid-session
    // that is a load increase (and down a reduction). Cheap deterministic
    // proxy; cross-session load trend is the progression engine's job, not
    // presence's.
    const ordered = [...straight].sort((a, b) => a.setNumber - b.setNumber);
    const loads = ordered.map((set) => set.loadKg).filter((load): load is number => load != null);
    if (loads.length > 1) {
      const first = loads[0]!;
      const last = loads[loads.length - 1]!;
      if (last > first) loadIncreases += 1;
      else if (last < first) loadReductions += 1;
    }
    intensityTechniques += entry.setRows.filter((set) => set.techniqueType !== "STRAIGHT_SET").length > 0 ? 1 : 0;
  }
  return {
    totalExercises: entries.length,
    completedExercises,
    skippedExercises: entries.length - completedExercises,
    substitutedExercises: 0,
    loadIncreases,
    loadReductions,
    intensityTechniques,
    painExercises,
  };
}

// ─── Outcome decision: never guess causes ────────────────────────────────────

export function decideSessionOutcome(input: {
  todayFeedback: { overallDifficulty: SessionDifficulty; pain: boolean } | null;
  history: SessionFeedbackRecord[];
  cause?: { category: "user_state" | "training"; explanation: string } | null;
}): SessionOutcome {
  const history = [...input.history].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const hardRun = countTrailingHard(history);
  const painToday = input.todayFeedback?.pain === true;
  const hardToday = input.todayFeedback?.overallDifficulty === "PESADA";

  // SAFETY first: pain is never negotiated, never auto-adapted silently.
  if (painToday) {
    return {
      decision: { decision: "SAFETY", reasonCode: "PAIN_REPORTED" },
      contextualQuestion: input.cause
        ? null
        : "Dor a gente leva a sério. Me diz: ela apareceu durante o movimento ou depois de terminar? Em qual exercício ela apareceu?",
      knownFactsEcho: ["dor registrada hoje"],
    };
  }

  // User identified the training as the cause → adjust (ADAPT), cause known.
  if (input.cause?.category === "training") {
    return {
      decision: { decision: "ADAPT", reasonCode: "CAUSE_IDENTIFIED_TRAINING" },
      contextualQuestion: null,
      knownFactsEcho: [`causa relatada: ${input.cause.explanation}`],
    };
  }

  // User says it is life (sleep, stress, week) → keep the stimulus, note it.
  if (input.cause?.category === "user_state") {
    return {
      decision: { decision: "MAINTAIN", reasonCode: "APPROPRIATE_DOSE" },
      contextualQuestion: null,
      knownFactsEcho: [`contexto do dia: ${input.cause.explanation}`],
    };
  }

  // Repeated hard sessions WITHOUT a known cause → investigate, never regress
  // automatically (PRESENCE 4).
  if (hardRun >= HARD_SESSIONS_FOR_INVESTIGATE || (hardToday && hardRun >= 1)) {
    return {
      decision: { decision: "INVESTIGATE", reasonCode: "RECURRED_HARD_WITHOUT_CAUSE" },
      contextualQuestion: "Tem uma coisa que eu estou vendo: você continua fechando o treino, mas já são algumas sessões que você me diz que está pesado. Antes de eu mexer em qualquer coisa, me diz: é o treino que está demais, ou você anda chegando mais cansado?",
      knownFactsEcho: ["sinais recorrentes de esforço alto sem causa conhecida"],
    };
  }

  // Clear evidence of improvement → PROGRESS without asking permission (B6).
  const recent = history.slice(-3).map((entry) => entry.overallDifficulty);
  const improving = recent.length >= 2 && recent.every((d) => d === "FACIL" || d === "BOA");
  if (improving && !hardToday) {
    return {
      decision: { decision: "PROGRESS", reasonCode: "EVIDENCE_SUFFICIENT" },
      contextualQuestion: null,
      knownFactsEcho: ["últimas sessões com esforço controlado"],
    };
  }

  // Today itself was hard (first time) → ask the only unknown, no questionnare.
  if (hardToday) {
    return {
      decision: { decision: "MAINTAIN", reasonCode: "APPROPRIATE_DOSE" },
      contextualQuestion: "Hoje bateu pesado. Quero teu lado: o treino que está puxado, ou foi só um dia mais cansado?",
      knownFactsEcho: ["esforço alto hoje, sem histórico ainda"],
    };
  }

  return {
    decision: { decision: "MAINTAIN", reasonCode: "APPROPRIATE_DOSE" },
    contextualQuestion: null,
    knownFactsEcho: [],
  };
}

function countTrailingHard(history: SessionFeedbackRecord[]): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]!.overallDifficulty === "PESADA") count += 1;
    else break;
  }
  return count;
}

// ─── Feedback trend over sessions (B8) ──────────────────────────────────────

export function computeFeedbackTrend(history: SessionFeedbackRecord[]): FeedbackTrend {
  if (history.length < 2) return "INSUFFICIENT_DATA";
  const recent = history.slice(-3);
  const scores = recent.map((entry) => difficultyScore(entry.overallDifficulty));
  const first = scores[0]!;
  const last = scores[scores.length - 1]!;
  const hardStreak = countTrailingHard(history);
  if (hardStreak >= HARD_SESSIONS_FOR_INVESTIGATE) return "NEEDS_INVESTIGATION";
  if (last < first) return "IMPROVING";
  if (last > first) return "NEEDS_INVESTIGATION";
  return "STABLE";
}

function difficultyScore(label: SessionDifficulty): number {
  switch (label) {
    case "FACIL": return 1;
    case "BOA": return 2;
    case "PESADA": return 3;
    case "DOR": return 4;
  }
}

// ─── Completion-time presence: facts echo + the ONE question ───────────────

export interface SessionPresenceSummary {
  outcome: "PROGRESS" | "MAINTAIN" | "REGRESS" | "INVESTIGATE" | "ADAPT" | "SAFETY";
  reasonCode: string;
  contextualQuestion: string | null;
  trend: FeedbackTrend;
  knownFactsEcho: string[];
}

/**
 * Builds the completion-time presence payload. The subjective overall
 * difficulty of THIS session is still unknown here — that is exactly what the
 * contextual question asks (B2), phrased from the observed facts (B3).
 * GUTO never asks what the backend already knows (B1/B10).
 */
export function buildSessionPresence(input: {
  facts: SessionFacts;
  history: SessionFeedbackRecord[];
}): SessionPresenceSummary {
  const { facts, history } = input;
  const painToday = facts.painExercises > 0;

  // SAFETY: exercise-level pain already recorded — ask only what is missing.
  if (painToday) {
    return {
      outcome: "SAFETY",
      reasonCode: "PAIN_REPORTED",
      contextualQuestion: "Dor a gente leva a sério. Me diz: ela apareceu durante o movimento ou depois de terminar? Em qual exercício ela apareceu?",
      trend: computeFeedbackTrend(history),
      knownFactsEcho: ["dor registrada na execução de hoje"],
    };
  }

  const hardRun = countTrailingHard(history);
  // INVESTIGATE: recurring hard sessions without a known cause → conversation,
  // never automatic regression (B5).
  if (hardRun >= HARD_SESSIONS_FOR_INVESTIGATE) {
    return {
      outcome: "INVESTIGATE",
      reasonCode: "RECURRED_HARD_WITHOUT_CAUSE",
      contextualQuestion: "Tem uma coisa que eu estou vendo: você continua fechando o treino, mas já são algumas sessões que você me diz que está pesado. Antes de eu mexer em qualquer coisa, me diz: é o treino que está demais, ou você anda chegando mais cansado?",
      trend: computeFeedbackTrend(history),
      knownFactsEcho: ["sinais recorrentes de esforço alto sem causa conhecida"],
    };
  }

  // PROGRESS without asking permission when evidence is clear (B6).
  const recent = history.slice(-3).map((entry) => entry.overallDifficulty);
  const improving = recent.length >= 2 && recent.every((label) => label === "FACIL" || label === "BOA");
  const outcome: SessionPresenceSummary["outcome"] = improving ? "PROGRESS" : "MAINTAIN";
  const reasonCode = improving ? "EVIDENCE_SUFFICIENT" : "APPROPRIATE_DOSE";

  // The ONE question: how today felt, phrased from the observed facts (B3).
  let question: string;
  if (facts.loadIncreases > 0) {
    question = `Hoje você subiu carga em ${facts.loadIncreases === 1 ? "um exercício" : `${facts.loadIncreases} exercícios`} e ainda fechou o treino. Como isso bateu?`;
  } else if (facts.loadReductions > 0) {
    question = "Vi que hoje você precisou baixar um pouco a carga. Quero teu lado: o treino estava pesado ou foi só um dia mais cansado?";
  } else {
    question = "Fechamos. Eu vi o que você fez hoje. Agora me passa a parte que eu não consigo sentir: ficou fácil, na medida ou pesado?";
  }

  const echo: string[] = [];
  if (facts.completedExercises > 0) echo.push(`execução registrada em ${facts.completedExercises} exercício(s)`);
  if (facts.intensityTechniques > 0) echo.push("técnica avançada aplicada");
  if (improving) echo.push("últimas sessões com esforço controlado");

  return {
    outcome,
    reasonCode,
    contextualQuestion: question,
    trend: computeFeedbackTrend(history),
    knownFactsEcho: echo,
  };
}

/**
 * Deterministic cause classification for a free-text clarification. Keyword
 * policy only — the LLM may phrase, never classify here. Unmatched text
 * stays unclassified (caller decides: ask again or record as-is).
 */
export function classifyCauseExplanation(text: string): "user_state" | "training" | null {
  const normalized = text.toLowerCase();
  if (/sono|dormindo|dormir|cansad|estress|trabalh|semana|vida|anxiety|ansiedade|agenda|feriado|viagem/iu.test(normalized)) return "user_state";
  if (/treino|pesado|carga|exerc[íi]cio|movimento|series|séries|reps|repeti/iu.test(normalized)) return "training";
  return null;
}

// ─── Human fallback lines (B11): never raw technical errors ─────────────────

const GUTO_FALLBACK_LINES = [
  "Foi mal, eu me perdi aqui. Manda de novo?",
  "Essa eu não peguei direito. Me explica de outro jeito?",
  "Pera, fiquei na dúvida no que você quis dizer. Pode repetir?",
];

/** Stable pick per requestId so the same failure never flip-flops wording. */
export function humanFallbackLine(requestId: string): string {
  let hash = 0;
  for (const char of requestId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return GUTO_FALLBACK_LINES[hash % GUTO_FALLBACK_LINES.length]!;
}

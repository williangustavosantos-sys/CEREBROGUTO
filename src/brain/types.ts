// src/brain/types.ts
// Tipos NARROW e auto-contidos da Fatia 1 do cérebro soberano.
// - NÃO importa server.ts (evita acoplamento/circular com o parlamento antigo).
// - NÃO contém lógica de decisão.
// - É estruturalmente compatível com o que o handler /guto já envia ao cliente
//   (GutoModelResponse: fala/acao/expectedResponse/avatarEmotion/workoutPlan/memoryPatch),
//   para que os commits 5/6 encaixem sem atrito ao fazer res.json(contract.response).

/** Idiomas suportados (lei do produto). */
export type Language = "pt-BR" | "en-US" | "it-IT";

/** Dificuldade do feedback pós-treino JÁ capturada hoje em workoutFeedbackHistory. */
export type FeedbackDifficulty = "easy" | "ok" | "hard" | "pain";

/** Sinal de progressão derivado do feedback (saída de getProgressionSignal). */
export type ProgressionSignal = "progress" | "hold" | "deload";

/**
 * Subconjunto REDUZIDO do estado lido por assembleWorldState (commit 4).
 * Sem DuoHealth / risco / morte / Arena / Avatar / XP / Proatividade — fora da Fatia 1.
 */
export interface ReducedWorldState {
  userId: string;
  language: Language;
  name?: string;
  country?: string;
  city?: string;
  trainingGoal?: string;
  trainingLimitations?: string[] | string;
  trainingStatus?: string;
  trainingLocation?: string;
  /** Feedback Fácil/Normal/Difícil já capturado (LIDO, não recapturado na Fatia 1). */
  recentDifficulty: FeedbackDifficulty[];
  /** Sinal agregado (progress|hold|deload) ou null se não há feedback suficiente. */
  feedbackSignal: ProgressionSignal | null;
}

/**
 * Ação estrutural do turno. Compatível com o campo `acao` (Acao) do GutoModelResponse.
 * A Fatia 1 só DECIDE 'none' (turno conversacional simples); as demais existem apenas
 * para serem RECONHECIDAS e retornarem validation:'defer' (caem na escada antiga).
 */
export type TurnAcao =
  | "none"
  | "updateWorkout"
  | "generateDiet"
  | "openProactiveCard"
  | "swapExercise"
  | "callCoach";

/**
 * Botões rápidos / próximo passo. Shape mínimo compatível com ExpectedResponse do server.ts
 * (tolera campos extras do contrato real via index signature).
 */
export interface TurnExpectedResponse {
  type?: string;
  instruction?: string;
  options?: string[];
  [key: string]: unknown;
}

/**
 * Payload PÚBLICO devolvido ao cliente (res.json). Shape-compatível com GutoModelResponse.
 * INVARIANTE: nunca contém meta interno do cérebro (LEI 11). É o ÚNICO que vai ao cliente.
 */
export interface PublicTurnResponse {
  fala: string;
  acao: TurnAcao;
  expectedResponse: TurnExpectedResponse | null;
  avatarEmotion?: string;
  workoutPlan?: unknown | null;
  memoryPatch?: Record<string, unknown> | null;
}

/** Resultado da decisão: 'ok' => usar response; 'defer' => cair na escada antiga (askGutoModel). */
export type TurnValidation = "ok" | "defer";

/**
 * Meta INTERNO do cérebro — auditoria/diagnóstico. NUNCA é serializado ao cliente.
 * Mantido FORA de `response` por design (chaves disjuntas de PublicTurnResponse).
 */
export interface TurnMeta {
  /** Classe do turno (ex.: "conversational_simple", "deferred:updateWorkout"). */
  kind: string;
  /** Por que o cérebro decidiu assim (texto interno; nunca vai ao usuário). */
  reasoning?: string;
  /** Origem da decisão. */
  via: "sovereign_brain_slice1";
  /** Houve chamada governada ao modelo neste turno? */
  modelCalled: boolean;
  /** Persistência honesta: true só se realmente gravou (commit 5). */
  persisted: boolean;
}

/**
 * Contrato de turno da Fatia 1. Separa o PÚBLICO (response) do INTERNO (meta/validation).
 * O handler envia SOMENTE contract.response ao res.json; meta e validation ficam no servidor.
 */
export interface TurnContract {
  response: PublicTurnResponse;
  validation: TurnValidation;
  meta: TurnMeta;
}

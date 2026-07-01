// src/brain/decide-turn.ts
// Fatia 1 do cérebro soberano — decide UM turno simples (acao:"none").
//
// PRINCÍPIOS (ver GUTO_ENGINEERING_GUIDE / GUTO_DECISION_ARCHITECTURE):
// - NÃO importa server.ts e NÃO invoca o motor antigo askGutoModel — chamá-lo
//   re-rodaria o parlamento inteiro (classifyContractIntent etc.).
// - Faz a PRÓPRIA chamada governada, mas as primitivas de baixo nível
//   (buildGutoBrainPrompt / fetchJsonWithTimeout / parseGutoResponse) e a
//   persistência são INJETADAS (DecideTurnDeps). O server.ts as conecta no
//   commit 6. Motivo: essas funções não são exportadas e a URL real embute
//   GEMINI_API_KEY/MODEL (privados do monolito) — injetar mantém o segredo lá
//   e deixa este módulo puro/testável.
// - Faz EXATAMENTE UMA chamada ao modelo no caminho feliz.
// - Só decide turno simples; qualquer ação complexa → validation:"defer".
// - meta interno NUNCA entra em response (LEI 11).
// - Persistência é HONESTA: meta.persisted=true só se realmente gravou.

import type {
  TurnContract,
  PublicTurnResponse,
  TurnExpectedResponse,
  TurnAcao,
  ReducedWorldState,
  Language,
} from "./types.js";
import { validateContract } from "./validate-contract.js";

/** Item de histórico mínimo (desacoplado do GutoHistoryItem do server.ts). */
export interface BrainHistoryItem {
  role: string;
  content: string;
}

/** Resultado da chamada governada ao modelo (adapter sobre fetchJsonWithTimeout). */
export interface ModelCallResult {
  ok: boolean;
  rawText?: string;
}

export type DecideWorldState = ReducedWorldState | {
  userId?: unknown;
  language?: unknown;
};

/**
 * Dependências injetadas. O server.ts (commit 6) liga cada uma às primitivas
 * REAIS já existentes — este módulo nunca as importa do monolito.
 */
export interface DecideTurnDeps {
  /** Wrap de buildGutoBrainPrompt: monta o prompt a partir do estado reduzido. */
  buildPrompt: (ctx: {
    worldState: DecideWorldState;
    input: string;
    history: BrainHistoryItem[];
  }) => string;
  /** Chamada governada ÚNICA ao modelo (adapter sobre fetchJsonWithTimeout + URL/body). */
  callModel: (prompt: string) => Promise<ModelCallResult>;
  /** Wrap de parseGutoResponse: texto cru → objeto candidato {fala, acao, ...}. */
  parseResponse: (rawText: string | undefined, language: string) => unknown;
  /**
   * Persistência injetada (applyMemoryPatch + commit do server.ts). Opcional:
   * ausente => nunca grava. Só é chamada DEPOIS de validateContract passar.
   */
  persist?: (userId: string, memoryPatch: Record<string, unknown>) => Promise<void>;
}

export interface DecideTurnInput {
  worldState: DecideWorldState;
  input: string;
  history?: BrainHistoryItem[];
}

const SUPPORTED_TURN_ACOES = new Set<TurnAcao>([
  "none",
  "updateWorkout",
  "generateDiet",
  "openProactiveCard",
  "swapExercise",
  "callCoach",
]);

/** Fala neutra e honesta para o caminho de defer (o server.ts substitui na escada antiga). */
function deferFala(language: Language): string {
  if (language === "en-US") return "One sec — let me think about this with you.";
  if (language === "it-IT") return "Un attimo — ci penso con te.";
  return "Só um segundo — deixa eu pensar nisso com você.";
}

/** Contrato de DEFER: cai na escada antiga. Nunca persiste, nunca afirma ter salvo. */
function deferContract(
  language: Language,
  kind: string,
  modelCalled: boolean,
  reasoning: string
): TurnContract {
  return {
    response: {
      fala: deferFala(language),
      acao: "none",
      expectedResponse: null,
    },
    validation: "defer",
    meta: {
      kind,
      reasoning,
      via: "sovereign_brain_slice1",
      modelCalled,
      persisted: false,
    },
  };
}

/** Coage expectedResponse cru para o shape público (ou null). */
function coerceExpectedResponse(value: unknown): TurnExpectedResponse | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as TurnExpectedResponse;
}

/** Lê memoryPatch só se for objeto plano serializável; senão null. */
function readMemoryPatch(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Decide um turno simples da Fatia 1.
 *
 * Caminho feliz (validation:"ok"):
 *  - 1 chamada ao modelo, resposta válida com acao="none";
 *  - persiste no MÁXIMO uma vez (só se há memoryPatch e deps.persist);
 *  - meta.persisted reflete a realidade da gravação.
 *
 * Defer (validation:"defer"): qualquer ação complexa, resposta inválida, ou
 * falha de chamada. Não persiste, não vaza meta, não afirma ter salvo.
 */
export async function decideTurn(
  input: DecideTurnInput,
  deps: DecideTurnDeps
): Promise<TurnContract> {
  const { worldState } = input;
  const language = (worldState.language as Language) || "pt-BR";
  const history = input.history ?? [];

  const prompt = deps.buildPrompt({ worldState, input: input.input, history });

  // ─── ÚNICA chamada ao modelo ──────────────────────────────────────────────
  let result: ModelCallResult;
  try {
    result = await deps.callModel(prompt);
  } catch {
    return deferContract(language, "model_call_error", true, "callModel lançou exceção");
  }

  if (!result.ok) {
    return deferContract(language, "model_not_ok", true, "callModel retornou ok=false");
  }

  // Parse + validação de FORMA (pura).
  const candidate = deps.parseResponse(result.rawText, language) as Record<string, unknown>;
  const verdict = validateContract(candidate);

  // Inválido (forma ruim) → defer seguro, sem persistir.
  if (!verdict.ok) {
    return deferContract(
      language,
      "invalid_form",
      true,
      `validateContract reprovou: ${verdict.errors.join("; ")}`
    );
  }
  if (verdict.validation !== "ok") {
    return deferContract(
      language,
      `deferred:${String(candidate.acao ?? "unknown")}`,
      true,
      "ação fora do contrato soberano"
    );
  }

  // ─── Turno soberano válido ────────────────────────────────────────────────
  // Monta o response PÚBLICO campo-a-campo: nunca espalha o candidato inteiro,
  // para que nenhuma chave estranha/meta vaze (LEI 11). PRESERVA a acao decidida
  // pelo cérebro (a execução do treino é feita pelo executor no server, depois).
  const candidateAcao = String(candidate.acao || "none") as TurnAcao;
  const decidedAcao: TurnAcao = SUPPORTED_TURN_ACOES.has(candidateAcao) ? candidateAcao : "none";
  const response: PublicTurnResponse = {
    fala: String(candidate.fala),
    acao: decidedAcao,
    expectedResponse: coerceExpectedResponse(candidate.expectedResponse),
  };
  if (typeof candidate.avatarEmotion === "string") {
    response.avatarEmotion = candidate.avatarEmotion;
  }

  const memoryPatch = readMemoryPatch(candidate.memoryPatch);
  if (memoryPatch) response.memoryPatch = memoryPatch;
  const proactiveMemoryAction = readMemoryPatch(candidate.proactiveMemoryAction);
  if (proactiveMemoryAction) response.proactiveMemoryAction = proactiveMemoryAction;

  // ─── Persistência HONESTA: depois da validação, no máximo 1 vez ───────────
  let persisted = false;
  let persistNote = "";
  if (memoryPatch && deps.persist) {
    try {
      await deps.persist(String(worldState.userId || ""), memoryPatch);
      persisted = true;
    } catch {
      // Falha de persistência NÃO transforma a fala em mentira: ela é
      // conversacional e não afirma "salvei". Apenas registramos no meta interno.
      persisted = false;
      persistNote = " (persist falhou — não afirmar gravação)";
    }
  }

  return {
    response,
    validation: "ok",
    meta: {
      kind: decidedAcao === "none" ? "conversational_simple" : `action:${decidedAcao}`,
      reasoning: `turno (${decidedAcao}) decidido pelo cérebro soberano${persistNote}`,
      via: "sovereign_brain_v2",
      modelCalled: true,
      persisted,
    },
  };
}

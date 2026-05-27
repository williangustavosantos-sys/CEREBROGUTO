/**
 * GUTO Chat Context Intent (Fase 3L)
 *
 * Interpreta mensagens CURTAS pelo CONTEXTO ATIVO antes de qualquer classificação
 * de patologia. Corrige o bug: no contexto de alimento, "não tenho" virava
 * patologia ("Ombro entendido") porque o detector lia o bloco de contexto
 * injetado (que contém "Limitations/pathology: ombro...") como se fosse a fala
 * do usuário.
 *
 * Regras (determinísticas, antes do modelo):
 *  - contexto alimento + "não tenho/acabou" → alimento indisponível (substituir).
 *  - contexto exercício + "não tenho/ocupado" → equipamento indisponível (trocar).
 *  - sem contexto + "não tenho" → pedir esclarecimento.
 *  - patologia SÓ quando houver região corporal explícita NA FALA do usuário.
 *
 * Funções puras, sem React, sem efeitos — cobertas por testes.
 */

export type ChatContextKind = "food" | "exercise" | "none";
export type ShortIntentLanguage = "pt-BR" | "en-US" | "it-IT";

// Marcadores que o app injeta no início do bloco de contexto.
const EXERCISE_CONTEXT_MARKER = "[WORKOUT EXERCISE CONTEXT";
const DIET_CONTEXT_MARKER = "[DIET CONTEXT";

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Remove os blocos de contexto injetados pelo app (`[WORKOUT EXERCISE CONTEXT …]`
 * e `[DIET CONTEXT …]`) e devolve apenas a fala real do usuário. Os blocos vêm
 * embutidos na mesma string e terminam em "User message:" quando presente.
 */
export function stripInjectedContext(rawInput: string): string {
  if (!rawInput) return "";
  // O app termina o bloco com "User message:" (exercício) ou "User question:"
  // (dieta) seguido da fala real do usuário.
  const userMsgMatch = rawInput.match(/User (?:message|question):\s*([\s\S]*)$/i);
  if (userMsgMatch) return userMsgMatch[1].trim();
  // Caso o bloco esteja só prefixado: corta tudo até o fim do colchete inicial.
  let out = rawInput;
  for (const marker of [EXERCISE_CONTEXT_MARKER, DIET_CONTEXT_MARKER]) {
    const idx = out.indexOf(marker);
    if (idx !== -1) {
      const close = out.indexOf("]", idx);
      if (close !== -1) out = out.slice(0, idx) + out.slice(close + 1);
    }
  }
  return out.trim();
}

export function detectActiveChatContext(rawInput: string): ChatContextKind {
  if (!rawInput) return "none";
  if (rawInput.includes(DIET_CONTEXT_MARKER)) return "food";
  if (rawInput.includes(EXERCISE_CONTEXT_MARKER)) return "exercise";
  return "none";
}

// Termos de região corporal explícita (a única coisa que autoriza patologia).
const BODY_REGION_TERMS = [
  "joelho", "knee", "ginocchio",
  "ombro", "shoulder", "spalla",
  "lombar", "coluna", "schiena", "lower back", "back",
  "perna", "pernas", "leg", "legs", "gamba", "gambe",
  "tornozelo", "ankle", "caviglia",
  "quadril", "hip", "anca",
  "punho", "wrist", "polso",
  "cotovelo", "elbow", "gomito",
  "peito", "chest", "petto",
  "pescoco", "neck", "collo",
  "costas", "dorsal",
];

/** Verdadeiro só se houver termo de região corporal na FALA do usuário. */
export function hasExplicitBodyRegion(userMessage: string): boolean {
  const n = normalize(userMessage);
  if (!n) return false;
  // Pontuação ("ombro." / "joelho,") não pode esconder a região corporal.
  const padded = ` ${n.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
  return BODY_REGION_TERMS.some((t) => padded.includes(` ${normalize(t)} `));
}

// "Não tenho / acabou / sem isso" → indisponibilidade genérica.
const UNAVAILABILITY_PHRASES = [
  "nao tenho", "nao tem", "nao tenho isso", "sem isso", "acabou", "acabou isso",
  "nao tenho esse", "nao tenho essa", "ta sem", "to sem", "estou sem", "nao possuo",
  "non ce l", "non ce l ho", "non ho", "non ho questo", "finito", "e finito",
  "i don t have", "i don t have it", "dont have", "don t have", "out of", "ran out",
  "we re out", "no tengo",
];

// Equipamento ocupado/indisponível (contexto de exercício).
const EQUIPMENT_BUSY_PHRASES = [
  "ocupado", "ocupada", "ta ocupado", "ta ocupada", "lotado", "cheio", "fila",
  "nao tem esse aparelho", "nao tem o aparelho", "aparelho ocupado", "maquina ocupada",
  "occupato", "occupata", "preso", "busy", "taken", "in use", "occupied",
];

function matchesAny(userMessageNormalized: string, phrases: string[]): boolean {
  return phrases.some((p) => userMessageNormalized.includes(normalize(p)));
}

/** Mensagem curta = poucas palavras (gatilho conservador para o gate determinístico). */
function isShort(userMessage: string): boolean {
  const words = normalize(userMessage).split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 4;
}

export function isUnavailabilityMessage(userMessage: string): boolean {
  const n = normalize(userMessage);
  if (!n) return false;
  return matchesAny(n, UNAVAILABILITY_PHRASES);
}

export function isEquipmentUnavailableMessage(userMessage: string): boolean {
  const n = normalize(userMessage);
  if (!n) return false;
  return matchesAny(n, EQUIPMENT_BUSY_PHRASES) || matchesAny(n, UNAVAILABILITY_PHRASES);
}

export type ShortContextIntent =
  | "food_unavailable"
  | "equipment_unavailable"
  | "needs_clarification"
  | "pathology"
  | "none";

/**
 * Decide a intenção de uma mensagem curta a partir do contexto ativo e da FALA
 * do usuário (já sem o bloco de contexto injetado). Nunca classifica patologia
 * sem região corporal explícita na fala.
 */
export function classifyShortContextIntent(params: {
  rawInput: string;
}): { intent: ShortContextIntent; context: ChatContextKind; userMessage: string } {
  const context = detectActiveChatContext(params.rawInput);
  const userMessage = stripInjectedContext(params.rawInput);

  // 1) Região corporal explícita na fala → patologia (independe do contexto).
  if (hasExplicitBodyRegion(userMessage)) {
    return { intent: "pathology", context, userMessage };
  }

  // 2) Contexto de alimento + indisponibilidade → alimento indisponível.
  if (context === "food" && isUnavailabilityMessage(userMessage)) {
    return { intent: "food_unavailable", context, userMessage };
  }

  // 3) Contexto de exercício + indisponibilidade/ocupado → equipamento.
  if (context === "exercise" && isEquipmentUnavailableMessage(userMessage)) {
    return { intent: "equipment_unavailable", context, userMessage };
  }

  // 4) Sem contexto + mensagem curta de indisponibilidade → pedir esclarecimento.
  if (context === "none" && isShort(userMessage) && isUnavailabilityMessage(userMessage)) {
    return { intent: "needs_clarification", context, userMessage };
  }

  return { intent: "none", context, userMessage };
}

// ─── Copy determinística (curta, no idioma do usuário) ────────────────────────

export function foodUnavailableReply(language: ShortIntentLanguage): string {
  if (language === "en-US") return "No problem. I will swap this food for a local equivalent.";
  if (language === "it-IT") return "Nessun problema. Lo cambio con un equivalente locale.";
  return "Sem problema. Eu troco esse alimento por um equivalente local.";
}

export function equipmentUnavailableReply(language: ShortIntentLanguage): string {
  if (language === "en-US") return "Got it. I will swap it for an equivalent exercise.";
  if (language === "it-IT") return "Capito. Lo cambio con un esercizio equivalente.";
  return "Fechado. Eu troco por um exercício equivalente.";
}

export function clarificationReply(language: ShortIntentLanguage): string {
  if (language === "en-US") return "You do not have what: food or equipment?";
  if (language === "it-IT") return "Cosa non hai: alimento o attrezzo?";
  return "Não tem o quê: alimento ou aparelho?";
}

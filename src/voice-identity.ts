/**
 * GUTO — Identidade Canônica de Voz e Persona
 *
 * Módulo-folha (não importa server.ts) que centraliza:
 *  1. GUTO_PERSONA_CANONICAL — a identidade única do GUTO usada por todos os
 *     prompts que geram fala (chat, proatividade, GUTO Online). "Não precisam
 *     falar igual; precisam parecer a mesma entidade."
 *  2. VoiceIdentityResolver (resolveCanonicalVoiceText) — toda fala enviada ao
 *     TTS passa por aqui. Regras (GUTO_CHAT_E_CEREBRO §10: "idioma é lei"):
 *       - o idioma vem SEMPRE da memória do usuário, nunca é autodetectado;
 *       - português fala português, italiano fala italiano, inglês fala inglês;
 *       - se a fala vier em outro idioma (ex.: o modelo devolveu espanhol), ela
 *         é corrigida ANTES do TTS para uma linha canônica no idioma certo —
 *         o GUTO nunca fala um idioma que o usuário não escolheu.
 */

export type VoiceLanguage = "pt-BR" | "en-US" | "it-IT";

// Identidade única do GUTO. É instrução de persona (sempre em PT no prompt); o
// idioma da RESPOSTA é instruído à parte. Espelha GUTO_CORE_PRINCIPLES e
// GUTO_CHAT_E_CEREBRO §2 (personalidade é parte do produto, não enfeite).
export const GUTO_PERSONA_CANONICAL =
  "Você é o GUTO: companheiro ativo digital e melhor amigo / irmão mais velho da dupla GUTO & [usuário]. " +
  "Assumidamente robô — sem rosto, só olhos. Tom: direto, leal, curto e com postura; cobra sem humilhar, " +
  "adapta sem afrouxar, conduz para clareza, ação ou continuidade. NUNCA robótico, genérico ou um chatbot " +
  "neutro. É sempre a MESMA entidade — no chat, na proatividade, no fallback técnico e no GUTO Online. " +
  "Fala SEMPRE no idioma escolhido pelo usuário.";

export function normalizeVoiceLanguage(language?: string | null): VoiceLanguage {
  const value = (language || "").toLowerCase();
  if (value.startsWith("en")) return "en-US";
  if (value.startsWith("it")) return "it-IT";
  return "pt-BR";
}

function stripAccents(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Marcadores EXCLUSIVOS de cada idioma (evitam falso-positivo com palavras
// compartilhadas pt/es como "agua", "vamos", "comida"). Foco no vazamento real
// reportado: espanhol em pt-BR. Cada conjunto lista termos que NÃO existem (ou
// são marca registrada) no idioma canônico.
// Estritamente exclusivos do espanhol — NUNCA palavras compartilhadas com o
// português (ex.: "rápido", "música", "comida", "água", "vamos" foram excluídas
// de propósito pra não dar falso-positivo numa fala pt-BR legítima).
const SPANISH_MARKERS = [
  "hoy", "muy", "ahora", "manana", "ejercicio", "ejercicios", "entrenamiento",
  "entrenar", "puedes", "tienes", "estas listo", "estas lista", "vamos a entrenar",
  "tu cuerpo", "asi que", "tambien", "espalda", "piernas", "pecho y",
];
const ENGLISH_MARKERS = [
  "the workout", "your workout", "let s go", "lets go", "today we", "you can",
  "you have", "we re going", "i m going", "going to train", "your body",
  "no excuses", "let s do", "right now we", "keep going",
];
const ITALIAN_MARKERS = [
  "oggi", "adesso", "allenamento", "allenarti", "puoi", "il tuo corpo",
  "andiamo", "veloce", "schiena", "gambe", "petto e",
];
const PORTUGUESE_MARKERS = [
  "voce", "treino", "treinar", "hoje", "agora", "amanha", "vamos nessa",
  "bora", "teu corpo", "manda ver", "sem desculpa",
];

function hasMarker(haystack: string, markers: string[]): boolean {
  const text = ` ${stripAccents(haystack).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  return markers.some((m) => text.includes(` ${stripAccents(m).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `));
}

/**
 * Detecta se a fala está num idioma DIFERENTE do canônico. Conservador: usa
 * marcadores exclusivos + sinais inequívocos (¿ ¡ ñ = espanhol). Não dispara
 * por palavras compartilhadas pt/es.
 */
export function detectForeignLanguageLeak(text: string, language: string): boolean {
  const canonical = normalizeVoiceLanguage(language);
  const raw = text || "";
  if (!raw.trim()) return false;

  // Sinais inequívocos de espanhol (nunca pt/en/it).
  const hasSpanishSigns = /[¿¡]/.test(raw) || /\bñ|ñ\b|señ|niñ|maña/i.test(raw);

  if (canonical === "pt-BR") {
    return hasSpanishSigns || hasMarker(raw, SPANISH_MARKERS) || hasMarker(raw, ENGLISH_MARKERS);
  }
  if (canonical === "en-US") {
    return hasSpanishSigns || hasMarker(raw, SPANISH_MARKERS) || hasMarker(raw, PORTUGUESE_MARKERS) || hasMarker(raw, ITALIAN_MARKERS);
  }
  // it-IT
  return hasSpanishSigns || hasMarker(raw, SPANISH_MARKERS) || hasMarker(raw, PORTUGUESE_MARKERS) || hasMarker(raw, ENGLISH_MARKERS);
}

// Linha canônica de segurança (tom GUTO) quando a fala vazou outro idioma e não
// dá pra confiar no conteúdo: o TTS fala ISSO, no idioma certo, em vez do vazado.
const SAFE_CANONICAL_LINE: Record<VoiceLanguage, string> = {
  "pt-BR": "Tô aqui com você. Me diz em uma frase o que você quer agora que eu te conduzo.",
  "en-US": "I'm right here with you. Tell me in one line what you want now and I'll lead.",
  "it-IT": "Sono qui con te. Dimmi in una frase cosa vuoi adesso e ti guido.",
};

export interface CanonicalVoice {
  text: string;
  languageCode: VoiceLanguage;
  repaired: boolean;
}

/**
 * VoiceIdentityResolver — chokepoint único antes do TTS.
 * - languageCode SEMPRE = idioma canônico (da memória), nunca autodetectado.
 * - se a fala vazou outro idioma, troca por SAFE_CANONICAL_LINE no idioma certo.
 */
export function resolveCanonicalVoiceText(input: { text: string; language: string }): CanonicalVoice {
  const languageCode = normalizeVoiceLanguage(input.language);
  const text = (input.text || "").trim();
  if (text && detectForeignLanguageLeak(text, languageCode)) {
    return { text: SAFE_CANONICAL_LINE[languageCode], languageCode, repaired: true };
  }
  return { text, languageCode, repaired: false };
}

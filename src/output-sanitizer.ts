/**
 * GUTO — Sanitizador de saída (Behavior Law 11)
 *
 * O usuário NUNCA pode ver informação interna do cérebro do GUTO: prompt,
 * contexto técnico, instruções de sistema, marcadores de pipeline ou qualquer
 * texto de engenharia. Estes marcadores nascem como contexto injetado (frontend
 * injeta `[DIET CONTEXT …]`/`[WORKOUT EXERCISE CONTEXT …]` na mensagem; a
 * proatividade injeta `[PROACTIVITY — …]`/`[PROATIVIDADE — …]`; a voz usa
 * `[GUTO_VOICE …]`) e deveriam ser consumidos APENAS pelo modelo/pipeline — nunca
 * voltar ao usuário.
 *
 * Esta é a última linha de defesa: roda no egresso único (`res.json` é envolvido
 * por um middleware) e limpa TODA resposta. Assim, NENHUM marcador interno
 * consegue sair do backend, qualquer que seja o caminho que o gerou.
 */

// Blocos colchetados internos: começam por uma PALAVRA EM CAIXA ALTA (≥3) — é o
// formato de todos os marcadores de contexto/pipeline do GUTO. Falas legítimas do
// GUTO não usam `[PALAVRA EM CAIXA …]`.
const BRACKET_MARKER = /\[[A-Z][A-Z0-9_]{2,}[^\]]*\]/g;

// Frases instrucionais internas (não colchetadas) que o frontend injeta.
const INTERNAL_PHRASES: RegExp[] = [
  /\bUser opened chat from[^.\n]*\.?/gi,
  /\bnutrition only\b/gi,
  /\bworkout only\b/gi,
  /\bUser (?:message|question):\s*/gi,
  /\blanguage:\s*[a-z]{2}-[A-Z]{2}\b/g,
  /\bEvento proativo devido:[^.\n]*\.?/gi,
  /\bPrompt ativo:[^\n]*/gi,
  /\bCard pendente:[^\n]*/gi,
  /\bTreino já planejado para hoje:[^\n]*/gi,
  /\bDecida a fala e a próxima ação[^.\n]*\.?/gi,
  /\bNão use culpa por streak[^.\n]*\.?/gi,
];

// Linhas inteiras claramente reservadas ao backend.
const RESERVED_LINES = /^\s*(?:SYSTEM|INTERNAL|DEBUG|SAFETY_OVERRIDE)\b.*$/gim;

// Detector (para asserções/tests): qualquer um dos marcadores reservados.
const RESERVED_DETECTOR = new RegExp(
  [
    BRACKET_MARKER.source,
    /\[(?:DIET CONTEXT|WORKOUT EXERCISE CONTEXT|EXERCISE CONTEXT|VOICE|PROACTIVITY|PROATIVIDADE|PROATTIVIT)/i.source,
    /\bUser opened chat from\b/i.source,
    /\bnutrition only\b/i.source,
    /\blanguage:\s*[a-z]{2}-[A-Z]{2}\b/.source,
    /\bEvento proativo devido:/i.source,
    /\bPrompt ativo:/i.source,
    /\bCard pendente:/i.source,
    /\bTreino já planejado para hoje:/i.source,
    /\bDecida a fala e a próxima ação\b/i.source,
    /\bNão use culpa por streak\b/i.source,
    /^\s*(?:SYSTEM|INTERNAL|DEBUG|SAFETY_OVERRIDE)\b/im.source,
  ].join("|"),
  "im",
);

/** Verdadeiro se o texto contém QUALQUER marcador reservado ao backend. */
export function containsReservedMarker(text: unknown): boolean {
  if (typeof text !== "string" || !text) return false;
  RESERVED_DETECTOR.lastIndex = 0;
  return RESERVED_DETECTOR.test(text);
}

/** Remove todo marcador interno de um texto destinado ao usuário. */
export function sanitizeUserFacingText(text: string): string {
  if (!text) return text;
  let out = text.replace(BRACKET_MARKER, " ");
  for (const phrase of INTERNAL_PHRASES) out = out.replace(phrase, " ");
  out = out.replace(RESERVED_LINES, " ");
  // Colapsa o espaço/linhas que sobraram, sem destruir parágrafos legítimos.
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n{3,} */g, "\n\n")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n");
  return out;
}

// Chaves que carregam binário/credencial — NÃO são texto de usuário; pular (perf
// + segurança). audioContent/imageBase64 são base64 grandes.
const SKIP_KEYS = new Set([
  "audioContent",
  "audioBase64",
  "imageBase64",
  "image",
  "token",
  "accessToken",
  "refreshToken",
  "videoUrl",
  "sourceFileName",
]);

/**
 * Limpa recursivamente TODA string de um payload de resposta antes de ir ao
 * usuário. Chokepoint único: é chamado pelo wrapper de `res.json`.
 */
export function sanitizeResponsePayload<T>(body: T, depth = 0): T {
  if (depth > 8 || body == null) return body;
  if (typeof body === "string") {
    return (containsReservedMarker(body) ? sanitizeUserFacingText(body) : body) as unknown as T;
  }
  if (Array.isArray(body)) {
    return body.map((item) => sanitizeResponsePayload(item, depth + 1)) as unknown as T;
  }
  if (typeof body === "object") {
    const source = body as Record<string, unknown>;
    let mutated = false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (SKIP_KEYS.has(key) || typeof value === "string" && value.length > 4000) {
        next[key] = value;
        continue;
      }
      const cleaned = sanitizeResponsePayload(value, depth + 1);
      if (cleaned !== value) mutated = true;
      next[key] = cleaned;
    }
    return (mutated ? next : body) as T;
  }
  return body;
}

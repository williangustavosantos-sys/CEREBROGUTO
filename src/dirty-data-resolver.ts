/**
 * GUTO Dirty Data Resolver
 *
 * Princípio: dado vazio é diferente de dado confuso. O onboarding já tem campos
 * estruturados para idade/altura/objetivo/etc. Apenas três campos são livres e
 * podem chegar sujos:
 *   - country
 *   - trainingPathology / trainingLimitations
 *   - foodRestrictions
 *
 * Este módulo:
 *   1. Chama Gemini UMA vez por edição de perfil (não por turno).
 *   2. Persiste o resultado em memory.resolvedFields.
 *   3. Devolve a próxima dúvida que bloqueia ação, se houver.
 *
 * Sem classes pesadas. Sem regex de palavra-chave. A interpretação é semântica.
 */

import { config } from "./config.js";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type ResolutionStatus =
  | "clear"              // entendi, posso usar
  | "needs_confirmation" // entendi parcialmente, preciso confirmar
  | "unknown"            // não entendi nada, ignoro mas não trato como vazio
  | "risky_unclear";     // entendi que é sensível mas não confiável o bastante

export type FreeField = "country" | "pathology" | "foodRestriction";

export interface ResolvedField {
  field: FreeField;
  rawValue: string;
  rawValueHash: string;        // detectar mudança e re-resolver
  normalizedValue?: string;    // ex: "italy", "milk_allergy"
  possibleMeaning?: string;    // ex: "feijão" para "vergão"
  bodyRegion?: string;         // ex: "knee", "lower_back" (apenas pathology)
  riskTags: string[];          // ex: ["food_unclear", "knee_sensitive"]
  confidence: number;          // 0..1
  status: ResolutionStatus;
  resolvedAt: string;
}

export interface ResolvedProfileFields {
  country?: ResolvedField;
  pathology?: ResolvedField;
  foodRestriction?: ResolvedField;
  /**
   * IDs de campos cuja dúvida o usuário já respondeu (mesmo que ainda
   * needs_confirmation no backend), para não perguntarmos de novo.
   */
  acknowledged?: string[];
}

export interface PendingClarification {
  field: FreeField;
  rawValue: string;
  possibleMeaning?: string;
  status: ResolutionStatus;
  /** Pista para o brain prompt — o GUTO escreve a frase final no idioma do usuário. */
  hint: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashRaw(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function isMeaningful(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // explicitly empty markers
  const lowered = trimmed.toLowerCase();
  if ([
    "sem dor",
    "nenhuma",
    "nada",
    "como de tudo",
    "sem alergia",
    "sem alergias",
    "sem intolerância",
    "sem intolerancia",
    "sem restrição",
    "sem restricao",
    "i eat everything",
    "no allergy",
    "no allergies",
    "no intolerance",
    "no intolerances",
    "no food restriction",
    "no food restrictions",
    "mangio tutto",
    "nessuna allergia",
    "nessuna intolleranza",
    "senza allergie",
    "senza intolleranze",
    "no",
    "none",
    "nessuno",
    "nessuna",
    "ninguna",
  ].includes(lowered)) {
    return false;
  }
  return true;
}

function normalizeForLocalResolution(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveKnownFoodRestrictionLocally(rawValue: string, now: string): ResolvedField | null {
  const normalized = normalizeForLocalResolution(rawValue);
  const normalizedWords = normalized.split(/\s+/).filter(Boolean);
  const hasPattern = (patterns: string[]) =>
    patterns.some((pattern) =>
      pattern.includes(" ")
        ? normalized.includes(pattern)
        : normalizedWords.includes(pattern)
    );
  // Fallback técnico para restrições estruturadas e inequívocas quando o resolver IA
  // estiver indisponível/quota. Não substitui o classificador semântico.
  const lactosePatterns = [
    "sem lactose",
    "zero lactose",
    "intolerancia a lactose",
    "intolerante a lactose",
    "lactose free",
    "no lactose",
    "lactose intolerant",
    "lactose",
    "lattosio",
    "senza lattosio",
    "intolleranza al lattosio",
  ];

  if (hasPattern(lactosePatterns)) {
    return {
      field: "foodRestriction",
      rawValue,
      rawValueHash: hashRaw(rawValue),
      normalizedValue: "lactose_intolerance",
      riskTags: ["intolerance"],
      confidence: 0.95,
      status: "clear",
      resolvedAt: now,
    };
  }

  const fishAndSeafoodPatterns = [
    "nao como peixe",
    "não como peixe",
    "sem peixe",
    "alergia a peixe",
    "alergico a peixe",
    "alérgico a peixe",
    "peixe",
    "fish",
    "no fish",
    "senza pesce",
    "pesce",
    "frutos do mar",
    "marisco",
    "camarão",
    "camarao",
    "shrimp",
    "seafood",
    "shellfish",
    "frutti di mare",
    "gamberi",
  ];

  if (hasPattern(fishAndSeafoodPatterns)) {
    return {
      field: "foodRestriction",
      rawValue,
      rawValueHash: hashRaw(rawValue),
      normalizedValue: "fish_seafood_restriction",
      riskTags: ["food_restriction"],
      confidence: 0.9,
      status: "clear",
      resolvedAt: now,
    };
  }

  const eggPatterns = [
    "nao como ovo",
    "não como ovo",
    "sem ovo",
    "alergia a ovo",
    "alergico a ovo",
    "alérgico a ovo",
    "ovo",
    "egg",
    "no egg",
    "uovo",
    "uova",
    "senza uovo",
    "senza uova",
  ];

  if (hasPattern(eggPatterns)) {
    return {
      field: "foodRestriction",
      rawValue,
      rawValueHash: hashRaw(rawValue),
      normalizedValue: "egg_restriction",
      riskTags: ["food_restriction"],
      confidence: 0.9,
      status: "clear",
      resolvedAt: now,
    };
  }

  return null;
}

/**
 * Fallback `needs_confirmation` para patologia declarada na calibragem
 * quando nem o classificador IA nem o resolver local conseguiram
 * normalizar o texto.
 *
 * Princípios (Santo Graal §3):
 *  - Regra 1 — GUTO não executa sem certeza: o gate continua bloqueando
 *    treino até que o usuário CONFIRME no chat o que escreveu.
 *  - Regra 3 — sem "se X então Y": não marcamos `clear` automático nem
 *    inferimos região anatômica; deixamos o `pendingClarification`
 *    gerar uma pergunta dirigida ("Confere comigo: 'X' está atual?").
 *
 * O `safetyFilterWorkoutPlan` continua aplicando precauções gerais
 * enquanto o status fica `needs_confirmation` (tag `user_declared`).
 */
function buildUserDeclaredPathology(rawValue: string, now: string): ResolvedField {
  return {
    field: "pathology",
    rawValue,
    rawValueHash: hashRaw(rawValue),
    riskTags: ["user_declared", "physical_attention"],
    confidence: 0.4,
    status: "needs_confirmation",
    resolvedAt: now,
  };
}

export function resolveKnownPathologyLocally(rawValue: string, now: string): ResolvedField | null {
  const normalized = normalizeForLocalResolution(rawValue);
  const noLimitationPatterns = [
    "sem dor",
    "sem dores",
    "sem limitacao",
    "sem limitacoes",
    "estou livre",
    "no pain",
    "pain free",
    "no limitations",
    "non ho dolori",
    "senza dolori",
    "nessun dolore",
    "nessuna",
  ];

  if (noLimitationPatterns.some((pattern) => normalized.includes(pattern))) {
    return {
      field: "pathology",
      rawValue,
      rawValueHash: hashRaw(rawValue),
      normalizedValue: "no_limitation",
      bodyRegion: "general",
      riskTags: [],
      confidence: 0.95,
      status: "clear",
      resolvedAt: now,
    };
  }

  const shoulderPatterns = [
    "ombro",
    "shoulder",
    "spalla",
    "empurrar",
    "push",
    "spingere",
  ];
  if (shoulderPatterns.some((pattern) => normalized.includes(pattern))) {
    return {
      field: "pathology",
      rawValue,
      rawValueHash: hashRaw(rawValue),
      normalizedValue: "shoulder_sensitive",
      bodyRegion: "shoulder",
      riskTags: ["physical_attention", "shoulder_sensitive", "load_sensitive"],
      confidence: 0.9,
      status: "clear",
      resolvedAt: now,
    };
  }

  const kneePatterns = ["joelho", "knee", "ginocchio"];
  if (kneePatterns.some((pattern) => normalized.includes(pattern))) {
    return {
      field: "pathology",
      rawValue,
      rawValueHash: hashRaw(rawValue),
      normalizedValue: "knee_sensitive",
      bodyRegion: "knee",
      riskTags: ["physical_attention", "knee_sensitive", "load_sensitive"],
      confidence: 0.9,
      status: "clear",
      resolvedAt: now,
    };
  }

  // Dor genérica de perna / lower body: esclarecimento VÁLIDO (ex.: "tenho dor
  // nas pernas"). Normaliza conservadoramente protegendo as articulações de
  // carga da perna — joelho + quadril + tornozelo. filterExercisesBySafety
  // deriva a região canônica de cada riskTag, então cobrimos as três.
  const lowerBodyPatterns = [
    "perna", "pernas", "leg", "legs", "gamba", "gambe",
    "coxa", "coxas", "quadriceps", "posterior de coxa",
    "panturrilha", "panturrilhas", "membros inferiores", "lower body",
  ];
  if (lowerBodyPatterns.some((pattern) => normalized.includes(pattern))) {
    return {
      field: "pathology",
      rawValue,
      rawValueHash: hashRaw(rawValue),
      normalizedValue: "lower_body_sensitive",
      bodyRegion: "knee",
      riskTags: ["physical_attention", "load_sensitive", "knee", "hip", "ankle"],
      confidence: 0.85,
      status: "clear",
      resolvedAt: now,
    };
  }

  // Coluna / lombar: protege carga axial e quadril.
  const lowerBackPatterns = [
    "coluna", "lombar", "lombalgia", "hernia de disco", "hernia",
    "lower back", "schiena", "spine",
  ];
  if (lowerBackPatterns.some((pattern) => normalized.includes(pattern))) {
    return {
      field: "pathology",
      rawValue,
      rawValueHash: hashRaw(rawValue),
      normalizedValue: "lower_back_sensitive",
      bodyRegion: "lower_back",
      riskTags: ["physical_attention", "load_sensitive", "lower_back", "hip"],
      confidence: 0.85,
      status: "clear",
      resolvedAt: now,
    };
  }

  return null;
}

function buildResolverPrompt(input: {
  country: string | null;
  pathology: string | null;
  foodRestriction: string | null;
}): string {
  return `You are a strict semantic classifier. Three free-text fields from a fitness app onboarding need to be normalized.

Do NOT use keyword lists. Reason semantically. If a field is empty, return null for it. NEVER invent meaning if uncertain — return status="unknown".

INPUT:
- country (where the user lives): ${input.country === null ? "null" : JSON.stringify(input.country)}
- pathology (pain / limitation / health condition affecting training): ${input.pathology === null ? "null" : JSON.stringify(input.pathology)}
- foodRestriction (allergy / intolerance / food the user does not eat): ${input.foodRestriction === null ? "null" : JSON.stringify(input.foodRestriction)}

For EACH non-null input return an object with these keys:
- rawValue: echo the input verbatim
- normalizedValue: a stable lowercase identifier (country: ISO-style "italy"|"brazil"|"spain"|"portugal"|"usa"|"uk"|"germany"|"france"|"argentina" etc; pathology: snake_case like "knee_pain" or "lower_back_pain"; foodRestriction: snake_case like "lactose_intolerance" or "peanut_allergy" or "no_beans"). Omit if you cannot decide.
- possibleMeaning: human-readable best guess only if it differs from the raw text or you suspect a typo (e.g. "Itlaia" → "Italy", "vergão" → "feijão"). Omit otherwise.
- bodyRegion: ONLY for pathology. One of: "knee" | "ankle" | "hip" | "lower_back" | "upper_back" | "shoulder" | "elbow" | "wrist" | "neck" | "chest" | "abdomen" | "general" | null.
- riskTags: short list of stable tags. Examples: country=[]; pathology=["physical_attention","cardio_sensitive","load_sensitive","balance_sensitive"]; foodRestriction=["food_unclear","allergy","intolerance","dietary_choice"].
- confidence: 0..1. Use 0.9+ only when the meaning is unambiguous.
- status: "clear" | "needs_confirmation" | "unknown" | "risky_unclear"
    * clear: confidence >= 0.85 and no safety concern
    * needs_confirmation: plausible interpretation but not certain (typos, ambiguous foods)
    * unknown: cannot interpret at all
    * risky_unclear: relates to physical/cardiac/medical risk OR allergy AND not fully clear

Rules:
- "dor no peito quando corro" → pathology, bodyRegion="chest", riskTags=["cardio_sensitive","physical_risk"], status="risky_unclear".
- "alergia a amendoim" → foodRestriction, normalizedValue="peanut_allergy", riskTags=["allergy"], status="clear".
- "vergão" → foodRestriction, possibleMeaning="feijão", riskTags=["food_unclear"], status="needs_confirmation".
- "Itlaia" → country, normalizedValue="italy", possibleMeaning="Italy", status="clear" (typo is obvious).
- "joelho ruim" → pathology, bodyRegion="knee", riskTags=["load_sensitive"], status="clear".

Return STRICTLY this JSON shape, with null for missing inputs:
{"country": <obj|null>, "pathology": <obj|null>, "foodRestriction": <obj|null>}
No prose, no markdown.`;
}

// ─── Gemini call ──────────────────────────────────────────────────────────────

async function callResolverModel(prompt: string, timeoutMs = 8000): Promise<unknown> {
  const apiKey = config.geminiApiKey;
  const model = config.geminiModel;
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface FreeFieldsInput {
  country?: string | null | undefined;
  pathology?: string | null | undefined;       // mapped from trainingPathology / trainingLimitations
  foodRestriction?: string | null | undefined; // mapped from foodRestrictions
  /** Previously resolved fields, to skip Gemini if rawValue did not change. */
  previous?: ResolvedProfileFields;
}

/**
 * Resolve the three free fields. Skips fields whose rawValue did not change
 * since the last resolution (cache by hash). Returns the merged result.
 *
 * On any error / no API key, returns the previous resolved fields untouched.
 * NEVER throws — dirty data must not break the profile save.
 */
export async function resolveProfileFreeFields(
  input: FreeFieldsInput
): Promise<ResolvedProfileFields> {
  const previous = input.previous ?? {};

  const country = isMeaningful(input.country) ? String(input.country).trim() : null;
  const pathology = isMeaningful(input.pathology) ? String(input.pathology).trim() : null;
  const foodRestriction = isMeaningful(input.foodRestriction)
    ? String(input.foodRestriction).trim()
    : null;

  // Decide which fields actually need resolution.
  const needsCountry = country !== null && previous.country?.rawValueHash !== hashRaw(country);
  const needsPathology = pathology !== null && previous.pathology?.rawValueHash !== hashRaw(pathology);
  const needsFood = foodRestriction !== null && previous.foodRestriction?.rawValueHash !== hashRaw(foodRestriction);

  // Drop previous resolutions for fields the user emptied.
  const merged: ResolvedProfileFields = {
    country: country === null ? undefined : previous.country,
    pathology: pathology === null ? undefined : previous.pathology,
    foodRestriction: foodRestriction === null ? undefined : previous.foodRestriction,
    acknowledged: previous.acknowledged,
  };

  if (!needsCountry && !needsPathology && !needsFood) {
    return merged;
  }

  const now = new Date().toISOString();
  const result = (await callResolverModel(
    buildResolverPrompt({
      country: needsCountry ? country : null,
      pathology: needsPathology ? pathology : null,
      foodRestriction: needsFood ? foodRestriction : null,
    })
  )) as Record<string, unknown> | null;

  if (!result || typeof result !== "object") {
    if (needsPathology && pathology) {
      // Patologia: campo estrutural da calibragem. Se nem o IA nem o resolver
      // local entenderam, registramos como `needs_confirmation` (Regra 1:
      // GUTO pergunta antes de executar). Isso garante que o gate de treino
      // emita uma pergunta dirigida ("Confere comigo: 'X' está atual?")
      // em vez de travar mudo.
      const localPathology = resolveKnownPathologyLocally(pathology, now);
      merged.pathology = localPathology || buildUserDeclaredPathology(pathology, now);
    }
    if (needsFood && foodRestriction) {
      // foodRestriction: pode vir lixo (ex.: "nessun dolore" vazado).
      // Só promovemos quando o resolver local reconhece um padrão alimentar
      // estruturado. Caso contrário deixamos undefined — o gate de dieta
      // usa `getUnresolvedFoodRestriction` no server.ts para perguntar.
      const localFood = resolveKnownFoodRestrictionLocally(foodRestriction, now);
      if (localFood) merged.foodRestriction = localFood;
    }
    return merged;
  }

  if (needsCountry) {
    const r = sanitizeField(result.country, "country", country!, now);
    if (r) merged.country = r;
  }
  if (needsPathology) {
    const r =
      sanitizeField(result.pathology, "pathology", pathology!, now) ||
      resolveKnownPathologyLocally(pathology!, now) ||
      buildUserDeclaredPathology(pathology!, now);
    merged.pathology = r;
  }
  if (needsFood) {
    const r =
      sanitizeField(result.foodRestriction, "foodRestriction", foodRestriction!, now) ||
      resolveKnownFoodRestrictionLocally(foodRestriction!, now);
    if (r) merged.foodRestriction = r;
  }

  // Reset acknowledgements for fields whose raw value changed.
  if (merged.acknowledged?.length) {
    const stillResolved = new Set<string>();
    if (merged.country) stillResolved.add(buildAckKey(merged.country));
    if (merged.pathology) stillResolved.add(buildAckKey(merged.pathology));
    if (merged.foodRestriction) stillResolved.add(buildAckKey(merged.foodRestriction));
    merged.acknowledged = merged.acknowledged.filter((k) => stillResolved.has(k));
  }

  return merged;
}

function sanitizeField(
  raw: unknown,
  field: FreeField,
  rawValue: string,
  now: string
): ResolvedField | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = normalizeStatus(r.status);
  const confidence = clampNumber(r.confidence, 0, 1) ?? 0.5;
  const tags = Array.isArray(r.riskTags)
    ? r.riskTags.filter((t): t is string => typeof t === "string").slice(0, 8)
    : [];
  return {
    field,
    rawValue,
    rawValueHash: hashRaw(rawValue),
    normalizedValue: typeof r.normalizedValue === "string" ? r.normalizedValue : undefined,
    possibleMeaning: typeof r.possibleMeaning === "string" ? r.possibleMeaning : undefined,
    bodyRegion: field === "pathology" && typeof r.bodyRegion === "string" ? r.bodyRegion : undefined,
    riskTags: tags,
    confidence,
    status,
    resolvedAt: now,
  };
}

function normalizeStatus(value: unknown): ResolutionStatus {
  if (value === "clear" || value === "needs_confirmation" || value === "unknown" || value === "risky_unclear") {
    return value;
  }
  return "unknown";
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, value));
}

function buildAckKey(field: ResolvedField): string {
  return `${field.field}:${field.rawValueHash}`;
}

// ─── Clarity gate ─────────────────────────────────────────────────────────────

/**
 * Returns the next pending clarification, if any, OR null.
 *
 * Rules:
 *   - one question at a time (priority: foodRestriction → pathology → country);
 *   - skip fields the user already acknowledged;
 *   - skip "clear";
 *   - unknown only blocks fields that directly affect safety/action.
 *   - "needs_confirmation" always asks;
 *   - "risky_unclear" only asks if blocking the next action requested.
 */
export function getPendingClarification(
  resolved: ResolvedProfileFields | undefined,
  context: "training" | "diet" | "chat" = "chat"
): PendingClarification | null {
  if (!resolved) return null;
  const ack = new Set(resolved.acknowledged ?? []);

  const order: ResolvedField[] = [];
  if (context === "diet" && resolved.foodRestriction) order.push(resolved.foodRestriction);
  if (resolved.pathology) order.push(resolved.pathology);
  if (resolved.foodRestriction && context !== "diet") order.push(resolved.foodRestriction);
  if (resolved.country) order.push(resolved.country);

  for (const field of order) {
    if (ack.has(buildAckKey(field))) continue;
    if (field.status === "clear") continue;
    if (
      field.status === "unknown" &&
      !(
        (context === "training" && field.field === "pathology") ||
        (context === "diet" && field.field === "foodRestriction")
      )
    ) continue;

    // risky_unclear only asks if directly relevant
    if (field.status === "risky_unclear") {
      const relevant =
        (context === "training" && field.field === "pathology") ||
        (context === "diet" && (field.field === "foodRestriction" || field.field === "pathology"));
      if (!relevant) continue;
    }

    return {
      field: field.field,
      rawValue: field.rawValue,
      possibleMeaning: field.possibleMeaning,
      status: field.status,
      hint: buildHint(field),
    };
  }
  return null;
}

function buildHint(field: ResolvedField): string {
  switch (field.field) {
    case "foodRestriction":
      if (field.status === "risky_unclear") {
        return `The user's food restriction "${field.rawValue}" looks safety-sensitive but is not fully clear. Confirm gently in one sentence — never assume safety.`;
      }
      if (field.status === "unknown") {
        return `The user wrote "${field.rawValue}" as something they do not eat, but the system could not understand it. Ask one short question before generating any diet.`;
      }
      return `The user wrote "${field.rawValue}" as a food they do not eat. ${
        field.possibleMeaning
          ? `It might mean "${field.possibleMeaning}" — ask in one short sentence to confirm.`
          : "Ask in one short sentence what that means, in their own words."
      }`;
    case "pathology":
      if (field.status === "risky_unclear") {
        return `The user reported "${field.rawValue}" which looks physically sensitive (possibly cardiac/load-sensitive). Acknowledge it and ask one short clarifying question — pain? movement limitation? instability?`;
      }
      if (field.status === "unknown") {
        return `The user reported "${field.rawValue}" as a body limitation, but the system could not understand it. Ask one short question before generating any workout.`;
      }
      return `The user reported "${field.rawValue}" as a body limitation. Ask one short clarifying question to understand whether it is pain, range-of-motion or instability before training.`;
    case "country":
      return `The user wrote "${field.rawValue}" as country of residence. ${
        field.possibleMeaning ? `Did they mean "${field.possibleMeaning}"? Confirm in one short sentence.` : "Ask once which country."
      }`;
  }
}

// ─── Conservative mode ────────────────────────────────────────────────────────

/**
 * If a clarification is pending and the user has not answered yet, the system
 * should still serve a result — but conservatively. This helper says whether
 * the engine should hold back intensity / avoid ambiguous foods etc.
 */
export function shouldEnterConservativeMode(
  resolved: ResolvedProfileFields | undefined,
  context: "training" | "diet"
): boolean {
  if (!resolved) return false;
  const fields = [resolved.pathology, resolved.foodRestriction];
  for (const f of fields) {
    if (!f) continue;
    if (f.status === "risky_unclear") return true;
    if (f.status === "needs_confirmation" && context === "diet" && f.field === "foodRestriction") return true;
    if (f.status === "needs_confirmation" && context === "training" && f.field === "pathology") return true;
  }
  return false;
}

// ─── Acknowledgement ──────────────────────────────────────────────────────────

/**
 * Mark a clarification as acknowledged once the user has replied to it.
 * Called from the chat pipeline when the model emits memoryPatch.acknowledgeClarification.
 */
export function acknowledgeClarification(
  resolved: ResolvedProfileFields | undefined,
  field: FreeField
): ResolvedProfileFields {
  const next: ResolvedProfileFields = { ...(resolved ?? {}) };
  const target =
    field === "country" ? next.country :
    field === "pathology" ? next.pathology :
    next.foodRestriction;
  if (!target) return next;
  const key = buildAckKey(target);
  const acknowledged = new Set(next.acknowledged ?? []);
  acknowledged.add(key);
  next.acknowledged = Array.from(acknowledged);
  return next;
}

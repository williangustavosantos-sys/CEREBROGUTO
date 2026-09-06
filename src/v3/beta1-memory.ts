import { V3Error } from "./errors.js";
import type { ActorContext } from "./types.js";

/**
 * BETA1 curated persistent memory (OKF-derived patterns, Postgres-authoritative).
 *
 * - Typed memory: closed category domain + stable semantic key.
 * - Provenance: every memory carries source_type + source_request_id.
 * - Lifecycle: ACTIVE / SUPERSEDED / RETRACTED (STALE is Beta 2).
 * - Supersession: the user is the authority over their own declared facts; a
 *   new declaration on the same category+key supersedes (never coexists with)
 *   the previous ACTIVE memory.
 * - The LLM never writes memory freely: this deterministic parser proposes
 *   candidates ONLY from explicit user declarations over a closed pattern set;
 *   the backend decides what persists (strict schema + policy).
 * - Memory is NOT a transcript: vague phrases never become durable memory.
 * - Content is DATA, never instruction: values are validated enums, never
 *   free text promoted into prompts.
 */

export const MEMORY_CATEGORIES = [
  "IDENTITY",
  "TRAINING_PREFERENCES",
  "TRAINING_ENVIRONMENT",
  "TRAINING_LIMITATIONS",
  "ROUTINE",
  "FOOD_PREFERENCES",
  "TRAINING_LEARNINGS",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type MemorySourceType =
  | "conversation"
  | "first_contact"
  | "workout_execution"
  | "food_swap"
  | "explicit_profile_edit"
  | "system_derived";

export type MemoryStatus = "ACTIVE" | "SUPERSEDED" | "RETRACTED";

export interface CuratedMemoryCandidate {
  category: MemoryCategory;
  key: string;
  value: Record<string, unknown>;
  confidence: "explicit" | "derived";
}

export interface PersistedMemory {
  id: string;
  tenantId: string;
  userId: string;
  category: MemoryCategory;
  key: string;
  value: Record<string, unknown>;
  status: MemoryStatus;
  confidence: string;
  sourceType: MemorySourceType;
  sourceRequestId: string | null;
  sourceEventId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt: string;
  supersedesId: string | null;
}

export interface RelevantMemorySnapshot {
  queryKind: "workout" | "diet" | "chat";
  memories: Array<Pick<PersistedMemory, "id" | "category" | "key" | "value" | "status" | "sourceType" | "updatedAt">>;
}

// ─── Deterministic curation (explicit declarations ONLY) ─────────────────────

const CARDIO_KEYS: ReadonlyArray<[RegExp, string]> = [
  [/\bbiciclet|bike|cycl/iu, "bike"],
  [/\besteira|treadmill|tapis/iu, "treadmill"],
  [/\bcorrid|running|run\b|caminhad|walk/iu, "walking_running"],
  [/\bel[ií]ptic|elliptical/iu, "elliptical"],
  [/\bremo|rowing|row\b/iu, "rowing"],
  [/\bpular corda|jump rope|rope skip/iu, "jump_rope"],
  [/\bnadar|swim/iu, "swimming"],
];

const BODY_REGIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bjoelho|knee/iu, "knee"],
  [/\b(lombar|lower\s?back)/iu, "lower_back"],
  [/\bombro|shoulder/iu, "shoulder"],
  [/\btornozel|ankle/iu, "ankle"],
  [/\bpunho|wrist/iu, "wrist"],
  [/\bcoluna|spine|neck|pesco[çc]o/iu, "spine"],
  [/\bquadril|hip\b/iu, "hip"],
  [/\bcotovelo|elbow/iu, "elbow"],
];

const EQUIPMENT_KEYS: ReadonlyArray<[RegExp, string]> = [
  [/\bhack\s?squat|hacks?\b/iu, "hack_squat"],
  [/\bsmith/iu, "smith_machine"],
  [/\bleg\s?press|legpress/iu, "leg_press"],
  [/\bpoli(o|a)|cable/iu, "cable_station"],
  [/\bel[ií]ptic|elliptical/iu, "elliptical"],
  [/\bremo|rowing machine/iu, "rowing_machine"],
];

function normalized(message: string): string {
  return message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
}

/** Fails the mutation when a curated candidate violates the closed domain. */
export function assertCuratedMemoryCandidate(candidate: CuratedMemoryCandidate): void {
  if (!MEMORY_CATEGORIES.includes(candidate.category)) {
    throw new V3Error("V3_MEMORY_CATEGORY_INVALID", "Categoria de memória inválida.", 409);
  }
  if (!candidate.key.trim() || candidate.key.length > 96) {
    throw new V3Error("V3_MEMORY_KEY_INVALID", "Chave de memória inválida.", 409);
  }
  if (!candidate.value || Array.isArray(candidate.value) || typeof candidate.value !== "object") {
    throw new V3Error("V3_MEMORY_VALUE_INVALID", "Estrutura de memória inválida.", 409);
  }
}

/**
 * Deterministic curation from a user turn. Only EXPLICIT declarations over a
 * closed pattern set become durable memory. Returns candidates; persistence is
 * decided by the repository (schema + policy), never by the model.
 */
export function resolveCuratedMemoryCandidates(message: string): CuratedMemoryCandidate[] {
  const text = normalized(message);
  const candidates: CuratedMemoryCandidate[] = [];

  // ── Cardio preference (like/dislike, explicit) ──
  const likesList: string[] = [];
  const dislikesList: string[] = [];
  const likeMatch = /(?:gosto de|curto|prefiro|amo|comecei a gostar de|adoro)\s+(.{0,60})/u.exec(text);
  const dislikeMatch = /(?:odeio|nao gosto de|nao curto|detesto|nao quero|evito)\s+(.{0,60})/u.exec(text);
  const scanWindow = (window: string, target: string[]) => {
    for (const [pattern, key] of CARDIO_KEYS) {
      if (pattern.test(window)) target.push(key);
    }
  };
  if (likeMatch?.[1]) scanWindow(likeMatch[1], likesList);
  if (dislikeMatch?.[1]) scanWindow(dislikeMatch[1], dislikesList);
  // "Prefiro X a Y" / "prefiro X do que Y" — direct A-over-B preference.
  const preferMatch = /prefiro\s+(.{2,40}?)\s+(?:a|do que|em vez de|no lugar de)\s+(.{2,40})/u.exec(text);
  if (preferMatch) {
    const preferred: string[] = [];
    const avoided: string[] = [];
    scanWindow(preferMatch[1], preferred);
    scanWindow(preferMatch[2], avoided);
    if (preferred[0] && avoided[0] && preferred[0] !== avoided[0]) {
      candidates.push({
        category: "TRAINING_PREFERENCES",
        key: "preferred_cardio",
        value: { preferred: preferred[0], avoided: avoided[0], declaration: message.trim() },
        confidence: "explicit",
      });
    }
  }
  if (likesList.length > 0) {
    candidates.push({
      category: "TRAINING_PREFERENCES",
      key: "liked_cardio",
      value: { liked: likesList, declaration: message.trim() },
      confidence: "explicit",
    });
  }
  if (dislikesList.length > 0) {
    candidates.push({
      category: "TRAINING_PREFERENCES",
      key: "disliked_cardio",
      value: { disliked: dislikesList, declaration: message.trim() },
      confidence: "explicit",
    });
  }

  // ── Equipment availability (environment) ──
  const lacksMatch = /(?:minha academia |a academia |aqui )?(?:nao tem|nao possui|nao disponivel|sem|falta de?)\s+(.{0,50})/u.exec(text);
  // Positive availability must NOT fire inside a negation ("não tem" contains
  // "tem") — lookbehind rejects a negated verb so both truths never persist.
  const nowHasMatch = /(?:agora |trocaram os aparelhos e |a academia agora )?(?<!nao )(?:tem|possui|instalaram)\s+(.{0,50})/u.exec(text);
  const scanEquipment = (window: string): string[] => {
    const found: string[] = [];
    for (const [pattern, key] of EQUIPMENT_KEYS) {
      if (pattern.test(window)) found.push(key);
    }
    return found;
  };
  if (lacksMatch?.[1]) {
    const missing = scanEquipment(lacksMatch[1]);
    for (const equipmentKey of missing) {
      candidates.push({
        category: "TRAINING_ENVIRONMENT",
        key: `equipment_missing_${equipmentKey}`,
        value: { equipment: equipmentKey, available: false, declaration: message.trim() },
        confidence: "explicit",
      });
    }
  }
  if (nowHasMatch?.[1]) {
    const available = scanEquipment(nowHasMatch[1]);
    for (const equipmentKey of available) {
      candidates.push({
        category: "TRAINING_ENVIRONMENT",
        key: `equipment_missing_${equipmentKey}`,
        value: { equipment: equipmentKey, available: true, declaration: message.trim() },
        confidence: "explicit",
      });
    }
  }

  // ── Dumbbells max weight (environment) ──
  const dumbbell = /halter(?:es)?\D{0,20}(\d{1,3})\s*kg/u.exec(text);
  if (dumbbell) {
    const weight = Number(dumbbell[1]);
    if (weight >= 1 && weight <= 100) {
      candidates.push({
        category: "TRAINING_ENVIRONMENT",
        key: "dumbbell_max_kg",
        value: { maxKg: weight, declaration: message.trim() },
        confidence: "explicit",
      });
    }
  }

  // ── Training limitations (pain/discomfort by body region) ──
  for (const [pattern, region] of BODY_REGIONS) {
    const regionHit = pattern.exec(text);
    if (!regionHit) continue;
    const painVerbs = /(?:do[ée]|doendo|dor|dolor|incomod|machuc|lesion|pinic)/iu;
    const negativeVerbs = /(?:nao posso|nao devo|evitar|evito|nao faco)/iu;
    if (painVerbs.test(text) || negativeVerbs.test(text)) {
      candidates.push({
        category: "TRAINING_LIMITATIONS",
        key: `body_region_${region}`,
        value: { bodyRegion: region, declaration: message.trim() },
        confidence: "explicit",
      });
      break;
    }
  }

  // ── Routine (usual training time) ──
  const routineMatch = /(?:treino sempre|treino normal|sempre treino|costumo treinar|treino)\D{0,12}(?:as|às|a\s|de)\s*(\d{1,2})(?:\D{0,4}(\d{2}))?/u.exec(text);
  if (routineMatch) {
    const hour = Number(routineMatch[1]);
    if (hour >= 0 && hour <= 23) {
      const minute = routineMatch[2] ? Number(routineMatch[2]) : 0;
      const period = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
      candidates.push({
        category: "ROUTINE",
        key: "usual_training_time",
        value: { hour, minute, period, declaration: message.trim() },
        confidence: "explicit",
      });
    }
  }

  // ── Food dislikes (explicit) ──
  const foodDislike = /(?:odeio|detesto|nao como|nao gosto de|nao quero)\s+(.{0,40})/u.exec(text);
  if (foodDislike?.[1]) {
    const food = foodDislike[1].replace(/[^a-z\u00e0-\u017f\s]/gu, "").trim();
    if (food.length >= 3 && food.split(/\s+/).length <= 3) {
      candidates.push({
        category: "FOOD_PREFERENCES",
        key: "disliked_food",
        value: { dislikedFood: food, declaration: message.trim() },
        confidence: "explicit",
      });
    }
  }

  return candidates;
}

/**
 * Provenance is mandatory for non-official-table memories: the source type and
 * (when available) the request id are required to build an auditable memory.
 */
export function assertMemoryProvenance(sourceType: MemorySourceType, requestId: string): void {
  if (!requestId.trim()) {
    throw new V3Error("V3_MEMORY_PROVENANCE_REQUIRED", "Provenance da memória é obrigatória.", 409);
  }
  if (![
    "conversation",
    "first_contact",
    "workout_execution",
    "food_swap",
    "explicit_profile_edit",
    "system_derived",
  ].includes(sourceType)) {
    throw new V3Error("V3_MEMORY_SOURCE_INVALID", "Origem de memória inválida.", 409);
  }
}

/** Deterministic, bounded, category-scoped retrieval plan for a turn. */
export function memoryCategoriesForQuery(queryKind: RelevantMemorySnapshot["queryKind"]): MemoryCategory[] {
  switch (queryKind) {
    case "workout":
      return [
        "TRAINING_PREFERENCES",
        "TRAINING_ENVIRONMENT",
        "TRAINING_LIMITATIONS",
        "ROUTINE",
        "TRAINING_LEARNINGS",
      ];
    case "diet":
      return ["FOOD_PREFERENCES", "TRAINING_LIMITATIONS"];
    case "chat":
    default:
      return [
        "TRAINING_LIMITATIONS",
        "TRAINING_PREFERENCES",
        "TRAINING_ENVIRONMENT",
        "TRAINING_LEARNINGS",
        "ROUTINE",
        "FOOD_PREFERENCES",
      ];
  }
}

export const RELEVANT_MEMORY_LIMIT = 12;

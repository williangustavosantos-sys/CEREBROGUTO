// Tipos do GUTO Active Presence Engine — Sprint 1

// ─── Sinais extraídos pelo Gemini ─────────────────────────────────────────────

export type SignalType =
  | "health_limitation"
  | "future_event"
  | "preference_block"
  | "weak_signal"
  | "location_shift"
  | "completion_signal"
  | "routine_signal";

export type DetectedLanguage = "pt" | "en" | "it" | "es" | "mixed";

export interface ExtractedSignal {
  type: SignalType;
  value: string;
  raw_phrase: string;
  confidence: number;
  language_detected: DetectedLanguage;
  needs_user_validation: boolean;
  date_text?: string;
  body_part?: string;
  meta?: Record<string, unknown>;
}

// ─── Contexto persistido no Context Bank ──────────────────────────────────────

export type ContextType =
  | "health_signal"
  | "future_event"
  | "preference_signal"
  | "weak_signal"
  | "location_signal"
  | "routine_signal";

export type ContextState =
  | "validated"
  | "active"
  | "needs_validation"
  | "hypothesis"
  | "blocked_unknown"
  | "cooldown"
  | "archived";

export type ContextSource = "extractor" | "user_explicit" | "coach_inferred";

export interface ContextItemMeta {
  originalType: SignalType | string;
  language: DetectedLanguage | string;
  dateText: string | null;
  bodyPart: string | null;
  needsUserValidation: boolean;
  extractor: string;
  [key: string]: unknown;
}

export interface ContextItem {
  id: string;
  userId: string;
  type: ContextType;
  value: string;
  state: ContextState;
  confidence: number;
  source: ContextSource;
  rawPhrase: string;
  meta: ContextItemMeta;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
  cooldownUntil?: string | null;
  expiresAt?: string | null;
}

// ─── Resultado da extração ───────────────────────────────────────────────────

export interface ExtractionResult {
  signals: ExtractedSignal[];
  raw?: string;
  error?: string;
}

// ─── Validation Queue ─────────────────────────────────────────────────────────
// A fila impede que dado confuso vire ação. GUTO pergunta primeiro, usa depois.

export type ValidationQueueStatus =
  | "pending"
  | "asked"
  | "resolved"
  | "dismissed"
  | "expired";

export type ValidationReason =
  | "blocked_unknown"
  | "needs_validation"
  | "health_safety_check"
  | "future_event_check";

export type ValidationObjective =
  | "clarify_unknown_term"
  | "confirm_health_signal"
  | "confirm_user_context"
  | "confirm_future_event";

export type ValidationResolution =
  | "confirmed"
  | "rejected"
  | "clarified"
  | "ignored";

export interface ValidationQueueItem {
  id: string;
  userId: string;
  contextItemId: string;
  contextType: ContextType;
  contextValue: string;
  rawPhrase: string;
  reason: ValidationReason;
  status: ValidationQueueStatus;
  priority: number;
  language: DetectedLanguage;
  attempts: number;
  askAfter: string;
  createdAt: string;
  updatedAt: string;
  askedAt?: string | null;
  resolvedAt?: string | null;
  expiresAt?: string | null;
  meta?: Record<string, unknown>;
}

export interface ValidationBrief {
  objective: ValidationObjective;
  reason: ValidationReason;
  target: {
    contextItemId: string;
    contextType: ContextType;
    contextValue: string;
    rawPhrase: string;
    bodyPart: string | null;
  };
  user: {
    language: DetectedLanguage;
  };
  facts: {
    mustConfirm: string[];
    mustAvoid: string[];
  };
  style: {
    mode: "clarify" | "care" | "confirm";
    maxSentences: number;
    allowMedicalAdvice: false;
  };
}

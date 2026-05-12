// Mapeia sinais extraídos para Context Items persistidos

import { addContextItem, isDuplicate } from "./context-bank";
import { syncValidationQueue } from "./validation-engine";
import type { ContextState, ContextType, ExtractedSignal } from "./types";

// ─── Mapeamento de tipo de sinal para tipo de contexto ────────────────────────

const SIGNAL_TO_CONTEXT_TYPE: Record<ExtractedSignal["type"], ContextType | null> = {
  health_limitation: "health_signal",
  future_event: "future_event",
  preference_block: "preference_signal",
  weak_signal: "weak_signal",
  location_shift: "location_signal",
  routine_signal: "routine_signal",
  completion_signal: null,
};

// ─── Thresholds por contexto ──────────────────────────────────────────────────
// Saúde é liability. Threshold mais alto e nunca vira dado validado sozinho.

const CONFIDENCE_THRESHOLDS: Record<ContextType, number> = {
  health_signal: 0.7,
  future_event: 0.5,
  preference_signal: 0.5,
  weak_signal: 0.5,
  location_signal: 0.5,
  routine_signal: 0.5,
};

function getThreshold(contextType: ContextType): number {
  return CONFIDENCE_THRESHOLDS[contextType] ?? 0.5;
}

// ─── Detecta termo desconhecido específico ────────────────────────────────────
// Não usa blocked_unknown como lixeira genérica. Só quando há termo de preferência
// que o extrator explicitamente não conseguiu normalizar com confiança.

export function isUnknownTerm(signal: ExtractedSignal): boolean {
  if (signal.type !== "preference_block") return false;
  if (!signal.needs_user_validation) return false;
  if (signal.confidence >= 0.6) return false;

  const value = signal.value.trim().toLowerCase();
  const raw = signal.raw_phrase.trim().toLowerCase();

  if (value.length <= 3) return true;
  if (value === raw) return true;

  return false;
}

// ─── Determina estado do contexto ─────────────────────────────────────────────

export function resolveContextState(
  signal: ExtractedSignal,
  contextType: ContextType
): ContextState | null {
  if (isUnknownTerm(signal)) return "blocked_unknown";

  // Saúde: nunca pula direto para active/validated. GUTO pergunta antes.
  if (contextType === "health_signal") {
    if (signal.confidence >= 0.85) return "needs_validation";
    if (signal.confidence >= getThreshold(contextType)) return "hypothesis";
    return null;
  }

  const threshold = getThreshold(contextType);

  if (signal.confidence >= 0.9 && !signal.needs_user_validation) {
    return "validated";
  }

  if (signal.confidence >= threshold && signal.needs_user_validation) {
    return "needs_validation";
  }

  if (signal.confidence >= threshold) {
    return "active";
  }

  return null;
}

function defaultExpiresAt(signal: ExtractedSignal): string | null {
  // Sprint 1: ainda não parseia datas naturais. Eventos ficam vivos por 14 dias
  // para serem tratados pela validation-engine futura.
  if (signal.type === "future_event") {
    const expires = new Date();
    expires.setDate(expires.getDate() + 14);
    return expires.toISOString();
  }

  return null;
}

// ─── Persiste array de sinais como context items ──────────────────────────────

export async function persistSignals(
  userId: string,
  signals: ExtractedSignal[]
): Promise<{ persisted: number; skipped: number; validationsCreated: number }> {
  let persisted = 0;
  let skipped = 0;

  for (const signal of signals) {
    const contextType = SIGNAL_TO_CONTEXT_TYPE[signal.type];

    if (!contextType) {
      skipped++;
      continue;
    }

    const contextState = resolveContextState(signal, contextType);

    if (!contextState) {
      skipped++;
      continue;
    }

    const duplicate = await isDuplicate(
      userId,
      contextType,
      signal.value,
      signal.raw_phrase
    );

    if (duplicate) {
      skipped++;
      continue;
    }

    await addContextItem(userId, {
      type: contextType,
      value: signal.value,
      state: contextState,
      confidence: signal.confidence,
      source: "extractor",
      rawPhrase: signal.raw_phrase,
      expiresAt: defaultExpiresAt(signal),
      meta: {
        originalType: signal.type,
        language: signal.language_detected,
        dateText: signal.date_text || null,
        bodyPart: signal.body_part || null,
        needsUserValidation: signal.needs_user_validation,
        extractor: "gemini",
      },
    });

    persisted++;
  }

  const validationSync = persisted > 0
    ? await syncValidationQueue(userId)
    : { created: 0, pending: 0 };

  return { persisted, skipped, validationsCreated: validationSync.created };
}

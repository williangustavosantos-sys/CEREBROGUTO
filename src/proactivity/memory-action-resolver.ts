// ─── GUTO Proactivity — Deterministic Action Resolver ────────────────────────
// Resolves proactive memory actions from user replies WITHOUT relying on the
// LLM. The model generates the natural fala; this module decides the action.
//
// Why: Rate-limit / fallback from the model caused wrong or missing actions.
// The model still generates the fala; this function decides the state transition.

import { getProactiveMemoriesByStatus, getProactiveMemories } from './proactive-store'
import type { ProactiveMemory } from './types'

// ─── Output types ──────────────────────────────────────────────────────────────

export type ResolvedAction =
  | { type: 'confirm'; memoryId: string }
  | { type: 'discard'; memoryId: string }
  | { type: 'validate'; memoryId: string; outcome: 'happened' | 'postponed' | 'discarded' }
  | { type: 'cancel_discard_request'; memoryId: string }

export interface ResolverResult {
  /** true = resolver has a definitive answer (may be null action = clarification needed) */
  engaged: boolean
  /** null = no action this turn (clarification needed); undefined = resolver didn't engage */
  action: ResolvedAction | null
  /** Context-aware fala to use if model fails. Only set when engaged=true and action=null. */
  fallbackMessage?: string
  /** Internal reason for logging — never shown to user. */
  reason: string
}

const PASS_THROUGH: ResolverResult = { engaged: false, action: null, reason: 'no_pending_memory' }

// ─── Normalisation ─────────────────────────────────────────────────────────────

function norm(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s,]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function hasAny(normalized: string, terms: string[]): boolean {
  return terms.some(
    (t) =>
      normalized === t ||
      normalized.startsWith(t + ' ') ||
      normalized.includes(' ' + t + ' ') ||
      normalized.endsWith(' ' + t)
  )
}

function isExactlyOneOf(normalized: string, terms: string[]): boolean {
  return terms.some((t) => normalized === t)
}

// ─── Term banks (normalised — no accents) ─────────────────────────────────────

// ── Confirmation ──
const CONFIRM_EXACT: string[] = [
  // pt-BR
  'sim', 'isso', 'isso mesmo', 'certo', 'correto', 'exato', 'confirmo', 'pode anotar',
  'isso ai', 'bora', 'pode', 'verdade', 'com certeza', 'ta bom', 'beleza', 'ok', 'valeu',
  'vai', 'vamo', 'manda ver',
  // en-US
  'yes', 'correct', 'right', 'exactly', 'confirm', 'yep', 'yeah', 'sure', 'affirmative',
  'totally', 'alright', 'for sure', 'roger', 'go ahead',
  // it-IT
  'si', 'esatto', 'giusto', 'confermo', 'certo', 'confermato', 'esattamente',
  'va bene', 'perfetto', 'certissimo', 'dai',
]

// ── Cancellation / discard (pending_confirmation) ──
const DISCARD_TERMS: string[] = [
  // pt-BR
  'nao vou mais', 'nao vai mais', 'cancelei', 'cancelou', 'nao vai rolar',
  'desisti', 'nao vou', 'nao acontece mais', 'foi cancelado', 'cancela',
  // en-US
  'cancelled', 'canceled', 'not going', 'wont go', 'wont happen', 'no longer', 'gave up',
  'i cancelled', 'not going anymore', 'its cancelled', "it's cancelled",
  // it-IT
  'non vado piu', 'annullato', 'ho cancellato', 'non ci vado', 'e annullato',
]

// ── Keep / cancel-discard-request (only used when GUTO already asked "Descarto X?") ──
const KEEP_TERMS: string[] = [
  // pt-BR
  'nao', 'mantém', 'mantem', 'pode manter', 'nao cancela', 'nao descarta', 'fica',
  'nao quero cancelar', 'deixa', 'deixa assim', 'deixa pra la', 'de boa',
  // en-US
  'no', 'keep it', 'keep', 'dont cancel', "don't cancel", 'hold on', 'never mind',
  'nope', 'nah', 'leave it',
  // it-IT
  'no', 'mantieni', 'tieni', 'non cancellare', 'lascia stare', 'lascialo', 'lascia',
]

// ── Ambiguity ──
const AMBIGUOUS_TERMS: string[] = [
  // pt-BR
  'talvez', 'nao sei', 'vou ver', 'depende', 'quem sabe', 'pode ser',
  // en-US
  'maybe', 'perhaps', 'not sure', 'depends', 'i dunno', 'dunno',
  // it-IT
  'forse', 'non so', 'chissa', 'vedremo', 'dipende',
]

// ── Correction prefixes (negation + comma → "no, it's Friday") ──
const CORRECTION_STARTS: string[] = [
  'nao,', 'no,', 'non,', 'nao e', 'no it', 'no its', "no it's", 'non e',
]

// ── Validation: happened ──
const HAPPENED_TERMS: string[] = [
  // pt-BR
  'sim', 'rolou', 'aconteceu', 'fui', 'deu certo', 'foi otimo', 'foi bom',
  'aconteceu sim', 'foi', 'deu', 'fomos',
  // en-US
  'yes', 'happened', 'it happened', 'went', 'done', 'did it', 'went well',
  'yep', 'yeah', 'we went',
  // it-IT
  'si', 'andato', 'e andato', 'e successo', 'fatto', 'ci sono andato', 'ci siamo andati',
]

// ── Validation: postponed ──
const POSTPONED_TERMS: string[] = [
  // pt-BR
  'adiei', 'ficou para depois', 'remarquei', 'adiado', 'vou depois',
  'fica pra depois', 'mudei', 'mudamos', 'ficou pra outra',
  // en-US
  'postponed', 'rescheduled', 'delayed', 'pushed back', 'moved it', 'moved',
  // it-IT
  'rimandato', 'rinviato', 'spostato', 'lo sposto', 'abbiamo rimandato',
]

// ── Validation: discarded ──
const VALIDATED_DISCARD_TERMS: string[] = [
  // pt-BR
  'nao fui', 'nao rolou', 'nao foi', 'cancelei', 'nao aconteceu', 'desisti',
  'nao vai mais', 'foi cancelado', 'nao fomos',
  // en-US
  'cancelled', 'canceled', 'did not go', "didn't go", 'did not happen', "didn't happen",
  'nope', 'no', "we didn't go",
  // it-IT
  'annullato', 'non ci sono andato', 'non e andato', 'cancellato', 'non siamo andati',
]

// ─── Correction detector ───────────────────────────────────────────────────────

function isCorrection(normalized: string): boolean {
  const startsWithCorrectionPrefix = CORRECTION_STARTS.some((prefix) =>
    normalized.startsWith(prefix)
  )
  if (!startsWithCorrectionPrefix) return false
  if (hasAny(normalized, DISCARD_TERMS)) return false
  const withoutPrefix = CORRECTION_STARTS.reduce(
    (s, p) => (s.startsWith(p) ? s.slice(p.length).trim() : s),
    normalized
  )
  return withoutPrefix.length > 1
}

// ─── Fallback messages — GUTO voice (direct, no apologies, no chatbot) ────────

function awaitingDiscardFallback(memory: ProactiveMemory, language: string): string {
  const item = memory.understood
  if (language === 'it-IT') return `"${item}" — cancello o tengo?`
  if (language === 'en-US') return `"${item}" — cancel it or keep it?`
  return `"${item}" — descarta ou mantém?`
}

function ambiguousConfirmFallback(memory: ProactiveMemory, language: string): string {
  const item = memory.understood
  if (language === 'it-IT') return `"${item}" — ci vai o no? Dimmi chiaramente.`
  if (language === 'en-US') return `"${item}" — yes or no? Tell me straight.`
  return `"${item}" — confirma ou cancela? Me fala direto.`
}

function correctionFallback(memory: ProactiveMemory, language: string): string {
  const item = memory.understood
  if (language === 'it-IT') return `Qualcosa è cambiato con "${item}"? Dimmi esattamente cosa.`
  if (language === 'en-US') return `Something changed with "${item}"? Tell me exactly what.`
  return `Mudou algo em "${item}"? Me conta exato o que mudou.`
}

function ambiguousValidateFallback(memory: ProactiveMemory, language: string): string {
  const item = memory.understood
  if (language === 'it-IT') return `"${item}" — è andato, rimandato o cancellato?`
  if (language === 'en-US') return `"${item}" — did it happen, postponed, or cancelled?`
  return `"${item}" — aconteceu, adiou ou foi embora?`
}

function multiplePendingFallback(language: string): string {
  if (language === 'it-IT') return `Ho più cose annotate. A quale stai rispondendo?`
  if (language === 'en-US') return `Got more than one thing noted. Which one are you answering?`
  return `Tenho mais de uma coisa anotada. Qual você tá respondendo?`
}

// ─── Main resolver ─────────────────────────────────────────────────────────────

export async function resolveProactiveMemoryActionFromUserReply(
  userId: string,
  userInput: string,
  language: string
): Promise<ResolverResult> {
  if (!userId || !userInput) return PASS_THROUGH

  const normalized = norm(userInput)
  if (!normalized) return PASS_THROUGH

  try {
    const [allMemories, pendingConfirmation, pendingValidation] = await Promise.all([
      getProactiveMemories(userId),
      getProactiveMemoriesByStatus(userId, ['pending_confirmation']),
      getProactiveMemoriesByStatus(userId, ['pending_validation']),
    ])

    // ── 0. Awaiting discard confirmation — absolute priority ───────────────────
    // These are confirmed/enriched/surfaced memories where user said "cancelei X"
    // and GUTO asked "Descarto X então?". Resolver closes the loop deterministically.
    const awaitingDiscard = allMemories.filter(
      (m) =>
        m.discardRequestedAt &&
        ['confirmed', 'enriched', 'surfaced'].includes(m.status)
    )

    if (awaitingDiscard.length > 0) {
      const target = awaitingDiscard[0]!

      if (hasAny(normalized, CONFIRM_EXACT)) {
        return {
          engaged: true,
          action: { type: 'discard', memoryId: target.id },
          reason: 'discard_confirmed_from_active',
        }
      }

      if (hasAny(normalized, KEEP_TERMS)) {
        return {
          engaged: true,
          action: { type: 'cancel_discard_request', memoryId: target.id },
          reason: 'discard_cancelled_by_user',
        }
      }

      // Ambiguous or unclear — stay engaged, model uses fallbackMessage if it fails
      return {
        engaged: true,
        action: null,
        fallbackMessage: awaitingDiscardFallback(target, language),
        reason: 'discard_ambiguous',
      }
    }

    // ── 1. Pending validation takes priority ───────────────────────────────────
    if (pendingValidation.length > 0) {
      if (pendingValidation.length > 1 && isExactlyOneOf(normalized, ['sim', 'yes', 'si'])) {
        return {
          engaged: true,
          action: null,
          fallbackMessage: multiplePendingFallback(language),
          reason: 'multiple_pending_validation_ambiguous_sim',
        }
      }

      const target = pendingValidation[0]!

      // Check discard BEFORE happened: "nao fui" contains "fui" but negation makes it discard
      if (hasAny(normalized, VALIDATED_DISCARD_TERMS)) {
        return {
          engaged: true,
          action: { type: 'validate', memoryId: target.id, outcome: 'discarded' },
          reason: 'validate_discarded',
        }
      }

      if (hasAny(normalized, POSTPONED_TERMS)) {
        return {
          engaged: true,
          action: { type: 'validate', memoryId: target.id, outcome: 'postponed' },
          reason: 'validate_postponed',
        }
      }

      if (hasAny(normalized, HAPPENED_TERMS)) {
        return {
          engaged: true,
          action: { type: 'validate', memoryId: target.id, outcome: 'happened' },
          reason: 'validate_happened',
        }
      }

      if (hasAny(normalized, AMBIGUOUS_TERMS)) {
        return {
          engaged: true,
          action: null,
          fallbackMessage: ambiguousValidateFallback(target, language),
          reason: 'validate_ambiguous',
        }
      }
    }

    // ── 2. Pending confirmation ────────────────────────────────────────────────
    if (pendingConfirmation.length > 0) {
      if (pendingConfirmation.length > 1 && isExactlyOneOf(normalized, ['sim', 'yes', 'si'])) {
        return {
          engaged: true,
          action: null,
          fallbackMessage: multiplePendingFallback(language),
          reason: 'multiple_pending_confirmation_ambiguous_sim',
        }
      }

      const target = pendingConfirmation[0]!

      // Correction must be checked BEFORE discard and confirm
      if (isCorrection(normalized)) {
        return {
          engaged: true,
          action: null,
          fallbackMessage: correctionFallback(target, language),
          reason: 'correction_no_endpoint',
        }
      }

      if (hasAny(normalized, DISCARD_TERMS)) {
        return {
          engaged: true,
          action: { type: 'discard', memoryId: target.id },
          reason: 'confirm_discard',
        }
      }

      if (hasAny(normalized, AMBIGUOUS_TERMS)) {
        return {
          engaged: true,
          action: null,
          fallbackMessage: ambiguousConfirmFallback(target, language),
          reason: 'confirm_ambiguous',
        }
      }

      if (hasAny(normalized, CONFIRM_EXACT)) {
        return {
          engaged: true,
          action: { type: 'confirm', memoryId: target.id },
          reason: 'confirmed',
        }
      }
    }

    return PASS_THROUGH
  } catch (err) {
    console.error('[GUTO][proactivity] resolver error:', err)
    return PASS_THROUGH
  }
}

// ─── GUTO Proactivity — Deterministic Action Resolver ────────────────────────
// Resolves proactive memory actions from user replies WITHOUT relying on the
// LLM. The model generates the natural fala; this module decides the action.
//
// Why: Cenários A, C, D e E falhavam porque o modelo caía em rate-limit/fallback
// e retornava resposta de treino em vez de chamar confirm/discard/validate.
// O modelo ainda gera a fala; esta função decide a ação de forma determinística.

import { getProactiveMemoriesByStatus } from './proactive-store'
import type { ProactiveMemory } from './types'

// ─── Output types ──────────────────────────────────────────────────────────────

export type ResolvedAction =
  | { type: 'confirm'; memoryId: string }
  | { type: 'discard'; memoryId: string }
  | { type: 'validate'; memoryId: string; outcome: 'happened' | 'postponed' | 'discarded' }

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
  return terms.some((t) => normalized === t || normalized.startsWith(t + ' ') || normalized.includes(' ' + t + ' ') || normalized.endsWith(' ' + t))
}

function isExactlyOneOf(normalized: string, terms: string[]): boolean {
  return terms.some((t) => normalized === t)
}

// ─── Term banks (normalised — no accents) ─────────────────────────────────────

// ── Confirmation ──
const CONFIRM_EXACT: string[] = [
  // pt-BR
  'sim', 'isso', 'isso mesmo', 'certo', 'correto', 'exato', 'confirmo', 'pode anotar',
  'isso ai', 'bora', 'pode', 'verdade', 'com certeza',
  // en-US
  'yes', 'correct', 'right', 'exactly', 'confirm', 'yep', 'yeah', 'sure', 'affirmative', 'totally',
  // it-IT
  'si', 'esatto', 'giusto', 'confermo', 'certo', 'confermato', 'esattamente',
]

// ── Cancellation / discard ──
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
// A correction starts with a negation AND contains new information (more words).
const CORRECTION_STARTS: string[] = [
  'nao,', 'no,', 'non,', 'nao e', 'no it', 'no its', "no it's", 'non e',
]

// ── Validation: happened ──
const HAPPENED_TERMS: string[] = [
  // pt-BR
  'sim', 'rolou', 'aconteceu', 'fui', 'deu certo', 'foi otimo', 'foi bom',
  'aconteceu sim', 'foi', 'deu',
  // en-US
  'yes', 'happened', 'it happened', 'went', 'done', 'did it', 'went well',
  'yep', 'yeah',
  // it-IT
  'si', 'andato', 'e andato', 'e successo', 'fatto', 'ci sono andato',
]

// ── Validation: postponed ──
const POSTPONED_TERMS: string[] = [
  // pt-BR
  'adiei', 'ficou para depois', 'remarquei', 'adiado', 'vou depois',
  'fica pra depois', 'mudei', 'mudamos',
  // en-US
  'postponed', 'rescheduled', 'delayed', 'pushed back', 'moved it',
  // it-IT
  'rimandato', 'rinviato', 'spostato', 'lo sposto',
]

// ── Validation: discarded (didn't happen / cancelled) ──
const VALIDATED_DISCARD_TERMS: string[] = [
  // pt-BR
  'nao fui', 'nao rolou', 'nao foi', 'cancelei', 'nao aconteceu', 'desisti',
  'nao vai mais', 'foi cancelado',
  // en-US
  'cancelled', 'canceled', 'did not go', "didn't go", 'did not happen', "didn't happen",
  'nope', 'no',
  // it-IT
  'annullato', 'non ci sono andato', 'non e andato', 'cancellato',
]

// ─── Correction detector ───────────────────────────────────────────────────────
// "nao, e sexta" / "no, it's Friday" / "non, e sabato"
// Condition: starts with correction prefix AND is longer than just the negation
// AND does not contain clear discard keywords (those take priority as discard).

function isCorrection(normalized: string): boolean {
  const startsWithCorrectionPrefix = CORRECTION_STARTS.some((prefix) => normalized.startsWith(prefix))
  if (!startsWithCorrectionPrefix) return false

  // If it also matches a discard term, treat as discard
  if (hasAny(normalized, DISCARD_TERMS)) return false

  // Must have more content after the prefix (not just "nao," with nothing else)
  const withoutPrefix = CORRECTION_STARTS.reduce((s, p) => s.startsWith(p) ? s.slice(p.length).trim() : s, normalized)
  return withoutPrefix.length > 1
}

// ─── Fallback messages ─────────────────────────────────────────────────────────

function ambiguousConfirmFallback(memory: ProactiveMemory, language: string): string {
  const item = memory.understood
  if (language === 'it-IT') {
    return `Capito, ma ho bisogno di una risposta più chiara prima di salvare. "${item}" — confermi o cancelli?`
  }
  if (language === 'en-US') {
    return `Got it, but I need a clearer answer before saving this. "${item}" — confirm or cancel?`
  }
  return `Entendi, mas preciso de uma resposta mais clara antes de guardar isso. "${item}" — confirma ou cancela?`
}

function correctionFallback(memory: ProactiveMemory, language: string): string {
  const item = memory.understood
  if (language === 'it-IT') {
    return `Capito che qualcosa è cambiato. Dimmi il dettaglio esatto — "${item}" in quale giorno?`
  }
  if (language === 'en-US') {
    return `Got it, something changed. Give me the exact detail — "${item}", which day?`
  }
  return `Entendi que mudou algo. Me fala o detalhe exato — "${item}", qual dia?`
}

function ambiguousValidateFallback(memory: ProactiveMemory, language: string): string {
  const item = memory.understood
  if (language === 'it-IT') {
    return `Devo confermare: "${item}" — è andato, è stato rimandato o è stato cancellato?`
  }
  if (language === 'en-US') {
    return `Need to confirm: "${item}" — did it happen, was it postponed, or was it cancelled?`
  }
  return `Preciso confirmar: "${item}" — aconteceu, foi adiado ou foi cancelado?`
}

function multiplePendingFallback(language: string): string {
  if (language === 'it-IT') {
    return `Ho più cose in attesa di conferma. Di quale stai parlando?`
  }
  if (language === 'en-US') {
    return `I have more than one thing waiting for confirmation. Which one are you referring to?`
  }
  return `Tenho mais de uma coisa esperando confirmação. Qual delas você está respondendo?`
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
    // Load pending memories — single async call
    const [pendingConfirmation, pendingValidation] = await Promise.all([
      getProactiveMemoriesByStatus(userId, ['pending_confirmation']),
      getProactiveMemoriesByStatus(userId, ['pending_validation']),
    ])

    // ── 1. Pending validation takes priority (injector shows it first) ──────────
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

      // Check discard BEFORE happened: "nao fui" contains "fui" (happened) but
      // the negation prefix makes it a discard. Discard terms include the negated forms.
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

      // Don't engage: let model handle unclear validation responses
      // (e.g. user may be talking about something else entirely)
    }

    // ── 2. Pending confirmation ──────────────────────────────────────────────────
    if (pendingConfirmation.length > 0) {
      // Multiple pending: "sim" alone is ambiguous across items
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

    // No pending memory matched → pass through to model
    return PASS_THROUGH
  } catch (err) {
    console.error('[GUTO][proactivity] resolver error:', err)
    return PASS_THROUGH
  }
}

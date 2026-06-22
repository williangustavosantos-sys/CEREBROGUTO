// ─── GUTO Proactivity — Semantic Action Resolver ─────────────────────────────
// Resolves proactive memory actions by semantic interpretation first, with
// deterministic fallbacks when the model is unavailable.
//
// Why: GUTO cannot save "if user says X then Y"; it must understand context,
// but state transitions still need guardrails and memory-id validation.

import { getProactiveMemoriesByStatus, getProactiveMemories, getDateKey } from './proactive-store'
import { detectTravelTrainingSignal } from './decision-engine'
import { resolveProactiveDate } from './date-resolver'
import type { ProactiveMemory } from './types'
import { config } from '../config'

// ─── Output types ──────────────────────────────────────────────────────────────

export type ResolvedAction =
  | {
      type: 'confirm'
      memoryId: string
      patch?: Partial<Pick<ProactiveMemory, 'rawText' | 'understood' | 'dateText' | 'dateParsed' | 'location' | 'stage' | 'confirmationStage' | 'proposedTrainingAdapted' | 'trainingAdapted'>>
    }
  | { type: 'discard'; memoryId: string }
  | { type: 'request_discard'; memoryId: string }
  | {
      type: 'update'
      memoryId: string
      patch: Partial<Pick<ProactiveMemory, 'rawText' | 'understood' | 'dateText' | 'dateParsed' | 'location' | 'stage' | 'confirmationStage' | 'proposedTrainingAdapted' | 'trainingAdapted'>>
    }
  | {
      type: 'validate'
      memoryId: string
      outcome: 'happened' | 'postponed' | 'discarded'
      patch?: Partial<Pick<ProactiveMemory, 'dateText' | 'dateParsed' | 'location'>>
    }
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

function isLikelyProactiveReply(normalized: string): boolean {
  if (normalized.split(' ').length <= 4) return true
  return /\b(viagem|viajar|viajo|trip|travel|viaggio|parto|cancelei|cancelado|cancelled|annullato|adiei|adiada|remarquei|troquei|mudei|postponed|rescheduled|rimandato|spostato|aconteceu|fui|rolou|happened|went|successo|andato|segunda|terca|quarta|quinta|sexta|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)\b/.test(normalized)
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
  'nao,', 'no,', 'non,', 'nao e', 'nao vai ser', 'no it', 'no its', "no it's", 'non e',
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
  'adiei', 'ficou para depois', 'remarquei', 'adiado', 'adiada', 'vou depois',
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
  'nao vai mais', 'foi cancelado', 'foi cancelada', 'nao fomos',
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

function titleCasePlace(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((part) => part ? part.charAt(0).toLocaleUpperCase('pt-BR') + part.slice(1) : part)
    .join(' ')
    .slice(0, 80)
}

function buildCorrectionUnderstood(
  memory: ProactiveMemory,
  language: string,
  patch: Partial<Pick<ProactiveMemory, 'dateText' | 'dateParsed' | 'location'>>
): string {
  const date = patch.dateText || memory.dateText || memory.dateParsed || ''
  const location = patch.location || memory.location || ''

  if (memory.type === 'trip') {
    if (language === 'en-US') {
      return `Probable trip${date ? ` on ${date}` : ''}${location ? ` to ${location}` : ''}`.trim()
    }
    if (language === 'it-IT') {
      return `Viaggio probabile${date ? ` ${date}` : ''}${location ? ` a ${location}` : ''}`.trim()
    }
    return `Viagem provável${date ? ` em ${date}` : ''}${location ? ` para ${location}` : ''}`.trim()
  }

  if (memory.type === 'commitment') {
    return `${memory.understood || 'Compromisso provável'}${date ? ` — ${date}` : ''}`.slice(0, 300)
  }

  return `${memory.understood || memory.rawText || 'Evento provável'}${date ? ` — ${date}` : ''}`.slice(0, 300)
}

function correctionPatch(
  memory: ProactiveMemory,
  userInput: string,
  language: string
): Partial<Pick<ProactiveMemory, 'understood' | 'dateText' | 'dateParsed' | 'location'>> | null {
  const patch: Partial<Pick<ProactiveMemory, 'understood' | 'dateText' | 'dateParsed' | 'location'>> = {}
  const resolvedDate = resolveProactiveDate(userInput, getDateKey())
  if (resolvedDate) {
    patch.dateText = resolvedDate.dateText
    patch.dateParsed = resolvedDate.dateParsed
  }

  const locationMatch = userInput.match(/\b(?:para|pra|to|a)\s+([\p{L}\p{M}\s.'-]{2,80})$/iu)
  if (locationMatch?.[1]) {
    patch.location = titleCasePlace(locationMatch[1])
  }

  if (Object.keys(patch).length === 0) return null
  patch.understood = buildCorrectionUnderstood(memory, language, patch)
  return patch
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

function tripEventCardFirstFallback(memory: ProactiveMemory, language: string): string {
  const item = memory.dateParsed || memory.dateText || memory.understood
  if (language === 'it-IT') return `Prima conferma il viaggio nel card (${item}). Dopo ti chiedo dell'allenamento adattato.`
  if (language === 'en-US') return `First confirm the trip on the card (${item}). After that I ask about the adapted workout.`
  return `Primeiro confirma a viagem no card (${item}). Depois eu pergunto sobre o treino adaptado.`
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

function actionFallback(action: ResolvedAction, memory: ProactiveMemory, language: string): string | undefined {
  const item = memory.understood
  if (action.type === 'request_discard') {
    if (language === 'it-IT') return `"${item}" — è saltato davvero? Se sì, libero quel blocco.`
    if (language === 'en-US') return `"${item}" — is that really off? If yes, I free that block.`
    return `"${item}" — caiu mesmo? Se caiu, eu libero esse bloco.`
  }
  return undefined
}

function appendUserReplyToMemoryPatch(
  memory: ProactiveMemory,
  userInput: string
): Partial<Pick<ProactiveMemory, 'rawText' | 'understood'>> {
  const reply = userInput.replace(/\s+/g, ' ').trim().slice(0, 180)
  if (!reply) return {}
  const append = (base: string | undefined): string => {
    const cleanBase = (base || '').replace(/\s+/g, ' ').trim()
    if (!cleanBase) return reply
    if (cleanBase.toLowerCase().includes(reply.toLowerCase())) return cleanBase
    return `${cleanBase}; ${reply}`.slice(0, 360)
  }
  return {
    rawText: append(memory.rawText),
    understood: append(memory.understood),
  }
}

function relevantMemoriesForSemantic(all: ProactiveMemory[]): ProactiveMemory[] {
  const active = new Set(['pending_confirmation', 'confirmed', 'enriched', 'surfaced', 'pending_validation'])
  return all
    .filter((memory) => active.has(memory.status))
    .slice(0, 8)
}

function semanticPrompt(input: string, memories: ProactiveMemory[], language: string): string {
  const memoryLines = memories.map((memory) => ({
    id: memory.id,
    type: memory.type,
    status: memory.status,
    understood: memory.understood,
    dateText: memory.dateText,
    dateParsed: memory.dateParsed,
    location: memory.location,
    discardRequestedAt: memory.discardRequestedAt,
  }))

  return `You are GUTO's proactive memory action resolver.

Goal: understand the user's intent semantically across Portuguese, English, Italian, slang and typos. Do NOT use keyword matching.

User language: ${language}
User message: ${JSON.stringify(input)}

Existing proactive memories:
${JSON.stringify(memoryLines, null, 2)}

Decide whether the user is answering, correcting, confirming, cancelling, postponing, or validating one of these memories.

Rules:
- A place mention is not a trip by itself. "jogo da Roma" is a football/team reference, not a trip to Rome.
- If a confirmed/enriched/surfaced memory was cancelled/changed, do NOT discard immediately. Return request_discard so GUTO confirms before deletion.
- If a pending_confirmation is clearly confirmed, return confirm. If clearly rejected/cancelled, return discard.
- If a pending_validation is answered, return validate with outcome: happened, postponed, or discarded.
- If the user is correcting a pending_confirmation detail and the corrected detail is clear, return update with patch. Keep it pending; GUTO will ask confirmation again.
- If the user is correcting a detail but the corrected new detail is not enough to safely update, return null with a short clarification.
- If the message is general research, weather curiosity, or not connected to a memory, return null with no clarification.
- If uncertain, return null with a short clarification in the user's language.

Return STRICT JSON only:
{
  "action": null | {"type":"confirm"|"discard"|"request_discard"|"cancel_discard_request","memoryId":"..."} | {"type":"update","memoryId":"...","patch":{"understood":"...","dateText":"...","dateParsed":"YYYY-MM-DD","location":"..."}} | {"type":"validate","memoryId":"...","outcome":"happened"|"postponed"|"discarded"},
  "clarification": "short GUTO-style question if needed, otherwise empty string",
  "reason": "short internal reason"
}`
}

function sanitizeSemanticAction(raw: unknown, memories: ProactiveMemory[], language: string): ResolverResult | null {
  if (!raw || typeof raw !== 'object') return null
  const parsed = raw as { action?: unknown; clarification?: unknown; reason?: unknown }
  const clarification = typeof parsed.clarification === 'string' ? parsed.clarification.trim().slice(0, 240) : ''
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : 'semantic'
  if (!parsed.action || typeof parsed.action !== 'object') {
    return clarification
      ? { engaged: true, action: null, fallbackMessage: clarification, reason }
      : null
  }

  const action = parsed.action as { type?: unknown; memoryId?: unknown; outcome?: unknown }
  const memoryId = typeof action.memoryId === 'string' ? action.memoryId.trim() : ''
  const memory = memories.find((item) => item.id === memoryId)
  if (!memory || typeof action.type !== 'string') return null

  if (action.type === 'confirm' && memory.status === 'pending_confirmation') {
    const patchInput =
      'patch' in action && action.patch && typeof action.patch === 'object'
        ? (action.patch as Record<string, unknown>)
        : {}
    const patch: Partial<Pick<ProactiveMemory, 'rawText' | 'understood' | 'dateText' | 'dateParsed' | 'location'>> = {}
    if (typeof patchInput.rawText === 'string' && patchInput.rawText.trim()) {
      patch.rawText = patchInput.rawText.trim().slice(0, 360)
    }
    if (typeof patchInput.understood === 'string' && patchInput.understood.trim()) {
      patch.understood = patchInput.understood.trim().slice(0, 360)
    }
    if (typeof patchInput.dateText === 'string' && patchInput.dateText.trim()) {
      patch.dateText = patchInput.dateText.trim().slice(0, 80)
    }
    if (typeof patchInput.dateParsed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patchInput.dateParsed)) {
      patch.dateParsed = patchInput.dateParsed
    }
    if (typeof patchInput.location === 'string' && patchInput.location.trim()) {
      patch.location = patchInput.location.trim().slice(0, 120)
    }
    return {
      engaged: true,
      action: { type: 'confirm', memoryId, ...(Object.keys(patch).length ? { patch } : {}) },
      reason,
    }
  }
  if (action.type === 'discard' && (memory.status === 'pending_confirmation' || memory.discardRequestedAt)) {
    return { engaged: true, action: { type: 'discard', memoryId }, reason }
  }
  if (action.type === 'request_discard' && ['confirmed', 'enriched', 'surfaced'].includes(memory.status) && !memory.discardRequestedAt) {
    const requestAction: ResolvedAction = { type: 'request_discard', memoryId }
    return {
      engaged: true,
      action: requestAction,
      fallbackMessage: clarification || actionFallback(requestAction, memory, language),
      reason,
    }
  }
  if (action.type === 'cancel_discard_request' && memory.discardRequestedAt) {
    return { engaged: true, action: { type: 'cancel_discard_request', memoryId }, reason }
  }
  if (action.type === 'update' && memory.status === 'pending_confirmation') {
    const rawPatch = action as { patch?: unknown }
    const patchInput = rawPatch.patch && typeof rawPatch.patch === 'object'
      ? rawPatch.patch as Record<string, unknown>
      : {}
    const patch: Partial<Pick<ProactiveMemory, 'understood' | 'dateText' | 'dateParsed' | 'location'>> = {}
    if (typeof patchInput.understood === 'string' && patchInput.understood.trim()) {
      patch.understood = patchInput.understood.trim().slice(0, 300)
    }
    if (typeof patchInput.dateText === 'string' && patchInput.dateText.trim()) {
      patch.dateText = patchInput.dateText.trim().slice(0, 80)
    }
    if (typeof patchInput.dateParsed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patchInput.dateParsed)) {
      patch.dateParsed = patchInput.dateParsed
    }
    if (typeof patchInput.location === 'string' && patchInput.location.trim()) {
      patch.location = patchInput.location.trim().slice(0, 120)
    }
    if (Object.keys(patch).length === 0) return null
    return {
      engaged: true,
      action: { type: 'update', memoryId, patch },
      fallbackMessage: clarification || correctionFallback({ ...memory, ...patch }, language),
      reason,
    }
  }
  if (
    action.type === 'validate' &&
    memory.status === 'pending_validation' &&
    (action.outcome === 'happened' || action.outcome === 'postponed' || action.outcome === 'discarded')
  ) {
    return {
      engaged: true,
      action: { type: 'validate', memoryId, outcome: action.outcome },
      reason,
    }
  }

  return clarification
    ? { engaged: true, action: null, fallbackMessage: clarification, reason }
    : null
}

async function resolveSemantically(
  input: string,
  memories: ProactiveMemory[],
  language: string
): Promise<ResolverResult | null> {
  if (!config.geminiApiKey || memories.length === 0) return null

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: semanticPrompt(input, memories, language) }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 900,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(8000),
      }
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return null
    return sanitizeSemanticAction(JSON.parse(text), memories, language)
  } catch {
    return null
  }
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

    const pendingDateCorrection = pendingConfirmation.find(
      (memory) => memory.type === 'trip' && memory.stage === 'date_correction'
    )
    if (pendingDateCorrection) {
      const resolvedDate = resolveProactiveDate(userInput, getDateKey())
      if (!resolvedDate) {
        return {
          engaged: true,
          action: null,
          fallbackMessage: language === 'en-US'
            ? 'What is the correct travel date?'
            : language === 'it-IT'
              ? 'Qual è la data corretta del viaggio?'
              : 'Qual é a data certa da viagem?',
          reason: 'trip_date_correction_missing_date',
        }
      }
      const patch = {
        dateText: resolvedDate.dateText,
        dateParsed: resolvedDate.dateParsed,
        understood: buildCorrectionUnderstood(pendingDateCorrection, language, resolvedDate),
        stage: 'impact_confirmation' as const,
        confirmationStage: 'impact' as const,
      }
      return {
        engaged: true,
        action: { type: 'update', memoryId: pendingDateCorrection.id, patch },
        fallbackMessage: language === 'en-US'
          ? 'Date updated. Confirm the decision on the card.'
          : language === 'it-IT'
            ? 'Data aggiornata. Conferma la decisione nel card.'
            : 'Data atualizada. Confirma a decisão no card.',
        reason: 'trip_date_corrected',
      }
    }

    if (pendingConfirmation.length === 1 && isCorrection(normalized)) {
      const target = pendingConfirmation[0]!
      const patch = correctionPatch(target, userInput, language)
      if (patch) {
        return {
          engaged: true,
          action: { type: 'update', memoryId: target.id, patch },
          fallbackMessage: correctionFallback({ ...target, ...patch }, language),
          reason: 'correction_update',
        }
      }
    }

    if (pendingConfirmation.length === 1 && pendingConfirmation[0]?.type === 'trip') {
      const target = pendingConfirmation[0]!
      const travelTrainingSignal = detectTravelTrainingSignal(userInput)
      if (travelTrainingSignal !== 'unknown') {
        const isContinuityQuestion = target.stage === 'continuity_question'
        const isEventConfirmation = target.stage === 'event_confirmation' || (
          !target.stage && target.confirmationStage !== 'impact'
        )
        if (isEventConfirmation) {
          return {
            engaged: true,
            action: null,
            fallbackMessage: tripEventCardFirstFallback(target, language),
            reason: 'pending_trip_event_card_first',
          }
        }
        return {
          engaged: true,
          action: {
            type: 'update',
            memoryId: target.id,
            patch: {
              ...appendUserReplyToMemoryPatch(target, userInput),
              proposedTrainingAdapted: travelTrainingSignal === 'can_train',
              ...(isContinuityQuestion
                ? { stage: 'impact_confirmation' as const, confirmationStage: 'impact' as const }
                : {}),
            },
          },
          reason: `pending_trip_card_${travelTrainingSignal}`,
        }
      }
    }

    const activeTrips = allMemories.filter(
      (memory) => memory.type === 'trip' && ['confirmed', 'enriched', 'surfaced'].includes(memory.status)
    )
    if (activeTrips.length === 1) {
      const target = activeTrips[0]!
      const travelTrainingSignal = detectTravelTrainingSignal(userInput)
      if (travelTrainingSignal !== 'unknown') {
        return {
          engaged: true,
          action: {
            type: 'update',
            memoryId: target.id,
            patch: {
              ...appendUserReplyToMemoryPatch(target, userInput),
              proposedTrainingAdapted: travelTrainingSignal === 'can_train',
              trainingAdapted: undefined,
              stage: 'impact_confirmation',
              confirmationStage: 'impact',
            },
          },
          reason: `active_trip_card_${travelTrainingSignal}`,
        }
      }

      const movedDate = resolveProactiveDate(userInput, getDateKey())
      if (movedDate && /\b(adiei|adiada|remarquei|troquei|mudei|mudou|postponed|rescheduled|moved|rimandato|spostato)\b/.test(normalized)) {
        return {
          engaged: true,
          action: {
            type: 'update',
            memoryId: target.id,
            patch: {
              dateText: movedDate.dateText,
              dateParsed: movedDate.dateParsed,
              understood: buildCorrectionUnderstood(target, language, movedDate),
              proposedTrainingAdapted: undefined,
              trainingAdapted: undefined,
              stage: 'continuity_question',
              confirmationStage: 'event',
            },
          },
          reason: 'active_trip_rescheduled',
        }
      }

      if (hasAny(normalized, DISCARD_TERMS)) {
        return {
          engaged: true,
          action: { type: 'discard', memoryId: target.id },
          reason: 'active_trip_cancelled',
        }
      }
    }

    if (
      (pendingConfirmation.length > 0 || pendingValidation.length > 0) &&
      !isLikelyProactiveReply(normalized)
    ) {
      return PASS_THROUGH
    }

    const semantic = await resolveSemantically(
      userInput,
      relevantMemoriesForSemantic(allMemories),
      language
    )
    if (semantic?.engaged) {
      if (semantic.action === null && pendingValidation.length === 1) {
        return {
          ...semantic,
          fallbackMessage: ambiguousValidateFallback(pendingValidation[0]!, language),
        }
      }
      if (semantic.action === null && pendingConfirmation.length === 1) {
        return {
          ...semantic,
          fallbackMessage: ambiguousConfirmFallback(pendingConfirmation[0]!, language),
        }
      }
      return semantic
    }

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
        const correction = correctionPatch(target, userInput, language) || undefined
        return {
          engaged: true,
          action: {
            type: 'validate',
            memoryId: target.id,
            outcome: 'postponed',
            ...(correction ? { patch: correction } : {}),
          },
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
        const patch = correctionPatch(target, userInput, language)
        if (patch) {
          return {
            engaged: true,
            action: { type: 'update', memoryId: target.id, patch },
            fallbackMessage: correctionFallback({ ...target, ...patch }, language),
            reason: 'correction_update',
          }
        }
        return {
          engaged: true,
          action: null,
          fallbackMessage: correctionFallback(target, language),
          reason: 'correction_no_endpoint',
        }
      }

      // Resposta curta ao dado crítico da viagem ("não vou conseguir treinar",
      // "consigo treinar no hotel") confirma a memória e completa o contexto
      // antes de gerar impacto. Sem isso, "não vou..." caía como descarte da
      // viagem ou como pedido de treino no fallback técnico.
      if (target.type === 'trip') {
        const travelTrainingSignal = detectTravelTrainingSignal(userInput)
        if (travelTrainingSignal !== 'unknown') {
          if (target.confirmationStage !== 'impact') {
            return {
              engaged: true,
              action: null,
              fallbackMessage: tripEventCardFirstFallback(target, language),
              reason: 'pending_trip_event_card_first',
            }
          }
          return {
            engaged: true,
            action: {
              type: 'update',
              memoryId: target.id,
              patch: {
                ...appendUserReplyToMemoryPatch(target, userInput),
                proposedTrainingAdapted: travelTrainingSignal === 'can_train',
                stage: 'impact_confirmation',
                confirmationStage: 'impact',
              },
            },
            reason: `pending_trip_card_${travelTrainingSignal}`,
          }
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

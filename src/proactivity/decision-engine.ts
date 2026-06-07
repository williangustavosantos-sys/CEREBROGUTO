import type {
  ProactiveBlockedPeriod,
  ProactiveDecision,
  ProactiveDecisionReason,
  ProactiveImpact,
  ProactiveMemory,
  ProactiveMissionEffect,
  ProactiveWorkoutEffect,
} from './types'

const DAY_MS = 24 * 60 * 60 * 1000

const PRIORITY: Record<ProactiveDecisionReason, number> = {
  health: 100,
  coach_lock: 90,
  travel: 80,
  commitment: 70,
  busy_week: 60,
  clear_week: 50,
}

export interface DecideFromProactiveMemoryInput {
  memory: ProactiveMemory
  now?: Date | string
  language?: string
  coachLocked?: boolean
}

export interface ProactiveAdaptationForDate {
  dateKey: string
  impacts: ProactiveImpact[]
  primaryImpact?: ProactiveImpact
  reason?: ProactiveDecisionReason
  blockedPeriod?: ProactiveBlockedPeriod
  workoutEffect: ProactiveWorkoutEffect
  missionEffect: ProactiveMissionEffect
  isAdaptedDay: boolean
  shouldAskCritical: boolean
  shouldAvoidBlindPenalty: boolean
  xpPolicy: 'no_free_xp' | 'normal'
  arenaPolicy: 'validation_required' | 'normal'
}

interface MemoryWithImpacts {
  proactiveImpacts?: ProactiveImpact[]
}

function normalizeText(value?: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}:h]+/gu, ' ')
    .trim()
    .toLowerCase()
}

function asDate(value?: Date | string): Date {
  if (value instanceof Date) return value
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

function weekDatesFrom(now: Date): string[] {
  return Array.from({ length: 7 }, (_, index) => dateKey(addDays(now, index)))
}

function matchWeekdayDate(text: string, now: Date): string | null {
  const weekdays: Array<{ day: number; tokens: string[] }> = [
    { day: 0, tokens: ['domingo', 'sunday', 'domenica'] },
    { day: 1, tokens: ['segunda', 'monday', 'lunedi', 'lunedi feira'] },
    { day: 2, tokens: ['terca', 'terça', 'tuesday', 'martedi'] },
    { day: 3, tokens: ['quarta', 'wednesday', 'mercoledi'] },
    { day: 4, tokens: ['quinta', 'thursday', 'giovedi'] },
    { day: 5, tokens: ['sexta', 'friday', 'venerdi'] },
    { day: 6, tokens: ['sabado', 'sábado', 'saturday', 'sabato'] },
  ]
  const target = weekdays.find((item) => item.tokens.some((token) => text.includes(token)))
  if (!target) return null
  const current = now.getUTCDay()
  const delta = (target.day - current + 7) % 7
  return dateKey(addDays(now, delta))
}

function resolveAffectedDates(memory: ProactiveMemory, text: string, now: Date, weekly = false): string[] {
  if (weekly) return weekDatesFrom(now)
  if (memory.dateParsed && /^\d{4}-\d{2}-\d{2}$/.test(memory.dateParsed)) {
    return [memory.dateParsed]
  }
  const byWeekday = matchWeekdayDate(text, now)
  if (byWeekday) return [byWeekday]
  return [dateKey(now)]
}

function resolvePeriod(text: string, reason: ProactiveDecisionReason): ProactiveBlockedPeriod | undefined {
  if (reason === 'travel') return 'all_day'
  if (/\b(manha|morning|mattina)\b/.test(text)) return 'morning'
  if (/\b(tarde|afternoon|pomeriggio)\b/.test(text)) return 'afternoon'
  if (/\b(noite|night|evening|sera|serata)\b/.test(text)) return 'evening'
  if (/\b(madrugada|late night|notte)\b/.test(text)) return 'night'
  if (/\b\d{1,2}h\b|\b\d{1,2}:\d{2}\b/.test(text)) return 'evening'
  return undefined
}

function impactId(memoryId: string, reason: ProactiveDecisionReason, dates: string[]): string {
  return ['pi', memoryId, reason, dates[0] || 'week'].join('_').replace(/[^a-zA-Z0-9_-]/g, '_')
}

function decisionId(memoryId: string, reason: ProactiveDecisionReason, dates: string[]): string {
  return ['pd', memoryId, reason, dates[0] || 'week'].join('_').replace(/[^a-zA-Z0-9_-]/g, '_')
}

function buildDecision({
  memory,
  reason,
  affectedDates,
  blockedPeriod,
  workoutEffect,
  missionEffect,
  message,
  criticalQuestion,
}: {
  memory: ProactiveMemory
  reason: ProactiveDecisionReason
  affectedDates: string[]
  blockedPeriod?: ProactiveBlockedPeriod
  workoutEffect: ProactiveWorkoutEffect
  missionEffect: ProactiveMissionEffect
  message: string
  criticalQuestion?: ProactiveDecision['criticalQuestion']
}): ProactiveDecision {
  const kind =
    reason === 'health'
      ? 'adapt_day'
      : reason === 'coach_lock'
        ? 'preserve_coach_lock'
        : reason === 'travel'
          ? 'adapt_day'
          : reason === 'commitment' && criticalQuestion
            ? 'ask_critical'
            : reason === 'commitment'
              ? 'block_period'
              : reason === 'busy_week'
                ? 'reduce_week'
                : 'keep_normal'
  return {
    id: decisionId(memory.id, reason, affectedDates),
    memoryId: memory.id,
    kind,
    reason,
    priority: PRIORITY[reason],
    affectedDates,
    blockedPeriod,
    criticalQuestion,
    workoutEffect,
    missionEffect,
    message,
    createdAt: new Date().toISOString(),
  }
}

export function decideFromProactiveMemory(
  input: DecideFromProactiveMemoryInput | ProactiveMemory
): ProactiveDecision | null {
  const memory = 'memory' in input ? input.memory : input
  const now = asDate('memory' in input ? input.now : undefined)
  const language = normalizeText('memory' in input ? input.language : undefined)
  const text = normalizeText([memory.rawText, memory.understood, memory.dateText, memory.location].filter(Boolean).join(' '))

  if (!text) return null

  const healthDetected =
    memory.type === 'health' ||
    /\b(dor|doente|doenca|doença|febre|lesao|lesao|lesao|pain|sick|ill|injury|dolore|malato)\b/.test(text)
  if (healthDetected) {
    const affectedDates = resolveAffectedDates(memory, text, now)
    return buildDecision({
      memory,
      reason: 'health',
      affectedDates,
      workoutEffect: 'minimal',
      missionEffect: 'reduced',
      message: language.includes('en')
        ? 'Health context wins. I am reducing today to the minimum executable mission; no free XP, only real validation counts.'
        : language.includes('it')
          ? 'Il contesto fisico viene prima. Riduco al minimo eseguibile; niente XP gratis, conta solo validazione reale.'
          : 'Contexto físico manda. Vou reduzir para a missão mínima executável; sem XP grátis, só validação real conta.',
    })
  }

  if ('memory' in input && input.coachLocked) {
    const affectedDates = resolveAffectedDates(memory, text, now)
    return buildDecision({
      memory,
      reason: 'coach_lock',
      affectedDates,
      workoutEffect: 'coach_locked',
      missionEffect: 'coach_locked',
      message: language.includes('en')
        ? 'Coach lock preserved. I will not overwrite the locked workout; adaptations become context only.'
        : language.includes('it')
          ? 'Blocco coach preservato. Non sovrascrivo l allenamento bloccato; gli adattamenti virano contesto.'
          : 'Treino travado pelo coach preservado. Não vou sobrescrever; adaptação vira contexto operacional.',
    })
  }

  const travelDetected =
    memory.type === 'trip' ||
    /\b(viajo|viajar|viagem|vou viajar|travel|trip|flight|volo|viaggio|parto)\b/.test(text)
  if (travelDetected) {
    const affectedDates = resolveAffectedDates(memory, text, now)
    return buildDecision({
      memory,
      reason: 'travel',
      affectedDates,
      blockedPeriod: 'all_day',
      workoutEffect: 'short_light',
      missionEffect: 'protected_before',
      message: language.includes('en')
        ? 'Travel locked in: that day becomes adapted. I will protect the main mission before the trip and keep the day short and light. No free XP; Arena only counts with real validation.'
        : language.includes('it')
          ? 'Viaggio segnato: quel giorno diventa adattato. Proteggo la missione principale prima e tengo il giorno corto e leggero. Niente XP gratis; Arena solo con validazione reale.'
          : 'Viagem fechada: esse dia vira adaptado. Vou proteger a missão principal antes e deixar o treino curto e leve no dia. Sem XP grátis; Arena só com validação real.',
    })
  }

  const commitmentDetected =
    memory.type === 'commitment' ||
    memory.type === 'schedule' ||
    /\b(reuniao|reunião|compromisso|consulta|evento|meeting|appointment|riunione|impegno)\b/.test(text)
  if (commitmentDetected) {
    const affectedDates = resolveAffectedDates(memory, text, now)
    const blockedPeriod = resolvePeriod(text, 'commitment')
    return buildDecision({
      memory,
      reason: 'commitment',
      affectedDates,
      blockedPeriod,
      workoutEffect: blockedPeriod ? 'short_light' : 'ask_critical',
      missionEffect: blockedPeriod ? 'reduced' : 'ask_critical',
      criticalQuestion: blockedPeriod ? undefined : 'period',
      message: blockedPeriod
        ? language.includes('en')
          ? 'Commitment blocked. I will protect that period and move the workout earlier or reduce it if needed.'
          : language.includes('it')
            ? 'Impegno bloccato. Proteggo quel periodo e anticipo o riduco l allenamento se serve.'
            : 'Compromisso bloqueado. Vou proteger esse período e antecipar ou reduzir o treino se precisar.'
        : language.includes('en')
          ? 'I only need the critical detail: what period is blocked? Morning, afternoon, or night?'
          : language.includes('it')
            ? 'Mi serve solo il dato critico: quale periodo e bloccato? Mattina, pomeriggio o sera?'
            : 'Só preciso do dado crítico: qual período fica bloqueado? Manhã, tarde ou noite?',
    })
  }

  if (/\b(semana corrida|semana apertada|busy week|packed week|settimana piena|settimana pesante)\b/.test(text)) {
    const affectedDates = resolveAffectedDates(memory, text, now, true)
    return buildDecision({
      memory,
      reason: 'busy_week',
      affectedDates,
      workoutEffect: 'minimal',
      missionEffect: 'reduced',
      message: language.includes('en')
        ? 'Busy week registered. I am reducing complexity and keeping a minimum executable plan; streak protection depends on minimum execution, not free XP.'
        : language.includes('it')
          ? 'Settimana piena registrata. Riduco la complessita e tengo un piano minimo eseguibile; la streak dipende da esecuzione minima, non da XP gratis.'
          : 'Semana corrida registrada. Vou reduzir a complexidade e manter plano mínimo executável; streak depende de execução mínima, não de XP grátis.',
    })
  }

  if (/\b(nada essa semana|sem nada essa semana|sem compromisso essa semana|nothing this week|free week|niente questa settimana)\b/.test(text)) {
    const affectedDates = resolveAffectedDates(memory, text, now, true)
    return buildDecision({
      memory,
      reason: 'clear_week',
      affectedDates,
      workoutEffect: 'normal',
      missionEffect: 'normal',
      message: language.includes('en')
        ? 'Clear week registered. I will keep the normal plan and will not ask this weekly opening again.'
        : language.includes('it')
          ? 'Settimana libera registrata. Mantengo il piano normale e non ripeto questa apertura settimanale.'
          : 'Semana livre registrada. Vou manter o plano normal e não repetir essa abertura semanal.',
    })
  }

  return null
}

export function buildImpactFromDecision(
  decision: ProactiveDecision,
  context?: MemoryWithImpacts | null
): ProactiveImpact | null {
  if (!decision.affectedDates.length) return null

  const existing = context?.proactiveImpacts?.find(
    (impact) => impact.memoryId === decision.memoryId && impact.decision.reason === decision.reason
  )
  const now = new Date().toISOString()
  const surfaces =
    decision.kind === 'ask_critical'
      ? (['chat'] as const)
      : decision.reason === 'clear_week'
        ? (['chat', 'workout', 'mission'] as const)
        : (['chat', 'workout', 'mission', 'guto_online', 'push', 'xp', 'arena', 'path', 'evolution'] as const)

  return {
    id: existing?.id || impactId(decision.memoryId, decision.reason, decision.affectedDates),
    memoryId: decision.memoryId,
    decision,
    status: 'active',
    surfaces: [...surfaces],
    priority: decision.priority,
    affectedDates: [...decision.affectedDates],
    blockedPeriod: decision.blockedPeriod,
    workoutEffect: decision.workoutEffect,
    missionEffect: decision.missionEffect,
    pushEffect: decision.reason === 'clear_week' || decision.kind === 'ask_critical' ? 'none' : 'avoid_blind_charge',
    xpEffect: decision.reason === 'clear_week' || decision.kind === 'ask_critical' ? 'none' : 'no_free_xp_context_only',
    arenaEffect: decision.reason === 'clear_week' || decision.kind === 'ask_critical' ? 'none' : 'validation_required',
    pathEffect: decision.reason === 'clear_week' || decision.kind === 'ask_critical' ? 'none' : 'adapted_context',
    evolutionEffect: decision.reason === 'clear_week' || decision.kind === 'ask_critical' ? 'none' : 'adapted_context',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
}

export function resolveEffectiveImpacts(impacts: ProactiveImpact[] = [], date: string | Date): ProactiveImpact[] {
  const key = typeof date === 'string' ? date.slice(0, 10) : dateKey(date)
  const relevant = impacts.filter(
    (impact) => impact.status === 'active' && impact.affectedDates.includes(key)
  )
  const sorted = [...relevant].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)
  })
  const winnersBySurface = new Map<string, ProactiveImpact>()
  const resolved: ProactiveImpact[] = []

  for (const impact of sorted) {
    let supersededBy: string | undefined
    for (const surface of impact.surfaces) {
      const winner = winnersBySurface.get(surface)
      if (winner) {
        supersededBy = winner.id
      } else {
        winnersBySurface.set(surface, impact)
      }
    }

    if (supersededBy) {
      resolved.push({ ...impact, status: 'superseded', supersededBy })
    } else {
      resolved.push({ ...impact, supersededBy: undefined })
    }
  }

  return resolved
}

export function getAdaptationForDate(memory: MemoryWithImpacts, date: string | Date): ProactiveAdaptationForDate {
  const dateKeyValue = typeof date === 'string' ? date.slice(0, 10) : dateKey(date)
  const impacts = resolveEffectiveImpacts(memory.proactiveImpacts || [], dateKeyValue)
  const activeImpacts = impacts
    .filter((impact) => impact.status === 'active')
    .sort((a, b) => b.priority - a.priority)
  const primaryImpact = activeImpacts[0]
  const workoutEffect = primaryImpact?.workoutEffect || 'normal'
  const missionEffect = primaryImpact?.missionEffect || 'normal'

  return {
    dateKey: dateKeyValue,
    impacts,
    primaryImpact,
    reason: primaryImpact?.decision.reason,
    blockedPeriod: primaryImpact?.blockedPeriod,
    workoutEffect,
    missionEffect,
    isAdaptedDay: workoutEffect === 'short_light' || workoutEffect === 'minimal',
    shouldAskCritical: workoutEffect === 'ask_critical' || missionEffect === 'ask_critical',
    shouldAvoidBlindPenalty: primaryImpact?.pushEffect === 'avoid_blind_charge',
    xpPolicy: primaryImpact?.xpEffect === 'no_free_xp_context_only' ? 'no_free_xp' : 'normal',
    arenaPolicy: primaryImpact?.arenaEffect === 'validation_required' ? 'validation_required' : 'normal',
  }
}

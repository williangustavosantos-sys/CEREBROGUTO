import type {
  ProactiveBlockedPeriod,
  ProactiveDecision,
  ProactiveDecisionReason,
  ProactiveImpact,
  ProactiveMemory,
  ProactiveMissionEffect,
  ProactiveWorkoutEffect,
} from './types'
import { resolveProactiveDate } from './date-resolver'

const DAY_MS = 24 * 60 * 60 * 1000

const PRIORITY: Record<ProactiveDecisionReason, number> = {
  health: 100,
  coach_lock: 90,
  travel: 80,
  commitment: 70,
  short_window: 65,
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
  isProtectedDay: boolean
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

// Continuidade primeiro: viagem \u00e9 mudan\u00e7a de contexto, n\u00e3o interrup\u00e7\u00e3o. O dado
// cr\u00edtico \u00e9 se o usu\u00e1rio consegue treinar. Sem ele, N\u00c3O criamos impacto
// definitivo (vira ask_critical). Detecta o sinal a partir do texto da mem\u00f3ria.
export type TravelTrainingSignal = 'can_train' | 'cannot_train' | 'unknown'

// "(?: treinar)?" é OPCIONAL: dentro do contexto de viagem (detectTravelTrainingSignal
// só roda quando travelDetected), a resposta curta "não vou conseguir" / "não consigo"
// / "não tem como" / "impossível" JÁ resolve a indisponibilidade — não precisa repetir
// "treinar". Sem isso, o follow-up curto caía em 'unknown' → ask_critical → LOOP
// ("ele repergunta o mesmo"), violando a Continuidade Primeiro (confirmar→registrar→
// adaptar→seguir). "não vai dar"/"não da pra" já eram standalone; alinhamos os demais.
const TRAVEL_CANNOT_TRAIN =
  /\b(nao vou conseguir|nao consigo|nao tem como|nao rola|impossivel|nao da pra(?: treinar)?|nao vai dar(?: pra treinar)?|sem tempo pra treinar|sem tempo pro treino|dia inteiro (ocupado|fora|sem tempo|de viagem)|wont be able to train|won t be able to train|can ?not train|cant train|no time to train|no way to train|impossible to train|non riesco|non posso allenarmi|non ce la faccio|impossibile|niente tempo per allenarmi|non ho tempo per allenarmi|giornata piena|tutto il giorno fuori|in viaggio tutto il giorno)\b/

const TRAVEL_CAN_TRAIN =
  /\b(consigo treinar|vou treinar|posso treinar|da pra treinar|tem academia|academia do hotel|academia no hotel|treino no hotel|treino no quarto|treinar no hotel|treinar no quarto|treinar no destino|hotel tem academia|missao curta|i can train|i can work ?out|hotel gym|gym at the hotel|train at the hotel|treino adaptado|treinar viajando|levo o treino|riesco ad? allenarmi|posso allenarmi|mi alleno (in hotel|in camera|in viaggio)|palestra (dell|in) hotel|c e una palestra|allenamento adattato|porto l allenamento|allenarsi in hotel)\b/

export function detectTravelTrainingSignal(value?: string): TravelTrainingSignal {
  const text = normalizeText(value)
  if (!text) return 'unknown'
  if (TRAVEL_CANNOT_TRAIN.test(text)) return 'cannot_train'
  if (TRAVEL_CAN_TRAIN.test(text)) return 'can_train'
  return 'unknown'
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

function durationDaysFromText(text: string): number {
  const match = text.match(/\bpor\s+(\d+|uma|um|duas|dois|tres|três|quatro)\s+dias?\b/)
  if (!match) return 1
  const raw = match[1] || ''
  const words: Record<string, number> = {
    uma: 1,
    um: 1,
    duas: 2,
    dois: 2,
    tres: 3,
    três: 3,
    quatro: 4,
  }
  const amount = /^\d+$/.test(raw) ? Number(raw) : words[raw]
  return amount && amount > 1 && amount <= 14 ? amount : 1
}

function rangeFromStart(dateKeyValue: string, days: number): string[] {
  const start = new Date(`${dateKeyValue.slice(0, 10)}T12:00:00.000Z`)
  if (Number.isNaN(start.getTime())) return [dateKeyValue]
  return Array.from({ length: days }, (_, index) => dateKey(addDays(start, index)))
}

function weekDatesFrom(now: Date): string[] {
  return Array.from({ length: 7 }, (_, index) => dateKey(addDays(now, index)))
}

function resolveAffectedDates(memory: ProactiveMemory, text: string, now: Date, weekly = false): string[] {
  if (weekly) return weekDatesFrom(now)
  if (memory.dateParsed && /^\d{4}-\d{2}-\d{2}$/.test(memory.dateParsed)) {
    return rangeFromStart(memory.dateParsed, durationDaysFromText(text))
  }
  const resolved = resolveProactiveDate(text, dateKey(now))
  if (resolved) return rangeFromStart(resolved.dateParsed, durationDaysFromText(text))
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
        : reason === 'travel' && criticalQuestion
          ? 'ask_critical'
          : reason === 'travel'
            ? 'adapt_day'
            : reason === 'commitment' && criticalQuestion
              ? 'ask_critical'
              : reason === 'commitment'
                ? 'block_period'
                : reason === 'busy_week'
                  ? 'reduce_week'
                  : reason === 'short_window'
                    ? 'adapt_day'
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
    const signal = detectTravelTrainingSignal(text)

    // Continuidade ativa: usuário consegue treinar viajando → mantém o treino,
    // adaptado para hotel/quarto (curto e leve). NÃO marca descanso, NÃO bloqueia
    // o dia inteiro, NÃO compensa com intensidade máxima.
    if (signal === 'can_train') {
      return buildDecision({
        memory,
        reason: 'travel',
        affectedDates,
        workoutEffect: 'short_light',
        missionEffect: 'reduced',
        message: language.includes('en')
          ? 'You can train on the trip, so I will NOT block that day. I keep the workout alive, adapted for hotel/room — short and clean. No rest by default, no max-intensity to compensate. XP only with real validation.'
          : language.includes('it')
            ? 'Puoi allenarti in viaggio, quindi NON blocco quel giorno. Tengo l allenamento vivo, adattato per hotel/camera — corto e pulito. Niente riposo di default, niente intensità massima per compensare. XP solo con validazione reale.'
            : 'Você consegue treinar na viagem, então NÃO vou bloquear o dia. Mantenho o treino vivo, adaptado pra hotel/quarto — curto e limpo. Sem descanso por padrão, sem intensidade máxima pra compensar. XP só com validação real.',
      })
    }

    // Usuário não vai conseguir treinar → dia protegido/indisponível. Reorganiza
    // a semana, sem XP grátis e sem Arena grátis. Isso NÃO é descanso passivo nem
    // "intensidade máxima pra compensar" — é proteger o dia e seguir o plano.
    if (signal === 'cannot_train') {
      return buildDecision({
        memory,
        reason: 'travel',
        affectedDates,
        blockedPeriod: 'all_day',
        workoutEffect: 'protected',
        missionEffect: 'protected',
        message: language.includes('en')
          ? 'Got it — that day is protected/unavailable. I reorganize the week around it. No automatic max-intensity, no free XP, no free Arena.'
          : language.includes('it')
            ? 'Capito — quel giorno è protetto/non disponibile. Riorganizzo la settimana. Niente intensità massima automatica, niente XP gratis, niente Arena gratis.'
            : 'Fechado — esse dia fica protegido/indisponível. Eu reorganizo a semana sem inventar intensidade máxima, sem XP grátis e sem Arena grátis.',
      })
    }

    // Contexto insuficiente: viagem nua ("viajo na quarta"). NÃO cria impacto
    // definitivo. Propõe continuidade e pergunta o único dado crítico que falta.
    return buildDecision({
      memory,
      reason: 'travel',
      affectedDates,
      workoutEffect: 'ask_critical',
      missionEffect: 'ask_critical',
      criticalQuestion: 'training',
      message: language.includes('en')
        ? 'Traveling is not stopping. I can adapt to a hotel/room/gym workout or a short 15-minute mission. I just need one thing: will you have any time to train that day, or is it truly impossible?'
        : language.includes('it')
          ? 'Viaggiare non è fermarsi. Posso adattare ad allenamento in hotel/camera/palestra o una missione corta di 15 minuti. Mi serve solo una cosa: avrai un po di tempo per allenarti quel giorno o è davvero impossibile?'
          : 'Viajar não é parar. Eu consigo adaptar pra treino de hotel/quarto/academia ou missão curta de 15 minutos. Só preciso de uma coisa: você vai ter algum tempo pra treinar nesse dia ou vai ser impossível mesmo?',
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

  // Pouco tempo hoje ("só tenho 10 minutos") = continuidade reduzida, NUNCA
  // cancelar. Vira missão curta e direta no dia.
  if (
    /\b\d{1,2}\s*(min|mins|minuto|minutos|minutes|minuti)\b/.test(text) ||
    /\b(pouco tempo|pouquinho de tempo|little time|poco tempo|sem muito tempo)\b/.test(text)
  ) {
    const affectedDates = resolveAffectedDates(memory, text, now)
    return buildDecision({
      memory,
      reason: 'short_window',
      affectedDates,
      workoutEffect: 'minimal',
      missionEffect: 'reduced',
      message: language.includes('en')
        ? 'Short window today, not a day off. I keep a short, direct mission so the streak stays alive — execution counts, no free XP.'
        : language.includes('it')
          ? 'Finestra corta oggi, non un giorno di riposo. Tengo una missione corta e diretta per mantenere viva la streak — conta l esecuzione, niente XP gratis.'
          : 'Janela curta hoje, não é dia parado. Eu seguro uma missão curta e direta pra manter a sequência viva — conta a execução, sem XP grátis.',
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
    isProtectedDay: workoutEffect === 'protected' || missionEffect === 'protected',
    shouldAskCritical: workoutEffect === 'ask_critical' || missionEffect === 'ask_critical',
    shouldAvoidBlindPenalty: primaryImpact?.pushEffect === 'avoid_blind_charge',
    xpPolicy: primaryImpact?.xpEffect === 'no_free_xp_context_only' ? 'no_free_xp' : 'normal',
    arenaPolicy: primaryImpact?.arenaEffect === 'validation_required' ? 'validation_required' : 'normal',
  }
}

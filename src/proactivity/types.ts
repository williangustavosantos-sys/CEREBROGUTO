// ─── GUTO Proactivity System — Types ─────────────────────────────────────────
// Stores data inside memory[userId] via the existing memory-store layer.
// No Prisma, no extra DB — same pattern as context-bank.ts.

export type ProactiveMemoryType =
  | 'trip'         // viagem, cidade, destino
  | 'commitment'   // reunião, evento, compromisso
  | 'schedule'     // mudança de horário de treino
  | 'health'       // dor planejada, cansaço, procedimento
  | 'other'        // qualquer coisa relevante que o GUTO percebeu

export type ProactiveMemoryStatus =
  | 'pending_confirmation'  // GUTO extraiu, ainda não confirmou com usuário
  | 'confirmed'             // usuário confirmou
  | 'enriched'              // enriquecida com clima/feriados
  | 'surfaced'              // GUTO mencionou durante a semana
  | 'pending_validation'    // semana passou, aguarda validação
  | 'validated_happened'    // aconteceu, pode descartar
  | 'validated_postponed'   // não aconteceu, mover para próxima semana
  | 'discarded'             // descartada

export type ProactiveImpactSurface =
  | 'chat'
  | 'workout'
  | 'mission'
  | 'guto_online'
  | 'push'
  | 'xp'
  | 'arena'
  | 'path'
  | 'evolution'

export type ProactiveImpactStatus =
  | 'active'
  | 'superseded'
  | 'discarded'
  | 'validated'

export type ProactiveDecisionReason =
  | 'health'
  | 'coach_lock'
  | 'travel'
  | 'commitment'
  | 'busy_week'
  | 'short_window'   // janela curta de tempo hoje (ex.: "só tenho 10 minutos")
  | 'clear_week'

export type ProactiveDecisionKind =
  | 'adapt_day'
  | 'block_period'
  | 'reduce_week'
  | 'keep_normal'
  | 'ask_critical'
  | 'preserve_coach_lock'

export type ProactiveBlockedPeriod =
  | 'morning'
  | 'afternoon'
  | 'evening'
  | 'night'
  | 'all_day'

export type ProactiveWorkoutEffect =
  | 'normal'
  | 'short_light'
  | 'minimal'
  | 'ask_critical'   // contexto insuficiente — pergunta o dado crítico antes de decidir
  | 'protected'      // dia indisponível/protegido (não é descanso passivo; reorganiza a semana)
  | 'coach_locked'

export type ProactiveMissionEffect =
  | 'normal'
  | 'reduced'
  | 'protected_before'
  | 'ask_critical'
  | 'protected'
  | 'coach_locked'

export interface ProactiveDecision {
  id: string
  memoryId: string
  kind: ProactiveDecisionKind
  reason: ProactiveDecisionReason
  priority: number
  affectedDates: string[]
  blockedPeriod?: ProactiveBlockedPeriod
  criticalQuestion?: 'date' | 'period' | 'health_detail' | 'training'
  workoutEffect: ProactiveWorkoutEffect
  missionEffect: ProactiveMissionEffect
  message: string
  createdAt: string
}

export interface ProactiveImpact {
  id: string
  memoryId: string
  decision: ProactiveDecision
  status: ProactiveImpactStatus
  surfaces: ProactiveImpactSurface[]
  priority: number
  affectedDates: string[]
  blockedPeriod?: ProactiveBlockedPeriod
  workoutEffect: ProactiveWorkoutEffect
  missionEffect: ProactiveMissionEffect
  pushEffect: 'none' | 'avoid_blind_charge'
  xpEffect: 'none' | 'no_free_xp_context_only'
  arenaEffect: 'none' | 'validation_required'
  pathEffect: 'none' | 'adapted_context'
  evolutionEffect: 'none' | 'adapted_context'
  supersededBy?: string
  createdAt: string
  updatedAt: string
}

export interface WeatherEnrichment {
  city: string
  date: string           // ISO date: "2026-05-18"
  tempMin: number
  tempMax: number
  condition: string      // "sol", "chuva", "nublado", "parcialmente nublado"
  conditionEn: string    // English version for internal logic
  source: 'wttr.in'
  fetchedAt?: string
}

export interface HolidayEnrichment {
  name: string
  nameLocal: string
  date: string           // ISO date
  country: string
}

export interface ProactiveMemory {
  id: string
  userId: string
  type: ProactiveMemoryType
  status: ProactiveMemoryStatus
  rawText: string            // o que o usuário disse, palavra por palavra
  understood: string         // o que o GUTO entendeu, em linguagem simples
  dateText?: string          // quando: "quinta", "semana que vem", "dia 20"
  dateParsed?: string        // ISO date resolvido (best effort)
  location?: string          // cidade/local, se relevante
  weatherEnrichment?: WeatherEnrichment
  holidayEnrichment?: HolidayEnrichment[]
  weatherFetchedAt?: string
  createdAt: string
  updatedAt: string
  // TTL: pending_confirmation expires after 24h; validated_postponed gets +7d new deadline
  expiresAt?: string
  weekKey: string            // "2026-W20" — semana em que foi criado
  confirmedAt?: string
  validatedAt?: string
  discardedAt?: string
  discardRequestedAt?: string
  decision?: ProactiveDecision
}

export interface WeeklyConversation {
  weekKey: string            // "2026-W20"
  happenedAt: string         // ISO datetime da conversa de segunda
  extractionDone: boolean    // true quando a extração foi feita desta conversa
  validationDone: boolean    // true quando a validação da semana anterior foi feita
}

export interface ProactivityContext {
  weeklyConversationNeeded: boolean   // é segunda e ainda não aconteceu esta semana
  validationNeeded: boolean            // há memórias pending_validation da semana passada
  activeMemories: ProactiveMemory[]    // confirmed + enriched + surfaced (ainda válidas)
  pendingConfirmation: ProactiveMemory[] // extraídas mas não confirmadas
}

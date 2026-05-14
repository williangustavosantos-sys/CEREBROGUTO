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

export interface WeatherEnrichment {
  city: string
  date: string           // ISO date: "2026-05-18"
  tempMin: number
  tempMax: number
  condition: string      // "sol", "chuva", "nublado", "parcialmente nublado"
  conditionEn: string    // English version for internal logic
  source: 'wttr.in'
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
  createdAt: string
  updatedAt: string
  weekKey: string            // "2026-W20" — semana em que foi criado
  confirmedAt?: string
  validatedAt?: string
  discardedAt?: string
  discardRequestedAt?: string
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

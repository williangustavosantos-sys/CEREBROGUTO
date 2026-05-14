// ─── GUTO Proactivity — Weekly Conversation ──────────────────────────────────
// Determina SE e QUANDO o GUTO deve abrir a conversa de segunda-feira.
// Não gera template. O LLM decide como falar.

import {
  getWeeklyConversation,
  saveWeeklyConversation,
  getWeekKey,
  getProactiveMemoriesByStatus,
} from './proactive-store'

import type { WeeklyConversation } from './types'

// ─── Checks ───────────────────────────────────────────────────────────────────

/**
 * Returns true if today is Monday in the user's timezone context.
 * We compare using the operational context date passed from server.ts.
 */
export function isMondayToday(weekday: string): boolean {
  // weekday comes from getOperationalContext() — lowercase English
  return weekday.toLowerCase() === 'monday'
}

/**
 * Returns true if the weekly opening conversation has already happened this week.
 */
export async function hasWeeklyConversationThisWeek(userId: string): Promise<boolean> {
  const weekKey = getWeekKey()
  const wc = await getWeeklyConversation(userId, weekKey)
  return wc !== null
}

/**
 * Marks the weekly conversation as started for this week.
 * Called when the proactive Monday message is generated.
 */
export async function openWeeklyConversation(userId: string): Promise<WeeklyConversation> {
  const weekKey = getWeekKey()
  const existing = await getWeeklyConversation(userId, weekKey)
  if (existing) return existing

  const wc: WeeklyConversation = {
    weekKey,
    happenedAt: new Date().toISOString(),
    extractionDone: false,
    validationDone: false,
  }
  await saveWeeklyConversation(userId, wc)
  return wc
}

/**
 * Returns true if there are memories from last week still pending validation.
 */
export async function hasPendingValidation(userId: string): Promise<boolean> {
  const memories = await getProactiveMemoriesByStatus(userId, ['pending_validation'])
  return memories.length > 0
}

// ─── Context for the prompt injector ─────────────────────────────────────────

export interface WeeklyCheckResult {
  /** True if GUTO should open the weekly conversation this session */
  shouldOpenWeekly: boolean
  /** True if GUTO should validate memories from last week */
  shouldValidate: boolean
  /** True if the weekly conversation happened but extraction not done yet */
  extractionPending: boolean
}

export async function getWeeklyCheckResult(
  userId: string,
  weekday: string
): Promise<WeeklyCheckResult> {
  const weekKey = getWeekKey()
  const wc = await getWeeklyConversation(userId, weekKey)
  const pendingValidation = await hasPendingValidation(userId)

  const isMonday = isMondayToday(weekday)
  const weeklyDone = wc !== null

  return {
    shouldOpenWeekly: isMonday && !weeklyDone,
    shouldValidate: pendingValidation,
    extractionPending: weeklyDone && !wc.extractionDone,
  }
}

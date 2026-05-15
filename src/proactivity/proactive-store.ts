// ─── GUTO Proactivity — Storage Layer ────────────────────────────────────────
// All proactive data lives inside memory[userId].proactiveMemories
// and memory[userId].weeklyConversation — same pattern as context-bank.ts.

import {
  readMemoryStoreAsync,
  writeMemoryStoreAsync,
} from '../memory-store'
import { config } from '../config'

import type {
  ProactiveMemory,
  ProactiveMemoryStatus,
  WeeklyConversation,
} from './types'

type ProactiveMemoryCandidate = Pick<
  ProactiveMemory,
  'type' | 'understood' | 'dateText' | 'dateParsed' | 'location'
>

// ─── Write mutex ──────────────────────────────────────────────────────────────
// Node.js is single-threaded but async writes can interleave.
// All writes go through this queue so read-modify-write is always atomic.

let proactiveWriteQueue: Promise<void> = Promise.resolve()

async function atomicUpdateMemories(
  userId: string,
  updater: (current: ProactiveMemory[]) => ProactiveMemory[]
): Promise<ProactiveMemory[]> {
  let result: ProactiveMemory[] = []
  proactiveWriteQueue = proactiveWriteQueue.catch(() => {}).then(async () => {
    const store = await readMemoryStoreAsync()
    const user = asUserMemory(store[userId])
    const current = Array.isArray(user.proactiveMemories)
      ? (user.proactiveMemories as ProactiveMemory[])
      : []
    result = updater(current)
    user.proactiveMemories = result
    store[userId] = user
    await writeMemoryStoreAsync(store)
  })
  await proactiveWriteQueue
  return result
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function asUserMemory(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function generateId(userId: string): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 7)
  return `pm_${userId.slice(0, 6)}_${ts}_${rand}`
}

function normalizeSignatureText(value?: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
}

function proactiveMemorySignature(memory: ProactiveMemoryCandidate): string {
  const date = memory.dateParsed || normalizeSignatureText(memory.dateText)
  return [
    memory.type,
    date,
    normalizeSignatureText(memory.location),
    normalizeSignatureText(memory.understood),
  ].join('|')
}

export function hasMatchingProactiveMemory(
  memories: ProactiveMemory[],
  candidate: ProactiveMemoryCandidate
): boolean {
  const candidateSignature = proactiveMemorySignature(candidate)
  return memories.some((memory) => proactiveMemorySignature(memory) === candidateSignature)
}

export function getDateKey(date = new Date(), timeZone = config.timeZone): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

export function getWeekKey(date = new Date()): string {
  // ISO week key in GUTO_TIME_ZONE: "2026-W20"
  const [year, month, day] = getDateKey(date).split('-').map(Number) as [number, number, number]
  const tmp = new Date(Date.UTC(year, month - 1, day))
  const dayOfWeek = tmp.getUTCDay() || 7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayOfWeek)
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// ─── ProactiveMemory CRUD ─────────────────────────────────────────────────────

// States that should be ignored once expired (pending ones that user never confirmed)
const EXPIRABLE_STATUSES: ProactiveMemoryStatus[] = ['pending_confirmation']

export async function getProactiveMemories(userId: string): Promise<ProactiveMemory[]> {
  const store = await readMemoryStoreAsync()
  const user = asUserMemory(store[userId])
  const raw = Array.isArray(user.proactiveMemories) ? user.proactiveMemories : []
  const now = new Date().toISOString()
  return (raw as ProactiveMemory[]).filter((m) => {
    if (m.expiresAt && m.expiresAt < now && EXPIRABLE_STATUSES.includes(m.status)) {
      return false
    }
    return true
  })
}

export async function addProactiveMemory(
  userId: string,
  data: Omit<ProactiveMemory, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
): Promise<ProactiveMemory> {
  const now = new Date().toISOString()
  // pending_confirmation expires after 24h if user never responds
  const expiresAt = data.status === 'pending_confirmation'
    ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    : data.expiresAt
  const newMemory: ProactiveMemory = {
    ...data,
    id: generateId(userId),
    userId,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  }
  await atomicUpdateMemories(userId, (current) => [...current, newMemory])
  return newMemory
}

export async function updateProactiveMemory(
  userId: string,
  memoryId: string,
  updates: Partial<Omit<ProactiveMemory, 'id' | 'userId' | 'createdAt'>>
): Promise<ProactiveMemory | null> {
  let found: ProactiveMemory | null = null
  await atomicUpdateMemories(userId, (current) => {
    return current.map((m) => {
      if (m.id !== memoryId) return m
      let merged = { ...m, ...updates, updatedAt: new Date().toISOString() }

      // validated_postponed: reschedule event to +7 days and re-enter active cycle
      if (updates.status === 'validated_postponed') {
        const baseDate = m.dateParsed
          ? new Date(m.dateParsed)
          : new Date()
        const rescheduled = new Date(baseDate.getTime() + 7 * 24 * 60 * 60 * 1000)
        const rescheduledIso = rescheduled.toISOString().slice(0, 10)
        merged = {
          ...merged,
          status: 'confirmed',
          dateParsed: rescheduledIso,
          weekKey: getWeekKey(rescheduled),
          expiresAt: undefined,
          confirmedAt: new Date().toISOString(),
          validatedAt: undefined,
        }
      }

      found = merged
      return found
    })
  })
  return found
}

export async function getProactiveMemoriesByStatus(
  userId: string,
  statuses: ProactiveMemoryStatus[]
): Promise<ProactiveMemory[]> {
  const all = await getProactiveMemories(userId)
  return all.filter((m) => statuses.includes(m.status))
}

export async function markPastActiveMemoriesPendingValidation(
  userId: string,
  today = getDateKey()
): Promise<ProactiveMemory[]> {
  const activeStatuses: ProactiveMemoryStatus[] = ['confirmed', 'enriched', 'surfaced']
  const now = new Date().toISOString()
  let transitioned: ProactiveMemory[] = []

  await atomicUpdateMemories(userId, (current) => {
    return current.map((memory) => {
      if (
        activeStatuses.includes(memory.status) &&
        memory.dateParsed &&
        memory.dateParsed < today
      ) {
        const updated = { ...memory, status: 'pending_validation' as const, updatedAt: now }
        transitioned.push(updated)
        return updated
      }
      return memory
    })
  })

  return transitioned
}

export async function discardProactiveMemory(
  userId: string,
  memoryId: string
): Promise<void> {
  const now = new Date().toISOString()
  await updateProactiveMemory(userId, memoryId, {
    status: 'discarded',
    discardedAt: now,
  })
}

// Marks a confirmed/enriched/surfaced memory as awaiting discard confirmation.
// Status stays unchanged — GUTO will ask "Descarto X?" before executing.
export async function requestDiscardProactiveMemory(
  userId: string,
  memoryId: string
): Promise<void> {
  await updateProactiveMemory(userId, memoryId, {
    discardRequestedAt: new Date().toISOString(),
  })
}

// Clears a pending discard request — user decided to keep the memory.
export async function cancelDiscardRequest(
  userId: string,
  memoryId: string
): Promise<void> {
  await atomicUpdateMemories(userId, (current) =>
    current.map((m) => {
      if (m.id !== memoryId) return m
      // Spread without discardRequestedAt — JSON serialisation will omit undefined
      const { discardRequestedAt: _removed, ...rest } = m
      return { ...rest, updatedAt: new Date().toISOString() } as ProactiveMemory
    })
  )
}

// ─── WeeklyConversation CRUD ──────────────────────────────────────────────────

export async function getWeeklyConversation(
  userId: string,
  weekKey?: string
): Promise<WeeklyConversation | null> {
  const store = await readMemoryStoreAsync()
  const user = asUserMemory(store[userId])
  const wc = user.weeklyConversation as WeeklyConversation | undefined
  if (!wc) return null
  if (weekKey && wc.weekKey !== weekKey) return null
  return wc
}

export async function saveWeeklyConversation(
  userId: string,
  wc: WeeklyConversation
): Promise<void> {
  const store = await readMemoryStoreAsync()
  const user = asUserMemory(store[userId])
  user.weeklyConversation = wc
  store[userId] = user
  await writeMemoryStoreAsync(store)
}

export async function markWeeklyConversationDone(
  userId: string,
  field: 'extractionDone' | 'validationDone'
): Promise<void> {
  const weekKey = getWeekKey()
  const store = await readMemoryStoreAsync()
  const user = asUserMemory(store[userId])
  const existing = user.weeklyConversation as WeeklyConversation | undefined
  const wc = existing?.weekKey === weekKey ? existing : {
    weekKey,
    happenedAt: new Date().toISOString(),
    extractionDone: false,
    validationDone: false,
  }
  wc[field] = true
  user.weeklyConversation = wc
  store[userId] = user
  await writeMemoryStoreAsync(store)
}

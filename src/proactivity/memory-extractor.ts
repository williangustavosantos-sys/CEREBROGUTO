// ─── GUTO Proactivity — Memory Extractor ─────────────────────────────────────
// Uses Gemini to extract proactive events from conversation text.
// Returns null if nothing relevant found. Never throws.

import { config } from '../config.js'
import { getWeekKey } from './proactive-store.js'
import { addDaysToDateKey, resolveProactiveDate } from './date-resolver.js'
import type { ProactiveMemoryType } from './types.js'

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractedEvent {
  type: ProactiveMemoryType
  rawText: string       // exact quote from conversation
  understood: string    // what GUTO understood, in user's language
  dateText?: string     // "quinta", "semana que vem", "20 de maio"
  dateParsed?: string   // ISO date if resolvable: "2026-05-22"
  location?: string     // city/place if relevant
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s/-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function numberWordPt(value: string): number | null {
  const map: Record<string, number> = {
    uma: 1,
    um: 1,
    duas: 2,
    dois: 2,
    tres: 3,
    três: 3,
    quatro: 4,
  }
  const normalized = normalize(value)
  if (/^\d+$/.test(normalized)) return Number(normalized)
  return map[normalized] ?? null
}

function durationDays(text: string): number {
  const match = text.match(/\bpor\s+(\d+|uma|um|duas|dois|tres|três|quatro)\s+dias?\b/)
  const amount = match ? numberWordPt(match[1] || '') : null
  return amount && amount > 1 && amount <= 14 ? amount : 1
}

function likelyDestination(raw: string): string | undefined {
  const match = raw.match(/\b(?:para|pra|to|a)\s+([\p{L}][\p{L}\s'-]{1,40})/iu)
  const value = match?.[1]?.replace(/\b(sexta|quinta|quarta|terça|terca|segunda|domingo|sábado|sabado|por|dias?)\b.*$/i, '').trim()
  return value || undefined
}

function travelEventFromLine(rawLine: string, todayISO: string, userLanguage: string): ExtractedEvent | null {
  const rawText = rawLine.replace(/^(USER|USUARIO|USUÁRIO|GUTO):\s*/i, '').trim()
  const text = normalize(rawText)
  if (!text) return null
  if (/\b(talvez|maybe|forse|quem sabe)\b/.test(text)) return null
  const isTravel = /\b(viajo|viajar|viagem|vou viajar|viajando|parto|viaggio|travel|trip|flight)\b/.test(text)
  if (!isTravel) return null

  const resolved = resolveProactiveDate(text, todayISO)
  if (!resolved) return null

  const days = durationDays(text)
  const endDate = days > 1 ? addDaysToDateKey(resolved.dateParsed, days - 1) : undefined
  const understood =
    userLanguage === 'en-US'
      ? days > 1
        ? `Probable trip from ${resolved.dateParsed} to ${endDate}`
        : `Probable trip on ${resolved.dateParsed}`
      : userLanguage === 'it-IT'
        ? days > 1
          ? `Viaggio probabile dal ${resolved.dateParsed} al ${endDate}`
          : `Viaggio probabile il ${resolved.dateParsed}`
        : days > 1
          ? `Viagem provável entre ${resolved.dateParsed} e ${endDate}`
          : `Viagem provável em ${resolved.dateParsed}`

  return {
    type: 'trip',
    rawText,
    understood,
    dateText: days > 1 ? `${resolved.dateText} por ${days} dias` : resolved.dateText,
    dateParsed: resolved.dateParsed,
    location: likelyDestination(rawText),
  }
}

export function extractDeterministicEvents(
  conversationText: string,
  userLanguage: string,
  todayISO: string
): ExtractedEvent[] {
  const lines = conversationText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const events: ExtractedEvent[] = []
  for (const line of lines) {
    if (/^GUTO:/i.test(line)) continue
    const event = travelEventFromLine(line, todayISO, userLanguage)
    if (event) events.push(event)
  }
  return events
}

function eventSignature(event: ExtractedEvent): string {
  return [
    event.type,
    event.dateParsed || normalize(event.dateText || ''),
    normalize(event.location || ''),
  ].join('|')
}

// ─── Extraction via Gemini ────────────────────────────────────────────────────

function buildExtractorPrompt(
  conversationText: string,
  userLanguage: string,
  todayISO: string
): string {
  return `You are the semantic event extractor for GUTO, a fitness companion app.

Today is ${todayISO}.
User language: ${userLanguage}

Read this conversation and extract ONLY concrete future events that affect workout execution.
- Trips or travel to other cities/countries
- Scheduled commitments that block or change training (meetings, appointments, events)
- Training schedule changes (will train at different time/day)
- Health events that affect training (planned procedure, doctor appointment, known recovery period)
- Weekly availability answers that affect execution:
  - Busy week / overloaded week / "semana corrida" => type "other"
  - Clear week / nothing this week / "nada essa semana" => type "other"

DO NOT extract:
- Past events already happened
- Vague mentions without a time reference ("someday I want to go to Paris")
- Things the user expressed uncertainty about ("maybe I'll go")
- Workout information (already handled by the main system)
- General research questions, curiosity, trivia, weather questions, sports/team references or city mentions that are not an actual trip/commitment.
- City/team ambiguity: "vou assistir o jogo da Roma" is about a football team, NOT a trip to Rome. "Roma é linda" is not a memory. "quinta viajo para Roma" is a trip. In Italian, "martedì viaggio a Milano" / "martedì parto" is a trip; "non riesco ad allenarmi martedì" is a training-availability change for that day.
- Anything that does not change training execution, availability, location, safety, travel preparation or routine continuity.
- For weekly availability answers, use dateText: "esta semana" and leave dateParsed empty unless the user provided a specific day.

Rules:
- Understand intent across Portuguese, English, Italian, slang and typos. Do NOT use keyword matching.
- If a phrase could mean multiple things and there is not enough context, do not extract it.
- Multiple events in one user message must become multiple array items.

Return a JSON array. Each item must have:
- type: "trip" | "commitment" | "schedule" | "health" | "other"
- rawText: the exact phrase the user said (copy verbatim)
- understood: a short natural sentence in the user's language summarizing what GUTO understood
- dateText: the date/time reference the user used (optional)
- dateParsed: resolved ISO date "YYYY-MM-DD" if you can determine it with confidence (optional)
- location: city or place name if mentioned (optional)

If nothing relevant found, return an empty array [].

CONVERSATION:
${conversationText}

Respond ONLY with a valid JSON array. No markdown, no explanation.`
}

export async function extractEventsFromConversation(
  conversationText: string,
  userLanguage: string,
  todayISO: string
): Promise<ExtractedEvent[]> {
  const deterministic = extractDeterministicEvents(conversationText, userLanguage, todayISO)
  if (!config.geminiApiKey || !conversationText.trim()) return deterministic

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`
    const prompt = buildExtractorPrompt(conversationText, userLanguage, todayISO)

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 800,
        },
      }),
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) return []

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    if (!rawText) return []

    const parsed = JSON.parse(rawText)
    if (!Array.isArray(parsed)) return []

    // Validate and sanitize
    const semantic: ExtractedEvent[] = parsed
      .filter((item): item is ExtractedEvent => {
        return (
          typeof item === 'object' &&
          item !== null &&
          typeof item.type === 'string' &&
          typeof item.rawText === 'string' &&
          typeof item.understood === 'string' &&
          item.rawText.length > 0 &&
          item.understood.length > 0
        )
      })
      .map((item) => {
        const rawEventText = String(item.rawText).slice(0, 500)
        const canonicalDate = resolveProactiveDate(
          [rawEventText, typeof item.dateText === 'string' ? item.dateText : ''].filter(Boolean).join(' '),
          todayISO
        )
        return {
          type: item.type as ProactiveMemoryType,
          rawText: rawEventText,
          understood: String(item.understood).slice(0, 300),
          dateText: canonicalDate?.dateText || (typeof item.dateText === 'string' ? item.dateText : undefined),
          dateParsed: canonicalDate?.dateParsed || (
            typeof item.dateParsed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.dateParsed)
              ? item.dateParsed
              : undefined
          ),
          location: typeof item.location === 'string' ? item.location : undefined,
        }
      })

    const seen = new Set(semantic.map(eventSignature))
    const merged = [...semantic]
    for (const event of deterministic) {
      const signature = eventSignature(event)
      if (!seen.has(signature)) {
        seen.add(signature)
        merged.push(event)
      }
    }
    return merged
  } catch {
    return deterministic
  }
}

// ─── Build proactive memories from extracted events ────────────────────────────

export function buildPendingMemoryData(
  userId: string,
  event: ExtractedEvent
): Omit<import('./types.js').ProactiveMemory, 'id' | 'userId' | 'createdAt' | 'updatedAt'> {
  return {
    type: event.type,
    status: 'pending_confirmation',
    rawText: event.rawText,
    understood: event.understood,
    dateText: event.dateText,
    dateParsed: event.dateParsed,
    location: event.location,
    weekKey: getWeekKey(),
    ...(event.type === 'trip'
      ? { stage: 'continuity_question' as const, confirmationStage: 'event' as const }
      : { stage: 'event_confirmation' as const }),
  }
}

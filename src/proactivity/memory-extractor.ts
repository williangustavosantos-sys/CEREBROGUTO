// ─── GUTO Proactivity — Memory Extractor ─────────────────────────────────────
// Uses Gemini to extract proactive events from conversation text.
// Returns null if nothing relevant found. Never throws.

import { config } from '../config'
import { getWeekKey } from './proactive-store'
import type { ProactiveMemoryType } from './types'

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractedEvent {
  type: ProactiveMemoryType
  rawText: string       // exact quote from conversation
  understood: string    // what GUTO understood, in user's language
  dateText?: string     // "quinta", "semana que vem", "20 de maio"
  dateParsed?: string   // ISO date if resolvable: "2026-05-22"
  location?: string     // city/place if relevant
}

// ─── Extraction via Gemini ────────────────────────────────────────────────────

const EXTRACTOR_MODEL = 'gemini-2.5-flash-lite'

function buildExtractorPrompt(
  conversationText: string,
  userLanguage: string,
  todayISO: string
): string {
  return `You are an event extraction assistant for GUTO, a fitness companion app.

Today is ${todayISO}.
User language: ${userLanguage}

Read this conversation and extract ONLY concrete future events that GUTO should remember:
- Trips or travel to other cities/countries
- Scheduled commitments (meetings, appointments, events)
- Training schedule changes (will train at different time/day)
- Health events (planned procedure, doctor appointment, known recovery period)

DO NOT extract:
- Past events already happened
- Vague mentions without a time reference ("someday I want to go to Paris")
- Things the user expressed uncertainty about ("maybe I'll go")
- Workout information (already handled by the main system)

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
  if (!config.geminiApiKey || !conversationText.trim()) return []

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACTOR_MODEL}:generateContent?key=${config.geminiApiKey}`
    const prompt = buildExtractorPrompt(conversationText, userLanguage, todayISO)

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          response_mime_type: 'application/json',
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
    return parsed
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
      .map((item) => ({
        type: item.type as ProactiveMemoryType,
        rawText: String(item.rawText).slice(0, 500),
        understood: String(item.understood).slice(0, 300),
        dateText: typeof item.dateText === 'string' ? item.dateText : undefined,
        dateParsed: typeof item.dateParsed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.dateParsed)
          ? item.dateParsed
          : undefined,
        location: typeof item.location === 'string' ? item.location : undefined,
      }))
  } catch {
    return []
  }
}

// ─── Build proactive memories from extracted events ────────────────────────────

export function buildPendingMemoryData(
  userId: string,
  event: ExtractedEvent
): Omit<import('./types').ProactiveMemory, 'id' | 'userId' | 'createdAt' | 'updatedAt'> {
  return {
    type: event.type,
    status: 'pending_confirmation',
    rawText: event.rawText,
    understood: event.understood,
    dateText: event.dateText,
    dateParsed: event.dateParsed,
    location: event.location,
    weekKey: getWeekKey(),
  }
}

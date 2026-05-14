// ─── GUTO Proactivity — Memory Enricher ───────────────────────────────────────
// Enriches confirmed memories with weather (wttr.in) and holidays (date.nager.at).
// No API keys required. Fails silently — enrichment is optional.

import {
  getProactiveMemoriesByStatus,
  updateProactiveMemory,
  getDateKey,
} from './proactive-store'

import type { WeatherEnrichment, HolidayEnrichment } from './types'

// ─── Weather via wttr.in ──────────────────────────────────────────────────────

const WEATHER_CONDITION_MAP: Record<string, { pt: string; it: string; en: string }> = {
  sunny: { pt: 'sol', it: 'soleggiato', en: 'sunny' },
  'partly cloudy': { pt: 'parcialmente nublado', it: 'parzialmente nuvoloso', en: 'partly cloudy' },
  cloudy: { pt: 'nublado', it: 'nuvoloso', en: 'cloudy' },
  overcast: { pt: 'nublado', it: 'coperto', en: 'overcast' },
  rain: { pt: 'chuva', it: 'pioggia', en: 'rain' },
  drizzle: { pt: 'garoa', it: 'pioggerella', en: 'drizzle' },
  snow: { pt: 'neve', it: 'neve', en: 'snow' },
  thunderstorm: { pt: 'tempestade', it: 'temporale', en: 'thunderstorm' },
  fog: { pt: 'neblina', it: 'nebbia', en: 'fog' },
  mist: { pt: 'névoa', it: 'foschia', en: 'mist' },
  clear: { pt: 'limpo', it: 'sereno', en: 'clear' },
}

function translateCondition(raw: string, lang: string): string {
  const lower = raw.toLowerCase()
  for (const [key, val] of Object.entries(WEATHER_CONDITION_MAP)) {
    if (lower.includes(key)) {
      if (lang === 'it-IT') return val.it
      if (lang === 'en-US') return val.en
      return val.pt
    }
  }
  return raw
}

interface WttrDay {
  date: string
  mintempC: string
  maxtempC: string
  hourly?: Array<{ weatherDesc: Array<{ value: string }> }>
}

export async function fetchWeatherForCity(
  city: string,
  date: string, // ISO: "2026-05-18"
  language = 'pt-BR'
): Promise<WeatherEnrichment | null> {
  if (!city) return null

  try {
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=en`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'GUTO-App/1.0' },
    })
    if (!res.ok) return null

    const data = (await res.json()) as { weather?: WttrDay[] }
    const days: WttrDay[] = data?.weather ?? []

    // Find the day matching the requested date (wttr returns 3 days from today)
    const targetDay = days.find((d) => d.date === date) ?? days[0]
    if (!targetDay) return null

    const rawCondition =
      targetDay.hourly?.[4]?.weatherDesc?.[0]?.value ??
      targetDay.hourly?.[0]?.weatherDesc?.[0]?.value ??
      'clear'

    return {
      city,
      date,
      tempMin: Number(targetDay.mintempC),
      tempMax: Number(targetDay.maxtempC),
      condition: translateCondition(rawCondition, language),
      conditionEn: rawCondition,
      source: 'wttr.in',
    }
  } catch {
    return null
  }
}

// ─── Holidays via date.nager.at ───────────────────────────────────────────────

function getCountryCode(country: string): string | null {
  const map: Record<string, string> = {
    brazil: 'BR', brasil: 'BR', br: 'BR',
    italy: 'IT', italia: 'IT', itália: 'IT', it: 'IT',
    'united states': 'US', usa: 'US', us: 'US', 'estados unidos': 'US',
    portugal: 'PT', pt: 'PT',
    france: 'FR', franca: 'FR', fr: 'FR',
    spain: 'ES', espanha: 'ES', es: 'ES',
    germany: 'DE', alemanha: 'DE', de: 'DE',
    'united kingdom': 'GB', uk: 'GB', gb: 'GB', england: 'GB',
    argentina: 'AR', ar: 'AR',
    mexico: 'MX', méxico: 'MX', mx: 'MX',
  }
  return map[country.toLowerCase().trim()] ?? null
}

interface NagerHoliday {
  date: string
  name: string
  localName: string
}

function formatUtcDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function addDaysToIsoDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const utc = new Date(Date.UTC(year, month - 1, day))
  utc.setUTCDate(utc.getUTCDate() + days)
  return formatUtcDate(utc)
}

function getIsoWeekMonday(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const utc = new Date(Date.UTC(year, month - 1, day))
  const dayOfWeek = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() - dayOfWeek + 1)
  return formatUtcDate(utc)
}

export async function fetchHolidaysForWeek(
  countryCode: string,
  weekStart: string // ISO date of Monday
): Promise<HolidayEnrichment[]> {
  if (!countryCode) return []

  try {
    const year = weekStart.slice(0, 4)
    const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'GUTO-App/1.0' },
    })
    if (!res.ok) return []

    const data = (await res.json()) as NagerHoliday[]

    // Filter to this week (Monday to Sunday)
    const monStr = weekStart
    const sunStr = addDaysToIsoDate(weekStart, 6)

    return data
      .filter((h) => h.date >= monStr && h.date <= sunStr)
      .map((h) => ({
        name: h.name,
        nameLocal: h.localName,
        date: h.date,
        country: countryCode,
      }))
  } catch {
    return []
  }
}

// ─── Enrich a single memory ───────────────────────────────────────────────────

export async function enrichMemory(
  userId: string,
  memoryId: string,
  memory: import('./types').ProactiveMemory,
  userCountry: string,
  language: string
): Promise<void> {
  const updates: Partial<import('./types').ProactiveMemory> = {
    status: 'enriched',
  }

  // Weather: only for trips with a known city and date
  if ((memory.type === 'trip' || memory.type === 'commitment') && memory.location && memory.dateParsed) {
    const weather = await fetchWeatherForCity(memory.location, memory.dateParsed, language)
    if (weather) {
      updates.weatherEnrichment = weather
    }
  }

  // Holidays: for any memory with a date, look up holidays in user's country
  if (memory.dateParsed && userCountry) {
    const countryCode = getCountryCode(userCountry)
    if (countryCode) {
      const weekStart = getIsoWeekMonday(memory.dateParsed)

      const holidays = await fetchHolidaysForWeek(countryCode, weekStart)
      if (holidays.length > 0) {
        updates.holidayEnrichment = holidays
      }
    }
  }

  await updateProactiveMemory(userId, memoryId, updates)
}

// ─── Batch enrichment (called by cron or on demand) ──────────────────────────

export async function enrichPendingMemories(
  userId: string,
  userCountry: string,
  language: string
): Promise<void> {
  const pending = await getProactiveMemoriesByStatus(userId, ['confirmed'])
  for (const memory of pending) {
    try {
      await enrichMemory(userId, memory.id, memory, userCountry, language)
    } catch {
      // Enrichment is non-critical — never fails the system
    }
  }
}

// ─── Get current week's Monday ISO date ──────────────────────────────────────

export function getCurrentWeekMonday(): string {
  return getIsoWeekMonday(getDateKey())
}

const DAY_MS = 24 * 60 * 60 * 1000

export interface ProactiveDateResolution {
  dateParsed: string
  dateText: string
}

const WEEKDAYS: Array<{ day: number; tokens: string[]; label: string }> = [
  { day: 0, tokens: ['domingo', 'sunday', 'domenica'], label: 'domingo' },
  { day: 1, tokens: ['segunda feira', 'segunda', 'monday', 'lunedi'], label: 'segunda-feira' },
  { day: 2, tokens: ['terca feira', 'terca', 'tuesday', 'martedi'], label: 'terça-feira' },
  { day: 3, tokens: ['quarta feira', 'quarta', 'wednesday', 'mercoledi'], label: 'quarta-feira' },
  { day: 4, tokens: ['quinta feira', 'quinta', 'thursday', 'giovedi'], label: 'quinta-feira' },
  { day: 5, tokens: ['sexta feira', 'sexta', 'friday', 'venerdi'], label: 'sexta-feira' },
  { day: 6, tokens: ['sabado', 'saturday', 'sabato'], label: 'sábado' },
]

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s/-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function parseDateKey(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T12:00:00.000Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toDateKey(value: Date): string {
  return value.toISOString().slice(0, 10)
}

export function addDaysToDateKey(value: string, amount: number): string {
  const parsed = parseDateKey(value)
  if (!parsed) return value
  return toDateKey(new Date(parsed.getTime() + amount * DAY_MS))
}

function numberWord(value: string): number | null {
  const words: Record<string, number> = {
    uma: 1,
    um: 1,
    duas: 2,
    dois: 2,
    tres: 3,
    tre: 3,
    three: 3,
    quattro: 4,
    quatro: 4,
    four: 4,
  }
  const normalized = normalize(value)
  return /^\d+$/.test(normalized) ? Number(normalized) : words[normalized] ?? null
}

export function resolveProactiveDate(
  rawText: string,
  todayKey: string
): ProactiveDateResolution | null {
  const today = parseDateKey(todayKey)
  if (!today) return null
  const text = normalize(rawText)
  if (!text) return null

  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (iso?.[1] && parseDateKey(iso[1])) {
    return { dateParsed: iso[1], dateText: iso[1] }
  }

  const explicit = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/)
  if (explicit) {
    const day = Number(explicit[1])
    const month = Number(explicit[2])
    const currentYear = today.getUTCFullYear()
    const rawYear = explicit[3]
    const year = rawYear ? (rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear)) : currentYear
    let parsed = new Date(Date.UTC(year, month - 1, day, 12))
    if (!rawYear && parsed.getTime() < today.getTime()) {
      parsed = new Date(Date.UTC(year + 1, month - 1, day, 12))
    }
    if (parsed.getUTCDate() === day && parsed.getUTCMonth() === month - 1) {
      return { dateParsed: toDateKey(parsed), dateText: explicit[0] }
    }
  }

  const mentionedWeekday = WEEKDAYS.find((item) => item.tokens.some((token) => text.includes(token)))
  const nextWeekMatch = text.match(/\b(semana que vem|proxima semana|next week|settimana prossima|prossima settimana)\b/)
  if (mentionedWeekday && nextWeekMatch) {
    const currentDay = today.getUTCDay()
    const daysUntilNextMonday = (8 - currentDay) % 7 || 7
    const weekdayOffsetFromMonday = (mentionedWeekday.day + 6) % 7
    return {
      dateParsed: addDaysToDateKey(todayKey, daysUntilNextMonday + weekdayOffsetFromMonday),
      dateText: mentionedWeekday.label,
    }
  }

  const relative: Array<{ pattern: RegExp; days: number; fallback: string }> = [
    { pattern: /\b(hoje|today|oggi)\b/, days: 0, fallback: 'hoje' },
    { pattern: /\b(amanha|tomorrow|domani)\b/, days: 1, fallback: 'amanhã' },
    {
      pattern: /\b(semana que vem|proxima semana|next week|settimana prossima|prossima settimana)\b/,
      days: 7,
      fallback: 'semana que vem',
    },
  ]
  for (const item of relative) {
    const match = text.match(item.pattern)
    if (match) {
      return {
        dateParsed: addDaysToDateKey(todayKey, item.days),
        dateText: match[0] || item.fallback,
      }
    }
  }

  const weeks = text.match(/\b(?:daqui|in|tra)\s+(\d+|uma|um|duas|dois|tres|three|tre|quatro|four|quattro)\s+(?:semanas?|weeks?|settimane?)\b/)
  if (weeks?.[1]) {
    const amount = numberWord(weeks[1])
    if (amount && amount <= 8) {
      return { dateParsed: addDaysToDateKey(todayKey, amount * 7), dateText: weeks[0] }
    }
  }

  const days = text.match(/\b(?:daqui|in|tra)\s+(\d+|uma|um|duas|dois|tres|three|tre|quatro|four|quattro)\s+(?:dias?|days?|giorni?)\b/)
  if (days?.[1]) {
    const amount = numberWord(days[1])
    if (amount && amount <= 30) {
      return { dateParsed: addDaysToDateKey(todayKey, amount), dateText: days[0] }
    }
  }

  const weekday = mentionedWeekday
  if (!weekday) return null
  const currentDay = today.getUTCDay()
  const delta = (weekday.day - currentDay + 7) % 7
  return {
    dateParsed: addDaysToDateKey(todayKey, delta === 0 ? 7 : delta),
    dateText: weekday.label,
  }
}

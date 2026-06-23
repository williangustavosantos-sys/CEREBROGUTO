import { getAdaptationForDate, type ProactiveAdaptationForDate } from './proactivity/decision-engine.js'
import { fetchHolidaysForWeek, fetchWeatherForCity } from './proactivity/memory-enricher.js'
import type { HolidayEnrichment, ProactiveImpact, ProactiveMemory, WeatherEnrichment } from './proactivity/types.js'

export interface DailyPresenceMemory {
  userId: string
  name?: string
  language?: string
  trainedToday?: boolean
  adaptedMissionToday?: boolean
  totalXp?: number
  streak?: number
  trainingLocation?: string
  trainingStatus?: string
  trainingLimitations?: string
  trainingAge?: number
  userAge?: number
  biologicalSex?: string
  trainingLevel?: string
  trainingGoal?: string
  preferredTrainingLocation?: string
  trainingPathology?: string
  country?: string
  countryCode?: string
  city?: string
  heightCm?: number
  weightKg?: number
  foodRestrictions?: string
  lastWorkoutPlan?: { title?: string; focus?: string; focusKey?: string; scheduledFor?: string } | null
  weeklyWorkoutPlan?: unknown
  weeklyDietPlan?: unknown
  dietGenerationStatus?: string
  activeExercise?: { source?: string; name?: string; updatedAt?: string } | null
  proactiveMemories?: ProactiveMemory[]
  proactiveImpacts?: ProactiveImpact[]
}

export interface DailyPresenceContext {
  userId: string
  dateKey: string
  language: string
  profile: {
    age?: number
    biologicalSex?: string
    trainingLevel?: string
    trainingGoal?: string
    trainingLocation?: string
    limitation?: string
    country?: string
    countryCode?: string
    city?: string
    heightCm?: number
    weightKg?: number
    foodRestrictions?: string
  }
  location: {
    city?: string
    country?: string
    countryCode?: string
    source: 'calibration' | 'trip_destination' | 'unknown'
  }
  weather: {
    value: WeatherEnrichment | null
    source: 'cache' | 'memory' | 'fetch' | 'none'
    isBadForOutdoorTraining: boolean
  }
  holidays: {
    today: HolidayEnrichment[]
    week: HolidayEnrichment[]
    source: 'cache' | 'memory' | 'fetch' | 'none'
  }
  proactivity: {
    adaptation: ProactiveAdaptationForDate
    activeMemory: ProactiveMemory | null
    activeImpact: ProactiveImpact | null
    tripToday: ProactiveMemory | null
    trainingAdapted?: boolean
  }
  workout: {
    trainedToday: boolean
    hasPlan: boolean
    planTitle?: string
    focusKey?: string
    workoutEffect: ProactiveAdaptationForDate['workoutEffect']
    missionEffect: ProactiveAdaptationForDate['missionEffect']
    isProtectedDay: boolean
    isAdaptedDay: boolean
    shouldAvoidBlindPenalty: boolean
  }
  diet: {
    status: string
    hasPlan: boolean
    lightContext: 'travel_adapted' | 'travel_protected' | 'normal'
  }
  gutoOnline: {
    activeExerciseName?: string
    source?: string
    shouldAvoidTrainingCharge: boolean
  }
}

type CacheEntry<T> = {
  dateKey: string
  value: T
}

const weatherCache = new Map<string, CacheEntry<WeatherEnrichment | null>>()
const holidayCache = new Map<string, CacheEntry<HolidayEnrichment[]>>()

const BAD_WEATHER_TERMS = ['rain', 'drizzle', 'thunderstorm', 'snow', 'storm']
const ACTIVE_MEMORY_STATUSES = new Set(['confirmed', 'enriched', 'surfaced'])

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function normalizeCachePart(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function formatDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function formatUtcDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function getIsoWeekMonday(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number]
  const utc = new Date(Date.UTC(year, month - 1, day))
  const dayOfWeek = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() - dayOfWeek + 1)
  return formatUtcDate(utc)
}

function isActiveProactiveMemory(memory: ProactiveMemory | undefined): memory is ProactiveMemory {
  return Boolean(memory && ACTIVE_MEMORY_STATUSES.has(memory.status))
}

function isBadWeather(weather: WeatherEnrichment | null): boolean {
  const condition = clean(weather?.conditionEn).toLowerCase()
  return Boolean(condition && BAD_WEATHER_TERMS.some((term) => condition.includes(term)))
}

function findMemoryForImpact(memory: DailyPresenceMemory, impact: ProactiveImpact | null): ProactiveMemory | null {
  if (!impact) return null
  return (memory.proactiveMemories || []).find((item) => item.id === impact.memoryId) || null
}

function findTripToday(memory: DailyPresenceMemory, dateKey: string): ProactiveMemory | null {
  return (memory.proactiveMemories || []).find((item) =>
    item.type === 'trip' &&
    item.dateParsed === dateKey &&
    isActiveProactiveMemory(item)
  ) || null
}

function findExistingWeather(memory: DailyPresenceMemory, city: string, dateKey: string): WeatherEnrichment | null {
  const normalizedCity = normalizeCachePart(city)
  if (!normalizedCity) return null
  const match = (memory.proactiveMemories || []).find((item) => {
    const weather = item.weatherEnrichment
    if (!weather || weather.date !== dateKey) return false
    return normalizeCachePart(weather.city) === normalizedCity
  })
  return match?.weatherEnrichment || null
}

function findExistingHolidays(memory: DailyPresenceMemory, countryCode: string, dateKey: string): HolidayEnrichment[] {
  const weekStart = getIsoWeekMonday(dateKey)
  const weekEnd = addDaysToIsoDate(weekStart, 6)
  return (memory.proactiveMemories || [])
    .flatMap((item) => item.holidayEnrichment || [])
    .filter((holiday) =>
      holiday.country.toUpperCase() === countryCode.toUpperCase() &&
      holiday.date >= weekStart &&
      holiday.date <= weekEnd
    )
}

function addDaysToIsoDate(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number]
  const utc = new Date(Date.UTC(year, month - 1, day))
  utc.setUTCDate(utc.getUTCDate() + days)
  return formatUtcDate(utc)
}

async function resolveDailyWeather({
  memory,
  city,
  dateKey,
  language,
  allowExternalFetch,
}: {
  memory: DailyPresenceMemory
  city?: string
  dateKey: string
  language: string
  allowExternalFetch: boolean
}): Promise<DailyPresenceContext['weather']> {
  const cleanCity = clean(city)
  if (!cleanCity) return { value: null, source: 'none', isBadForOutdoorTraining: false }

  const fromMemory = findExistingWeather(memory, cleanCity, dateKey)
  if (fromMemory) {
    return { value: fromMemory, source: 'memory', isBadForOutdoorTraining: isBadWeather(fromMemory) }
  }

  const key = `${memory.userId}:${dateKey}:${normalizeCachePart(cleanCity)}:${language}`
  const cached = weatherCache.get(key)
  if (cached?.dateKey === dateKey) {
    return { value: cached.value, source: 'cache', isBadForOutdoorTraining: isBadWeather(cached.value) }
  }

  if (!allowExternalFetch) return { value: null, source: 'none', isBadForOutdoorTraining: false }

  const fetched = await fetchWeatherForCity(cleanCity, dateKey, language).catch(() => null)
  weatherCache.set(key, { dateKey, value: fetched })
  return { value: fetched, source: 'fetch', isBadForOutdoorTraining: isBadWeather(fetched) }
}

async function resolveDailyHolidays({
  memory,
  countryCode,
  dateKey,
  allowExternalFetch,
}: {
  memory: DailyPresenceMemory
  countryCode?: string
  dateKey: string
  allowExternalFetch: boolean
}): Promise<DailyPresenceContext['holidays']> {
  const code = clean(countryCode).toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) return { today: [], week: [], source: 'none' }

  const fromMemory = findExistingHolidays(memory, code, dateKey)
  if (fromMemory.length > 0) {
    return { today: fromMemory.filter((holiday) => holiday.date === dateKey), week: fromMemory, source: 'memory' }
  }

  const weekStart = getIsoWeekMonday(dateKey)
  const key = `${code}:${weekStart}`
  const cached = holidayCache.get(key)
  if (cached?.dateKey === dateKey) {
    return { today: cached.value.filter((holiday) => holiday.date === dateKey), week: cached.value, source: 'cache' }
  }

  if (!allowExternalFetch) return { today: [], week: [], source: 'none' }

  const fetched = await fetchHolidaysForWeek(code, weekStart).catch(() => [])
  holidayCache.set(key, { dateKey, value: fetched })
  return { today: fetched.filter((holiday) => holiday.date === dateKey), week: fetched, source: 'fetch' }
}

export async function buildDailyPresenceContext(
  memory: DailyPresenceMemory,
  options: {
    dateKey?: string
    language?: string
    now?: Date
    timeZone?: string
    allowExternalFetch?: boolean
  } = {}
): Promise<DailyPresenceContext> {
  const language = clean(options.language || memory.language) || 'pt-BR'
  const timeZone = options.timeZone || process.env.GUTO_TIME_ZONE || 'Europe/Rome'
  const dateKey = options.dateKey || formatDateKey(options.now || new Date(), timeZone)
  const adaptation = getAdaptationForDate(memory, dateKey)
  const activeImpact = adaptation.primaryImpact || null
  const memoryForImpact = findMemoryForImpact(memory, activeImpact)
  const tripToday = findTripToday(memory, dateKey)
  const activeMemory = isActiveProactiveMemory(memoryForImpact || undefined)
    ? memoryForImpact
    : tripToday

  const calibratedCity = clean(memory.city)
  const calibratedCountry = clean(memory.country)
  const calibratedCountryCode = clean(memory.countryCode).toUpperCase()
  const tripCity = activeMemory?.type === 'trip' && activeMemory.dateParsed === dateKey
    ? clean(activeMemory.location)
    : ''
  const effectiveCity = tripCity || calibratedCity
  const locationSource: DailyPresenceContext['location']['source'] = tripCity
    ? 'trip_destination'
    : effectiveCity
      ? 'calibration'
      : 'unknown'

  const [weather, holidays] = await Promise.all([
    resolveDailyWeather({
      memory,
      city: effectiveCity,
      dateKey,
      language,
      allowExternalFetch: options.allowExternalFetch === true,
    }),
    resolveDailyHolidays({
      memory,
      countryCode: calibratedCountryCode,
      dateKey,
      allowExternalFetch: options.allowExternalFetch === true,
    }),
  ])

  const hasDietPlan = Boolean(memory.weeklyDietPlan || memory.dietGenerationStatus === 'generated')
  const travelLightContext =
    activeMemory?.type === 'trip' && activeMemory.dateParsed === dateKey
      ? activeMemory.trainingAdapted === false || adaptation.isProtectedDay
        ? 'travel_protected'
        : 'travel_adapted'
      : 'normal'

  return {
    userId: memory.userId,
    dateKey,
    language,
    profile: {
      age: memory.userAge ?? memory.trainingAge,
      biologicalSex: clean(memory.biologicalSex) || undefined,
      trainingLevel: clean(memory.trainingLevel || memory.trainingStatus) || undefined,
      trainingGoal: clean(memory.trainingGoal) || undefined,
      trainingLocation: clean(memory.preferredTrainingLocation || memory.trainingLocation) || undefined,
      limitation: clean(memory.trainingPathology || memory.trainingLimitations) || undefined,
      country: calibratedCountry || undefined,
      countryCode: calibratedCountryCode || undefined,
      city: calibratedCity || undefined,
      heightCm: memory.heightCm,
      weightKg: memory.weightKg,
      foodRestrictions: clean(memory.foodRestrictions) || undefined,
    },
    location: {
      city: effectiveCity || undefined,
      country: calibratedCountry || undefined,
      countryCode: calibratedCountryCode || undefined,
      source: locationSource,
    },
    weather,
    holidays,
    proactivity: {
      adaptation,
      activeMemory,
      activeImpact,
      tripToday,
      trainingAdapted: activeMemory?.trainingAdapted,
    },
    workout: {
      trainedToday: Boolean(memory.trainedToday),
      hasPlan: Boolean(memory.lastWorkoutPlan),
      planTitle: clean(memory.lastWorkoutPlan?.title || memory.lastWorkoutPlan?.focus) || undefined,
      focusKey: clean(memory.lastWorkoutPlan?.focusKey) || undefined,
      workoutEffect: adaptation.workoutEffect,
      missionEffect: adaptation.missionEffect,
      isProtectedDay: adaptation.isProtectedDay,
      isAdaptedDay: adaptation.isAdaptedDay,
      shouldAvoidBlindPenalty: adaptation.shouldAvoidBlindPenalty,
    },
    diet: {
      status: clean(memory.dietGenerationStatus) || 'idle',
      hasPlan: hasDietPlan,
      lightContext: travelLightContext,
    },
    gutoOnline: {
      activeExerciseName: clean(memory.activeExercise?.name) || undefined,
      source: clean(memory.activeExercise?.source) || undefined,
      shouldAvoidTrainingCharge: adaptation.isProtectedDay || adaptation.shouldAvoidBlindPenalty,
    },
  }
}

export function formatDailyPresenceContextForPrompt(context: DailyPresenceContext): string {
  const facts: string[] = []
  facts.push(`date=${context.dateKey}`)

  const location = [
    context.location.city,
    context.location.countryCode || context.location.country,
  ].filter(Boolean).join('/')
  if (location) facts.push(`location=${location}:${context.location.source}`)

  const profileBits = [
    context.profile.age ? `age:${context.profile.age}` : '',
    context.profile.biologicalSex ? `sex:${context.profile.biologicalSex}` : '',
    context.profile.trainingGoal ? `goal:${context.profile.trainingGoal}` : '',
    context.profile.trainingLevel ? `level:${context.profile.trainingLevel}` : '',
    context.profile.trainingLocation ? `trainAt:${context.profile.trainingLocation}` : '',
    context.profile.limitation ? `limit:${context.profile.limitation}` : '',
    context.profile.weightKg ? `kg:${context.profile.weightKg}` : '',
    context.profile.heightCm ? `cm:${context.profile.heightCm}` : '',
    context.profile.foodRestrictions ? `food:${context.profile.foodRestrictions}` : '',
  ].filter(Boolean)
  if (profileBits.length) facts.push(`profile=${profileBits.join(',')}`)

  if (context.weather.value) {
    facts.push(`weather=${context.weather.value.conditionEn || context.weather.value.condition}:${context.weather.value.tempMin}-${context.weather.value.tempMax}C`)
  }
  if (context.holidays.today.length > 0) {
    facts.push(`holidayToday=${context.holidays.today.map((h) => h.nameLocal || h.name).join(',')}`)
  }

  const memory = context.proactivity.activeMemory
  if (memory) {
    const eventBits = [
      memory.type,
      memory.dateParsed || context.dateKey,
      memory.location ? `at:${memory.location}` : '',
      typeof memory.trainingAdapted === 'boolean' ? `trainingAdapted:${memory.trainingAdapted}` : '',
    ].filter(Boolean)
    facts.push(`event=${eventBits.join(',')}`)
  }

  if (context.workout.isProtectedDay) facts.push('workout=protected:noBlindCharge')
  else if (context.workout.isAdaptedDay) facts.push(`workout=adapted:${context.workout.workoutEffect}`)
  else facts.push(`workout=${context.workout.hasPlan ? 'planned' : 'not_planned'}`)

  if (context.diet.lightContext !== 'normal') facts.push(`diet=${context.diet.lightContext}`)
  else facts.push(`diet=${context.diet.status}`)

  if (context.gutoOnline.activeExerciseName) {
    facts.push(`gutoOnline=${context.gutoOnline.activeExerciseName}`)
  }

  return facts.join(' | ')
}

export function shouldSuppressTrainingCharge(context: DailyPresenceContext): boolean {
  return context.workout.isProtectedDay
}

export function clearDailyPresenceContextCache(): void {
  weatherCache.clear()
  holidayCache.clear()
}

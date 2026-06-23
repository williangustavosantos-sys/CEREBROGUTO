import "./test-env.js"
import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildDailyPresenceContext,
  clearDailyPresenceContextCache,
  formatDailyPresenceContextForPrompt,
  shouldSuppressTrainingCharge,
  type DailyPresenceMemory,
} from "../src/daily-presence-context.js"
import type { ProactiveImpact, ProactiveMemory } from "../src/proactivity/types.js"

const originalFetch = globalThis.fetch.bind(globalThis)
const DATE = "2026-06-24"

function makeTripMemory(overrides: Partial<ProactiveMemory> = {}): ProactiveMemory {
  return {
    id: "trip-1",
    userId: "daily-user",
    type: "trip",
    status: "confirmed",
    rawText: "viajo na quarta",
    understood: "Viagem na quarta",
    dateText: "quarta",
    dateParsed: DATE,
    location: "Milano",
    createdAt: "2026-06-20T10:00:00.000Z",
    updatedAt: "2026-06-20T10:00:00.000Z",
    weekKey: "2026-W26",
    trainingAdapted: false,
    stage: "confirmed_protected",
    ...overrides,
  }
}

function makeImpact(overrides: Partial<ProactiveImpact> = {}): ProactiveImpact {
  return {
    id: "impact-1",
    memoryId: "trip-1",
    status: "active",
    surfaces: ["chat", "workout", "mission", "guto_online", "push", "xp", "path"],
    priority: 80,
    affectedDates: [DATE],
    workoutEffect: "protected",
    missionEffect: "protected",
    pushEffect: "avoid_blind_charge",
    xpEffect: "no_free_xp_context_only",
    arenaEffect: "validation_required",
    pathEffect: "adapted_context",
    evolutionEffect: "adapted_context",
    createdAt: "2026-06-20T10:00:00.000Z",
    updatedAt: "2026-06-20T10:00:00.000Z",
    decision: {
      id: "decision-1",
      memoryId: "trip-1",
      kind: "adapt_day",
      reason: "travel",
      priority: 80,
      affectedDates: [DATE],
      workoutEffect: "protected",
      missionEffect: "protected",
      message: "Trip protected.",
      createdAt: "2026-06-20T10:00:00.000Z",
    },
    ...overrides,
  }
}

function makeMemory(overrides: Partial<DailyPresenceMemory> = {}): DailyPresenceMemory {
  return {
    userId: "daily-user",
    name: "Will",
    language: "pt-BR",
    userAge: 33,
    biologicalSex: "male",
    trainingLevel: "intermediate",
    trainingGoal: "hypertrophy",
    preferredTrainingLocation: "park",
    trainingPathology: "joelho sensível",
    country: "Italia",
    countryCode: "IT",
    city: "Roma",
    heightCm: 178,
    weightKg: 82,
    foodRestrictions: "sem lactose",
    trainedToday: false,
    lastWorkoutPlan: { title: "Pernas e core", focusKey: "legs_core" },
    dietGenerationStatus: "generated",
    proactiveMemories: [],
    proactiveImpacts: [],
    ...overrides,
  }
}

beforeEach(() => {
  clearDailyPresenceContextCache()
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearDailyPresenceContextCache()
})

describe("DailyPresenceContext", () => {
  it("monta contexto diário com perfil completo, cidade e país da calibragem", async () => {
    const ctx = await buildDailyPresenceContext(makeMemory(), {
      dateKey: DATE,
      language: "pt-BR",
      allowExternalFetch: false,
    })

    assert.equal(ctx.profile.age, 33)
    assert.equal(ctx.profile.countryCode, "IT")
    assert.equal(ctx.profile.city, "Roma")
    assert.equal(ctx.location.city, "Roma")
    assert.equal(ctx.location.source, "calibration")
    assert.equal(ctx.profile.weightKg, 82)
    assert.equal(ctx.profile.heightCm, 178)
    assert.equal(ctx.profile.foodRestrictions, "sem lactose")

    const compact = formatDailyPresenceContextForPrompt(ctx)
    assert.match(compact, /location=Roma\/IT:calibration/)
    assert.match(compact, /kg:82/)
    assert.match(compact, /cm:178/)
    assert.match(compact, /food:sem lactose/)
    assert.ok(compact.length < 700, `contexto diário ficou grande demais: ${compact.length}`)
  })

  it("busca clima diário por cidade com cache e falha silenciosa", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(JSON.stringify({
        weather: [{
          date: DATE,
          mintempC: "16",
          maxtempC: "23",
          hourly: [{ weatherDesc: [{ value: "Rain" }] }],
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof globalThis.fetch

    const first = await buildDailyPresenceContext(makeMemory({ countryCode: undefined }), {
      dateKey: DATE,
      language: "pt-BR",
      allowExternalFetch: true,
    })
    const second = await buildDailyPresenceContext(makeMemory({ countryCode: undefined }), {
      dateKey: DATE,
      language: "pt-BR",
      allowExternalFetch: true,
    })

    assert.equal(calls, 1)
    assert.equal(first.weather.source, "fetch")
    assert.equal(second.weather.source, "cache")
    assert.equal(first.weather.value?.city, "Roma")
    assert.equal(first.weather.isBadForOutdoorTraining, true)

    clearDailyPresenceContextCache()
    globalThis.fetch = (async () => {
      throw new Error("network down")
    }) as typeof globalThis.fetch

    const failed = await buildDailyPresenceContext(makeMemory({ countryCode: undefined }), {
      dateKey: DATE,
      language: "pt-BR",
      allowExternalFetch: true,
    })
    assert.equal(failed.weather.value, null)
    assert.equal(failed.weather.isBadForOutdoorTraining, false)
  })

  it("inclui feriado nacional quando a fonte retorna a data da semana", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([
        { date: DATE, name: "National Holiday", localName: "Festa nazionale" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as typeof globalThis.fetch

    const ctx = await buildDailyPresenceContext(makeMemory({ city: undefined }), {
      dateKey: DATE,
      language: "pt-BR",
      allowExternalFetch: true,
    })

    assert.equal(ctx.holidays.source, "fetch")
    assert.equal(ctx.holidays.today.length, 1)
    assert.equal(ctx.holidays.today[0]?.country, "IT")
    assert.match(formatDailyPresenceContextForPrompt(ctx), /holidayToday=Festa nazionale/)
  })

  it("usa destino temporário apenas quando há viagem confirmada no dia", async () => {
    const trip = makeTripMemory({ location: "Milano", trainingAdapted: true, stage: "confirmed_adapted" })
    const impact = makeImpact({
      workoutEffect: "short_light",
      missionEffect: "reduced",
      decision: {
        ...makeImpact().decision,
        workoutEffect: "short_light",
        missionEffect: "reduced",
      },
    })

    const ctx = await buildDailyPresenceContext(makeMemory({
      proactiveMemories: [trip],
      proactiveImpacts: [impact],
    }), {
      dateKey: DATE,
      language: "pt-BR",
      allowExternalFetch: false,
    })

    assert.equal(ctx.location.city, "Milano")
    assert.equal(ctx.location.source, "trip_destination")
    assert.equal(ctx.proactivity.activeMemory?.id, "trip-1")
    assert.equal(ctx.proactivity.trainingAdapted, true)
    assert.equal(ctx.workout.isAdaptedDay, true)
    assert.equal(ctx.diet.lightContext, "travel_adapted")
  })

  it("dia protegido bloqueia cobrança/push e alimenta missão, dieta e GUTO Online", async () => {
    const ctx = await buildDailyPresenceContext(makeMemory({
      activeExercise: { source: "online", name: "Agachamento", updatedAt: "2026-06-24T10:00:00.000Z" },
      proactiveMemories: [makeTripMemory()],
      proactiveImpacts: [makeImpact()],
    }), {
      dateKey: DATE,
      language: "pt-BR",
      allowExternalFetch: false,
    })

    assert.equal(ctx.workout.isProtectedDay, true)
    assert.equal(ctx.workout.missionEffect, "protected")
    assert.equal(ctx.diet.lightContext, "travel_protected")
    assert.equal(ctx.gutoOnline.activeExerciseName, "Agachamento")
    assert.equal(ctx.gutoOnline.shouldAvoidTrainingCharge, true)
    assert.equal(shouldSuppressTrainingCharge(ctx), true)
    assert.match(formatDailyPresenceContextForPrompt(ctx), /workout=protected:noBlindCharge/)
  })
})

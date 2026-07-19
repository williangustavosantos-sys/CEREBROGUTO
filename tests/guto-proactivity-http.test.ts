import "./test-env.js"
import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Server } from "node:http"
import jwt from "jsonwebtoken"

const tmpDir = join(process.cwd(), "tmp")
const testMemoryFile = join(tmpDir, "guto-memory.proactivity-http-test.json")

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server }
let server: Server
let baseUrl = ""
let originalFetch: typeof globalThis.fetch

const USER_ID = "proactivity-http-user"

function buildGeminiResponse(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] }
}

function authHeaders(userId = USER_ID) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!)
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}

function writeUserMemory(userId: string, data: Record<string, unknown>) {
  const store = existsSync(testMemoryFile)
    ? (JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, unknown>)
    : {}
  store[userId] = { userId, name: "Will", language: "pt-BR", ...data }
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2))
}

function dateKey(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.GUTO_TIME_ZONE || "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

function currentWeekKey() {
  const [year, month, day] = dateKey(0).split("-").map(Number) as [number, number, number]
  const tmp = new Date(Date.UTC(year, month - 1, day))
  const dayOfWeek = tmp.getUTCDay() || 7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayOfWeek)
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

function missionPlan(title = "Corpo inteiro controlado") {
  return {
    title,
    focus: title,
    focusKey: "full_body",
    dateLabel: "hoje",
    scheduledFor: dateKey(),
    summary: "Missão do dia pronta.",
    exercises: [
      {
        id: "agachamento_livre",
        name: "Agachamento livre",
        canonicalNamePt: "Agachamento livre",
        muscleGroup: "legs_core",
        sets: 3,
        reps: "10",
        rest: "60s",
        cue: "Desce controlado.",
        note: "Controle antes de carga.",
        videoUrl: "/videos/agachamento_livre.mp4",
        videoProvider: "local",
        sourceFileName: "agachamento_livre.mp4",
      },
    ],
  }
}

function mockGutoModel(payload: Record<string, unknown>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify(payload))), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return originalFetch(input as RequestInfo, init)
  }) as typeof globalThis.fetch
}

describe("proactivity HTTP cycle", () => {
  before(async () => {
    // O cérebro só chama o endpoint Gemini quando existe uma chave configurada.
    // O valor é fictício e toda chamada é interceptada pelo mock deste arquivo.
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-only-gemini-key"
    process.env.GUTO_MEMORY_FILE = testMemoryFile
    process.env.GUTO_DISABLE_LISTEN = "1"
    process.env.GUTO_ALLOW_DEV_ACCESS = "true"
    mkdirSync(tmpDir, { recursive: true })
    originalFetch = globalThis.fetch.bind(globalThis)

    const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      app: { listen: (port: number, hostname: string, callback?: () => void) => Server }
    }
    app = serverModule.app
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve())
      server.once("error", reject)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Failed to bind proactivity HTTP test server.")
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(() => {
    globalThis.fetch = originalFetch
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2))
    writeUserMemory(USER_ID, { proactiveMemories: [], weeklyConversation: null })
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  })

  it("GET /guto/proactivity/memories lists pending_confirmation", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "Quinta vou para Roma",
      understood: "Viagem para Roma na quinta",
      dateText: "quinta",
      weekKey: "2026-W20",
    })

    const res = await fetch(`${baseUrl}/guto/proactivity/memories`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { memories: Array<{ status: string; understood: string }> }
    assert.equal(body.memories.length, 1)
    assert.equal(body.memories[0]?.status, "pending_confirmation")
    assert.match(body.memories[0]?.understood ?? "", /Roma/i)
  })

  it("POST card SIM confirma viagem com treino adaptado e cria impacto uma única vez", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const tripDate = dateKey(1)
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "viajo amanhã",
      understood: "Viagem amanhã",
      dateText: "amanhã",
      dateParsed: tripDate,
      stage: "impact_confirmation",
      confirmationStage: "impact",
      proposedTrainingAdapted: true,
      weekKey: "2026-W20",
    })

    const res = await fetch(`${baseUrl}/guto/proactivity/confirm`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id, trainingAdapted: true }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      ok: boolean
      memory: { status: string; confirmedAt?: string; confirmationStage?: string; stage?: string; trainingAdapted?: boolean }
      impact?: { status: string; memoryId: string; workoutEffect: string; missionEffect: string } | null
      expectedResponse?: { context?: string; options?: string[] } | null
      memoryPatch?: {
        proactiveImpacts?: Array<{ memoryId: string; status: string; workoutEffect: string }>
        proactivePrompt?: { kind?: string; relatedMemoryId?: string; status?: string }
        activeConversationContext?: { kind?: string; relatedMemoryId?: string } | null
      }
      fala?: string
    }
    assert.equal(body.ok, true)
    assert.equal(body.memory.status, "confirmed")
    assert.ok(body.memory.confirmedAt)
    assert.equal(body.memory.confirmationStage, "impact")
    assert.equal(body.memory.stage, "confirmed_adapted")
    assert.equal(body.memory.trainingAdapted, true)
    assert.equal(body.impact?.workoutEffect, "short_light")
    assert.match(body.fala || "", /salvei.*viagem/i)
    assert.equal(body.memoryPatch?.proactivePrompt, null)
    assert.equal(body.memoryPatch?.activeConversationContext, null)
    assert.equal(body.memoryPatch?.proactiveImpacts?.filter((impact) => impact.memoryId === memory.id).length, 1)

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<
      string,
      {
        proactivePrompt?: { kind?: string; relatedMemoryId?: string; status?: string }
        activeConversationContext?: { kind?: string; relatedMemoryId?: string } | null
        proactiveImpacts?: Array<{ memoryId: string; status: string; workoutEffect: string }>
      }
    >
    assert.equal(store[USER_ID]?.proactivePrompt || null, null)
    assert.equal(store[USER_ID]?.activeConversationContext || null, null)
    assert.equal(store[USER_ID]?.proactiveImpacts?.filter((impact) => impact.memoryId === memory.id).length, 1)
  })

  it("POST card CONFIRMAR de viagem sem trainingAdapted não retorna 400", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const tripDate = dateKey(1)
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "viajo amanhã",
      understood: "Viagem amanhã",
      dateText: "amanhã",
      dateParsed: tripDate,
      stage: "impact_confirmation",
      confirmationStage: "impact",
      weekKey: currentWeekKey(),
    })

    const res = await fetch(`${baseUrl}/guto/proactivity/confirm`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      ok?: boolean
      memory?: { status?: string; stage?: string; trainingAdapted?: boolean }
      impact?: { memoryId?: string; workoutEffect?: string } | null
      fala?: string
      memoryPatch?: {
        proactiveMemories?: Array<{ id?: string; rawText?: string; understood?: string; stage?: string }>
        proactiveImpacts?: Array<{ memoryId?: string }>
      }
    }
    assert.equal(body.ok, true)
    assert.equal(body.memory?.status, "confirmed")
    assert.equal(body.memory?.stage, "confirmed_adapted")
    assert.equal(body.memory?.trainingAdapted, true)
    assert.equal(body.impact?.memoryId, memory.id)
    assert.equal(body.impact?.workoutEffect, "short_light")
    assert.match(body.fala || "", /adap/i)
    assert.doesNotMatch(
      JSON.stringify(body),
      /trainingAdapted required|Evento proativo devido|Decida a fala|buildSovereignBrainPrompt|prompt interno|texto interno/i,
    )
    assert.equal(body.memoryPatch?.proactiveMemories?.filter((item) => item.id === memory.id).length, 1)
    assert.equal(body.memoryPatch?.proactiveImpacts?.filter((item) => item.memoryId === memory.id).length, 1)
  })

  it("POST card CONFIRMAR de viagem em continuity_question abre pergunta de treino sem 409", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const tripDate = dateKey(1)
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "viajo amanhã",
      understood: "Viagem amanhã",
      dateText: "amanhã",
      dateParsed: tripDate,
      stage: "continuity_question",
      confirmationStage: "event",
      weekKey: currentWeekKey(),
    })

    const res = await fetch(`${baseUrl}/guto/proactivity/confirm`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      ok?: boolean
      memory?: { status?: string; stage?: string; trainingAdapted?: boolean }
      impact?: unknown
      fala?: string
      expectedResponse?: unknown
      memoryPatch?: {
        proactivePrompt?: { kind?: string; relatedMemoryId?: string; status?: string }
        proactiveImpacts?: Array<{ memoryId?: string; status?: string }>
      }
    }
    assert.equal(body.ok, true)
    assert.equal(body.memory?.status, "confirmed")
    assert.equal(body.memory?.stage, "continuity_question")
    assert.equal(body.memory?.trainingAdapted, undefined)
    assert.equal(body.impact, null)
    assert.equal(body.memoryPatch?.proactivePrompt?.kind, "travel_training")
    assert.equal(body.memoryPatch?.proactivePrompt?.relatedMemoryId, memory.id)
    assert.equal(body.memoryPatch?.proactivePrompt?.status, "active")
    assert.equal(body.memoryPatch?.proactiveImpacts?.some((impact) => impact.memoryId === memory.id && impact.status === "active"), false)
    assert.match(body.fala || "", /treino adaptado|consegue treinar|rotina por lá/i)
    assert.ok(body.expectedResponse)
  })

  it("POST discard pending trip before card → memory discarded and no proactiveImpact created", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "viajo quarta",
      understood: "Viagem na quarta",
      dateText: "quarta",
      weekKey: "2026-W20",
    })

    const discardRes = await fetch(`${baseUrl}/guto/proactivity/discard`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id }),
    })
    assert.equal(discardRes.status, 200)
    const body = (await discardRes.json()) as {
      ok: boolean
      memoryPatch?: {
        proactiveMemories?: Array<{ id: string; status: string }>
        proactiveImpacts?: Array<{ memoryId: string; status: string }>
        proactivePrompt?: { status?: string } | null
        activeConversationContext?: { kind?: string } | null
      }
    }
    assert.equal(body.ok, true)
    assert.equal(body.memoryPatch?.proactiveMemories?.find((item) => item.id === memory.id)?.status, "discarded")
    assert.notEqual(body.memoryPatch?.proactivePrompt?.status, "active")
    assert.equal(body.memoryPatch?.activeConversationContext, null)
    assert.deepEqual(body.memoryPatch?.proactiveImpacts || [], [])
  })

  it("POST discard remove pending_confirmation", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "Cancelou viagem",
      understood: "Viagem cancelada",
      weekKey: "2026-W20",
    })

    const res = await fetch(`${baseUrl}/guto/proactivity/discard`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok: boolean }
    assert.equal(body.ok, true)

    const list = await fetch(`${baseUrl}/guto/proactivity/memories`, { headers: authHeaders() })
    const listed = (await list.json()) as { memories: Array<{ id: string }> }
    assert.ok(!listed.memories.some((entry) => entry.id === memory.id), "discarded memory must not appear in active list")

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<
      string,
      { proactiveMemories?: Array<{ id: string; status: string }> }
    >
    const stored = store[USER_ID]?.proactiveMemories?.find((entry) => entry.id === memory.id)
    assert.equal(stored?.status, "discarded")
  })

  it("POST validate pending_validation → happened", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_validation",
      rawText: "Viagem Roma",
      understood: "Viagem para Roma",
      dateParsed: "2026-05-10",
      weekKey: "2026-W19",
    })

    const res = await fetch(`${baseUrl}/guto/proactivity/validate`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id, outcome: "happened" }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok: boolean; memory: { status: string } }
    assert.equal(body.ok, true)
    assert.equal(body.memory.status, "validated_happened")
  })

  it("viagem adiada mantém o memoryId, volta à continuidade e exige novo card", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const { resolveProactiveDate } = await import("../src/proactivity/date-resolver.js")
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_validation",
      rawText: "viagem de ontem",
      understood: "Viagem de ontem",
      dateParsed: dateKey(-1),
      weekKey: currentWeekKey(),
      stage: "confirmed_protected",
      confirmationStage: "impact",
      trainingAdapted: false,
    })
    const newDate = resolveProactiveDate("foi adiada para sexta", dateKey())
    assert.ok(newDate)
    mockGutoModel({ action: null, clarification: "", reason: "deterministic" })

    const res = await fetch(`${baseUrl}/guto`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        language: "pt-BR",
        profile: { userId: USER_ID, name: "Will" },
        history: [],
        input: "Foi adiada para sexta.",
      }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      fala?: string
      memoryPatch?: {
        proactiveMemories?: Array<{ id: string; status: string; stage?: string; dateParsed?: string; trainingAdapted?: boolean }>
        proactivePrompt?: { kind?: string; relatedMemoryId?: string; status?: string }
        proactiveImpacts?: Array<{ memoryId: string; status: string }>
      }
    }
    const updated = body.memoryPatch?.proactiveMemories?.find((item) => item.id === memory.id)
    assert.equal(updated?.status, "pending_confirmation")
    assert.equal(updated?.stage, "continuity_question")
    assert.equal(updated?.dateParsed, newDate.dateParsed)
    assert.equal(updated?.trainingAdapted, undefined)
    assert.equal(body.memoryPatch?.proactivePrompt?.kind, "travel_training")
    assert.equal(body.memoryPatch?.proactivePrompt?.relatedMemoryId, memory.id)
    assert.equal(body.memoryPatch?.proactivePrompt?.status, "active")
    assert.equal(body.memoryPatch?.proactiveImpacts?.some((impact) => impact.memoryId === memory.id && impact.status === "active"), false)
    assert.match(body.fala || "", /treino adaptado|consegue treinar/i)
  })

  it("viagem cancelada na validação é descartada e deixa de influenciar o futuro", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_validation",
      rawText: "viagem cancelada",
      understood: "Viagem de ontem",
      dateParsed: dateKey(-1),
      weekKey: currentWeekKey(),
    })

    const res = await fetch(`${baseUrl}/guto/proactivity/validate`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id, outcome: "discarded" }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      memory?: { id: string; status: string }
      memoryPatch?: { proactiveImpacts?: Array<{ memoryId: string; status: string }> }
    }
    assert.equal(body.memory?.id, memory.id)
    assert.equal(body.memory?.status, "discarded")
    assert.equal(body.memoryPatch?.proactiveImpacts?.some((impact) => impact.memoryId === memory.id && impact.status === "active"), false)
  })

  it("depois da data o GUTO abre validação do que aconteceu", async () => {
    const pastDate = dateKey(-1)
    writeUserMemory(USER_ID, {
      hasSeenChatOpening: true,
      proactiveSent: {},
      proactivePrompt: null,
      proactiveMemories: [{
        id: "trip-past-validation",
        userId: USER_ID,
        type: "trip",
        status: "confirmed",
        stage: "confirmed_adapted",
        trainingAdapted: true,
        rawText: "viagem ontem",
        understood: "Viagem de ontem",
        dateText: "ontem",
        dateParsed: pastDate,
        weekKey: currentWeekKey(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString(),
      }],
      proactiveImpacts: [],
      weeklyConversation: { weekKey: currentWeekKey(), happenedAt: new Date().toISOString(), extractionDone: true, validationDone: false },
      lastWorkoutPlan: missionPlan(),
    })

    const res = await fetch(`${baseUrl}/guto/proactive?language=pt-BR&force=1`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { slot?: string; fala?: string }
    assert.equal(body.slot, "memory_validation")
    assert.match(body.fala || "", /aconteceu|mudou|cancelado/i)
    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, {
      proactiveMemories?: Array<{ id: string; status: string }>
    }>
    assert.equal(store[USER_ID]?.proactiveMemories?.find((item) => item.id === "trip-past-validation")?.status, "pending_validation")
  })

  it("dia protegido não gera penalidade nem XP grátis", async () => {
    const protectedDate = dateKey(-1)
    const oldActive = new Date(`${dateKey(-2)}T12:00:00.000Z`).toISOString()
    writeUserMemory(USER_ID, {
      initialXpGranted: true,
      initialXpGrantedAt: oldActive,
      lastActiveAt: oldActive,
      totalXp: 100,
      streak: 2,
      xpEvents: [],
      completedWorkoutDates: [],
      adaptedMissionDates: [],
      missedMissionDates: [],
      proactiveMemories: [{
        id: "trip-protected-no-penalty",
        userId: USER_ID,
        type: "trip",
        status: "confirmed",
        stage: "confirmed_protected",
        trainingAdapted: false,
        rawText: "viagem ontem",
        understood: "Dia protegido",
        dateParsed: protectedDate,
        weekKey: currentWeekKey(),
        createdAt: oldActive,
        updatedAt: oldActive,
        confirmedAt: oldActive,
      }],
      proactiveImpacts: [{
        id: "impact-protected-no-penalty",
        memoryId: "trip-protected-no-penalty",
        status: "active",
        surfaces: ["workout", "mission", "path"],
        priority: 90,
        affectedDates: [protectedDate],
        workoutEffect: "protected",
        missionEffect: "protected",
        pushEffect: "avoid_blind_charge",
        xpEffect: "no_free_xp_context_only",
        arenaEffect: "validation_required",
        pathEffect: "adapted_context",
        evolutionEffect: "adapted_context",
        decision: {
          id: "decision-protected-no-penalty",
          memoryId: "trip-protected-no-penalty",
          kind: "protect_day",
          reason: "travel",
          priority: 90,
          affectedDates: [protectedDate],
          workoutEffect: "protected",
          missionEffect: "protected",
          message: "Dia protegido.",
          createdAt: oldActive,
        },
        createdAt: oldActive,
        updatedAt: oldActive,
      }],
    })

    const res = await fetch(`${baseUrl}/guto/memory`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      totalXp?: number
      streak?: number
      missedMissionDates?: string[]
      xpEvents?: Array<{ type?: string; date?: string; amount?: number }>
    }
    assert.equal(body.totalXp, 100)
    assert.equal(body.streak, 2)
    assert.equal(body.missedMissionDates?.includes(protectedDate), false)
    assert.equal(body.xpEvents?.some((event) => event.date === protectedDate), false)
  })

  it("POST extract marca weeklyConversation mesmo com 0 eventos (mock Gemini)", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "[]" }] } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return originalFetch(input as RequestInfo, init)
    }) as typeof globalThis.fetch

    const res = await fetch(`${baseUrl}/guto/proactivity/extract`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        conversationText: "USER: só passei para dar oi\nGUTO: Tô aqui. Me diz o que precisa.",
        language: "pt-BR",
      }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { extracted: number }
    assert.equal(body.extracted, 0)

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, { weeklyConversation?: { extractionDone?: boolean } }>
    assert.equal(store[USER_ID]?.weeklyConversation?.extractionDone, true)

    globalThis.fetch = originalFetch
  })

  it("POST extract salva viagem pendente mesmo quando Gemini retorna vazio", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "[]" }] } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return originalFetch(input as RequestInfo, init)
    }) as typeof globalThis.fetch

    const res = await fetch(`${baseUrl}/guto/proactivity/extract`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        conversationText: "USER: viajo sexta\nGUTO: Consigo adaptar. Você consegue treinar?",
        language: "pt-BR",
      }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { extracted: number; memories: Array<{ status: string; type: string; dateParsed?: string }> }
    assert.equal(body.extracted, 1)
    assert.equal(body.memories[0]?.status, "pending_confirmation")
    assert.equal(body.memories[0]?.type, "trip")
    assert.equal(body.memories[0]?.dateParsed?.length, 10)

    globalThis.fetch = originalFetch
  })

  it("POST extract resolve 'amanhã' em data real e não duplica card da mesma viagem", async () => {
    const tomorrow = dateKey(1)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify([
                  {
                    type: "trip",
                    rawText: "eu viajo amanhã",
                    understood: "Viagem amanhã",
                    dateText: "amanhã",
                    dateParsed: tomorrow,
                  },
                ]),
              }],
            },
          }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return originalFetch(input as RequestInfo, init)
    }) as typeof globalThis.fetch

    const res = await fetch(`${baseUrl}/guto/proactivity/extract`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        conversationText: "USER: eu viajo amanhã\nGUTO: Você consegue treinar adaptado?",
        language: "pt-BR",
      }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { extracted: number; memories: Array<{ dateParsed?: string; status: string }> }
    assert.equal(body.extracted, 1)
    assert.equal(body.memories[0]?.status, "pending_confirmation")
    assert.equal(body.memories[0]?.dateParsed, tomorrow)

    globalThis.fetch = originalFetch
  })

  it("Supino reto máquina ocupado não aceita memória ou card alucinado pelo extrator", async () => {
    const workout = missionPlan("Peito e tríceps")
    workout.exercises = [{
      ...workout.exercises[0]!,
      id: "supino_reto_maquina",
      name: "Supino reto máquina",
      canonicalNamePt: "Supino reto máquina",
      muscleGroup: "chest_triceps",
    }]
    writeUserMemory(USER_ID, {
      preferredTrainingLocation: "gym",
      trainingLocation: "gym",
      trainingLevel: "consistent",
      trainingStatus: "consistent",
      trainingPathology: "sem dor",
      trainingLimitations: "sem dor",
      trainingGoal: "muscle_gain",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      country: "Italia",
      countryCode: "IT",
      trainingSchedule: "today",
      lastWorkoutPlan: workout,
      proactiveMemories: [],
      proactiveImpacts: [],
      proactivePrompt: null,
      activeConversationContext: null,
    })

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("generativelanguage.googleapis.com")) {
        const requestBody = typeof init?.body === "string" ? init.body : ""
        if (requestBody.includes("semantic event extractor")) {
          return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify([{
            type: "other",
            rawText: "semana corrida",
            understood: "Confirmar que sua semana está corrida",
            dateText: "esta semana",
          }]))), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify({
          fala: "Máquina ocupada: troca por supino reto com halteres, mantendo séries, repetições e descanso.",
          acao: "none",
          expectedResponse: null,
          proactiveMemoryAction: null,
          memoryPatch: {},
        }))), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return originalFetch(input as RequestInfo, init)
    }) as typeof globalThis.fetch

    const chat = await fetch(`${baseUrl}/guto`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        language: "pt-BR",
        profile: { userId: USER_ID, name: "Will" },
        history: [],
        input: "Supino reto máquina ocupado?",
        turnId: "turn-supino-grounding-regression",
      }),
    })
    assert.equal(chat.status, 200)
    const chatBody = await chat.json() as {
      fala?: string
      proactiveMemoryAction?: unknown
      expectedResponse?: unknown
      turnDecision?: { cards?: unknown[] }
    }
    assert.match(chatBody.fala || "", /troca|substitu|halter|crucifixo/i)
    assert.equal(chatBody.proactiveMemoryAction || null, null)
    assert.equal(chatBody.expectedResponse || null, null)
    assert.deepEqual(chatBody.turnDecision?.cards || [], [])

    const extraction = await fetch(`${baseUrl}/guto/proactivity/extract`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        conversationText: `USER: Supino reto máquina ocupado?\nGUTO: ${chatBody.fala || ""}`,
        language: "pt-BR",
      }),
    })
    assert.equal(extraction.status, 200)
    const extractionBody = await extraction.json() as { extracted?: number; memories?: unknown[] }
    assert.equal(extractionBody.extracted, 0)
    assert.deepEqual(extractionBody.memories || [], [])

    const memories = await fetch(`${baseUrl}/guto/proactivity/memories`, { headers: authHeaders() })
    const memoriesBody = await memories.json() as { memories?: unknown[] }
    assert.deepEqual(memoriesBody.memories || [], [])

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, {
      proactiveMemories?: unknown[]
      proactiveImpacts?: unknown[]
      proactivePrompt?: unknown
      activeConversationContext?: unknown
      trainingSchedule?: string
    }>
    assert.deepEqual(store[USER_ID]?.proactiveMemories || [], [])
    assert.deepEqual(store[USER_ID]?.proactiveImpacts || [], [])
    assert.equal(store[USER_ID]?.proactivePrompt || null, null)
    assert.equal(store[USER_ID]?.activeConversationContext || null, null)
    assert.equal(store[USER_ID]?.trainingSchedule, "today")

    globalThis.fetch = originalFetch
  })

  it("turno atômico cria uma viagem, mantém o memoryId e só abre card no impacto", async () => {
    const { resolveProactiveDate } = await import("../src/proactivity/date-resolver.js")
    const resolved = resolveProactiveDate("viajo na próxima terça-feira", dateKey())
    assert.ok(resolved)
    writeUserMemory(USER_ID, {
      proactiveMemories: [],
      proactiveImpacts: [],
      proactivePrompt: null,
      preferredTrainingLocation: "gym",
      trainingLocation: "gym",
      trainingLevel: "returning",
      trainingStatus: "returning",
      trainingPathology: "sem dor",
      trainingLimitations: "sem dor",
      trainingGoal: "fat_loss",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      country: "Italia",
      countryCode: "IT",
    })
    mockGutoModel({ fala: "Entendi o contexto.", acao: "none", expectedResponse: null })

    const first = await fetch(`${baseUrl}/guto`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        language: "pt-BR",
        profile: { userId: USER_ID, name: "Will" },
        history: [],
        input: "Viajo na próxima terça-feira.",
        turnId: "turn-trip-created",
      }),
    })
    assert.equal(first.status, 200)
    const firstBody = (await first.json()) as {
      expectedResponse?: { context?: string }
      turnDecision?: { relatedMemoryId?: string; stage?: string; cards?: unknown[] }
      memoryPatch?: { proactiveMemories?: Array<{ id: string; dateParsed?: string; stage?: string }> }
    }
    const memoryId = firstBody.turnDecision?.relatedMemoryId
    assert.ok(memoryId)
    assert.equal(firstBody.turnDecision?.stage, "continuity_question")
    assert.deepEqual(firstBody.turnDecision?.cards, [])
    assert.equal(firstBody.expectedResponse?.context, "travel_training")
    assert.equal(firstBody.memoryPatch?.proactiveMemories?.length, 1)
    assert.equal(firstBody.memoryPatch?.proactiveMemories?.[0]?.dateParsed, resolved.dateParsed)

    globalThis.fetch = originalFetch
    const extracted = await fetch(`${baseUrl}/guto/proactivity/extract`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ conversationText: "USER: Viajo na próxima terça-feira.", language: "pt-BR" }),
    })
    const extractedBody = (await extracted.json()) as { extracted: number }
    assert.equal(extractedBody.extracted, 0)

    mockGutoModel({ fala: "Não deveria decidir fora do contexto.", acao: "none", expectedResponse: null })
    const impossible = await fetch(`${baseUrl}/guto`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        language: "pt-BR",
        profile: { userId: USER_ID, name: "Will" },
        history: [],
        input: "Impossível.",
        turnId: "turn-trip-impossible",
      }),
    })
    const impossibleBody = (await impossible.json()) as {
      turnDecision?: { relatedMemoryId?: string; stage?: string; cards?: Array<{ memoryId: string }> }
      memoryPatch?: { proactiveMemories?: Array<{ id: string; stage?: string }>; proactiveImpacts?: unknown[] }
    }
    assert.equal(impossibleBody.turnDecision?.relatedMemoryId, memoryId)
    assert.equal(impossibleBody.turnDecision?.stage, "impact_confirmation")
    assert.deepEqual(impossibleBody.turnDecision?.cards, [{ memoryId, stage: "impact_confirmation", dateParsed: resolved.dateParsed }])
    assert.equal(impossibleBody.memoryPatch?.proactiveMemories?.filter((item) => item.id === memoryId).length, 1)
    assert.equal(impossibleBody.memoryPatch?.proactiveImpacts?.length, 0)

    const replay = await fetch(`${baseUrl}/guto`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        language: "pt-BR",
        profile: { userId: USER_ID, name: "Will" },
        history: [],
        input: "Impossível.",
        turnId: "turn-trip-impossible",
      }),
    })
    const replayBody = (await replay.json()) as { turnDecision?: { relatedMemoryId?: string; stage?: string } }
    assert.equal(replayBody.turnDecision?.relatedMemoryId, memoryId)
    assert.equal(replayBody.turnDecision?.stage, "impact_confirmation")

    const list = await fetch(`${baseUrl}/guto/proactivity/memories`, { headers: authHeaders() })
    const listBody = (await list.json()) as { memories: Array<{ id: string; stage?: string }> }
    assert.equal(listBody.memories.filter((item) => item.id === memoryId).length, 1)
    assert.equal(listBody.memories.find((item) => item.id === memoryId)?.stage, "impact_confirmation")

    const confirmed = await fetch(`${baseUrl}/guto/proactivity/confirm`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId, trainingAdapted: false }),
    })
    const confirmedBody = (await confirmed.json()) as {
      memory?: { id?: string; stage?: string }
      impact?: { memoryId?: string; workoutEffect?: string }
      memoryPatch?: { proactiveMemories?: Array<{ id: string; stage?: string }>; proactiveImpacts?: Array<{ memoryId: string }> }
    }
    assert.equal(confirmedBody.memory?.id, memoryId)
    assert.equal(confirmedBody.memory?.stage, "confirmed_protected")
    assert.equal(confirmedBody.impact?.memoryId, memoryId)
    assert.equal(confirmedBody.impact?.workoutEffect, "protected")
    assert.equal(confirmedBody.memoryPatch?.proactiveMemories?.filter((item) => item.id === memoryId).length, 1)
    assert.equal(confirmedBody.memoryPatch?.proactiveImpacts?.filter((item) => item.memoryId === memoryId).length, 1)
  })

  it("card pendente não bloqueia uma nova intenção explícita no chat", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const tripDate = dateKey(1)
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "eu viajo amanhã",
      understood: "Viagem amanhã",
      dateText: "amanhã",
      dateParsed: tripDate,
      stage: "impact_confirmation",
      confirmationStage: "impact",
      proposedTrainingAdapted: false,
      weekKey: currentWeekKey(),
    })
    mockGutoModel({
      fala: "Vou seguir.",
      acao: "none",
      expectedResponse: null,
    })

    const res = await fetch(`${baseUrl}/guto`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        language: "pt-BR",
        profile: { userId: USER_ID, name: "Will" },
        history: [],
        input: "Qual é a minha dieta de hoje?",
      }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      fala?: string
      expectedResponse?: unknown
      memoryPatch?: {
        activeConversationContext?: { kind?: string; relatedMemoryId?: string } | null
        proactiveImpacts?: Array<{ workoutEffect: string }>
      }
    }
    assert.equal(body.fala, "Vou seguir.")
    assert.equal(body.expectedResponse, null)
    assert.notEqual(body.memoryPatch?.proactiveImpacts?.some((impact) => impact.workoutEffect === "protected"), true)

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<
      string,
      {
        proactiveMemories?: Array<{ id: string; status: string; confirmationStage?: string; rawText?: string }>
        proactiveImpacts?: Array<{ workoutEffect: string }>
      }
    >
    assert.equal(store[USER_ID]?.proactiveMemories?.find((item) => item.id === memory.id)?.status, "pending_confirmation")
    assert.equal(store[USER_ID]?.proactiveMemories?.find((item) => item.id === memory.id)?.confirmationStage, "impact")
    assert.doesNotMatch(store[USER_ID]?.proactiveMemories?.find((item) => item.id === memory.id)?.rawText || "", /dieta de hoje/i)
    assert.equal(store[USER_ID]?.proactiveImpacts?.some((impact) => impact.workoutEffect === "protected"), false)
  })

  it("ALTERAR DATA mantém o mesmo rascunho pendente e repete o card com a data corrigida", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const { resolveProactiveDate } = await import("../src/proactivity/date-resolver.js")
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "viajo quarta",
      understood: "Viagem na quarta",
      dateText: "quarta",
      dateParsed: dateKey(3),
      weekKey: currentWeekKey(),
      stage: "impact_confirmation",
      confirmationStage: "impact",
      proposedTrainingAdapted: false,
    })

    const change = await fetch(`${baseUrl}/guto/proactivity/change-date`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id }),
    })
    assert.equal(change.status, 200)
    const changeBody = (await change.json()) as {
      fala?: string
      memory?: { id: string; status: string; stage?: string; confirmedAt?: string; trainingAdapted?: boolean }
      memoryPatch?: { proactiveImpacts?: Array<{ status: string }> }
    }
    assert.match(changeBody.fala || "", /data certa/i)
    assert.equal(changeBody.memory?.id, memory.id)
    assert.equal(changeBody.memory?.status, "pending_confirmation")
    assert.equal(changeBody.memory?.stage, "date_correction")
    assert.equal(changeBody.memory?.confirmedAt, undefined)
    assert.equal(changeBody.memory?.trainingAdapted, undefined)
    assert.equal(changeBody.memoryPatch?.proactiveImpacts?.some((impact) => impact.status === "active"), false)

    const correctedDate = resolveProactiveDate("sexta-feira", dateKey())
    assert.ok(correctedDate)
    const reply = await fetch(`${baseUrl}/guto`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        language: "pt-BR",
        profile: { userId: USER_ID, name: "Will" },
        history: [],
        input: "sexta-feira",
        turnId: "turn-trip-date-correction",
      }),
    })
    assert.equal(reply.status, 200)
    const replyBody = (await reply.json()) as {
      fala?: string
      turnDecision?: { relatedMemoryId?: string; stage?: string; cards?: Array<{ memoryId: string; dateParsed?: string }> }
      memoryPatch?: {
        proactiveMemories?: Array<{ id: string; status: string; stage?: string; dateParsed?: string; trainingAdapted?: boolean }>
        proactiveImpacts?: Array<{ status: string }>
      }
    }
    const corrected = replyBody.memoryPatch?.proactiveMemories?.find((item) => item.id === memory.id)
    assert.match(replyBody.fala || "", /confirma.*card/i)
    assert.equal(corrected?.status, "pending_confirmation")
    assert.equal(corrected?.stage, "impact_confirmation")
    assert.equal(corrected?.dateParsed, correctedDate.dateParsed)
    assert.equal(corrected?.trainingAdapted, undefined)
    assert.equal(replyBody.turnDecision?.relatedMemoryId, memory.id)
    assert.equal(replyBody.turnDecision?.stage, "impact_confirmation")
    assert.deepEqual(replyBody.turnDecision?.cards, [{
      memoryId: memory.id,
      stage: "impact_confirmation",
      dateParsed: correctedDate.dateParsed,
    }])
    assert.equal(replyBody.memoryPatch?.proactiveImpacts?.some((impact) => impact.status === "active"), false)
  })

  it("viagem confirmada + impossível cria um único card final de impacto sem proteger direto", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const tripDate = dateKey(1)
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "eu viajo amanhã",
      understood: "Viagem amanhã",
      dateText: "amanhã",
      dateParsed: tripDate,
      weekKey: currentWeekKey(),
      stage: "continuity_question",
      confirmationStage: "event",
    })
    writeUserMemory(USER_ID, {
      proactiveMemories: [memory],
      proactiveImpacts: [],
      proactivePrompt: {
        id: "prompt-travel-training",
        kind: "travel_training",
        relatedMemoryId: memory.id,
        status: "active",
        fala: `Will, viagem confirmada. Você vai conseguir fazer um treino adaptado de 20 minutos amanhã, dia ${tripDate.slice(8, 10)}/${tripDate.slice(5, 7)}?`,
        expectedResponse: { type: "text", context: "travel_training", options: ["SIM", "NÃO"] },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      activeConversationContext: {
        kind: "travel_impact_confirmation",
        source: "proactive_prompt",
        relatedMemoryId: memory.id,
        updatedAt: new Date().toISOString(),
      },
    })

    const res = await fetch(`${baseUrl}/guto`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        language: "pt-BR",
        profile: { userId: USER_ID, name: "Will" },
        history: [],
        input: "impossível treinar",
      }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      fala?: string
      memoryPatch?: {
        proactiveMemories?: Array<{ id: string; status: string; confirmationStage?: string }>
        proactiveImpacts?: Array<{ workoutEffect: string }>
        proactivePrompt?: { status?: string } | null
        activeConversationContext?: { kind?: string; relatedMemoryId?: string } | null
      }
    }
    assert.match(body.fala || "", /confirma no card/i)
    assert.equal(body.memoryPatch?.proactiveMemories?.filter((item) => item.id === memory.id).length, 1)
    assert.equal(body.memoryPatch?.proactiveMemories?.find((item) => item.id === memory.id)?.status, "pending_confirmation")
    assert.equal(body.memoryPatch?.proactiveMemories?.find((item) => item.id === memory.id)?.confirmationStage, "impact")
    assert.equal(body.memoryPatch?.activeConversationContext?.kind, "travel_impact_confirmation")
    assert.equal(body.memoryPatch?.activeConversationContext?.relatedMemoryId, memory.id)
    assert.equal(body.memoryPatch?.proactiveImpacts?.some((impact) => impact.workoutEffect === "protected"), false)
  })

  it("confirmar dia protegido atualiza Percurso com impacto definitivo", async () => {
    const { addProactiveMemory, updateProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const tripDate = dateKey(1)
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "eu viajo amanhã",
      understood: "Viagem amanhã",
      dateText: "amanhã",
      dateParsed: tripDate,
      weekKey: currentWeekKey(),
    })
    await updateProactiveMemory(USER_ID, memory.id, {
      rawText: "eu viajo amanhã; impossível treinar",
      understood: "Viagem amanhã; impossível treinar",
      status: "pending_confirmation",
      confirmationStage: "impact",
      stage: "impact_confirmation",
      proposedTrainingAdapted: false,
    })

    const res = await fetch(`${baseUrl}/guto/proactivity/confirm`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id, trainingAdapted: false }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      ok: boolean
      memory?: { status: string; stage?: string; trainingAdapted?: boolean }
      impact?: { workoutEffect: string; pathEffect: string; affectedDates?: string[] }
      memoryPatch?: { proactiveImpacts?: Array<{ memoryId: string; workoutEffect: string; pathEffect: string; affectedDates?: string[] }> }
    }
    assert.equal(body.ok, true)
    assert.equal(body.memory?.status, "confirmed")
    assert.equal(body.memory?.stage, "confirmed_protected")
    assert.equal(body.memory?.trainingAdapted, false)
    assert.equal(body.impact?.workoutEffect, "protected")
    assert.equal(body.impact?.pathEffect, "adapted_context")
    assert.deepEqual(body.impact?.affectedDates, [tripDate])
    assert.equal(body.memoryPatch?.proactiveImpacts?.find((impact) => impact.memoryId === memory.id)?.workoutEffect, "protected")
  })

  it("gera treino base mesmo com card de viagem pendente", async () => {
    const tripDate = dateKey(2)
    const pendingTrip = {
      id: "pm-workout-pending-trip",
      userId: USER_ID,
      type: "trip",
      status: "pending_confirmation",
      stage: "impact_confirmation",
      confirmationStage: "impact",
      rawText: "viajo terça; impossível treinar",
      understood: "Viagem terça; dia protegido aguardando confirmação",
      dateParsed: tripDate,
      weekKey: currentWeekKey(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    writeUserMemory(USER_ID, {
      hasSeenChatOpening: true,
      trainedToday: false,
      proactiveSent: {},
      proactiveMemories: [pendingTrip],
      proactiveImpacts: [],
      lastWorkoutPlan: null,
      trainingGoal: "fat_loss",
      preferredTrainingLocation: "gym",
      trainingLocation: "gym",
      trainingLevel: "returning",
      trainingStatus: "returning",
      trainingPathology: "sem dor",
      trainingLimitations: "sem dor",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      country: "Italia",
      countryCode: "IT",
    })
    mockGutoModel({
      fala: "Treino base pronto.",
      acao: "updateWorkout",
      expectedResponse: null,
      workoutPlan: missionPlan("Treino base com viagem pendente"),
    })

    const res = await fetch(`${baseUrl}/guto/proactive?language=pt-BR&force=1`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { acao?: string; workoutPlan?: { title?: string; exercises?: unknown[] } }
    assert.equal(body.acao, "updateWorkout")
    assert.ok((body.workoutPlan?.exercises?.length || 0) > 0)

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, {
      lastWorkoutPlan?: { title?: string }
      proactiveMemories?: Array<{ id: string; stage?: string }>
    }>
    assert.ok(store[USER_ID]?.lastWorkoutPlan)
    assert.equal(store[USER_ID]?.proactiveMemories?.find((item) => item.id === pendingTrip.id)?.stage, "impact_confirmation")
  })

  it("job de treino base não extrai viagem a partir do texto interno da calibragem", async () => {
    writeUserMemory(USER_ID, {
      hasSeenChatOpening: true,
      trainedToday: false,
      proactiveSent: {},
      proactiveMemories: [],
      proactiveImpacts: [],
      weeklyConversation: null,
      lastWorkoutPlan: null,
      trainingGoal: "fat_loss",
      preferredTrainingLocation: "mixed",
      trainingLocation: "mixed",
      trainingLevel: "returning",
      trainingStatus: "viaggio questa settimana, in ripresa",
      trainingPathology: "senza dolore",
      trainingLimitations: "senza dolore",
      biologicalSex: "male",
      userAge: 40,
      heightCm: 176,
      weightKg: 84,
      country: "Italia",
      countryCode: "IT",
      language: "it-IT",
    })
    mockGutoModel({
      fala: "Allenamento base pronto.",
      acao: "updateWorkout",
      expectedResponse: null,
      workoutPlan: missionPlan("Allenamento base"),
    })

    const res = await fetch(`${baseUrl}/guto/proactive?language=it-IT&force=1`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { acao?: string; workoutPlan?: { exercises?: unknown[] } }
    assert.equal(body.acao, "updateWorkout")
    assert.ok((body.workoutPlan?.exercises?.length || 0) > 0)

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, {
      proactiveMemories?: unknown[]
    }>
    assert.deepEqual(store[USER_ID]?.proactiveMemories || [], [])
  })

  it("GET /guto/proactive?force=1 pergunta contexto semanal antes da missão e persiste", async () => {
    mockGutoModel({
      fala: "Olá! Como posso te ajudar hoje?",
      acao: "none",
      expectedResponse: null,
    })
    writeUserMemory(USER_ID, {
      name: "Maria",
      hasSeenChatOpening: true,
      trainedToday: false,
      totalXp: 100,
      xpEvents: [],
      completedWorkoutDates: [],
      proactiveSent: {},
      proactiveMemories: [],
      proactiveImpacts: [],
      weeklyConversation: null,
      lastWorkoutPlan: null,
      trainingGoal: "fat_loss",
      preferredTrainingLocation: "gym",
      trainingLevel: "returning",
      trainingPathology: "sem dor",
      trainingLimitations: "sem dor",
    })

    const res = await fetch(`${baseUrl}/guto/proactive?language=pt-BR&force=1`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { due: boolean; slot: string; fala: string }
    assert.equal(body.due, true)
    assert.equal(body.slot, "arrival")
    assert.match(body.fala, /Maria/i)
    assert.match(body.fala, /semana|pr[oó]ximos dias|resto da semana/i)
    assert.match(body.fala, /viagem|compromisso|dor|hor[aá]rio/i)
    assert.doesNotMatch(body.fala, /Corpo inteiro controlado|Missão do dia pronta/i)
    assert.doesNotMatch(body.fala, /Como posso te ajudar hoje/i)

    const second = await fetch(`${baseUrl}/guto/proactive?language=pt-BR&force=1`, { headers: authHeaders() })
    assert.equal(second.status, 200)
    const secondBody = (await second.json()) as { due: boolean; slot?: string; fala?: string }
    assert.equal(secondBody.due, true, "prompt ativo deve persistir até o usuário responder")
    assert.equal(secondBody.slot, "arrival")
    assert.equal(secondBody.fala, body.fala)

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<
      string,
      {
        totalXp?: number
        xpEvents?: unknown[]
        completedWorkoutDates?: unknown[]
        lastWorkoutPlan?: { title?: string } | null
        proactivePrompt?: { status?: string; fala?: string }
      }
    >
    assert.equal(store[USER_ID]?.totalXp, 100)
    assert.equal(store[USER_ID]?.xpEvents?.length, 0)
    assert.equal(store[USER_ID]?.completedWorkoutDates?.length, 0)
    assert.equal(store[USER_ID]?.lastWorkoutPlan, null)
    assert.equal(store[USER_ID]?.proactivePrompt?.status, "active")
    assert.equal(store[USER_ID]?.proactivePrompt?.fala, body.fala)
  })

  it("GET /guto/proactive abre contexto semanal mesmo com missão já persistida", async () => {
    mockGutoModel({ fala: "fallback não deve aparecer", acao: "none", expectedResponse: null })
    const readyMission = missionPlan("Corpo inteiro controlado")
    writeUserMemory(USER_ID, {
      name: "Maria",
      hasSeenChatOpening: true,
      trainedToday: false,
      totalXp: 100,
      proactiveSent: {},
      proactiveMemories: [],
      proactiveImpacts: [],
      weeklyConversation: null,
      proactivePrompt: null,
      lastWorkoutPlan: readyMission,
      trainingGoal: "fat_loss",
      preferredTrainingLocation: "gym",
      trainingLevel: "returning",
      trainingPathology: "sem dor",
      trainingLimitations: "sem dor",
    })

    const res = await fetch(`${baseUrl}/guto/proactive?language=pt-BR&force=1`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      due: boolean
      slot: string
      fala: string
      acao?: string
      workoutPlan?: { title?: string; exercises?: unknown[] }
      expectedResponse?: { type?: string } | null
    }
    assert.equal(body.due, true)
    assert.equal(body.slot, "arrival")
    assert.match(body.fala, /miss[aã]o/i, "a missão continua apresentada na mesma chegada")
    assert.match(body.fala, /semana|pr[oó]ximos dias|resto da semana/i)
    assert.match(body.fala, /viagem|compromisso|dor|hor[aá]rio/i)
    assert.equal(body.acao, "updateWorkout")
    assert.ok((body.workoutPlan?.exercises?.length || 0) > 0)
    assert.equal(body.expectedResponse?.type, "text")

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, {
      proactivePrompt?: { kind?: string; status?: string }
      weeklyConversation?: { extractionDone?: boolean }
    }>
    assert.equal(store[USER_ID]?.proactivePrompt?.kind, "weekly_opening")
    assert.equal(store[USER_ID]?.proactivePrompt?.status, "active")
    assert.equal(store[USER_ID]?.weeklyConversation?.extractionDone, false)
  })

  it("GET /guto/proactive?force=1 com semana aberta mostra missão pronta", async () => {
    mockGutoModel({
      fala: "Olá! Como posso te ajudar hoje?",
      acao: "none",
      expectedResponse: null,
    })
    const { getWeekKey } = await import("../src/proactivity/proactive-store.js")
    writeUserMemory(USER_ID, {
      name: "Maria",
      hasSeenChatOpening: true,
      trainedToday: false,
      totalXp: 100,
      xpEvents: [],
      completedWorkoutDates: [],
      proactiveSent: {},
      proactiveMemories: [],
      proactiveImpacts: [],
      weeklyConversation: {
        weekKey: getWeekKey(),
        happenedAt: new Date().toISOString(),
        extractionDone: false,
        validationDone: false,
      },
      lastWorkoutPlan: missionPlan(),
      trainingGoal: "fat_loss",
      preferredTrainingLocation: "gym",
      trainingLevel: "returning",
      trainingPathology: "sem dor",
      trainingLimitations: "sem dor",
    })

    const res = await fetch(`${baseUrl}/guto/proactive?language=pt-BR&force=1`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { due: boolean; slot: string; fala: string }
    assert.equal(body.due, true)
    assert.equal(body.slot, "arrival")
    assert.match(body.fala, /Maria/i)
    assert.match(body.fala, /miss[aã]o/i)
    assert.doesNotMatch(body.fala, /Como posso te ajudar hoje/i)
  })

  it("GET /guto/proactive?force=1 com missão e ombro menciona cuidado físico", async () => {
    mockGutoModel({ fala: "Olá! Como posso te ajudar hoje?", acao: "none", expectedResponse: null })
    writeUserMemory(USER_ID, {
      name: "Maria",
      hasSeenChatOpening: true,
      trainedToday: false,
      proactiveSent: {},
      proactiveMemories: [],
      proactiveImpacts: [],
      weeklyConversation: {
        weekKey: currentWeekKey(),
        happenedAt: new Date().toISOString(),
        extractionDone: true,
        validationDone: false,
      },
      lastWorkoutPlan: missionPlan("Corpo inteiro"),
      trainingPathology: "ombro direito sensível",
      trainingLimitations: "ombro direito sensível",
    })

    const res = await fetch(`${baseUrl}/guto/proactive?language=pt-BR&force=1`, { headers: authHeaders() })
    const body = (await res.json()) as { fala: string }
    assert.match(body.fala, /ombro/i)
    assert.match(body.fala, /cuidado|ajusto|ajust/i)
    assert.doesNotMatch(body.fala, /Como posso te ajudar hoje/i)
  })

  it("GET /guto/proactive?force=1 com viagem protegida não repete pergunta semanal", async () => {
    mockGutoModel({ fala: "Olá! Como posso te ajudar hoje?", acao: "none", expectedResponse: null })
    const tripDate = dateKey(2)
    writeUserMemory(USER_ID, {
      name: "Maria",
      hasSeenChatOpening: true,
      trainedToday: false,
      proactiveSent: {},
      proactiveMemories: [
        {
          id: "memory-trip-protected",
          userId: USER_ID,
          type: "trip",
          status: "confirmed",
          rawText: "viagem amanhã",
          understood: "Viagem protegida.",
          dateText: "amanhã",
          dateParsed: tripDate,
          weekKey: "2026-W20",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
        },
      ],
      weeklyConversation: null,
      lastWorkoutPlan: missionPlan("Corpo inteiro sem impacto"),
      trainingPathology: "sem dor",
      trainingLimitations: "sem dor",
      proactiveImpacts: [
        {
          id: "impact-trip-protected",
          memoryId: "memory-trip-protected",
          status: "active",
          surfaces: ["chat", "workout", "mission"],
          priority: 90,
          affectedDates: [tripDate],
          workoutEffect: "protected",
          missionEffect: "protected",
          pushEffect: "avoid_blind_charge",
          xpEffect: "no_free_xp_context_only",
          arenaEffect: "validation_required",
          pathEffect: "adapted_context",
          evolutionEffect: "adapted_context",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          decision: {
            id: "decision-trip-protected",
            memoryId: "memory-trip-protected",
            kind: "adapt_day",
            reason: "travel",
            priority: 90,
            affectedDates: [tripDate],
            workoutEffect: "protected",
            missionEffect: "protected",
            message: "Viagem protegida.",
            createdAt: new Date().toISOString(),
          },
        },
      ],
    })

    const res = await fetch(`${baseUrl}/guto/proactive?language=pt-BR&force=1`, { headers: authHeaders() })
    const body = (await res.json()) as { fala: string }
    assert.match(body.fala, /viagem/i)
    assert.match(body.fala, /proteg/i)
    assert.match(body.fala, /Corpo inteiro|miss[aã]o/i)
    assert.doesNotMatch(body.fala, /como t[aá] tua semana|Tem viagem/i)
    assert.doesNotMatch(body.fala, /Como posso te ajudar hoje/i)
  })

  it("GET /guto/proactive?force=1 traz memória futura confirmada de volta como fala visível", async () => {
    const tripDate = dateKey(1)
    writeUserMemory(USER_ID, {
      name: "Maria",
      hasSeenChatOpening: true,
      trainedToday: false,
      proactiveSent: {},
      proactiveMemories: [
        {
          id: "memory-trip-tomorrow",
          userId: USER_ID,
          type: "trip",
          status: "confirmed",
          rawText: "vou viajar amanhã",
          understood: "Viagem amanhã.",
          dateText: "amanhã",
          dateParsed: tripDate,
          weekKey: currentWeekKey(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
        },
      ],
      proactiveImpacts: [],
      weeklyConversation: null,
      lastWorkoutPlan: missionPlan("Corpo inteiro antes da viagem"),
      trainingPathology: "sem dor",
      trainingLimitations: "sem dor",
    })

    const res = await fetch(`${baseUrl}/guto/proactive?language=pt-BR&force=1`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { due: boolean; slot: string; fala: string }
    assert.equal(body.due, true)
    assert.equal(body.slot, "memory_reminder")
    assert.match(body.fala, /Amanh[aã].*viagem/i)
    assert.doesNotMatch(body.fala, /como t[aá] tua semana|Tem viagem/i)

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<
      string,
      {
        proactiveMemories?: Array<{ id: string; status: string }>
        proactivePrompt?: { status?: string; kind?: string; relatedMemoryId?: string }
      }
    >
    assert.equal(store[USER_ID]?.proactiveMemories?.find((item) => item.id === "memory-trip-tomorrow")?.status, "surfaced")
    assert.equal(store[USER_ID]?.proactivePrompt?.status, "active")
    assert.equal(store[USER_ID]?.proactivePrompt?.kind, "memory_reminder")
    assert.equal(store[USER_ID]?.proactivePrompt?.relatedMemoryId, "memory-trip-tomorrow")
  })

  it("no dia da viagem adaptada pergunta o local; no dia protegido não cobra treino", async () => {
    const today = dateKey()
    const baseTrip = {
      userId: USER_ID,
      type: "trip",
      status: "confirmed",
      rawText: "viagem hoje",
      understood: "Viagem hoje",
      dateText: "hoje",
      dateParsed: today,
      weekKey: currentWeekKey(),
      confirmationStage: "impact",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
    }
    const baseImpact = {
      status: "active",
      surfaces: ["chat", "workout", "mission", "diet", "path"],
      priority: 90,
      affectedDates: [today],
      pushEffect: "avoid_blind_charge",
      xpEffect: "no_free_xp_context_only",
      arenaEffect: "validation_required",
      pathEffect: "adapted_context",
      evolutionEffect: "adapted_context",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    writeUserMemory(USER_ID, {
      hasSeenChatOpening: true,
      proactiveSent: {},
      proactiveMemories: [{ ...baseTrip, id: "trip-today-adapted", stage: "confirmed_adapted", trainingAdapted: true }],
      proactiveImpacts: [{
        ...baseImpact,
        id: "impact-today-adapted",
        memoryId: "trip-today-adapted",
        workoutEffect: "short_light",
        missionEffect: "reduced",
        decision: {
          id: "decision-today-adapted",
          memoryId: "trip-today-adapted",
          kind: "adapt_day",
          reason: "travel",
          priority: 90,
          affectedDates: [today],
          workoutEffect: "short_light",
          missionEffect: "reduced",
          message: "Viagem confirmada.",
          createdAt: new Date().toISOString(),
        },
      }],
      weeklyConversation: { weekKey: currentWeekKey(), happenedAt: new Date().toISOString(), extractionDone: true, validationDone: false },
      lastWorkoutPlan: missionPlan(),
    })
    const adapted = await fetch(`${baseUrl}/guto/proactive?language=pt-BR&force=1`, { headers: authHeaders() })
    assert.equal(adapted.status, 200)
    const adaptedBody = (await adapted.json()) as { slot?: string; fala?: string }
    assert.equal(adaptedBody.slot, "memory_reminder")
    assert.match(adaptedBody.fala || "", /academia, quarto ou ar livre/i)

    writeUserMemory(USER_ID, {
      hasSeenChatOpening: true,
      proactivePrompt: null,
      proactiveSent: {},
      proactiveMemories: [{ ...baseTrip, id: "trip-today-protected", stage: "confirmed_protected", trainingAdapted: false }],
      proactiveImpacts: [{
        ...baseImpact,
        id: "impact-today-protected",
        memoryId: "trip-today-protected",
        workoutEffect: "protected",
        missionEffect: "protected",
        decision: {
          id: "decision-today-protected",
          memoryId: "trip-today-protected",
          kind: "protect_day",
          reason: "travel",
          priority: 90,
          affectedDates: [today],
          workoutEffect: "protected",
          missionEffect: "protected",
          message: "Dia protegido.",
          createdAt: new Date().toISOString(),
        },
      }],
      weeklyConversation: { weekKey: currentWeekKey(), happenedAt: new Date().toISOString(), extractionDone: true, validationDone: false },
      lastWorkoutPlan: missionPlan(),
    })
    const protectedDay = await fetch(`${baseUrl}/guto/proactive?language=pt-BR&force=1`, { headers: authHeaders() })
    assert.equal(protectedDay.status, 200)
    const protectedBody = (await protectedDay.json()) as { slot?: string; fala?: string; workoutPlan?: unknown }
    assert.equal(protectedBody.slot, "memory_reminder")
    assert.match(protectedBody.fala || "", /dia.*protegido|sem cobrança burra/i)
    assert.doesNotMatch(protectedBody.fala || "", /vai treinar|bora treinar|perdeu/i)
    assert.equal(protectedBody.workoutPlan, undefined)
  })
})

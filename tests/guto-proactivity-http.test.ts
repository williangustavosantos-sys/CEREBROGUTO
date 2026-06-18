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

  it("POST confirm de viagem confirma evento e abre pergunta de treino adaptado, sem impacto no Percurso", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const tripDate = dateKey(1)
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "viajo amanhã",
      understood: "Viagem amanhã",
      dateText: "amanhã",
      dateParsed: tripDate,
      weekKey: "2026-W20",
    })

    const res = await fetch(`${baseUrl}/guto/proactivity/confirm`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      ok: boolean
      memory: { status: string; confirmedAt?: string; confirmationStage?: string }
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
    assert.equal(body.memory.confirmationStage, "event")
    assert.equal(body.impact, null)
    assert.match(body.fala || "", /treino adaptado de 20 minutos/i)
    assert.match(body.fala || "", new RegExp(tripDate.slice(8, 10) + "/" + tripDate.slice(5, 7)))
    assert.equal(body.expectedResponse?.context, "travel_training")
    assert.deepEqual(body.expectedResponse?.options, ["SIM", "NÃO"])
    assert.equal(body.memoryPatch?.proactivePrompt?.kind, "travel_training")
    assert.equal(body.memoryPatch?.proactivePrompt?.relatedMemoryId, memory.id)
    assert.equal(body.memoryPatch?.activeConversationContext?.kind, "travel_impact_confirmation")
    assert.equal(body.memoryPatch?.activeConversationContext?.relatedMemoryId, memory.id)
    assert.deepEqual(body.memoryPatch?.proactiveImpacts || [], [])

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<
      string,
      {
        proactivePrompt?: { kind?: string; relatedMemoryId?: string; status?: string }
        activeConversationContext?: { kind?: string; relatedMemoryId?: string } | null
        proactiveImpacts?: Array<{ memoryId: string; status: string; workoutEffect: string }>
      }
    >
    assert.equal(store[USER_ID]?.proactivePrompt?.status, "active")
    assert.equal(store[USER_ID]?.proactivePrompt?.relatedMemoryId, memory.id)
    assert.equal(store[USER_ID]?.activeConversationContext?.kind, "travel_impact_confirmation")
    assert.deepEqual(store[USER_ID]?.proactiveImpacts || [], [])
  })

  it("POST discard confirmed trip before impact → memory discarded and no proactiveImpact created", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "viajo quarta",
      understood: "Viagem na quarta",
      dateText: "quarta",
      weekKey: "2026-W20",
    })

    const confirmRes = await fetch(`${baseUrl}/guto/proactivity/confirm`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id }),
    })
    assert.equal(confirmRes.status, 200)

    const requestDiscardRes = await fetch(`${baseUrl}/guto/proactivity/request-discard`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id }),
    })
    assert.equal(requestDiscardRes.status, 200)

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

  it("pendência de evento de viagem bloqueia resposta paralela antes do card ser confirmado", async () => {
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
        input: "impossível treinar",
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
    assert.match(body.fala || "", /confirma.*viagem.*card/i)
    assert.equal(body.expectedResponse, null)
    assert.equal(body.memoryPatch?.activeConversationContext?.kind, "travel_confirmation")
    assert.equal(body.memoryPatch?.activeConversationContext?.relatedMemoryId, memory.id)
    assert.equal(body.memoryPatch?.proactiveImpacts?.some((impact) => impact.workoutEffect === "protected"), false)

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<
      string,
      {
        proactiveMemories?: Array<{ id: string; status: string; confirmationStage?: string; rawText?: string }>
        proactiveImpacts?: Array<{ workoutEffect: string }>
      }
    >
    assert.equal(store[USER_ID]?.proactiveMemories?.find((item) => item.id === memory.id)?.status, "pending_confirmation")
    assert.equal(store[USER_ID]?.proactiveMemories?.find((item) => item.id === memory.id)?.confirmationStage, "event")
    assert.doesNotMatch(store[USER_ID]?.proactiveMemories?.find((item) => item.id === memory.id)?.rawText || "", /imposs[ií]vel treinar/i)
    assert.equal(store[USER_ID]?.proactiveImpacts?.some((impact) => impact.workoutEffect === "protected"), false)
  })

  it("viagem confirmada + impossível cria um único card final de impacto sem proteger direto", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const tripDate = dateKey(1)
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "confirmed",
      rawText: "eu viajo amanhã",
      understood: "Viagem amanhã",
      dateText: "amanhã",
      dateParsed: tripDate,
      weekKey: currentWeekKey(),
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
    assert.match(body.fala || "", new RegExp(`Confirmo amanhã, dia ${tripDate.slice(8, 10)}/${tripDate.slice(5, 7)}`, "i"))
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
    })

    const res = await fetch(`${baseUrl}/guto/proactivity/confirm`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ memoryId: memory.id }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      ok: boolean
      impact?: { workoutEffect: string; pathEffect: string; affectedDates?: string[] }
      memoryPatch?: { proactiveImpacts?: Array<{ memoryId: string; workoutEffect: string; pathEffect: string; affectedDates?: string[] }> }
    }
    assert.equal(body.ok, true)
    assert.equal(body.impact?.workoutEffect, "protected")
    assert.equal(body.impact?.pathEffect, "adapted_context")
    assert.deepEqual(body.impact?.affectedDates, [tripDate])
    assert.equal(body.memoryPatch?.proactiveImpacts?.find((impact) => impact.memoryId === memory.id)?.workoutEffect, "protected")
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
        lastWorkoutPlan?: { title?: string }
        proactivePrompt?: { status?: string; fala?: string }
      }
    >
    assert.equal(store[USER_ID]?.totalXp, 100)
    assert.equal(store[USER_ID]?.xpEvents?.length, 0)
    assert.equal(store[USER_ID]?.completedWorkoutDates?.length, 0)
    assert.equal(store[USER_ID]?.lastWorkoutPlan?.title, "Corpo inteiro controlado")
    assert.equal(store[USER_ID]?.proactivePrompt?.status, "active")
    assert.equal(store[USER_ID]?.proactivePrompt?.fala, body.fala)
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
})

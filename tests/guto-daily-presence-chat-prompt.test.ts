import "./test-env.js"
import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Server } from "node:http"
import jwt from "jsonwebtoken"

const tmpDir = join(process.cwd(), "tmp")
const testMemoryFile = join(tmpDir, "guto-memory.daily-presence-chat-test.json")
const originalFetch = globalThis.fetch.bind(globalThis)

process.env.GUTO_MEMORY_FILE = testMemoryFile
process.env.GUTO_DISABLE_LISTEN = "1"
process.env.GUTO_ALLOW_DEV_ACCESS = "true"
process.env.GEMINI_API_KEY = "test-gemini-key"
process.env.GUTO_MODEL_TIMEOUT_MS = "3000"

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server }
let server: Server
let baseUrl = ""

function authHeaders(userId = "daily-chat-user") {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!)
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}

function readStore(): Record<string, unknown> {
  if (!existsSync(testMemoryFile)) return {}
  return JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, unknown>
}

function writeUserMemory(userId: string, data: Record<string, unknown>) {
  const store = readStore()
  store[userId] = {
    userId,
    name: "Will",
    language: "pt-BR",
    initialXpGranted: true,
    totalXp: 100,
    streak: 2,
    trainedToday: false,
    adaptedMissionToday: false,
    lastActiveAt: "2026-06-23T08:00:00.000Z",
    completedWorkoutDates: [],
    adaptedMissionDates: [],
    missedMissionDates: [],
    xpEvents: [],
    proactiveSent: {},
    initialXpRewardSeen: true,
    proactiveMemories: [],
    proactiveImpacts: [],
    ...data,
  }
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2))
}

function extractPrompt(init?: RequestInit): string {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
  return String(body?.contents?.[0]?.parts?.[0]?.text || "")
}

function geminiResponse(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
  }
}

describe("DailyPresenceContext no chat", () => {
  before(async () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2))

    const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      app: { listen: (port: number, hostname: string, callback?: () => void) => Server }
    }
    app = serverModule.app
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve())
      server.once("error", reject)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Failed to bind daily presence chat test server.")
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(() => {
    globalThis.fetch = originalFetch
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2))
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  })

  it("injeta contexto diário compacto no prompt principal", async () => {
    writeUserMemory("daily-chat-user", {
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
    })

    let capturedBrainPrompt = ""
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes("generativelanguage.googleapis.com")) {
        return originalFetch(input as RequestInfo, init)
      }

      const prompt = extractPrompt(init)
      if (prompt.includes("strict semantic safety classifier")) {
        return new Response(JSON.stringify(geminiResponse(JSON.stringify({
          flag: null,
          confidence: 0,
          reasoning: "safe",
        }))), { status: 200, headers: { "Content-Type": "application/json" } })
      }

      if (prompt.includes("semantic contract classifier")) {
        return new Response(JSON.stringify(geminiResponse(JSON.stringify({
          kind: "none",
          confidence: 1,
          reason: "test",
          age: null,
          limitationText: null,
          statusText: null,
          locationText: null,
          dateLabel: null,
          muscleGroup: null,
          avoidFocuses: [],
        }))), { status: 200, headers: { "Content-Type": "application/json" } })
      }

      if (prompt.includes("VOCÊ É GUTO")) {
        capturedBrainPrompt = prompt
      }
      return new Response(JSON.stringify(geminiResponse(JSON.stringify({
        fala: "Contexto entendido.",
        acao: "none",
        expectedResponse: null,
        avatarEmotion: "default",
        memoryPatch: {},
      }))), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof globalThis.fetch

    const res = await fetch(`${baseUrl}/guto`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ input: "qual é o plano de hoje?", language: "pt-BR" }),
    })

    assert.equal(res.status, 200)
    assert.match(capturedBrainPrompt, /Contexto diário GUTO:/)
    assert.match(capturedBrainPrompt, /location=Roma\/IT:calibration/)
    assert.match(capturedBrainPrompt, /kg:82/)
    assert.match(capturedBrainPrompt, /cm:178/)
    assert.match(capturedBrainPrompt, /food:sem lactose/)
  })
})

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

  it("POST confirm → status confirmed, decision e proactiveImpact", async () => {
    const { addProactiveMemory } = await import("../src/proactivity/proactive-store.js")
    const memory = await addProactiveMemory(USER_ID, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "viajo quarta",
      understood: "Viagem na quarta",
      dateText: "quarta",
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
      memory: { status: string; confirmedAt?: string; decision?: { reason: string } }
      impact?: { status: string; memoryId: string; workoutEffect: string; missionEffect: string }
      memoryPatch?: { proactiveImpacts?: Array<{ memoryId: string; status: string; workoutEffect: string }> }
    }
    assert.equal(body.ok, true)
    assert.equal(body.memory.status, "confirmed")
    assert.ok(body.memory.confirmedAt)
    assert.equal(body.memory.decision?.reason, "travel")
    assert.equal(body.impact?.status, "active")
    assert.equal(body.impact?.memoryId, memory.id)
    assert.equal(body.impact?.workoutEffect, "short_light")
    assert.equal(body.impact?.missionEffect, "protected_before")
    assert.equal(body.memoryPatch?.proactiveImpacts?.[0]?.memoryId, memory.id)

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<
      string,
      { proactiveImpacts?: Array<{ memoryId: string; status: string; workoutEffect: string }> }
    >
    assert.equal(store[USER_ID]?.proactiveImpacts?.[0]?.memoryId, memory.id)
    assert.equal(store[USER_ID]?.proactiveImpacts?.[0]?.workoutEffect, "short_light")
  })

  it("POST discard confirmed memory → proactiveImpact discarded", async () => {
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
      memoryPatch?: { proactiveImpacts?: Array<{ memoryId: string; status: string }> }
    }
    assert.equal(body.ok, true)
    assert.equal(body.memoryPatch?.proactiveImpacts?.find((impact) => impact.memoryId === memory.id)?.status, "discarded")
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
        conversationText: "USER: Quinta vou para Roma\nGUTO: Roma quinta a domingo, certo?",
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
})

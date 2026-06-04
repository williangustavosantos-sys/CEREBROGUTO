import "./test-env.js"
import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Server } from "node:http"
import jwt from "jsonwebtoken"

const tmpDir = join(process.cwd(), "tmp")
const testMemoryFile = join(tmpDir, "guto-memory.active-exercise-test.json")

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server }
let server: Server
let baseUrl = ""

const USER_ID = "active-exercise-user"

function authHeaders(userId = USER_ID) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!)
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}

function readUserMemory(userId: string): Record<string, unknown> {
  const store = existsSync(testMemoryFile)
    ? (JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, Record<string, unknown>>)
    : {}
  return store[userId] || {}
}

function writeUserMemory(userId: string, data: Record<string, unknown>) {
  const store = existsSync(testMemoryFile)
    ? (JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, unknown>)
    : {}
  store[userId] = { userId, name: "Will", language: "pt-BR", ...data }
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2))
}

describe("active exercise bridge (chat ↔ GUTO Online)", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = testMemoryFile
    process.env.GUTO_DISABLE_LISTEN = "1"
    process.env.GUTO_ALLOW_DEV_ACCESS = "true"
    mkdirSync(tmpDir, { recursive: true })

    const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      app: { listen: (port: number, hostname: string, callback?: () => void) => Server }
    }
    app = serverModule.app
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve())
      server.once("error", reject)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Failed to bind active-exercise test server.")
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(() => {
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2))
    writeUserMemory(USER_ID, {})
  })

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  })

  it("POST /guto/active-exercise persists the exercise on GutoMemory (source única)", async () => {
    const res = await fetch(`${baseUrl}/guto/active-exercise`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        exercise: {
          source: "online",
          name: "Supino reto com barra",
          muscleGroup: "peito",
          reps: "8-10",
          load: "40kg",
          rest: "75s",
          currentSet: 2,
          totalSets: 4,
        },
      }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })

    const active = readUserMemory(USER_ID).activeExercise as Record<string, unknown> | null
    assert.ok(active, "activeExercise should be persisted")
    assert.equal(active!.source, "online")
    assert.equal(active!.name, "Supino reto com barra")
    assert.equal(active!.muscleGroup, "peito")
    assert.equal(active!.currentSet, 2)
    assert.equal(active!.totalSets, 4)
    assert.equal(typeof active!.updatedAt, "string")
  })

  it("defaults unknown source to chat and trims overly long names", async () => {
    const longName = "x".repeat(200)
    const res = await fetch(`${baseUrl}/guto/active-exercise`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ exercise: { source: "weird", name: longName } }),
    })
    assert.equal(res.status, 200)

    const active = readUserMemory(USER_ID).activeExercise as Record<string, unknown>
    assert.equal(active.source, "chat")
    assert.equal((active.name as string).length, 120)
  })

  it("POST with { exercise: null } clears the active exercise", async () => {
    writeUserMemory(USER_ID, {
      activeExercise: {
        source: "chat",
        name: "Agachamento livre",
        updatedAt: new Date().toISOString(),
      },
    })

    const res = await fetch(`${baseUrl}/guto/active-exercise`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ exercise: null }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })

    assert.equal(readUserMemory(USER_ID).activeExercise, null)
  })

  it("requires auth", async () => {
    const res = await fetch(`${baseUrl}/guto/active-exercise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exercise: { source: "chat", name: "Rosca direta" } }),
    })
    assert.equal(res.status, 401)
  })
})

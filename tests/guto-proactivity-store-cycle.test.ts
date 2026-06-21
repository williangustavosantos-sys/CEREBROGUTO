import "./test-env.js"
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"

const TMP_FILE = "tmp/guto-proactivity-cycle-test.json"
const USER_ID = "proactivity-cycle-user"

before(() => {
  if (!existsSync("tmp")) mkdirSync("tmp", { recursive: true })
  process.env.GUTO_MEMORY_FILE = TMP_FILE
  writeFileSync(TMP_FILE, JSON.stringify({}))
})

after(() => {
  try {
    writeFileSync(TMP_FILE, JSON.stringify({}))
  } catch {
    /**/
  }
})

test("P3 — memória ativa passada vira pending_validation, não discarded", async () => {
  const { addProactiveMemory, getProactiveMemoriesByStatus, markPastActiveMemoriesPendingValidation } =
    await import("../src/proactivity/proactive-store.js")

  const yesterday = new Date()
  yesterday.setUTCDate(yesterday.getUTCDate() - 3)
  const pastDate = yesterday.toISOString().slice(0, 10)

  await addProactiveMemory(USER_ID, {
    type: "trip",
    status: "confirmed",
    rawText: "Viagem Roma",
    understood: "Viagem para Roma",
    dateText: "quinta passada",
    dateParsed: pastDate,
    location: "Roma",
    weekKey: "2026-W01",
  })

  await markPastActiveMemoriesPendingValidation(USER_ID)

  const pendingValidation = await getProactiveMemoriesByStatus(USER_ID, ["pending_validation"])
  assert.equal(pendingValidation.length, 1)
  assert.equal(pendingValidation[0]?.status, "pending_validation")

  const discarded = await getProactiveMemoriesByStatus(USER_ID, ["discarded"])
  assert.equal(discarded.length, 0)
})

test("ciclo confirm — pending_confirmation vira confirmed com confirmedAt", async () => {
  const { addProactiveMemory, updateProactiveMemory, getProactiveMemoriesByStatus } =
    await import("../src/proactivity/proactive-store.js")

  const memory = await addProactiveMemory(USER_ID, {
    type: "trip",
    status: "pending_confirmation",
    rawText: "Quinta vou para Roma",
    understood: "Viagem para Roma na quinta",
    dateText: "quinta",
    weekKey: "2026-W20",
  })

  const confirmedAt = new Date().toISOString()
  await updateProactiveMemory(USER_ID, memory.id, {
    status: "confirmed",
    confirmedAt,
  })

  const confirmed = await getProactiveMemoriesByStatus(USER_ID, ["confirmed"])
  assert.ok(confirmed.some((item) => item.id === memory.id))
  assert.ok(confirmed.find((item) => item.id === memory.id)?.confirmedAt)
})

test("upsert idempotente serializa duas extrações do mesmo evento sem append cego", async () => {
  const { upsertProactiveMemory, getProactiveMemories } = await import("../src/proactivity/proactive-store.js")
  const userId = `${USER_ID}-idempotent`
  const candidate = {
    type: "trip" as const,
    status: "pending_confirmation" as const,
    stage: "continuity_question" as const,
    rawText: "viajo na próxima terça",
    understood: "Viagem na próxima terça",
    dateText: "terça-feira",
    dateParsed: "2026-06-30",
    weekKey: "2026-W26",
  }

  const [first, second] = await Promise.all([
    upsertProactiveMemory(userId, candidate),
    upsertProactiveMemory(userId, { ...candidate, understood: "Viagem provável em 2026-06-30" }),
  ])
  const memories = await getProactiveMemories(userId)

  assert.equal(memories.length, 1)
  assert.equal(first.memory.id, second.memory.id)
  assert.equal([first.created, second.created].filter(Boolean).length, 1)
  assert.equal(memories[0]?.eventKey, `trip:${userId}:2026-06-30`)
})

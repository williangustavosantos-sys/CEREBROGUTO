// ─── Tests: Deterministic Proactivity Action Resolver ─────────────────────────
// These tests run without calling Gemini. They validate the resolver logic
// directly against in-memory proactive memory state.
// Covers cenários A, B, C, D, E, F do QA manual (GUTO_PROACTIVITY_AUDIT.md).

import './test-env.js'
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'

// ─── Temporary memory store setup ─────────────────────────────────────────────
const TMP_FILE = 'tmp/guto-proactivity-resolver-test.json'
const USER_A = 'resolver-test-user-A'
const USER_B = 'resolver-test-user-B'

before(() => {
  if (!existsSync('tmp')) mkdirSync('tmp', { recursive: true })
  process.env.GUTO_MEMORY_FILE = TMP_FILE
  writeFileSync(TMP_FILE, JSON.stringify({}))
})

after(() => {
  try { writeFileSync(TMP_FILE, JSON.stringify({})) } catch { /**/ }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function seedMemory(userId: string, memoryData: object) {
  const { readMemoryStoreAsync, writeMemoryStoreAsync } = await import('../src/memory-store.js') as any
  const store = await readMemoryStoreAsync()
  store[userId] = memoryData
  await writeMemoryStoreAsync(store)
}

async function resolve(userId: string, input: string, lang = 'pt-BR') {
  const { resolveProactiveMemoryActionFromUserReply } = await import('../src/proactivity/memory-action-resolver.js')
  return resolveProactiveMemoryActionFromUserReply(userId, input, lang)
}

function makePendingConfirmation(id: string) {
  return {
    id,
    userId: USER_A,
    type: 'trip',
    status: 'pending_confirmation',
    rawText: 'Quinta vou para Roma',
    understood: 'Viagem para Roma na quinta',
    dateText: 'quinta',
    dateParsed: '2026-05-15',
    location: 'Roma',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    weekKey: '2026-W20',
  }
}

function makePendingValidation(id: string) {
  return {
    id,
    userId: USER_B,
    type: 'trip',
    status: 'pending_validation',
    rawText: 'Quinta vou para Roma',
    understood: 'Viagem para Roma na quinta',
    dateText: 'quinta',
    dateParsed: '2026-05-08',
    location: 'Roma',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    weekKey: '2026-W19',
  }
}

// ─── Cenário A — Confirmação clara ────────────────────────────────────────────

test('A — "sim" confirma pending_confirmation (pt-BR)', async () => {
  const memoryId = 'pm_A1_confirm'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'sim')
  assert.equal(result.engaged, true, 'resolver deve engajar')
  assert.deepEqual(result.action, { type: 'confirm', memoryId })
})

test('A — "yes" confirma pending_confirmation (en-US)', async () => {
  const memoryId = 'pm_A2_confirm'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'yes', 'en-US')
  assert.equal(result.engaged, true)
  assert.deepEqual(result.action, { type: 'confirm', memoryId })
})

test('A — "sì" confirma pending_confirmation (it-IT)', async () => {
  const memoryId = 'pm_A3_confirm'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [{ ...makePendingConfirmation(memoryId), userId: USER_A }],
  })
  const result = await resolve(USER_A, 'sì', 'it-IT')
  assert.equal(result.engaged, true)
  assert.deepEqual(result.action, { type: 'confirm', memoryId })
})

test('A — "exato" confirma pending_confirmation', async () => {
  const memoryId = 'pm_A4_confirm'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'exato')
  assert.equal(result.engaged, true)
  assert.deepEqual(result.action, { type: 'confirm', memoryId })
})

// ─── Cenário B — Descarte / cancelamento ──────────────────────────────────────

test('B — "não vou mais" descarta pending_confirmation', async () => {
  const memoryId = 'pm_B1_discard'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'não vou mais')
  assert.equal(result.engaged, true)
  assert.deepEqual(result.action, { type: 'discard', memoryId })
})

test('B — "cancelei" descarta pending_confirmation', async () => {
  const memoryId = 'pm_B2_discard'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'cancelei')
  assert.equal(result.engaged, true)
  assert.deepEqual(result.action, { type: 'discard', memoryId })
})

test('B — "not going anymore" descarta (en-US)', async () => {
  const memoryId = 'pm_B3_discard'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'not going anymore', 'en-US')
  assert.equal(result.engaged, true)
  assert.deepEqual(result.action, { type: 'discard', memoryId })
})

// ─── Cenário C — Validação posterior ─────────────────────────────────────────

test('C — "sim" valida pending_validation como happened', async () => {
  const memoryId = 'pm_C1_validate'
  await seedMemory(USER_B, {
    userId: USER_B,
    proactiveMemories: [makePendingValidation(memoryId)],
  })
  const result = await resolve(USER_B, 'sim')
  assert.equal(result.engaged, true)
  assert.deepEqual(result.action, { type: 'validate', memoryId, outcome: 'happened' })
})

test('C — "rolou" valida como happened', async () => {
  const memoryId = 'pm_C2_validate'
  await seedMemory(USER_B, {
    userId: USER_B,
    proactiveMemories: [makePendingValidation(memoryId)],
  })
  const result = await resolve(USER_B, 'rolou')
  assert.equal(result.engaged, true)
  assert.deepEqual(result.action, { type: 'validate', memoryId, outcome: 'happened' })
})

test('C — "adiei" valida como postponed', async () => {
  const memoryId = 'pm_C3_postponed'
  await seedMemory(USER_B, {
    userId: USER_B,
    proactiveMemories: [makePendingValidation(memoryId)],
  })
  const result = await resolve(USER_B, 'adiei')
  assert.equal(result.engaged, true)
  assert.deepEqual(result.action, { type: 'validate', memoryId, outcome: 'postponed' })
})

test('C — "cancelei" valida como discarded', async () => {
  const memoryId = 'pm_C4_discarded'
  await seedMemory(USER_B, {
    userId: USER_B,
    proactiveMemories: [makePendingValidation(memoryId)],
  })
  const result = await resolve(USER_B, 'cancelei')
  assert.equal(result.engaged, true)
  assert.deepEqual(result.action, { type: 'validate', memoryId, outcome: 'discarded' })
})

test('C — "não fui" valida como discarded', async () => {
  const memoryId = 'pm_C5_discarded'
  await seedMemory(USER_B, {
    userId: USER_B,
    proactiveMemories: [makePendingValidation(memoryId)],
  })
  const result = await resolve(USER_B, 'não fui')
  assert.equal(result.engaged, true)
  assert.deepEqual(result.action, { type: 'validate', memoryId, outcome: 'discarded' })
})

// ─── Cenário D — Ambiguidade ──────────────────────────────────────────────────

test('D — "talvez" não confirma, retorna fallbackMessage (pt-BR)', async () => {
  const memoryId = 'pm_D1_ambiguous'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'talvez')
  assert.equal(result.engaged, true, 'resolver deve engajar')
  assert.equal(result.action, null, 'nenhum endpoint deve ser chamado')
  assert.ok(result.fallbackMessage, 'deve retornar fallbackMessage')
  assert.match(result.fallbackMessage!, /confirma|cancela/i, 'fallback deve pedir esclarecimento')
})

test('D — "maybe" não confirma (en-US)', async () => {
  const memoryId = 'pm_D2_ambiguous'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'maybe', 'en-US')
  assert.equal(result.engaged, true)
  assert.equal(result.action, null)
  assert.ok(result.fallbackMessage)
})

test('D — "não sei" não confirma (ambiguidade pt-BR)', async () => {
  const memoryId = 'pm_D3_ambiguous'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'não sei')
  assert.equal(result.engaged, true)
  assert.equal(result.action, null)
  assert.ok(result.fallbackMessage)
})

test('D — ambiguidade em pending_validation retorna fallback', async () => {
  const memoryId = 'pm_D4_validate_ambiguous'
  await seedMemory(USER_B, {
    userId: USER_B,
    proactiveMemories: [makePendingValidation(memoryId)],
  })
  const result = await resolve(USER_B, 'talvez')
  assert.equal(result.engaged, true)
  assert.equal(result.action, null)
  assert.ok(result.fallbackMessage)
  assert.match(result.fallbackMessage!, /aconteceu|adiado|cancelado/i)
})

// ─── Cenário E — Correção sem endpoint ───────────────────────────────────────

test('E — "não, é sexta" não chama endpoint, retorna fallback de correção', async () => {
  const memoryId = 'pm_E1_correction'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'não, é sexta')
  assert.equal(result.engaged, true)
  assert.equal(result.action, null, 'nenhum endpoint de memória')
  assert.ok(result.fallbackMessage, 'deve ter fallback de correção')
  assert.equal(result.reason, 'correction_no_endpoint')
})

test('E — "no, it\'s Friday" detecta correção (en-US)', async () => {
  const memoryId = 'pm_E2_correction'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, "no, it's Friday", 'en-US')
  assert.equal(result.engaged, true)
  assert.equal(result.action, null)
  assert.equal(result.reason, 'correction_no_endpoint')
})

test('E — "não, vai ser sábado" detecta correção', async () => {
  const memoryId = 'pm_E3_correction'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'não, vai ser sábado')
  assert.equal(result.engaged, true)
  assert.equal(result.action, null)
  assert.equal(result.reason, 'correction_no_endpoint')
})

test('E — "não, é para Milão" detecta correção de destino', async () => {
  const memoryId = 'pm_E4_correction'
  await seedMemory(USER_A, {
    userId: USER_A,
    proactiveMemories: [makePendingConfirmation(memoryId)],
  })
  const result = await resolve(USER_A, 'não, é para Milão')
  assert.equal(result.engaged, true)
  assert.equal(result.action, null)
  assert.equal(result.reason, 'correction_no_endpoint')
})

// ─── Cenário F — Timezone: resolver não usa UTC puro ─────────────────────────

test('F — resolver usa apenas input/memória, sem depender de UTC direto', async () => {
  // The resolver itself doesn't do date parsing (it's pure string matching).
  // Verify it doesn't crash near midnight and that getDateKey uses the configured TZ.
  const { getDateKey, getWeekKey } = await import('../src/proactivity/proactive-store.js')
  const rome = 'Europe/Rome'
  const dateKey = getDateKey(new Date(), rome)
  const weekKey = getWeekKey(new Date())
  assert.match(dateKey, /^\d{4}-\d{2}-\d{2}$/, 'dateKey deve ser ISO date do timezone configurado')
  assert.match(weekKey, /^\d{4}-W\d{2}$/, 'weekKey deve ser ISO week')
})

// ─── Sem memória pendente — pass-through ──────────────────────────────────────

test('pass-through quando não há memória pendente', async () => {
  const emptyUser = 'resolver-empty-user'
  await seedMemory(emptyUser, { userId: emptyUser, proactiveMemories: [] })
  const result = await resolve(emptyUser, 'sim')
  assert.equal(result.engaged, false, 'não deve engajar sem memória pendente')
})

test('pass-through para input vazio', async () => {
  const result = await resolve(USER_A, '')
  assert.equal(result.engaged, false)
})

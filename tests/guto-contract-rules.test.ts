import './test-env.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.GEMINI_API_KEY = ''

test('contrato: "nessun dolore" nao vira restricao alimentar', async () => {
  const { resolveProfileFreeFields, getPendingClarification } = await import('../src/dirty-data-resolver.js')

  const resolved = await resolveProfileFreeFields({
    foodRestriction: 'nessun dolore',
    previous: {},
  })

  assert.equal(resolved.foodRestriction, undefined)
  assert.equal(getPendingClarification(resolved, 'diet'), null)
})

test('contrato: lattosio resolve como lactose sem depender do modelo', async () => {
  const { resolveProfileFreeFields, getPendingClarification } = await import('../src/dirty-data-resolver.js')

  const resolved = await resolveProfileFreeFields({
    foodRestriction: 'Lattosio',
    previous: {},
  })

  assert.equal(resolved.foodRestriction?.status, 'clear')
  assert.equal(resolved.foodRestriction?.normalizedValue, 'lactose_intolerance')
  assert.equal(getPendingClarification(resolved, 'diet'), null)
})

test('contrato: correcao proativa ambigua nao executa update direto', async () => {
  const { resolveProactiveMemoryActionFromUserReply } = await import('../src/proactivity/memory-action-resolver.js')
  const { writeMemoryStoreAsync } = await import('../src/memory-store.js')

  const userId = 'contract-proactivity-user'
  await writeMemoryStoreAsync({
    [userId]: {
      userId,
      proactiveMemories: [
        {
          id: 'pm_contract_1',
          userId,
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
        },
      ],
    },
  })

  const result = await resolveProactiveMemoryActionFromUserReply(userId, 'não, é sexta', 'pt-BR')

  assert.equal(result.engaged, true)
  assert.equal(result.action, null)
  assert.match(result.fallbackMessage || '', /mudou|exato|confirma|certeza/i)
})

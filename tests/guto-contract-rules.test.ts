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

test('contrato: "como de tudo" e "sem alergia" nao viram restricao incerta', async () => {
  const { resolveProfileFreeFields, getPendingClarification } = await import('../src/dirty-data-resolver.js')

  for (const foodRestriction of ['COMO DE TUDO', 'I EAT EVERYTHING', 'MANGIO TUTTO', 'SEM ALERGIA', 'NO ALLERGY', 'NESSUNA ALLERGIA']) {
    const resolved = await resolveProfileFreeFields({
      foodRestriction,
      previous: {},
    })

    assert.equal(resolved.foodRestriction, undefined, foodRestriction)
    assert.equal(getPendingClarification(resolved, 'diet'), null, foodRestriction)
  }
})

test('contrato: alergia/intolerancia separada sobrevive quando restricao diz que come de tudo', async () => {
  const { resolveProfileFreeFields, getPendingClarification } = await import('../src/dirty-data-resolver.js')

  const resolved = await resolveProfileFreeFields({
    foodRestriction: 'MANGIO TUTTO; Lattosio',
    previous: {},
  })

  assert.equal(resolved.foodRestriction?.status, 'clear')
  assert.equal(resolved.foodRestriction?.normalizedValue, 'lactose_intolerance')
  assert.equal(getPendingClarification(resolved, 'diet'), null)
})

test('contrato: correcao proativa clara executa update deterministico', async () => {
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
  assert.equal(result.action?.type, 'update')
  assert.equal(result.action?.type === 'update' ? result.action.patch.dateText : undefined, 'sexta-feira')
  const [{ resolveProactiveDate }, { getDateKey }] = await Promise.all([
    import('../src/proactivity/date-resolver.js'),
    import('../src/proactivity/proactive-store.js'),
  ])
  assert.equal(
    result.action?.type === 'update' ? result.action.patch.dateParsed : undefined,
    resolveProactiveDate('não, é sexta', getDateKey())?.dateParsed,
  )
})

// ─── Fase 3 — esclarecimento de limitação física (dor) ──────────────────────
// Bug 2: "Tenho dor nas pernas" é esclarecimento SUFICIENTE. Tem que normalizar
// conservador (lower body) e liberar o gate de treino — sem depender de IA.

test('contrato: "Tenho dor nas pernas" normaliza como lower body e libera o gate', async () => {
  const { resolveProfileFreeFields, getPendingClarification } = await import('../src/dirty-data-resolver.js')

  const resolved = await resolveProfileFreeFields({ pathology: 'Tenho dor nas pernas', previous: {} })

  assert.equal(resolved.pathology?.status, 'clear')
  assert.equal(resolved.pathology?.normalizedValue, 'lower_body_sensitive')
  assert.equal(resolved.pathology?.bodyRegion, 'knee')
  for (const tag of ['knee', 'hip', 'ankle']) {
    assert.ok(resolved.pathology?.riskTags.includes(tag), `riskTags deve cobrir ${tag}`)
  }
  // Gate de treino liberado: nenhuma pergunta de patologia pendente.
  assert.equal(getPendingClarification(resolved, 'training'), null)
})

test('contrato: "no joelho" e "na coluna" também são esclarecimentos válidos', async () => {
  const { resolveProfileFreeFields, getPendingClarification } = await import('../src/dirty-data-resolver.js')

  const joelho = await resolveProfileFreeFields({ pathology: 'dor no joelho direito', previous: {} })
  assert.equal(joelho.pathology?.status, 'clear')
  assert.equal(joelho.pathology?.bodyRegion, 'knee')
  assert.equal(getPendingClarification(joelho, 'training'), null)

  const coluna = await resolveProfileFreeFields({ pathology: 'dor na coluna', previous: {} })
  assert.equal(coluna.pathology?.status, 'clear')
  assert.equal(coluna.pathology?.bodyRegion, 'lower_back')
  assert.equal(getPendingClarification(coluna, 'training'), null)
})

test('contrato: patologia ambígua ("Gambia") NÃO vira clear e mantém a pergunta', async () => {
  const { resolveProfileFreeFields, getPendingClarification } = await import('../src/dirty-data-resolver.js')

  const resolved = await resolveProfileFreeFields({ pathology: 'Gambia', previous: {} })

  assert.notEqual(resolved.pathology?.status, 'clear')
  const pending = getPendingClarification(resolved, 'training')
  assert.ok(pending, 'patologia ambígua deve gerar pergunta')
  assert.equal(pending?.field, 'pathology')
})

test('contrato: limitação física e restrição alimentar ficam separadas', async () => {
  const { resolveProfileFreeFields } = await import('../src/dirty-data-resolver.js')

  // "não como lactose" → restrição alimentar, nunca patologia.
  const food = await resolveProfileFreeFields({ foodRestriction: 'não como lactose', previous: {} })
  assert.equal(food.foodRestriction?.normalizedValue, 'lactose_intolerance')
  assert.equal(food.pathology, undefined)

  // "dor nas pernas" → patologia, nunca restrição alimentar.
  const pathology = await resolveProfileFreeFields({ pathology: 'dor nas pernas', previous: {} })
  assert.equal(pathology.pathology?.field, 'pathology')
  assert.equal(pathology.foodRestriction, undefined)
})

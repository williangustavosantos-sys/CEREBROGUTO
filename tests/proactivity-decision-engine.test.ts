import './test-env.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildImpactFromDecision,
  decideFromProactiveMemory,
  getAdaptationForDate,
  resolveEffectiveImpacts,
} from '../src/proactivity/decision-engine.js'
import type { ProactiveImpact, ProactiveMemory } from '../src/proactivity/types.js'

const NOW = '2026-06-07T12:00:00.000Z'
const WEDNESDAY = '2026-06-10'

function makeMemory(
  id: string,
  type: ProactiveMemory['type'],
  rawText: string,
  patch: Partial<ProactiveMemory> = {}
): ProactiveMemory {
  return {
    id,
    userId: 'decision-engine-user',
    type,
    status: 'confirmed',
    rawText,
    understood: rawText,
    createdAt: NOW,
    updatedAt: NOW,
    weekKey: '2026-W23',
    ...patch,
  }
}

function pipeline(memory: ProactiveMemory, date = WEDNESDAY, coachLocked = false) {
  const decision = decideFromProactiveMemory({ memory, now: NOW, language: 'pt-BR', coachLocked })
  assert.ok(decision, 'memória operacional deve gerar decisão')
  const impact = buildImpactFromDecision(decision, { proactiveImpacts: [] })
  assert.ok(impact, 'decisão operacional deve gerar impacto')
  const adaptation = getAdaptationForDate({ proactiveImpacts: [impact] }, date)
  return { decision, impact, adaptation }
}

test('viajo quarta (sem dado crítico): NÃO cria impacto definitivo, pergunta o crítico', () => {
  // Continuidade primeiro: viagem nua é mudança de contexto, não interrupção.
  // Sem saber se o usuário consegue treinar, o GUTO não decide descanso nem
  // treino adaptado — vira ask_critical (pending_clarification).
  const memory = makeMemory('pm_trip', 'trip', 'viajo quarta', { dateText: 'quarta' })
  const { decision, impact, adaptation } = pipeline(memory)

  assert.equal(decision.reason, 'travel')
  assert.equal(decision.kind, 'ask_critical')
  assert.equal(decision.criticalQuestion, 'training')
  // Não assume descanso (protected) nem treino adaptado (short_light) ainda.
  assert.equal(adaptation.workoutEffect, 'ask_critical')
  assert.notEqual(adaptation.workoutEffect, 'short_light')
  assert.notEqual(adaptation.workoutEffect, 'protected')
  assert.equal(adaptation.shouldAskCritical, true)
  // Impacto não-definitivo: só chat, sem efeito de XP/Arena/push.
  assert.deepEqual(impact.surfaces, ['chat'])
  assert.equal(impact.xpEffect, 'none')
  assert.equal(impact.arenaEffect, 'none')
  assert.equal(impact.pushEffect, 'none')
})

test('viagem + resposta CURTA "não vou conseguir" (sem "treinar"): resolve protegido, NÃO repergunta (anti-loop)', () => {
  // Bug do loop: turn-1 "viajo sexta" → ask_critical (pergunta se consegue treinar);
  // turn-2 resposta curta "não vou conseguir" precisa RESOLVER em dia protegido, não
  // voltar a ask_critical e repetir a pergunta. Antes a regex exigia "treinar" junto.
  const memory = makeMemory('pm_trip_short_no', 'trip', 'viajo quarta, não vou conseguir', { dateText: 'quarta' })
  const { decision, adaptation } = pipeline(memory)

  assert.equal(decision.reason, 'travel')
  assert.notEqual(decision.kind, 'ask_critical') // NÃO pode repetir a pergunta
  assert.equal(adaptation.workoutEffect, 'protected')
  assert.equal(adaptation.isProtectedDay, true)
  assert.equal(adaptation.shouldAskCritical, false)
})

test('viajo quarta + consigo treinar no hotel: mantém treino adaptado, NÃO descanso', () => {
  const memory = makeMemory('pm_trip_hotel', 'trip', 'viajo quarta, consigo treinar no hotel', { dateText: 'quarta' })
  const { decision, adaptation } = pipeline(memory)

  assert.equal(decision.reason, 'travel')
  assert.equal(decision.kind, 'adapt_day')
  assert.equal(adaptation.workoutEffect, 'short_light')
  assert.equal(adaptation.missionEffect, 'reduced')
  assert.equal(adaptation.isAdaptedDay, true)
  assert.equal(adaptation.isProtectedDay, false)
  // Não bloqueia o dia inteiro — ele consegue treinar.
  assert.notEqual(adaptation.blockedPeriod, 'all_day')
})

test('viajo quarta + não vou conseguir treinar: dia protegido, sem XP/Arena grátis', () => {
  const memory = makeMemory('pm_trip_block', 'trip', 'viajo quarta, não vou conseguir treinar', { dateText: 'quarta' })
  const { decision, adaptation } = pipeline(memory)

  assert.equal(decision.reason, 'travel')
  assert.equal(adaptation.workoutEffect, 'protected')
  assert.equal(adaptation.missionEffect, 'protected')
  assert.equal(adaptation.isProtectedDay, true)
  assert.equal(adaptation.isAdaptedDay, false)
  // Sem compensação cega: nada de XP/Arena grátis nem intensidade máxima.
  assert.equal(adaptation.xpPolicy, 'no_free_xp')
  assert.equal(adaptation.arenaPolicy, 'validation_required')
  assert.equal(adaptation.shouldAvoidBlindPenalty, true)
})

test('só tenho 10 minutos: missão curta, NÃO cancela', () => {
  const memory = makeMemory('pm_short', 'other', 'só tenho 10 minutos hoje')
  const { decision, adaptation } = pipeline(memory, '2026-06-07')

  assert.equal(decision.reason, 'short_window')
  assert.equal(adaptation.workoutEffect, 'minimal')
  assert.equal(adaptation.missionEffect, 'reduced')
  // Não vira 'normal' (cancelado/sem efeito): a missão curta é mantida.
  assert.notEqual(adaptation.workoutEffect, 'normal')
})

test('reunião quarta à noite: bloqueia período e reduz/antecipa treino', () => {
  const memory = makeMemory('pm_meeting', 'commitment', 'reunião quarta à noite', { dateText: 'quarta à noite' })
  const { decision, impact, adaptation } = pipeline(memory)

  assert.equal(decision.reason, 'commitment')
  assert.equal(decision.blockedPeriod, 'evening')
  assert.equal(impact.surfaces.includes('workout'), true)
  assert.equal(impact.surfaces.includes('mission'), true)
  assert.equal(adaptation.workoutEffect, 'short_light')
  assert.equal(adaptation.missionEffect, 'reduced')
})

test('semana corrida: reduz complexidade semanal e exige execução mínima', () => {
  const memory = makeMemory('pm_busy_week', 'other', 'semana corrida')
  const { decision, impact, adaptation } = pipeline(memory, '2026-06-08')

  assert.equal(decision.reason, 'busy_week')
  assert.equal(impact.affectedDates.length, 7)
  assert.equal(adaptation.workoutEffect, 'minimal')
  assert.equal(adaptation.missionEffect, 'reduced')
  assert.equal(adaptation.xpPolicy, 'no_free_xp')
})

test('nada essa semana: mantém plano normal e resolve abertura semanal', () => {
  const memory = makeMemory('pm_clear_week', 'other', 'nada essa semana')
  const { decision, impact, adaptation } = pipeline(memory, '2026-06-08')

  assert.equal(decision.reason, 'clear_week')
  assert.equal(impact.status, 'active')
  assert.equal(adaptation.workoutEffect, 'normal')
  assert.equal(adaptation.missionEffect, 'normal')
  assert.equal(adaptation.xpPolicy, 'normal')
})

test('saudação pura não gera decisão nem impacto', () => {
  const memory = makeMemory('pm_hello', 'other', 'oi GUTO')
  const decision = decideFromProactiveMemory({ memory, now: NOW, language: 'pt-BR' })

  assert.equal(decision, null)
})

test('viagem + reunião na mesma data: viagem vence reunião por prioridade', () => {
  // Viagem com dado crítico (consegue treinar) gera impacto definitivo que, por
  // prioridade, supera a reunião nas surfaces compartilhadas.
  const trip = pipeline(makeMemory('pm_trip_conflict', 'trip', 'viajo quarta, treino no hotel', { dateText: 'quarta' })).impact
  const meeting = pipeline(makeMemory('pm_meeting_conflict', 'commitment', 'reunião quarta à noite', { dateText: 'quarta à noite' })).impact
  const resolved = resolveEffectiveImpacts([meeting, trip], WEDNESDAY)
  const adaptation = getAdaptationForDate({ proactiveImpacts: [meeting, trip] }, WEDNESDAY)

  assert.equal(resolved.find((impact) => impact.id === trip.id)?.status, 'active')
  assert.equal(resolved.find((impact) => impact.id === meeting.id)?.status, 'superseded')
  assert.equal(adaptation.reason, 'travel')
  assert.equal(adaptation.workoutEffect, 'short_light')
})

test('dor + semana corrida: saúde vence semana corrida', () => {
  const pain = pipeline(makeMemory('pm_pain', 'health', 'estou com dor quarta', { dateText: 'quarta' })).impact
  const busy = pipeline(makeMemory('pm_busy_conflict', 'other', 'semana corrida'), WEDNESDAY).impact
  const resolved = resolveEffectiveImpacts([busy, pain], WEDNESDAY)
  const adaptation = getAdaptationForDate({ proactiveImpacts: [busy, pain] }, WEDNESDAY)

  assert.equal(resolved.find((impact) => impact.id === pain.id)?.status, 'active')
  assert.equal(resolved.find((impact) => impact.id === busy.id)?.status, 'superseded')
  assert.equal(adaptation.reason, 'health')
  assert.equal(adaptation.workoutEffect, 'minimal')
})

test('coach lock: treino travado pelo coach não é sobrescrito', () => {
  const memory = makeMemory('pm_locked', 'trip', 'viajo quarta', { dateText: 'quarta' })
  const { decision, impact, adaptation } = pipeline(memory, WEDNESDAY, true)

  assert.equal(decision.reason, 'coach_lock')
  assert.equal(impact.workoutEffect, 'coach_locked')
  assert.equal(adaptation.workoutEffect, 'coach_locked')
  assert.equal(adaptation.isAdaptedDay, false)
})

test('cancelamento remove impacto ativo do seletor', () => {
  const impact = pipeline(makeMemory('pm_cancel', 'trip', 'viajo quarta', { dateText: 'quarta' })).impact
  const discarded: ProactiveImpact = { ...impact, status: 'discarded' }
  const adaptation = getAdaptationForDate({ proactiveImpacts: [discarded] }, WEDNESDAY)

  assert.equal(adaptation.primaryImpact, undefined)
  assert.equal(adaptation.workoutEffect, 'normal')
  assert.equal(adaptation.missionEffect, 'normal')
})

test('confirmar memória cria decisão e impacto persistível', () => {
  const memory = makeMemory('pm_confirm', 'commitment', 'reunião quarta à noite', { dateText: 'quarta à noite' })
  const decision = decideFromProactiveMemory({ memory, now: NOW, language: 'pt-BR' })
  assert.ok(decision)
  const impact = buildImpactFromDecision(decision, { proactiveImpacts: [] })

  assert.ok(impact)
  assert.equal(impact.memoryId, memory.id)
  assert.equal(impact.status, 'active')
  assert.equal(impact.surfaces.includes('workout'), true)
  assert.equal(impact.surfaces.includes('mission'), true)
})

test('descartar memória descarta impacto e treino/missão voltam ao normal', () => {
  const impact = pipeline(makeMemory('pm_discard', 'other', 'semana corrida'), '2026-06-08').impact
  const discarded: ProactiveImpact = { ...impact, status: 'discarded' }
  const adaptation = getAdaptationForDate({ proactiveImpacts: [discarded] }, '2026-06-08')

  assert.equal(adaptation.primaryImpact, undefined)
  assert.equal(adaptation.workoutEffect, 'normal')
  assert.equal(adaptation.missionEffect, 'normal')
})

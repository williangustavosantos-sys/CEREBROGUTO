// ─── GUTO Proactivity — Context Injector ─────────────────────────────────────
// Builds the proactivity context block injected into buildGutoBrainPrompt.
// The LLM receives real data and decides naturally how to use it.
// GUTO is never forced to say something — the data is context, not a script.

import {
  getProactiveMemoriesByStatus,
  markPastActiveMemoriesPendingValidation,
} from './proactive-store'

import { getWeeklyCheckResult } from './weekly-conversation'
import type { ProactiveMemory } from './types'

// ─── Format helpers ────────────────────────────────────────────────────────────

function formatMemoryForPrompt(m: ProactiveMemory, language: string): string {
  const lines: string[] = []

  lines.push(`- [${m.type.toUpperCase()}] ${m.understood}`)

  if (m.dateText) {
    lines.push(`  Quando: ${m.dateText}${m.dateParsed ? ` (${m.dateParsed})` : ''}`)
  }

  if (m.location) {
    lines.push(`  Local: ${m.location}`)
  }

  if (m.weatherEnrichment) {
    const w = m.weatherEnrichment
    const lang = language
    if (lang === 'it-IT') {
      lines.push(`  Meteo ${w.city}: ${w.condition}, ${w.tempMin}–${w.tempMax}°C em ${w.date}`)
    } else if (lang === 'en-US') {
      lines.push(`  Weather in ${w.city}: ${w.condition}, ${w.tempMin}–${w.tempMax}°C on ${w.date}`)
    } else {
      lines.push(`  Clima em ${w.city}: ${w.condition}, ${w.tempMin}–${w.tempMax}°C em ${w.date}`)
    }
  }

  if (m.holidayEnrichment && m.holidayEnrichment.length > 0) {
    const holidays = m.holidayEnrichment.map((h) => `${h.nameLocal} (${h.date})`).join(', ')
    if (language === 'it-IT') {
      lines.push(`  Festività questa settimana: ${holidays}`)
    } else if (language === 'en-US') {
      lines.push(`  Holidays this week: ${holidays}`)
    } else {
      lines.push(`  Feriados esta semana: ${holidays}`)
    }
  }

  return lines.join('\n')
}

// ─── Main builder ──────────────────────────────────────────────────────────────

export async function buildProactivityContextBlock(
  userId: string,
  weekday: string,
  language: string
): Promise<string | null> {
  try {
    await markPastActiveMemoriesPendingValidation(userId)
    const weeklyCheck = await getWeeklyCheckResult(userId, weekday)

    // Active memories: confirmed, enriched, surfaced (not yet discarded/validated)
    const activeMemories = await getProactiveMemoriesByStatus(userId, [
      'confirmed',
      'enriched',
      'surfaced',
    ])

    const pendingConfirmation = await getProactiveMemoriesByStatus(userId, [
      'pending_confirmation',
    ])

    const pendingValidation = await getProactiveMemoriesByStatus(userId, [
      'pending_validation',
    ])

    // Nothing to inject
    if (
      !weeklyCheck.shouldOpenWeekly &&
      !weeklyCheck.shouldValidate &&
      activeMemories.length === 0 &&
      pendingConfirmation.length === 0 &&
      pendingValidation.length === 0
    ) {
      return null
    }

    const sections: string[] = []

    // ── Weekly conversation signal ─────────────────────────────────────────────
    if (weeklyCheck.shouldOpenWeekly) {
      if (language === 'it-IT') {
        sections.push(
          `[PROATTIVITÀ — APERTURA SETTIMANALE]\n` +
          `Oggi è lunedì. Hai già pianificato l'allenamento della settimana.\n` +
          `All'inizio di questa conversazione, chiedi casualmente come sarà la sua settimana — come un amico che vuole sapere se ci sono viaggi, impegni o cambiamenti di orario che potrebbero influenzare il programma.\n` +
          `Sii naturale. Non usare frasi tipo "ora farò la mia domanda settimanale". Chiedilo come vengono le cose nella conversazione.`
        )
      } else if (language === 'en-US') {
        sections.push(
          `[PROACTIVITY — WEEKLY OPENING]\n` +
          `Today is Monday. You've already planned this week's workout.\n` +
          `Early in this conversation, casually ask how the week looks — like a friend checking if there are trips, commitments, or schedule changes that might affect the plan.\n` +
          `Be natural. Don't say "I will now ask my weekly question." Just bring it up as it fits.`
        )
      } else {
        sections.push(
          `[PROATIVIDADE — ABERTURA SEMANAL]\n` +
          `Hoje é segunda-feira. Você já montou o treino da semana.\n` +
          `No início dessa conversa, pergunta casualmente como vai ser a semana — como amigo que quer saber se tem viagem, compromisso ou mudança de horário que pode afetar o plano.\n` +
          `Seja natural. Não diga "agora vou fazer minha pergunta semanal". Traga como vem na conversa.`
        )
      }
    }

    // ── Validation signal ──────────────────────────────────────────────────────
    if (weeklyCheck.shouldValidate && pendingValidation.length > 0) {
      const first = pendingValidation[0]!
      const item = `"${first.understood}"${first.dateText ? ` — ${first.dateText}` : ''}`

      if (language === 'it-IT') {
        sections.push(
          `[PROATTIVITÀ — VALIDAZIONE SETTIMANA SCORSA]\n` +
          `La settimana scorsa avevi registrato questo evento:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORITÀ: risolvi questa validazione prima di parlare di allenamento, dieta o nuova missione.\n` +
          `Chiedi brevemente e naturalmente cosa è successo — solo questo evento, uno alla volta.\n` +
          `Se l'utente conferma che È SUCCESSO, DEVI ritornare: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "happened" }\n` +
          `Se l'utente dice che è stato RIMANDATO, DEVI ritornare: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "postponed" }\n` +
          `Se l'utente dice che è stato CANCELLATO o non succederà più, DEVI ritornare: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "discarded" }\n` +
          `Se la risposta è ambigua, NON ritornare proactiveMemoryAction — chiedi chiarezza.`
        )
      } else if (language === 'en-US') {
        sections.push(
          `[PROACTIVITY — LAST WEEK VALIDATION]\n` +
          `Last week you had registered this event:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORITY: resolve this validation before talking about workout, diet, or a new mission.\n` +
          `Briefly and naturally ask what happened — only this event, one at a time.\n` +
          `If the user confirms it HAPPENED, you MUST return: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "happened" }\n` +
          `If the user says it was POSTPONED, you MUST return: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "postponed" }\n` +
          `If the user says it was CANCELLED or will not happen anymore, you MUST return: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "discarded" }\n` +
          `If the response is ambiguous, do NOT return proactiveMemoryAction — ask for clarity.`
        )
      } else {
        sections.push(
          `[PROATIVIDADE — VALIDAÇÃO DA SEMANA PASSADA]\n` +
          `Na semana passada você tinha registrado este evento:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORIDADE: resolva essa validação antes de falar de treino, dieta ou nova missão.\n` +
          `Pergunte rapidinho e naturalmente o que aconteceu — só este evento, um por vez.\n` +
          `Se o usuário confirmar que ACONTECEU, você DEVE retornar: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "happened" }\n` +
          `Se o usuário disser que ADIOU, você DEVE retornar: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "postponed" }\n` +
          `Se o usuário disser que CANCELOU ou não vai mais acontecer, você DEVE retornar: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "discarded" }\n` +
          `Se a resposta for ambígua, NÃO retorne proactiveMemoryAction — peça clareza.`
        )
      }
    }

    // ── Active memories (enriched context for natural use) ────────────────────
    if (activeMemories.length > 0) {
      const formattedMemories = activeMemories
        .map((m) => formatMemoryForPrompt(m, language))
        .join('\n')

      if (language === 'it-IT') {
        sections.push(
          `[PROATTIVITÀ — CONTESTO DELLA SETTIMANA]\n` +
          `Sai già queste cose sulla sua settimana. Usale naturalmente quando ha senso — non forzarle, non elencarle tutte in una volta:\n` +
          formattedMemories
        )
      } else if (language === 'en-US') {
        sections.push(
          `[PROACTIVITY — WEEK CONTEXT]\n` +
          `You already know these things about this week. Use them naturally when it makes sense — don't force them, don't list them all at once:\n` +
          formattedMemories
        )
      } else {
        sections.push(
          `[PROATIVIDADE — CONTEXTO DA SEMANA]\n` +
          `Você já sabe essas coisas sobre a semana dele. Use naturalmente quando couber — não force, não liste tudo de vez:\n` +
          formattedMemories
        )
      }
    }

    // ── Pending confirmation (one at a time) ──────────────────────────────────
    if (pendingConfirmation.length > 0) {
      const first = pendingConfirmation[0]!
      const item = `"${first.understood}"${first.dateText ? ` — ${first.dateText}` : ''}`

      if (language === 'it-IT') {
        sections.push(
          `[PROATTIVITÀ — CONFERMA IN ATTESA]\n` +
          `Hai captato qualcosa dalla conversazione ma non hai ancora confermato:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORITÀ: risolvi questa conferma prima di parlare di allenamento, dieta o nuova missione.\n` +
          `Quando arriva il momento giusto, chiedi naturalmente se ha capito bene — solo questo, non altri. Una cosa alla volta.\n` +
          `Se l'utente CONFERMA (risponde "sì", "esatto", "confermo" o equivalente chiaro), DEVI ritornare: proactiveMemoryAction: { type: "confirm", memoryId: "${first.id}" }\n` +
          `Se l'utente NEGA e cancella l'evento o dice che non succederà più, DEVI ritornare: proactiveMemoryAction: { type: "discard", memoryId: "${first.id}" }\n` +
          `Se l'utente corregge dettagli (es: "no, è venerdì"), NON ritornare proactiveMemoryAction — chiedi conferma del dettaglio corretto; la correzione strutturata non è supportata ancora.\n` +
          `Se la risposta è AMBIGUA o off-topic, NON ritornare proactiveMemoryAction — richiedi chiarezza.`
        )
      } else if (language === 'en-US') {
        sections.push(
          `[PROACTIVITY — PENDING CONFIRMATION]\n` +
          `You picked up something from the conversation but haven't confirmed it yet:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORITY: resolve this confirmation before talking about workout, diet, or a new mission.\n` +
          `When the moment is right, naturally check if you understood correctly — just this one, not others. One thing at a time.\n` +
          `If the user CONFIRMS (says "yes", "that's right", "confirmed" or clear equivalent), you MUST return: proactiveMemoryAction: { type: "confirm", memoryId: "${first.id}" }\n` +
          `If the user DENIES and cancels the event or says it will not happen anymore, you MUST return: proactiveMemoryAction: { type: "discard", memoryId: "${first.id}" }\n` +
          `If the user corrects details (ex: "no, Friday"), do NOT return proactiveMemoryAction — ask for confirmation of the corrected detail; structured correction is not supported yet.\n` +
          `If the response is AMBIGUOUS or off-topic, do NOT return proactiveMemoryAction — ask for clarity.`
        )
      } else {
        sections.push(
          `[PROATIVIDADE — CONFIRMAÇÃO PENDENTE]\n` +
          `Você captou algo da conversa mas ainda não confirmou:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORIDADE: resolva essa confirmação antes de falar de treino, dieta ou nova missão.\n` +
          `Quando o momento for certo, confira naturalmente se entendeu direito — só esse, não outros. Um de cada vez.\n` +
          `Se o usuário CONFIRMAR (responder "sim", "isso mesmo", "confirmo" ou equivalente claro), você DEVE retornar: proactiveMemoryAction: { type: "confirm", memoryId: "${first.id}" }\n` +
          `Se o usuário NEGAR e cancelar o evento ou disser que não vai mais acontecer, você DEVE retornar: proactiveMemoryAction: { type: "discard", memoryId: "${first.id}" }\n` +
          `Se o usuário corrigir detalhes (ex: "não, é sexta"), NÃO retorne proactiveMemoryAction — peça confirmação do detalhe corrigido; correção estruturada ainda não é suportada.\n` +
          `Se a resposta for AMBÍGUA ou off-topic, NÃO retorne proactiveMemoryAction — peça clareza.`
        )
      }
    }

    if (sections.length === 0) return null

    return sections.join('\n\n')
  } catch {
    // Proactivity context is optional — never fails the main chat
    return null
  }
}

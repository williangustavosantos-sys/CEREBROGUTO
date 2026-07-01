// ─── GUTO Proactivity — Context Injector ─────────────────────────────────────
// Builds the proactivity context block injected into buildGutoBrainPrompt.
// The LLM receives real data and decides naturally how to use it.
// GUTO is never forced to say something — the data is context, not a script.

import {
  getProactiveMemoriesByStatus,
  markPastActiveMemoriesPendingValidation,
} from './proactive-store.js'

import { getWeeklyCheckResult } from './weekly-conversation.js'
import type { ProactiveMemory } from './types.js'

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
    if (language === 'it-IT') {
      lines.push(`  Meteo ${w.city}: ${w.condition}, ${w.tempMin}–${w.tempMax}°C em ${w.date}`)
    } else if (language === 'en-US') {
      lines.push(`  Weather in ${w.city}: ${w.condition}, ${w.tempMin}–${w.tempMax}°C on ${w.date}`)
    } else {
      lines.push(`  Clima em ${w.city}: ${w.condition}, ${w.tempMin}–${w.tempMax}°C em ${w.date}`)
    }
  }

  if (m.weatherEnrichment && ['rain', 'drizzle', 'thunderstorm', 'snow', 'storm'].some((term) =>
    (m.weatherEnrichment?.conditionEn || '').toLowerCase().includes(term)
  )) {
    if (language === 'it-IT') {
      lines.push(`  Impatto sul treino: se dipende da strada/parco, preferisci casa o palestra.`)
    } else if (language === 'en-US') {
      lines.push(`  Training impact: if it depends on outdoors/park, prefer home or gym.`)
    } else {
      lines.push(`  Impacto no treino: se depender de rua/parque, prefira casa ou academia.`)
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

// ─── Identity rule appended to every action block ─────────────────────────────
// GUTO never tells the user that data was saved, confirmed, or recorded.
// That is a chatbot behaviour. GUTO just talks, like a friend.

function identityRule(language: string): string {
  if (language === 'it-IT') {
    return `REGOLA IDENTITÀ: quando esegui l'azione nella tua risposta, NON dire all'utente che hai salvato, registrato o confermato qualcosa. Parla come un amico — non come un sistema.`
  }
  if (language === 'en-US') {
    return `IDENTITY RULE: when you execute the action in your response, do NOT tell the user you saved, recorded or confirmed anything. Talk like a friend — not like a system.`
  }
  return `REGRA DE IDENTIDADE: quando executar a ação na sua resposta, NÃO diga ao usuário que salvou, registrou ou confirmou algo. Fale como amigo — não como sistema.`
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

    // All active memories: confirmed, enriched, surfaced
    const allActiveMemories = await getProactiveMemoriesByStatus(userId, [
      'confirmed',
      'enriched',
      'surfaced',
    ])

    // Separate: memories awaiting discard confirmation vs normal active context
    const awaitingDiscard = allActiveMemories.filter((m) => m.discardRequestedAt)
    const activeMemories = allActiveMemories.filter((m) => !m.discardRequestedAt)

    const pendingConfirmation = await getProactiveMemoriesByStatus(userId, ['pending_confirmation'])
    const pendingValidation = await getProactiveMemoriesByStatus(userId, ['pending_validation'])

    // Nothing to inject
    if (
      !weeklyCheck.shouldOpenWeekly &&
      !weeklyCheck.shouldValidate &&
      allActiveMemories.length === 0 &&
      pendingConfirmation.length === 0 &&
      pendingValidation.length === 0
    ) {
      return null
    }

    const sections: string[] = []

    // ── Awaiting discard confirmation — absolute priority ──────────────────────
    // User already said "cancelei X" and GUTO asked "Descarto X então?".
    // This block must be resolved before anything else happens.
    if (awaitingDiscard.length > 0) {
      const first = awaitingDiscard[0]!
      const item = `"${first.understood}"${first.dateText ? ` — ${first.dateText}` : ''}`

      if (language === 'it-IT') {
        sections.push(
          `[PROATTIVITÀ — CONFERMA CANCELLAZIONE]\n` +
          `L'utente ha detto di voler cancellare questo evento:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORITÀ ASSOLUTA: prima di qualsiasi altra cosa, chiedi in modo naturale e diretto se vuole davvero toglierlo.\n` +
          `Se l'utente conferma (dice "sì", "cancella", "vai" o equivalente chiaro): proactiveMemoryAction: { type: "discard", memoryId: "${first.id}" }\n` +
          `Se l'utente nega o vuole tenerlo (dice "no", "mantieni", "lascia" o equivalente): proactiveMemoryAction: { type: "cancel_discard_request", memoryId: "${first.id}" }\n` +
          `Se la risposta è AMBIGUA: NON ritornare proactiveMemoryAction — chiedi di nuovo in modo diretto.\n` +
          identityRule(language)
        )
      } else if (language === 'en-US') {
        sections.push(
          `[PROACTIVITY — DISCARD CONFIRMATION]\n` +
          `The user said they want to cancel this event:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `TOP PRIORITY: before doing anything else, directly ask if they really want to drop it.\n` +
          `If user confirms (says "yes", "cancel it", "sure" or clear equivalent): proactiveMemoryAction: { type: "discard", memoryId: "${first.id}" }\n` +
          `If user denies or wants to keep it (says "no", "keep it", "never mind" or equivalent): proactiveMemoryAction: { type: "cancel_discard_request", memoryId: "${first.id}" }\n` +
          `If AMBIGUOUS: do NOT return proactiveMemoryAction — ask again directly.\n` +
          identityRule(language)
        )
      } else {
        sections.push(
          `[PROATIVIDADE — CONFIRMAÇÃO DE DESCARTE]\n` +
          `O usuário disse querer cancelar este evento:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORIDADE ABSOLUTA: antes de qualquer outra coisa, pergunta direto se ele quer mesmo tirar isso.\n` +
          `Se o usuário confirmar (disser "sim", "descarta", "vai" ou equivalente claro): proactiveMemoryAction: { type: "discard", memoryId: "${first.id}" }\n` +
          `Se o usuário negar ou quiser manter (disser "não", "mantém", "deixa" ou equivalente): proactiveMemoryAction: { type: "cancel_discard_request", memoryId: "${first.id}" }\n` +
          `Se AMBÍGUO: NÃO retorne proactiveMemoryAction — pergunta de novo direto.\n` +
          identityRule(language)
        )
      }
    }

    // ── Weekly conversation signal ─────────────────────────────────────────────
    // Weekly opening is presence context, not an interruption. Pending
    // confirmation/validation above can block the turn; a weekly check should
    // ride along only after the current user intent is handled.
    if (weeklyCheck.shouldOpenWeekly) {
      if (language === 'it-IT') {
        sections.push(
          `[PROATTIVITÀ — APERTURA SETTIMANALE]\n` +
          `Questa settimana non è ancora stata aperta con l'utente.\n` +
          `Se l'utente ha chiesto un'azione esplicita (allenamento, dieta, dolore, tecnica o conferma), rispondi PRIMA a quell'intenzione. Poi, solo se resta naturale, aggiungi un check corto sulla settimana.\n` +
          `Chiedi com'è la settimana come un amico che vuole sapere se ci sono viaggi, impegni o cambiamenti di orario che possono influenzare l'allenamento.\n` +
          `Salverai solo ciò che cambia l'esecuzione del treino. Sii naturale, niente frase da sistema.`
        )
      } else if (language === 'en-US') {
        sections.push(
          `[PROACTIVITY — WEEKLY OPENING]\n` +
          `This week has not been opened with the user yet.\n` +
          `If the user asked for an explicit action (workout, diet, pain, technique, or confirmation), answer that intent FIRST. Then, only if natural, add one short weekly check.\n` +
          `Ask how the week looks like a friend checking if there are trips, commitments, or schedule changes that might affect training.\n` +
          `Only remember what changes workout execution. Be natural, never system-like.`
        )
      } else {
        sections.push(
          `[PROATIVIDADE — ABERTURA SEMANAL]\n` +
          `Esta semana ainda não foi aberta com o usuário.\n` +
          `Se o usuário pediu uma ação explícita (treino, dieta, dor, técnica ou confirmação), responda ESSA intenção primeiro. Depois, só se couber natural, acrescente um check curto da semana.\n` +
          `Pergunta como vai ser a semana como amigo que quer saber se tem viagem, compromisso ou mudança de horário que pode afetar o treino.\n` +
          `Só memorize o que muda a execução do treino. Seja natural, nada de frase de sistema.`
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
          `Se SUCCESSO: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "happened" }\n` +
          `Se RIMANDATO: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "postponed" }\n` +
          `Se CANCELLATO: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "discarded" }\n` +
          `Se AMBIGUO: NON ritornare proactiveMemoryAction — chiedi chiarezza.\n` +
          identityRule(language)
        )
      } else if (language === 'en-US') {
        sections.push(
          `[PROACTIVITY — LAST WEEK VALIDATION]\n` +
          `Last week you had this registered:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORITY: resolve this before talking about workout, diet, or a new mission.\n` +
          `Briefly and naturally ask what happened — only this one, one at a time.\n` +
          `If HAPPENED: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "happened" }\n` +
          `If POSTPONED: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "postponed" }\n` +
          `If CANCELLED: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "discarded" }\n` +
          `If AMBIGUOUS: do NOT return proactiveMemoryAction — ask for clarity.\n` +
          identityRule(language)
        )
      } else {
        sections.push(
          `[PROATIVIDADE — VALIDAÇÃO DA SEMANA PASSADA]\n` +
          `Na semana passada você tinha registrado:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORIDADE: resolva isso antes de falar de treino, dieta ou nova missão.\n` +
          `Pergunta rapidinho e naturalmente o que aconteceu — só este, um por vez.\n` +
          `Se ACONTECEU: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "happened" }\n` +
          `Se ADIOU: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "postponed" }\n` +
          `Se CANCELOU: proactiveMemoryAction: { type: "validate", memoryId: "${first.id}", outcome: "discarded" }\n` +
          `Se AMBÍGUO: NÃO retorne proactiveMemoryAction — peça clareza.\n` +
          identityRule(language)
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
          `Sai già queste cose sulla sua settimana. Usale solo quando aiutano allenamento, preparazione o continuità — non forzarle, non elencarle tutte:\n` +
          formattedMemories
        )
      } else if (language === 'en-US') {
        sections.push(
          `[PROACTIVITY — WEEK CONTEXT]\n` +
          `You already know these things about this week. Use them only when they help training, preparation or continuity — don't force them, don't list them all at once:\n` +
          formattedMemories
        )
      } else {
        sections.push(
          `[PROATIVIDADE — CONTEXTO DA SEMANA]\n` +
          `Você já sabe essas coisas sobre a semana dele. Use só quando ajudar treino, preparação ou continuidade — não force, não liste tudo de vez:\n` +
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
          `Quando arriva il momento giusto, chiedi con parole TUE, come un amico (es: "parti mercoledì, vero?"). NON copiare il testo interno sopra né usare virgolette — solo questo.\n` +
          `Se CONFERMA (risponde "sì", "esatto" o equivalente chiaro): proactiveMemoryAction: { type: "confirm", memoryId: "${first.id}" }\n` +
          `Se NEGA e cancella l'evento: proactiveMemoryAction: { type: "discard", memoryId: "${first.id}" }\n` +
          `Se corregge dettagli (es: "no, è venerdì"): proactiveMemoryAction: { type: "update", memoryId: "${first.id}", patch: { "dateText": "...", "dateParsed": "YYYY-MM-DD", "location": "...", "understood": "..." } }. Aggiorna solo i campi chiari e chiedi conferma del dettaglio corretto.\n` +
          `Se AMBIGUO: NON ritornare proactiveMemoryAction — richiedi chiarezza.\n` +
          identityRule(language)
        )
      } else if (language === 'en-US') {
        sections.push(
          `[PROACTIVITY — PENDING CONFIRMATION]\n` +
          `You picked up something from the conversation but haven't confirmed it yet:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORITY: resolve this before talking about workout, diet, or a new mission.\n` +
          `When the moment is right, ask IN YOUR OWN WORDS, like a friend (e.g. "you're traveling Wednesday, right?"). NEVER copy the internal text above or use quotes — just this one.\n` +
          `If CONFIRMS ("yes", "that's right" or clear equivalent): proactiveMemoryAction: { type: "confirm", memoryId: "${first.id}" }\n` +
          `If DENIES and cancels the event: proactiveMemoryAction: { type: "discard", memoryId: "${first.id}" }\n` +
          `If corrects details ("no, Friday"): proactiveMemoryAction: { type: "update", memoryId: "${first.id}", patch: { "dateText": "...", "dateParsed": "YYYY-MM-DD", "location": "...", "understood": "..." } }. Update only clear fields and ask confirmation of the corrected detail.\n` +
          `If AMBIGUOUS: do NOT return proactiveMemoryAction — ask for clarity.\n` +
          identityRule(language)
        )
      } else {
        sections.push(
          `[PROATIVIDADE — CONFIRMAÇÃO PENDENTE]\n` +
          `Você captou algo da conversa mas ainda não confirmou:\n  ${item}\n` +
          `ID: ${first.id}\n` +
          `PRIORIDADE: resolva essa confirmação antes de falar de treino, dieta ou nova missão.\n` +
          `Quando o momento for certo, pergunte com SUAS palavras, como amigo (ex: "você viaja quarta, né? confirma só pra eu ajustar a semana"). NUNCA copie o texto interno acima nem use aspas — só esse, um por vez.\n` +
          `Se CONFIRMAR ("sim", "isso mesmo" ou equivalente claro): proactiveMemoryAction: { type: "confirm", memoryId: "${first.id}" }\n` +
          `Se NEGAR e cancelar o evento: proactiveMemoryAction: { type: "discard", memoryId: "${first.id}" }\n` +
          `Se corrigir detalhes ("não, é sexta"): proactiveMemoryAction: { type: "update", memoryId: "${first.id}", patch: { "dateText": "...", "dateParsed": "YYYY-MM-DD", "location": "...", "understood": "..." } }. Atualize só campos claros e peça confirmação do detalhe corrigido.\n` +
          `Se AMBÍGUO: NÃO retorne proactiveMemoryAction — peça clareza.\n` +
          identityRule(language)
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

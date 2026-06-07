export type OperationalIntent =
  | "workout"
  | "location"
  | "diet"
  | "pain"
  | "technique"
  | null;

function normalizeContractText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isWorkoutExecutionRequest(value: string): boolean {
  const normalized = normalizeContractText(value);
  return /\b(treino|treinar|monta|montar|workout|training|allenamento|allenarmi|scheda)\b/.test(normalized);
}

export function extractTrainingLocation(value: string): string | undefined {
  const normalized = normalizeContractText(value);
  if (/\b(academia|academias|gym|palestra|pales)\b/.test(normalized)) return "gym";
  if (/\b(casa|home)\b/.test(normalized)) return "home";
  if (/\b(parque|park|parco)\b/.test(normalized)) return "park";
  if (/\b(piscina|pool)\b/.test(normalized)) return "piscina";
  return undefined;
}

export function detectImmediateOperationalIntent(value: string): OperationalIntent {
  const normalized = normalizeContractText(value);
  if (isWorkoutExecutionRequest(value)) return "workout";
  if (extractTrainingLocation(value)) return "location";
  if (/\b(dieta|refeicao|refeição|comida|alimento|meal|diet|food|pasto|cibo)\b/.test(normalized)) {
    return "diet";
  }
  if (/\b(dor|joelho|ombro|febre|tonto|pain|knee|shoulder|fever|dolore|ginocchio|spalla)\b/.test(normalized)) {
    return "pain";
  }
  if (/\b(como faco|como faço|tecnica|técnica|execucao|execução|how do i|technique|form|come faccio)\b/.test(normalized)) {
    return "technique";
  }
  return null;
}

export function isImmediateOperationalTurn(value: string): boolean {
  return detectImmediateOperationalIntent(value) !== null;
}

// Detecta que o usuário está RESPONDENDO à abertura semanal ("tem viagem,
// horário apertado, dor ou compromisso?"): compromissos/eventos, viagem,
// horário/agenda, dia da semana/período, ou negativa/"tudo certo".
const WEEKLY_ANSWER_PATTERNS =
  /\b(reuniao|compromisso|evento|prova|exame|esame|medico|consulta|dentista|viagem|viajar|viaggio|trip|travel|trabalho|work|festa|aniversario|casamento|formatura|riunione|appuntamento|impegno|horario|apertad|corrid|ocupad|busy|tight|livre|folga|agenda|segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje|semana|weekend|manha|tarde|noite|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|nada|nenhum|tranquil|normal|niente|libero|occupato|nothing)\b/;

export function looksLikeWeeklyAnswer(value: string): boolean {
  const normalized = normalizeContractText(value);
  if (!normalized) return false;
  if (WEEKLY_ANSWER_PATTERNS.test(normalized)) return true;
  // "tudo certo/bem/ok", "all good", "tutto bene/ok"
  if (/\b(tudo|all|tutto)\b/.test(normalized) && /\b(certo|bem|ok|good|bene|tranquil)\b/.test(normalized)) return true;
  return false;
}

export function shouldDeferWeeklyOpeningForTurn(proactivityContext: string | null | undefined, input: string): boolean {
  if (!proactivityContext) return false;
  const hasWeeklyOpening =
    proactivityContext.includes("ABERTURA SEMANAL") ||
    proactivityContext.includes("WEEKLY OPENING") ||
    proactivityContext.includes("APERTURA SETTIMANALE");
  if (!hasWeeklyOpening) return false;
  const hasBlockingProactivity =
    proactivityContext.includes("CONFIRMAÇÃO DE DESCARTE") ||
    proactivityContext.includes("DISCARD CONFIRMATION") ||
    proactivityContext.includes("CONFERMA CANCELLAZIONE") ||
    proactivityContext.includes("VALIDAÇÃO SEMANA PASSADA") ||
    proactivityContext.includes("LAST WEEK VALIDATION") ||
    proactivityContext.includes("VALIDAZIONE SETTIMANA SCORSA") ||
    proactivityContext.includes("CONFIRMAÇÃO PENDENTE") ||
    proactivityContext.includes("PENDING CONFIRMATION") ||
    proactivityContext.includes("CONFERMA PENDENTE");
  if (hasBlockingProactivity) return false;
  // Deferir (NÃO re-perguntar a abertura semanal) quando o usuário está
  // RESPONDENDO a ela — compromisso/viagem/horário/dia/"nada/tudo certo" — ou
  // num turno operacional. Re-perguntar nesses casos repetia o texto da abertura
  // → o front deduplicava (removeConsecutiveDuplicateGutoMessages) → GUTO ficava
  // MUDO (bug P0: "reunião na quarta" → silêncio). Saudação pura NÃO defere: aí
  // a abertura semanal ainda deve ser feita.
  // Antes só deferíamos em intents operacionais (treino/local/dieta/dor/técnica),
  // então respostas de compromisso/viagem/disponibilidade caíam de fora.
  return isImmediateOperationalTurn(input) || looksLikeWeeklyAnswer(input);
}

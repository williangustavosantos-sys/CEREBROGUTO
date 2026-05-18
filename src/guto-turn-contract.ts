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

export function shouldDeferWeeklyOpeningForTurn(proactivityContext: string | null | undefined, input: string): boolean {
  if (!proactivityContext || !isImmediateOperationalTurn(input)) return false;
  const hasWeeklyOpening =
    proactivityContext.includes("ABERTURA SEMANAL") ||
    proactivityContext.includes("WEEKLY OPENING") ||
    proactivityContext.includes("APERTURA SETTIMANALE");
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
  return hasWeeklyOpening && !hasBlockingProactivity;
}

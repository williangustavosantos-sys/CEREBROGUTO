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
  if (!/\b(treino|treinar|monta|montar|workout|training|allenamento|allenarmi|scheda)\b/.test(normalized)) {
    return false;
  }
  // Recusa ou feedback NEGATIVO sobre treino NÃO é pedido de execução. Sem este
  // guard, quando o Gemini cai e a calibragem está completa, "não quero treinar"
  // e "não gostei do treino" caíam no fallback técnico que PROMOVIA treino
  // ("Bora começar" + updateWorkout) — ignorando a recusa/feedback do usuário.
  const refusalOrDislike =
    /\b(nao quero|nao vou|nao estou a fim|nao to a fim|nao gostei|nao curti|nem a fim|sem vontade|sem saco|odiei|detestei|preguica)\b/.test(normalized) ||
    /\b(dont want|do not want|wont|not feeling|didnt like|did not like|hate|boring|lame)\b/.test(normalized) ||
    /\b(non voglio|non vado|non mi va|non mi piace|odio|noioso|zero sbatti|non ho voglia)\b/.test(normalized) ||
    /\b(chato|chata|entediante|pessimo|horrivel)\b/.test(normalized);
  return !refusalOrDislike;
}

export type TrainingPrepKind = "meal" | "hydration" | "generic";

// Preparação CURTA antes do treino: tomar café/comer, beber água, pré-treino,
// trocar de roupa, banheiro, deslocar-se até a academia, "espera 10 minutos".
// Isso NÃO é recusa, desistência nem adiamento — a pessoa VAI treinar, só está
// se preparando. O treino planejado continua de pé.
//
// O guard de recusa/adiamento tem precedência: quem nega ("não vou treinar",
// "não quero", "vou deixar pra amanhã") NÃO está se preparando — continua sendo
// recusa real e deve seguir para a escada de persistência, não para cá.
export function detectTrainingPrep(value: string): { kind: TrainingPrepKind } | null {
  const text = normalizeContractText(value);
  if (!text) return null;

  const refusalOrPostpone =
    /\b(nao vou|nao quero|nao to a fim|nao estou a fim|nem a fim|sem vontade|sem saco|desisto|desistir|fica pra|deixa pra|deixar pra|deixo pra|amanha|outro dia|nao treino|nao da hoje|nao rola hoje)\b/.test(text) ||
    /\b(dont want|do not want|wont|not today|tomorrow|skip it|give up|quit)\b/.test(text) ||
    /\b(non voglio|non vado|domani|un altro giorno|lascio|rimando)\b/.test(text);
  if (refusalOrPostpone) return null;

  // Hidratação antes do treino (água/beber) — desde que não seja sobre comida.
  if (
    /\b(agua|hidrat|beber|bebo|water|hydrate|drink|idrat|bere|acqua)\b/.test(text) &&
    !/\b(cafe|comer|comendo|comida|refeicao|lanche)\b/.test(text)
  ) {
    return { kind: "hydration" };
  }

  // Alimentação curta antes do treino (café da manhã, comer, terminar de comer).
  if (
    /\b(cafe|comer|comendo|comida|refeicao|lanche|breakfast|eat|eating|finish eating|colazione|mangiare|mangio|finire di mangiare)\b/.test(text)
  ) {
    return { kind: "meal" };
  }

  // Preparação genérica: pré-treino, trocar de roupa, banheiro, deslocamento até
  // a academia, "espera N minutos", "já tô indo".
  // "espera N minutos" é preparação (pedir pra GUTO aguardar). "só tenho/tenho N
  // minutos" é DISPONIBILIDADE limitada = proactive_context (continuidade), não
  // preparação — por isso o gatilho de espera exige o verbo de aguardar, nunca o
  // "N minutos" solto.
  const genericPrep =
    /\b(pre treino|pretreino|trocar de roupa|trocar a roupa|me trocar|roupa|banheiro|wc|toalete|chegar na academia|chegando na academia|indo pra academia|indo para academia|estou indo|to indo|ja vou|ja to indo|me arrumar|me apront|me ajeit|espera|espere|aguarda|me da (uns )?\d+ ?min)\b/.test(text) ||
    /\b(pre workout|preworkout|change clothes|getting dressed|getting ready|bathroom|restroom|on my way|heading to the gym|wait a (sec|minute|moment)|give me \d+ ?min)\b/.test(text) ||
    /\b(pre allenamento|preallenamento|cambiarmi|bagno|sto arrivando|sto andando|aspetta|dammi \d+ ?min|mi preparo)\b/.test(text);
  if (genericPrep) return { kind: "generic" };

  return null;
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

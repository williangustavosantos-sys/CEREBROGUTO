export const MODEL_MEMORY_ALLOWED_FIELDS = new Set([
  "name",
  "language",
  "foodRestrictions",
  "trainingLocation",
  "preferredTrainingLocation",
  "city",
  "country",
]);

export interface ModelMemoryAuthorization {
  allowed: Record<string, unknown>;
  blocked: string[];
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function declaresName(input: string): boolean {
  const text = normalizeText(input);
  return /\b(me chamo|meu nome e|pode me chamar de|chame(?:-me)? de|my name is|call me|mi chiamo|chiamami)\b/.test(text);
}

function declaresLanguage(input: string): boolean {
  const text = normalizeText(input);
  return /\b(fale|fala|responda|mude|troque|speak|reply|switch|parla|rispondi|cambia)\b/.test(text) &&
    /\b(portugues|ingles|italiano|italian|english|portuguese|pt-br|en-us|it-it)\b/.test(text);
}

function declaresFoodPreference(input: string): boolean {
  const text = normalizeText(input);
  return /\b(nao como|nao consumo|nao posso comer|alerg|intoler|vegano|vegana|vegetariano|vegetariana|sem lactose|sem gluten|i do not eat|i dont eat|allerg|intoler|vegan|vegetarian|non mangio|non consumo|non posso mangiare|senza lattosio|senza glutine)\b/.test(text);
}

function declaresTrainingLocation(input: string): boolean {
  const text = normalizeText(input);
  return /\b(treino|treinar|academia|ginasio|casa|parque|condominio|gym|train|training|home|park|palestra|alleno|allenarmi)\b/.test(text) &&
    /\b(em|na|no|num|mudei|agora|at|in|to|a|al|alla|cambiato)\b/.test(text);
}

function declaresGeographicLocation(input: string): boolean {
  const text = normalizeText(input);
  return /\b(moro em|vivo em|estou em|sou de|minha cidade|meu pais|i live in|i am in|im in|my city|my country|vivo a|abito a|sono a|sono di|mia citta|mio paese)\b/.test(text);
}

function isExplicitlyDeclared(field: string, input: string): boolean {
  if (field === "name") return declaresName(input);
  if (field === "language") return declaresLanguage(input);
  if (field === "foodRestrictions") return declaresFoodPreference(input);
  if (field === "trainingLocation" || field === "preferredTrainingLocation") {
    return declaresTrainingLocation(input);
  }
  if (field === "city" || field === "country") return declaresGeographicLocation(input);
  return false;
}

/**
 * Policy gate for model-proposed memory. The LLM never writes durable state:
 * it proposes a small declarative patch, this gate proves that the current
 * message explicitly declared each field, and only then may the executor save.
 */
export function authorizeModelMemoryPatch(
  proposal: unknown,
  currentMessage: string,
): ModelMemoryAuthorization {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    return { allowed: {}, blocked: [] };
  }

  const allowed: Record<string, unknown> = {};
  const blocked: string[] = [];
  for (const [field, value] of Object.entries(proposal as Record<string, unknown>)) {
    if (
      MODEL_MEMORY_ALLOWED_FIELDS.has(field) &&
      isExplicitlyDeclared(field, currentMessage)
    ) {
      allowed[field] = value;
    } else {
      blocked.push(field);
    }
  }
  return { allowed, blocked: [...new Set(blocked)].sort() };
}

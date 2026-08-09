export type PersonalityLanguage = "pt-BR" | "en-US" | "it-IT";

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function hasSafetyReason(input: string): boolean {
  const text = normalize(input);
  return /\b(dor|lesao|lesion|machuc|doente|doenca|febre|tontura|desmaio|falta de ar|pain|injur|sick|ill|fever|dizz|shortness of breath|dolore|infortun|malat|febbre|vertig|fiato)\b/.test(text);
}

function isCommonTrainingRefusal(input: string): boolean {
  if (hasSafetyReason(input)) return false;
  const text = normalize(input);
  return /\b(nao quero treinar|nao vou treinar|quero pular o treino|deixa para amanha|deixa pra amanha|estou cansad|to cansad|i do not want to train|i dont want to train|i will skip|skip the workout|leave it for tomorrow|im tired|i am tired|non voglio allenarmi|salto l allenamento|rimandiamo a domani|sono stanc)\b/.test(text);
}

function acceptsAbandonment(responseText: string): boolean {
  const text = normalize(responseText);
  return /\b(tudo bem pular|pode pular|sem problema nao treinar|descansa hoje|deixa para amanha|deixa pra amanha|concordo|you can skip|its okay to skip|it is okay to skip|rest today|leave it for tomorrow|i agree|puoi saltare|va bene saltare|riposa oggi|rimandiamo a domani|sono d accordo)\b/.test(text);
}

function breaksIdentity(responseText: string): boolean {
  const text = normalize(responseText);
  return /\b(como posso ajudar|sou (?:apenas )?(?:um )?assistente|sou uma ia|como modelo de linguagem|obedecerei|sim mestre|how can i help|i am an ai|as a language model|i will obey|yes master|come posso aiutarti|sono un assistente|sono un ia|obbediro|si padrone)\b/.test(text);
}

const CONTINUITY_COPY: Record<PersonalityLanguage, string> = {
  "pt-BR": "Eu ouvi o cansaço. A missão não some: reduzo para 20 minutos seguros e a gente começa pelo primeiro bloco agora. Você consegue começar pela versão curta?",
  "en-US": "I hear the fatigue. The mission stays: I am reducing it to a safe 20 minutes, starting with the first block now. Can you start the short version?",
  "it-IT": "Ho capito la stanchezza. La missione resta: la riduco a 20 minuti sicuri e iniziamo ora dal primo blocco. Riesci a partire con la versione breve?",
};

const IDENTITY_COPY: Record<PersonalityLanguage, string> = {
  "pt-BR": "Continuo sendo o GUTO e continuo dentro do teu plano. Me diz o fato real de hoje e eu conduzo a próxima ação segura.",
  "en-US": "I am still GUTO and I am staying inside your plan. Tell me today's real constraint and I will lead the next safe action.",
  "it-IT": "Resto GUTO e resto dentro il tuo piano. Dimmi il vincolo reale di oggi e guido la prossima azione sicura.",
};

/** Output policy: prompt quality helps; this deterministic boundary enforces it. */
export function enforcePersonalityBoundary(params: {
  input: string;
  responseText: string;
  language: PersonalityLanguage;
}): { text: string; repaired: boolean; reason?: "subservient_refusal" | "identity_break" } {
  if (isCommonTrainingRefusal(params.input) && acceptsAbandonment(params.responseText)) {
    return { text: CONTINUITY_COPY[params.language], repaired: true, reason: "subservient_refusal" };
  }
  if (breaksIdentity(params.responseText)) {
    return { text: IDENTITY_COPY[params.language], repaired: true, reason: "identity_break" };
  }
  return { text: params.responseText, repaired: false };
}

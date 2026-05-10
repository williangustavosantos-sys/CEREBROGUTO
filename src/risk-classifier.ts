/**
 * GUTO Risk Pre-Classifier
 *
 * Princípio: GUTO tem persona forte de cobrança/swap, mas certos sinais do
 * usuário não combinam com cobrança — precisam de acolhimento + encaminhamento
 * para recurso real (CVV, emergência, profissional de TA, médico).
 *
 * Este módulo:
 *   1. Roda UMA chamada ao Gemini Flash Lite por turno do chat.
 *   2. Classifica o input em uma de 4 flags de risco (ou null).
 *   3. NÃO persiste em memória — risco é por turno.
 *   4. Falha aberta: qualquer erro → flag null (comportamento normal).
 *
 * O wiring deste classifier está em server.ts:askGutoModel. Quando flag != null
 * e confidence >= 0.6, o brain prompt recebe um bloco SAFETY_OVERRIDE no topo
 * que suspende a persona normal por um turno.
 */

import { config } from "./config.js";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type RiskFlag =
  | "eating_disorder"     // jejum extremo, vomitar, laxante para emagrecer, perder Xkg em Y dias
  | "suicide_self_harm"   // ideação, fazer besteira, não aguento mais, autolesão
  | "cardio_neuro_acute"  // dor no peito, falta de ar súbita, dormência, vista escurecendo
  | "trauma_acute"        // estalo + inchaço, perda de sensibilidade, queda recente sem apoio
  | null;

export type ClassifierLanguage = "pt-BR" | "en-US" | "it-IT" | "es-ES";

export interface RiskClassification {
  flag: RiskFlag;
  /** 0..1; usar threshold de 0.6 para ativar o modo segurança */
  confidence: number;
  /** Razão curta para debug e log de auditoria */
  reasoning: string;
  classifiedAt: string;
}

const DEFAULT_TIMEOUT_MS = 1800;
const DEFAULT_MODEL = "gemini-2.5-flash-lite";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeFlag(value: unknown): RiskFlag {
  if (
    value === "eating_disorder" ||
    value === "suicide_self_harm" ||
    value === "cardio_neuro_acute" ||
    value === "trauma_acute"
  ) {
    return value;
  }
  return null;
}

function safeFallback(reasoning: string): RiskClassification {
  return {
    flag: null,
    confidence: 0,
    reasoning,
    classifiedAt: new Date().toISOString(),
  };
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildRiskPrompt(input: string): string {
  return `You are a strict semantic safety classifier for a fitness app called GUTO.
Your only job: read ONE user message and decide if it signals a real-world risk that requires escalation, NOT casual training/diet conversation.

Possible flags (mutually exclusive — pick the SINGLE most relevant; if multiple apply, pick by hierarchy: suicide_self_harm > cardio_neuro_acute > trauma_acute > eating_disorder):

1. eating_disorder
   Real signals: explicit purging, laxatives for weight loss, fasting >24h declared, unrealistic weight goals (e.g. >5kg in <2 weeks), severe restriction patterns ("só whey e água"), skipping meals as a strategy when underweight or already at goal.
   NOT this flag: normal "vou pular o lanche, comi pesado no almoço", intermittent fasting (16:8) declared by user, single-meal swap requests.

2. suicide_self_harm
   Real signals: ideation ("fazer besteira", "sumir do mundo", "não aguento mais"), explicit self-harm mention, desperation framing ("tô no fundo do poço"), expressed hopelessness combined with impulse mention.
   NOT this flag: regular venting ("foi um dia ruim"), normal sadness ("tô triste", "to mal hoje" without escalation).

3. cardio_neuro_acute
   Real signals: chest pain on exertion, sudden shortness of breath at rest, arm/face numbness, sudden vision changes during exercise, palpitations + lightheadedness, "coração disparou e não para".
   NOT this flag: normal post-workout fatigue, "coração acelera quando corro" (expected), DOMS, soreness.

4. trauma_acute
   Real signals: described pop/snap + immediate swelling, sudden loss of sensation in a limb, fall with persistent inability to bear weight, joint clearly out of place, severe acute pain after impact.
   NOT this flag: chronic pain ("joelho ruim de novo"), DOMS, mild discomfort, "estranho" sem detalhes graves.

5. null (default — most messages)
   Use null for: training resistance, normal diet questions, lifestyle conversation, language switch, account questions, mild emotion, post-workout fatigue, idiom ("tô morrendo de fome", "esse treino me matou"), figurative language.

Examples (ground truth):
- "vou pular almoço hoje, tô com 78kg ainda e quero descer pra 70 logo" → eating_disorder, 0.75
- "estou muito mal e com medo de fazer besteira" → suicide_self_harm, 0.92
- "comecei a sentir o coração disparado e falta de ar mesmo parado" → cardio_neuro_acute, 0.85
- "caí da escada, joelho inchou e não consigo dobrar" → trauma_acute, 0.88
- "estou cansado, não vou treinar hoje" → null, 0.0
- "tô morrendo de fome, almoço já" → null, 0.0  (idiom)
- "esse treino me matou, mal consigo andar" → null, 0.0  (idiom)
- "to triste hoje" → null, 0.0
- "vou pular o lanche da tarde" → null, 0.0  (single skip, no pattern)
- "joelho doendo de novo" → null, 0.0  (chronic, mild)

Use confidence < 0.6 ONLY when the signal is ambiguous. Confidence >= 0.6 means you are reasonably sure escalation is appropriate.

USER MESSAGE TO CLASSIFY:
${JSON.stringify(input)}

Return STRICTLY this JSON shape, no prose, no markdown:
{"flag": <"eating_disorder"|"suicide_self_harm"|"cardio_neuro_acute"|"trauma_acute"|null>, "confidence": <number 0..1>, "reasoning": <short string under 120 chars>}`;
}

// ─── Gemini call ──────────────────────────────────────────────────────────────

async function callRiskModel(
  prompt: string,
  model: string,
  timeoutMs: number
): Promise<unknown> {
  const apiKey = config.geminiApiKey;
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          maxOutputTokens: 200,
        },
      }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ClassifyRiskOptions {
  timeoutMs?: number;
  model?: string;
}

/**
 * Classifica o input do usuário em uma das 4 flags de risco (ou null).
 * NUNCA lança — qualquer erro vira flag=null (falha aberta).
 *
 * @param input  texto do usuário (idioma livre — o prompt é em inglês mas
 *               classifica qualquer idioma graças ao modelo multilíngue)
 * @param language  idioma da sessão (não usado pelo prompt hoje — reservado
 *                  para futuras melhorias, ex: localização do reasoning)
 */
export async function classifyRisk(
  input: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  language: ClassifierLanguage,
  options: ClassifyRiskOptions = {}
): Promise<RiskClassification> {
  const trimmed = (input || "").trim();
  if (!trimmed) return safeFallback("empty_input");

  // Inputs muito curtos (< 4 chars) raramente carregam sinal de risco —
  // economiza tokens e latência.
  if (trimmed.length < 4) return safeFallback("too_short");

  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = (await callRiskModel(buildRiskPrompt(trimmed), model, timeoutMs)) as
    | { flag?: unknown; confidence?: unknown; reasoning?: unknown }
    | null;

  if (!result || typeof result !== "object") {
    return safeFallback("classifier_error");
  }

  return {
    flag: normalizeFlag(result.flag),
    confidence: clampConfidence(result.confidence),
    reasoning:
      typeof result.reasoning === "string" ? result.reasoning.slice(0, 200) : "",
    classifiedAt: new Date().toISOString(),
  };
}

// ─── Safety override block builder ────────────────────────────────────────────
//
// Quando o classifier ativa flag != null e confidence >= 0.6, o brain prompt
// recebe este bloco no TOPO (antes da persona). A função é pública para que
// o server.ts possa usá-la sem duplicar tabelas de recursos.

interface SafetyResource {
  pt: string;
  en: string;
  it: string;
  es: string;
}

const SAFETY_RESOURCES: Record<Exclude<RiskFlag, null>, SafetyResource> = {
  eating_disorder: {
    pt:
      "Encaminhe para profissional de transtorno alimentar (nutricionista clínica ou psicólogo de TA). Diga, em UMA frase, que isso aqui não é o lugar certo pra te ajudar com restrição/jejum/purgação — você precisa de acompanhamento humano. NÃO ofereça swap, NÃO sugira refeição alternativa, NÃO calcule macros.",
    en:
      "Refer to an eating-disorder professional (clinical dietitian or ED-specialized therapist). Say, in ONE sentence, that this app isn't the right place to help with restriction/purging/extreme fasting — they need human follow-up. DO NOT offer swaps, DO NOT suggest alternative meals, DO NOT calculate macros.",
    it:
      "Indirizza verso un professionista per disturbi alimentari (nutrizionista clinico o psicologo specializzato in DCA). In UNA frase: questo posto non è quello giusto per aiutare con restrizione/digiuno estremo/purghe — serve un accompagnamento umano. NON proporre swap, NON suggerire pasti alternativi, NON calcolare macro.",
    es:
      "Deriva a un profesional de TCA (nutricionista clínica o psicólogo especializado en TCA). En UNA frase: esto no es el lugar adecuado para ayudar con restricción/ayuno extremo/purga — necesita acompañamiento humano. NO ofrezcas swap, NO sugieras comida alternativa, NO calcules macros.",
  },
  suicide_self_harm: {
    pt:
      "Reconheça em UMA frase, sem ironia. Encaminhe para o CVV (188 no Brasil, 24h, ligação grátis) e diga que é prioridade ligar agora. Em outros países: 988 (US/Canadá), 02 23272328 (Itália), 024 (Espanha). Encerre dizendo que você fica por aqui se ele quiser conversar depois — sem trazer treino. NUNCA mande treinar.",
    en:
      "Acknowledge in ONE sentence, no irony. Refer to a crisis line: 988 (US/Canada), 116 123 (UK), Lifeline 13 11 14 (AU). Tell them calling now is the priority. End by saying you're here if they want to talk later — never bring up training. DO NOT push exercise.",
    it:
      "Riconosci in UNA frase, senza ironia. Indirizza al Telefono Amico (02 23272328) o al numero di emergenza 112. Di che chiamare ora è la priorità. Chiudi dicendo che sei qui se vuole parlare dopo — non parlare di allenamento. NON spingere l'allenamento.",
    es:
      "Reconoce en UNA frase, sin ironía. Deriva al Teléfono de la Esperanza (024 en España, gratuito 24h) o al 112. Di que llamar ahora es la prioridad. Cierra diciendo que estás acá si quiere hablar después — no menciones entrenamiento. NO empujes ejercicio.",
  },
  cardio_neuro_acute: {
    pt:
      "Pare o treino agora. Esse sintoma exige emergência hoje, não amanhã. SAMU 192 (Brasil) ou ir direto ao pronto-socorro. NÃO sugira ajuste de treino, NÃO 'leve mais leve hoje' — o caminho é avaliação médica imediata.",
    en:
      "Stop training now. This symptom needs emergency evaluation today, not tomorrow. Call 911 (US) or local emergency service, or go straight to the ER. DO NOT suggest a workout adjustment, DO NOT say 'take it easy today' — the path is immediate medical evaluation.",
    it:
      "Ferma l'allenamento adesso. Questo sintomo richiede pronto soccorso oggi, non domani. 118 o pronto soccorso più vicino. NON suggerire un aggiustamento di allenamento, NON dire 'oggi vai piano' — la strada è valutazione medica immediata.",
    es:
      "Para el entrenamiento ahora. Este síntoma requiere urgencia hoy, no mañana. 112 o ir directo a urgencias. NO sugieras ajuste de entrenamiento, NO digas 'hoy ve más suave' — el camino es evaluación médica inmediata.",
  },
  trauma_acute: {
    pt:
      "Pare de tentar mexer. Imobilize a região e vai pro pronto-socorro hoje. Sem treino até passar por médico. NÃO sugira mobilidade, NÃO sugira ajuste — primeiro avaliação, depois retorno.",
    en:
      "Stop trying to move it. Immobilize the area and head to the ER today. No training until medical evaluation. DO NOT suggest mobility work, DO NOT suggest a workaround — evaluation first, return after.",
    it:
      "Smetti di provare a muoverlo. Immobilizza la zona e vai al pronto soccorso oggi. Niente allenamento finché un medico non ti valuta. NON suggerire mobilità, NON suggerire alternative — prima la valutazione, poi il ritorno.",
    es:
      "Para de intentar moverlo. Inmoviliza la zona y ve a urgencias hoy. Sin entrenamiento hasta evaluación médica. NO sugieras movilidad, NO sugieras alternativa — primero evaluación, después regreso.",
  },
};

const SAFETY_HEADERS: Record<ClassifierLanguage, string> = {
  "pt-BR": "⚠️ ALERTA DE SEGURANÇA — TURNO ATUAL",
  "en-US": "⚠️ SAFETY OVERRIDE — CURRENT TURN",
  "it-IT": "⚠️ ALLERTA DI SICUREZZA — TURNO ATTUALE",
  "es-ES": "⚠️ ALERTA DE SEGURIDAD — TURNO ACTUAL",
};

/**
 * Constrói o bloco que será injetado no TOPO do brain prompt quando
 * o classifier ativar flag != null com confidence >= 0.6.
 *
 * O bloco suspende a persona normal por UM turno: força acolhimento +
 * encaminhamento para recurso real, sem swap, sem cobrança, sem treino.
 *
 * Idioma do bloco: instruções em PT (modelo entende), recursos no idioma
 * do usuário para que a fala final saia natural.
 */
export function buildSafetyOverrideBlock(
  flag: Exclude<RiskFlag, null>,
  language: ClassifierLanguage
): string {
  const resource = SAFETY_RESOURCES[flag];
  const localized =
    language === "pt-BR" ? resource.pt :
    language === "en-US" ? resource.en :
    language === "it-IT" ? resource.it :
    resource.es;

  const header = SAFETY_HEADERS[language];

  return [
    header,
    `Tipo de risco detectado: **${flag}**.`,
    "",
    "REGRAS PARA ESTE TURNO (substituem a persona normal):",
    "1. Reconheça em UMA frase, sem ironia, sem 'bora', sem provocação.",
    "2. NÃO use o tom de cobrança nem o de melhor amigo provocador.",
    "3. NÃO sugira treino, swap nutricional, ajuste de macro, missão alternativa.",
    "4. NÃO peça expectedResponse — deixe `null`.",
    "5. NÃO retorne `acao: updateWorkout` — use `acao: none`.",
    "6. `avatarEmotion` deve ser `critical`.",
    "7. Encaminhamento obrigatório:",
    `   ${localized}`,
    "",
    `Idioma da fala visível: ${language}.`,
    "Tamanho: 2 frases curtas, máximo 320 caracteres.",
    "memoryPatch: vazio `{}`.",
    "",
    "Esta regra vale APENAS para este turno. Não persistir em memória.",
    "═══════════════════════════════════════════════════════════════════",
  ].join("\n");
}

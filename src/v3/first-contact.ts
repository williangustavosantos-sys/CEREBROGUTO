import type { FirstContactState, OfficialGoal, OfficialProfile } from "./types.js";

const PT_INTRO = "Finalmente chegou, [nome]. Tava te esperando. Antes de começar de verdade, preciso alinhar duas coisas importantes...";

function displaySex(value: string): string {
  if (value === "male") return "masculino";
  if (value === "female") return "feminino";
  if (value === "prefer_not_to_say") return "não informado";
  return value;
}

export function buildFirstContactSummary(input: {
  profile: OfficialProfile;
  goal: OfficialGoal;
  foodDeclaration: string;
  limitationDeclaration: string;
}): string {
  if (input.profile.language === "en-US") return [
    `Profile: ${input.profile.age} years old, sex ${input.profile.biologicalSex}, ${input.profile.weightKg} kg, ${input.profile.heightCm} cm, level ${input.profile.trainingStatus}, frequency ${input.profile.weeklyFrequencyDaysPerWeek}x per week.`,
    `Goal: ${input.goal.code}.`,
    `Food declaration: ${input.foodDeclaration}.`,
    `Pain, limitations, or relevant conditions declared: ${input.limitationDeclaration}.`,
    "Default plan environment: gym.",
  ].join(" ");
  if (input.profile.language === "it-IT") return [
    `Profilo: ${input.profile.age} anni, sesso ${input.profile.biologicalSex}, ${input.profile.weightKg} kg, ${input.profile.heightCm} cm, livello ${input.profile.trainingStatus}, frequenza ${input.profile.weeklyFrequencyDaysPerWeek} volte a settimana.`,
    `Obiettivo: ${input.goal.code}.`,
    `Alimentazione dichiarata: ${input.foodDeclaration}.`,
    `Dolori, limitazioni o condizioni rilevanti dichiarate: ${input.limitationDeclaration}.`,
    "Ambiente predefinito del piano: palestra.",
  ].join(" ");
  return [
    `Perfil: ${input.profile.age} anos, sexo ${displaySex(input.profile.biologicalSex)}, ${input.profile.weightKg} kg, ${input.profile.heightCm} cm, nível ${input.profile.trainingStatus}, frequência ${input.profile.weeklyFrequencyDaysPerWeek}x por semana.`,
    `Objetivo: ${input.goal.code}.`,
    `Alimentação declarada: ${input.foodDeclaration}.`,
    `Dores, limitações ou condições declaradas: ${input.limitationDeclaration}.`,
    "Ambiente padrão do plano: academia.",
  ].join(" ");
}

export function firstContactPrompt(input: {
  state: Omit<FirstContactState, "currentPrompt" | "summary">;
  displayName: string;
  summary: string | null;
  language: OfficialProfile["language"];
}): string | null {
  if (input.state.status === "NOT_STARTED" || input.state.status === "COMPLETED") return null;
  if (input.state.step === "food_restrictions") {
    if (input.language === "en-US") return `You finally made it, ${input.displayName || "partner"}. I've been waiting for you. Before we really begin, I need to align two important things...\n\nWhat is your diet like today? Is there anything you don't eat, or any allergy, intolerance, or restriction?`;
    if (input.language === "it-IT") return `Finalmente sei arrivato, ${input.displayName || "compagno"}. Ti stavo aspettando. Prima di iniziare davvero, devo chiarire due cose importanti...\n\nCom'è la tua alimentazione oggi? C'è qualcosa che non mangi, oppure qualche allergia, intolleranza o restrizione?`;
    return `${PT_INTRO.replace("[nome]", input.displayName || "parceiro")}\n\nComo é sua alimentação hoje? Tem algo que você não come, alguma alergia, intolerância ou restrição?`;
  }
  if (input.state.step === "training_limitations") {
    if (input.language === "en-US") return "Now tell me: is there any pain, limitation, or relevant condition I need to respect in your training?";
    if (input.language === "it-IT") return "Ora dimmi: c'è qualche dolore, limitazione o condizione rilevante che devo rispettare nel tuo allenamento?";
    return "Agora me conta: existe alguma dor, limitação ou condição relevante que eu precise respeitar no seu treino?";
  }
  if (input.state.step === "confirmation") {
    if (input.language === "en-US") return `${input.summary || ""}\n\nIs this context correct? Confirm it so I can create your workout and diet from the same version.`.trim();
    if (input.language === "it-IT") return `${input.summary || ""}\n\nQuesto contesto è corretto? Confermalo per permettermi di creare allenamento e dieta dalla stessa versione.`.trim();
    return `${input.summary || ""}\n\nEsse contexto está correto? Confirme para eu criar seu treino e sua dieta a partir da mesma versão.`.trim();
  }
  return null;
}

export function materializeFirstContact(input: {
  status?: FirstContactState["status"];
  step?: FirstContactState["step"];
  foodDeclaration?: string | null;
  limitationDeclaration?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  confirmedContextVersion?: number | null;
  displayName: string;
  profile: OfficialProfile | null;
  goal: OfficialGoal | null;
}): FirstContactState {
  const base = {
    status: input.status || "NOT_STARTED",
    step: input.step || "food_restrictions",
    foodDeclaration: input.foodDeclaration ?? null,
    limitationDeclaration: input.limitationDeclaration ?? null,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    confirmedContextVersion: input.confirmedContextVersion ?? null,
  };
  const summary = input.profile && input.goal && base.foodDeclaration && base.limitationDeclaration
    ? buildFirstContactSummary({
        profile: input.profile,
        goal: input.goal,
        foodDeclaration: base.foodDeclaration,
        limitationDeclaration: base.limitationDeclaration,
      })
    : null;
  return {
    ...base,
    summary,
    currentPrompt: firstContactPrompt({ state: base, displayName: input.displayName, summary, language: input.profile?.language || "pt-BR" }),
  };
}

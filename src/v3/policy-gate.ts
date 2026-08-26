import type { DecisionEnvelope } from "./contracts.js";
import type { OfficialSnapshot, PolicyGateResult, TurnEnvelope } from "./types.js";
import { assertFactChange } from "./facts.js";

function detectsAcuteRisk(message: string): boolean {
  return /dor (forte|aguda)|machuquei|les[aã]o|desmaio|falta de ar|peito doendo|doente|febre|vomit|injur|sharp pain|chest pain|sick|fever/iu.test(message);
}

function safetySpeech(language: string): string {
  if (language === "it-IT") return "Mi fermo qui: con questo segnale di rischio non modifico il piano. Dimmi se il dolore è forte o improvviso e, se lo è, cerca assistenza medica.";
  if (language === "en-US") return "I’m stopping here: with this risk signal I won’t change the plan. Tell me if the pain is severe or sudden, and seek medical care if it is.";
  return "Vou parar aqui: com esse sinal de risco eu não altero o plano. Me diga se a dor é forte ou repentina e, se for, procure atendimento médico.";
}

export class PolicyGateV3 {
  authorize(decision: DecisionEnvelope, envelope: TurnEnvelope, snapshot: OfficialSnapshot): PolicyGateResult {
    if (detectsAcuteRisk(envelope.message) && decision.action !== "callSafetyPath" && decision.action !== "askClarification") {
      return {
        authorized: false,
        code: "SAFETY_PATH_REQUIRED",
        decision: {
          ...decision,
          speech: safetySpeech(envelope.official.profile.language),
          action: "callSafetyPath",
          reasonCode: "acute_risk_override",
          selectedCandidateId: undefined,
        },
      };
    }

    if (decision.action === "swapExercise" || decision.action === "swapFood") {
      const candidate = envelope.candidates.find((item) => item.id === decision.selectedCandidateId);
      if (!candidate) return { authorized: false, code: "CANDIDATE_NOT_ALLOWED", decision };
      if (!envelope.activeContext) return { authorized: false, code: "ACTIVE_CONTEXT_REQUIRED", decision };
      const expectedKind = decision.action === "swapExercise" ? "workout" : "diet";
      if (envelope.activeContext.kind !== expectedKind || candidate.kind !== (expectedKind === "workout" ? "exercise" : "food")) {
        return { authorized: false, code: "CONTEXT_ACTION_MISMATCH", decision };
      }
      const plan = expectedKind === "workout" ? snapshot.workout : snapshot.diet;
      if (!plan || plan.id !== envelope.activeContext.planId) return { authorized: false, code: "OFFICIAL_PLAN_NOT_FOUND", decision };
      if (plan.version !== envelope.activeContext.planVersion) return { authorized: false, code: "STALE_ACTIVE_CONTEXT", decision };

      if (decision.action === "swapExercise") {
        const item = snapshot.workout?.items.find((entry) => entry.id === envelope.activeContext?.itemId);
        if (!item) return { authorized: false, code: "OFFICIAL_EXERCISE_NOT_FOUND", decision };
        if (candidate.metadata.muscleGroup !== item.muscleGroup) {
          return { authorized: false, code: "EXERCISE_PURPOSE_MISMATCH", decision };
        }
      }
    }

    if (decision.action === "askClarification" && !decision.clarificationQuestion) {
      return { authorized: false, code: "CLARIFICATION_REQUIRED", decision };
    }
    if (decision.action === "updateFacts") {
      if (!decision.operationalFacts?.length) return { authorized: false, code: "OPERATIONAL_FACT_REQUIRED", decision };
      try {
        for (const fact of decision.operationalFacts) assertFactChange({ ...fact, source: "user_declared" });
      } catch {
        return { authorized: false, code: "OPERATIONAL_FACT_INVALID", decision };
      }
      if (decision.operationalFacts.some((fact) => fact.factType === "PHYSICAL_CONSTRAINT") && detectsAcuteRisk(envelope.message)) {
        return { authorized: false, code: "SAFETY_PATH_REQUIRED", decision: { ...decision, action: "callSafetyPath", operationalFacts: undefined } };
      }
    }

    return { authorized: true, code: "AUTHORIZED", decision };
  }
}

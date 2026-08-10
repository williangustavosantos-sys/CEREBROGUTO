import { V3Error } from "./errors.js";

export const ConversationFactStatus = ["FACT_CONFIRMED", "FACT_UNKNOWN"] as const;
export type ConversationFactStatus = (typeof ConversationFactStatus)[number];

export const ActionSufficiency = ["ACTION_SUFFICIENT", "ACTION_NEEDS_INFORMATION"] as const;
export type ActionSufficiency = (typeof ActionSufficiency)[number];

export const ClinicalCertainty = ["CLINICAL_UNKNOWN"] as const;
export type ClinicalCertainty = (typeof ClinicalCertainty)[number];

export const ConversationStatus = ["OUT_OF_SCOPE", "ACTION_BLOCKED_FOR_SAFETY", "READY_TO_EXECUTE", "IN_PROGRESS"] as const;
export type ConversationStatus = (typeof ConversationStatus)[number];

export interface ConversationKnownFact {
  key: string;
  value: unknown;
  certainty: ConversationFactStatus;
  source?: "user_declared" | "derived" | "system";
}

export interface ConversationMissingInformation {
  key: string;
  reason: string;
  expectedDecisionImpact: string;
}

export interface ConversationDecisionState {
  threadKey: string;
  version: number;
  activeTopic: string | null;
  activeGoal: string | null;
  knownFacts: ConversationKnownFact[];
  resolvedSlots: string[];
  missingInformation: ConversationMissingInformation[];
  uncertaintyType: "none" | "operational" | "clinical" | "safety" | "out_of_scope";
  decisionSufficiency: ActionSufficiency;
  pendingAction: string | null;
  nextAllowedAction: string | null;
  previousInteractionId: string | null;
  status: ConversationStatus;
  updatedAt: string;
}

export interface ConversationStateProposal {
  topic?: string;
  resolvedFacts?: ConversationKnownFact[];
  unresolvedFacts?: string[];
}

export interface ClarificationProposal {
  required: boolean;
  reason?: string;
  missingInformation?: ConversationMissingInformation[];
  expectedDecisionImpact?: string;
}

export function emptyConversationDecisionState(threadKey = "companion"): ConversationDecisionState {
  return {
    threadKey,
    version: 0,
    activeTopic: null,
    activeGoal: null,
    knownFacts: [],
    resolvedSlots: [],
    missingInformation: [],
    uncertaintyType: "none",
    decisionSufficiency: "ACTION_SUFFICIENT",
    pendingAction: null,
    nextAllowedAction: null,
    previousInteractionId: null,
    status: "IN_PROGRESS",
    updatedAt: new Date(0).toISOString(),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function assertClarificationIsMaterial(
  state: ConversationDecisionState,
  clarification: ClarificationProposal | undefined,
): void {
  if (!clarification?.required) return;
  const missing = clarification.missingInformation || [];
  if (!clarification.reason || !clarification.expectedDecisionImpact || missing.length === 0) {
    throw new V3Error("V3_CLARIFICATION_NOT_MATERIAL", "Esclarecimento sem impacto decisório material foi rejeitado.", 409);
  }
  const repeated = missing.find((item) => state.resolvedSlots.includes(item.key));
  if (repeated) {
    throw new V3Error("V3_CLARIFICATION_ALREADY_RESOLVED", "Uma informação já resolvida não pode ser solicitada novamente.", 409, { slot: repeated.key });
  }
}

export function applyConversationDecision(
  current: ConversationDecisionState,
  input: {
    proposedAction: string;
    requiresMoreInformation: boolean;
    proposal?: ConversationStateProposal;
    clarification?: ClarificationProposal;
    interactionId?: string;
    resultCode: string;
  },
): ConversationDecisionState {
  assertClarificationIsMaterial(current, input.clarification);
  const resolvedFacts = input.proposal?.resolvedFacts || [];
  const known = new Map(current.knownFacts.map((fact) => [fact.key, fact]));
  for (const fact of resolvedFacts) known.set(fact.key, fact);
  const resolvedSlots = unique([...current.resolvedSlots, ...resolvedFacts.map((fact) => fact.key)]);
  const requiredMissing = input.clarification?.required
    ? input.clarification.missingInformation || []
    : [];
  const unresolved = new Set(input.proposal?.unresolvedFacts || requiredMissing.map((item) => item.key));
  const missingInformation = requiredMissing.filter((item) => !resolvedSlots.includes(item.key));
  const needsInformation = input.requiresMoreInformation || missingInformation.length > 0 || unresolved.size > 0;
  return {
    ...current,
    version: current.version + 1,
    activeTopic: input.proposal?.topic || current.activeTopic,
    knownFacts: [...known.values()],
    resolvedSlots,
    missingInformation,
    uncertaintyType: needsInformation ? "operational" : "none",
    decisionSufficiency: needsInformation ? "ACTION_NEEDS_INFORMATION" : "ACTION_SUFFICIENT",
    pendingAction: needsInformation ? input.proposedAction : null,
    nextAllowedAction: needsInformation ? "askClarification" : input.proposedAction,
    previousInteractionId: input.interactionId || current.previousInteractionId,
    status: needsInformation ? "IN_PROGRESS" : input.resultCode === "SAFETY_PATH_REQUIRED" ? "ACTION_BLOCKED_FOR_SAFETY" : "READY_TO_EXECUTE",
    updatedAt: new Date().toISOString(),
  };
}

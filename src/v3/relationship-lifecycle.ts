import { V3Error } from "./errors.js";

/**
 * Relationship Lifecycle — deterministic relational state machine.
 *
 * The GUTO product philosophy: GUTO has its own presence; prolonged user
 * absence must produce a consequence; it must never become an app that sends
 * infinite charges; there is a relational progression/degradation; there may be
 * a terminal/inactive state; when the user returns the system must handle the
 * return explicitly; official user data is never destroyed or corrupted by the
 * relational lifecycle.
 *
 * AUTHORITY: the LLM NEVER decides the official lifecycle state. Transitions
 * are driven exclusively by official data (last presence / interaction day)
 * plus time/absence plus this deterministic policy. The LLM may only verbalize
 * the state returned here.
 *
 * States (safe technical terms):
 *   ACTIVE   — relationship healthy, recent presence/interaction.
 *   AT_RISK  — first absence threshold crossed (consecutive days without
 *              mission completed / interaction).
 *   DECAYING — sustained absence; GUTO is visibly weakening.
 *   TERMINAL — terminal/inactive. No public setter and no silent restore:
 *              re-entry only follows a successfully persisted official user
 *              turn evaluated by the deterministic return policy.
 */

export const RELATIONSHIP_LIFECYCLE_STATES = ["ACTIVE", "AT_RISK", "DECAYING", "TERMINAL"] as const;
export type RelationshipLifecycleState = (typeof RELATIONSHIP_LIFECYCLE_STATES)[number];

export interface RelationshipLifecyclePolicy {
  /** Consecutive absence days to move ACTIVE → AT_RISK. */
  atRiskAfterAbsenceDays: number;
  /** Consecutive absence days to move AT_RISK → DECAYING. */
  decayingAfterAbsenceDays: number;
  /** Consecutive absence days to move DECAYING → TERMINAL. */
  terminalAfterAbsenceDays: number;
}

/**
 * Closed Beta policy — the minimum, explicit, documented thresholds needed to
 * make the lifecycle deterministic and testable. They are centralized here (a
 * single source of truth), never hidden in arbitrary per-call numbers. The
 * brain spec seed ("Atenção 3–5d / Crítico ≥6d") informs the defaults.
 */
export const RELATIONSHIP_LIFECYCLE_POLICY: RelationshipLifecyclePolicy = {
  atRiskAfterAbsenceDays: 3,
  decayingAfterAbsenceDays: 7,
  terminalAfterAbsenceDays: 14,
};

export interface RelationshipLifecycleTransition {
  state: RelationshipLifecycleState;
  transitioned: boolean;
  reason?: string;
}

/** Number of full calendar days between an anchor day and the evaluation day. */
export function absenceDaysBetween(anchorDay: string | null, asOf: string): number {
  if (!anchorDay) return 0;
  const anchor = new Date(`${anchorDay}T00:00:00.000Z`);
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);
  if (Number.isNaN(anchor.getTime()) || Number.isNaN(asOfDate.getTime())) return 0;
  const diff = Math.floor((asOfDate.getTime() - anchor.getTime()) / 86_400_000);
  return Math.max(0, diff);
}

/**
 * Deterministic absence transition. TERMINAL is terminal here: an arbitrary
 * lifecycle evaluation never restores it. Re-entry is handled separately only
 * after a successful official user turn has been durably persisted.
 * From any non-terminal state, a fresh presence (absenceDays === 0) recovers to
 * ACTIVE; growing absence degrades ACTIVE → AT_RISK → DECAYING → TERMINAL.
 */
export function evaluateRelationshipLifecycleState(
  current: RelationshipLifecycleState,
  absenceDays: number,
  policy: RelationshipLifecyclePolicy = RELATIONSHIP_LIFECYCLE_POLICY,
): RelationshipLifecycleTransition {
  if (current === "TERMINAL") {
    return { state: "TERMINAL", transitioned: false };
  }
  const target: RelationshipLifecycleState =
    absenceDays >= policy.terminalAfterAbsenceDays
      ? "TERMINAL"
      : absenceDays >= policy.decayingAfterAbsenceDays
        ? "DECAYING"
        : absenceDays >= policy.atRiskAfterAbsenceDays
          ? "AT_RISK"
          : "ACTIVE";
  const transitioned = target !== current;
  const reason = !transitioned
    ? undefined
    : target === "TERMINAL"
      ? "prolonged_absence_terminal"
      : target === "DECAYING"
        ? "prolonged_absence_decaying"
        : target === "AT_RISK"
          ? "absence_at_risk"
          : "presence_recovery";
  return { state: target, transitioned, reason };
}

/** A successful authenticated turn is the official return event. This is not
 * a public setter: callers must first durably record the turn. */
export function evaluateOfficialRelationshipReturn(
  current: RelationshipLifecycleState,
): RelationshipLifecycleTransition {
  return current === "ACTIVE"
    ? { state: "ACTIVE", transitioned: false }
    : { state: "ACTIVE", transitioned: true, reason: "official_user_return" };
}

/**
 * Proactivity gate: a TERMINAL relationship must never keep sending proactive
 * charges. Terminal is the only state that suppresses proactivity (DECAYING
 * still warns, per the product policy of gradual consequence).
 */
export function shouldSuppressProactivity(state: RelationshipLifecycleState): boolean {
  return state === "TERMINAL";
}

export interface RelationshipLifecycleRecord {
  tenantId: string;
  userId: string;
  state: RelationshipLifecycleState;
  enteredStateAt: string | null;
  lastEvaluatedAt: string;
  lastPresenceDay: string | null;
  consecutiveAbsenceDays: number;
  version: number;
}

export interface RelationshipLifecycleEvent {
  tenantId: string;
  userId: string;
  requestId: string;
  fromState: RelationshipLifecycleState;
  toState: RelationshipLifecycleState;
  reason: string;
  at: string;
}

export function assertRelationshipLifecycleState(value: string): RelationshipLifecycleState {
  if (!RELATIONSHIP_LIFECYCLE_STATES.includes(value as RelationshipLifecycleState)) {
    throw new V3Error("V3_RELATIONSHIP_LIFECYCLE_STATE_INVALID", "Estado de lifecycle relacional inválido.", 409);
  }
  return value as RelationshipLifecycleState;
}

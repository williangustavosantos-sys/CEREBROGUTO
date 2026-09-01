import type { PushSubscriptionRecord } from "./push-store.js";
import { shouldSuppressProactivity, type RelationshipLifecycleState } from "./v3/relationship-lifecycle.js";

export type PushSuppressionReason =
  | "no_memory"
  | "inactive_access"
  | "outside_window"
  | "action_completed"
  | "context_suppressed"
  | "relationship_terminal"
  | "recent_activity"
  | "duplicate"
  | "decision_unavailable";

export interface PushEligibilityMemory {
  trainedToday?: boolean;
  completedWorkoutDates?: string[];
  lastActiveAt?: string;
}

export interface PushCandidate<TMemory extends PushEligibilityMemory, TContext = unknown> {
  memory: TMemory | null;
  activeAccess: boolean;
  contextSuppressed: boolean;
  relationshipLifecycleState?: RelationshipLifecycleState | null;
  context: TContext;
}

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

export interface PushDispatchLog {
  dispatchId: string;
  subjectRef: string;
  slot: string | null;
  phase: "eligibility" | "decision" | "delivery";
  outcome: "eligible" | "suppressed" | "decided" | "sent" | "invalid_subscription" | "failed";
  reason?: PushSuppressionReason | "send_error";
  statusCode?: number;
}

export interface PushDispatchResult {
  ok: true;
  dispatchId: string;
  total: number;
  eligible: number;
  sent: number;
  skipped: number;
  failed: number;
  invalidSubscriptions: number;
  suppressions: Partial<Record<PushSuppressionReason, number>>;
}

export interface PushDispatchDependencies<TMemory extends PushEligibilityMemory, TContext = unknown> {
  dispatchId: string;
  now: Date;
  timeZone: string;
  subscriptions: PushSubscriptionRecord[];
  loadCandidate: (userId: string) => Promise<PushCandidate<TMemory, TContext>>;
  decide: (input: {
    memory: TMemory;
    context: TContext;
    slot: string;
    now: Date;
  }) => Promise<PushPayload | null>;
  send: (subscription: PushSubscriptionRecord, payload: PushPayload) => Promise<void>;
  recordSuccess: (endpoint: string, slot: string, sentAt: Date) => Promise<void>;
  recordFailure: (endpoint: string, failedAt: Date) => Promise<void>;
  deleteSubscription: (endpoint: string) => Promise<boolean>;
  subjectRef: (userId: string) => string;
  log: (event: PushDispatchLog) => void;
}

function timeParts(now: Date, timeZone: string): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  return {
    day,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

export function getApprovedPushSlot(now: Date, timeZone: string): string | null {
  const { minutes } = timeParts(now, timeZone);
  if (minutes >= 21 * 60) return "21";
  if (minutes >= 18 * 60) return "18";
  if (minutes >= 12 * 60) return "12";
  return null;
}

export function evaluatePushEligibility(input: {
  memory: PushEligibilityMemory | null;
  activeAccess: boolean;
  contextSuppressed: boolean;
  relationshipLifecycleState?: RelationshipLifecycleState | null;
  subscription: PushSubscriptionRecord;
  now: Date;
  timeZone: string;
}): { eligible: true; slot: string; day: string } | { eligible: false; reason: PushSuppressionReason; slot: string | null; day: string } {
  const { day } = timeParts(input.now, input.timeZone);
  const slot = getApprovedPushSlot(input.now, input.timeZone);
  if (!input.memory) return { eligible: false, reason: "no_memory", slot, day };
  if (!input.activeAccess) return { eligible: false, reason: "inactive_access", slot, day };
  if (input.relationshipLifecycleState && shouldSuppressProactivity(input.relationshipLifecycleState)) {
    return { eligible: false, reason: "relationship_terminal", slot, day };
  }
  if (!slot) return { eligible: false, reason: "outside_window", slot, day };

  const completedDates = Array.isArray(input.memory.completedWorkoutDates)
    ? input.memory.completedWorkoutDates
    : [];
  if (input.memory.trainedToday || completedDates.includes(day)) {
    return { eligible: false, reason: "action_completed", slot, day };
  }
  if (input.contextSuppressed) {
    return { eligible: false, reason: "context_suppressed", slot, day };
  }
  if (input.subscription.lastSentAt) {
    const lastSentDay = timeParts(new Date(input.subscription.lastSentAt), input.timeZone).day;
    if (lastSentDay === day) {
      return { eligible: false, reason: "duplicate", slot, day };
    }
  }
  if (input.memory.lastActiveAt) {
    const activeAt = new Date(input.memory.lastActiveAt).getTime();
    if (Number.isFinite(activeAt) && input.now.getTime() - activeAt < 120 * 60_000) {
      return { eligible: false, reason: "recent_activity", slot, day };
    }
  }
  return { eligible: true, slot, day };
}

function incrementSuppression(
  suppressions: PushDispatchResult["suppressions"],
  reason: PushSuppressionReason
): void {
  suppressions[reason] = (suppressions[reason] || 0) + 1;
}

export async function dispatchExternalPush<TMemory extends PushEligibilityMemory, TContext = unknown>(
  deps: PushDispatchDependencies<TMemory, TContext>
): Promise<PushDispatchResult> {
  const deliveredUsers = new Set<string>();
  const result: PushDispatchResult = {
    ok: true,
    dispatchId: deps.dispatchId,
    total: deps.subscriptions.length,
    eligible: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    invalidSubscriptions: 0,
    suppressions: {},
  };

  for (const subscription of deps.subscriptions) {
    const subjectRef = deps.subjectRef(subscription.userId);
    try {
      if (deliveredUsers.has(subscription.userId)) {
        result.skipped += 1;
        incrementSuppression(result.suppressions, "duplicate");
        deps.log({
          dispatchId: deps.dispatchId,
          subjectRef,
          slot: getApprovedPushSlot(deps.now, deps.timeZone),
          phase: "eligibility",
          outcome: "suppressed",
          reason: "duplicate",
        });
        continue;
      }
      const candidate = await deps.loadCandidate(subscription.userId);
      const eligibility = evaluatePushEligibility({
        memory: candidate.memory,
        activeAccess: candidate.activeAccess,
        contextSuppressed: candidate.contextSuppressed,
        relationshipLifecycleState: candidate.relationshipLifecycleState,
        subscription,
        now: deps.now,
        timeZone: deps.timeZone,
      });
      if (!eligibility.eligible) {
        result.skipped += 1;
        incrementSuppression(result.suppressions, eligibility.reason);
        deps.log({
          dispatchId: deps.dispatchId,
          subjectRef,
          slot: eligibility.slot,
          phase: "eligibility",
          outcome: "suppressed",
          reason: eligibility.reason,
        });
        continue;
      }

      result.eligible += 1;
      deps.log({
        dispatchId: deps.dispatchId,
        subjectRef,
        slot: eligibility.slot,
        phase: "eligibility",
        outcome: "eligible",
      });
      const payload = await deps.decide({
        memory: candidate.memory!,
        context: candidate.context,
        slot: eligibility.slot,
        now: deps.now,
      });
      if (!payload?.body.trim()) {
        result.skipped += 1;
        incrementSuppression(result.suppressions, "decision_unavailable");
        deps.log({
          dispatchId: deps.dispatchId,
          subjectRef,
          slot: eligibility.slot,
          phase: "decision",
          outcome: "suppressed",
          reason: "decision_unavailable",
        });
        continue;
      }
      deps.log({
        dispatchId: deps.dispatchId,
        subjectRef,
        slot: eligibility.slot,
        phase: "decision",
        outcome: "decided",
      });

      try {
        await deps.send(subscription, payload);
        await deps.recordSuccess(subscription.endpoint, eligibility.slot, deps.now);
        deliveredUsers.add(subscription.userId);
        result.sent += 1;
        deps.log({
          dispatchId: deps.dispatchId,
          subjectRef,
          slot: eligibility.slot,
          phase: "delivery",
          outcome: "sent",
        });
      } catch (error) {
        const statusCode = Number((error as { statusCode?: unknown })?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          await deps.deleteSubscription(subscription.endpoint);
          result.invalidSubscriptions += 1;
          result.failed += 1;
          deps.log({
            dispatchId: deps.dispatchId,
            subjectRef,
            slot: eligibility.slot,
            phase: "delivery",
            outcome: "invalid_subscription",
            statusCode,
          });
        } else {
          await deps.recordFailure(subscription.endpoint, deps.now);
          result.failed += 1;
          deps.log({
            dispatchId: deps.dispatchId,
            subjectRef,
            slot: eligibility.slot,
            phase: "delivery",
            outcome: "failed",
            reason: "send_error",
            statusCode: statusCode || undefined,
          });
        }
      }
    } catch {
      result.failed += 1;
      deps.log({
        dispatchId: deps.dispatchId,
        subjectRef,
        slot: getApprovedPushSlot(deps.now, deps.timeZone),
        phase: "delivery",
        outcome: "failed",
        reason: "send_error",
      });
    }
  }

  return result;
}

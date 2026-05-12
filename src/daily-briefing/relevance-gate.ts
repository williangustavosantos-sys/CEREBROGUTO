import { DailyHook, GateDecision, UserInteractionProfile } from "./types";

export function shouldUseHook(params: {
  hook: DailyHook;
  userInteractionProfile: UserInteractionProfile;
  now: string;
}): GateDecision {
  const { hook, userInteractionProfile, now } = params;

  if (hook.usedAt) {
    return { decision: "silence", reason: "already_used" };
  }

  if (hook.staleAfter <= now) {
    return { decision: "silence", reason: "stale" };
  }

  if (hook.actionImpact === "none") {
    return { decision: "silence", reason: "does_not_change_action" };
  }

  if (userInteractionProfile.blocked) {
    return { decision: "silence", reason: "user_blocked" };
  }

  if (
    userInteractionProfile.ignoredCount >= 2 &&
    hook.actionImpact !== "critical" &&
    hook.actionImpact !== "high"
  ) {
    return { decision: "silence", reason: "user_ignoring" };
  }

  return { decision: "speak", reason: "relevant" };
}

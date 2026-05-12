import type { DailyHook, GateDecision } from "./types";

export interface GateOptions {
  now?: string; // ISO
  maxDailyHooks?: number; // not used in this gate, but future
}

export function shouldUseHook(
  hook: DailyHook,
  options: GateOptions = {}
): GateDecision {
  const now = options.now ?? new Date().toISOString();

  // Expired
  if (hook.staleAfter && hook.staleAfter <= now) {
    return "silence_expired";
  }

  // Already used
  if (hook.usedAt) {
    return "silence"; // already spoken
  }

  // Cooldown active
  if (hook.cooldownUntil && hook.cooldownUntil > now) {
    return "silence_cooldown";
  }

  // Does not change action
  if (!hook.changesAction) {
    return "silence_low_impact";
  }

  // Impact low/none
  if (hook.actionImpact === "none" || hook.actionImpact === "low") {
    return "silence_low_impact";
  }

  // Good to speak
  return "speak";
}

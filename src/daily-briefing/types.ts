export type DailyHookCategory =
  | "weather"
  | "schedule"
  | "health"
  | "routine"
  | "system";

export type DailyHookSource =
  | "weather_api"
  | "context_bank"
  | "manual"
  | "system";

export type ActionImpact = "none" | "low" | "medium" | "high";

export type GateDecision =
  | "speak"
  | "silence"
  | "silence_cooldown"
  | "silence_low_impact"
  | "silence_expired";

export interface DailyHook {
  id: string;
  userId: string;
  category: DailyHookCategory;
  title: string;
  content: string;
  actionImpact: ActionImpact;
  changesAction: boolean;
  source: DailyHookSource;
  createdAt: string; // ISO
  peakUntil: string; // ISO
  staleAfter: string; // ISO
  usedAt?: string | null; // ISO
  cooldownUntil?: string | null; // ISO
  meta?: Record<string, unknown>;
}

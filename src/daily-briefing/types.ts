export type DailyHookCategory =
  | "weekly_plan"
  | "weather"
  | "travel_weather"
  | "holiday"
  | "local_event"
  | "health_protection"
  | "diet_awareness";

export type ActionImpact =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "critical";

export interface DailyHook {
  id: string;
  userId: string;
  category: DailyHookCategory;
  title: string;
  content: string;

  actionImpact: ActionImpact;

  objective:
    | "adapt_training"
    | "protect_consistency"
    | "use_good_weather"
    | "avoid_bad_weather"
    | "plan_week"
    | "prepare_holiday"
    | "validate_interest";

  mustMention: string[];
  mustAvoid: string[];

  source: {
    type: "weather_api" | "holiday_api" | "user_weekly_probe" | "manual";
    provider?: string;
    checkedAt: string;
  };

  createdAt: string; // ISO
  peakUntil: string; // ISO
  staleAfter: string; // ISO
  usedAt?: string | null; // ISO

  meta?: Record<string, unknown>;
}

export interface GateDecision {
  decision: "speak" | "silence";
  reason: string;
}

export interface UserInteractionProfile {
  userId: string;
  positiveCount: number;
  ignoredCount: number;
  blocked: boolean;
}

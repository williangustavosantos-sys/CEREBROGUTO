import { selectBestHook } from "./hook-selector";
import type { DailyHook } from "./types";

export interface DailyBrief {
  hasBrief: boolean;
  hooks: DailyHook[];
  mustMention: string[];
  mustAvoid: string[];
  style: {
    maxSentences: number;
  };
}

export async function buildDailyBrief(userId: string, now?: string): Promise<DailyBrief> {
  const hook = await selectBestHook(userId, now);

  if (!hook) {
    return {
      hasBrief: false,
      hooks: [],
      mustMention: [],
      mustAvoid: [],
      style: { maxSentences: 1 },
    };
  }

  return {
    hasBrief: true,
    hooks: [hook],
    mustMention: [hook.content],
    mustAvoid: [
      "briefing",
      "hook",
      "sistema",
      "daily brief",
      "internal context",
    ],
    style: {
      maxSentences: 2,
    },
  };
}

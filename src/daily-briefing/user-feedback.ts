import { readMemoryStoreAsync, writeMemoryStoreAsync } from "../memory-store";
import { DailyHookCategory, UserInteractionProfile } from "./types";

export interface CategoryFeedback {
  positiveCount: number;
  ignoredCount: number;
  blocked: boolean;
}

export type HookFeedbackProfile = Record<DailyHookCategory, CategoryFeedback>;

export async function getUserFeedbackProfile(userId: string): Promise<HookFeedbackProfile> {
  const memory = await readMemoryStoreAsync();
  const userMemory = memory[userId] as Record<string, any>;
  if (!userMemory) {
    return createEmptyProfile();
  }

  const profile = userMemory.hookFeedbackProfile as HookFeedbackProfile | undefined;
  if (!profile) {
    return createEmptyProfile();
  }

  return profile;
}

export async function saveUserFeedbackProfile(userId: string, profile: HookFeedbackProfile): Promise<void> {
  const memory = await readMemoryStoreAsync();
  const userMemory = (memory[userId] || {}) as Record<string, any>;
  
  userMemory.hookFeedbackProfile = profile;
  memory[userId] = userMemory;

  await writeMemoryStoreAsync(memory);
}

export async function recordHookFeedback(
  userId: string, 
  category: DailyHookCategory, 
  type: "positive" | "ignored" | "blocked"
): Promise<void> {
  const profile = await getUserFeedbackProfile(userId);

  if (!profile[category]) {
    profile[category] = { positiveCount: 0, ignoredCount: 0, blocked: false };
  }

  if (type === "positive") {
    profile[category].positiveCount += 1;
    // reset ignored count if user started engaging again
    profile[category].ignoredCount = 0; 
  } else if (type === "ignored") {
    profile[category].ignoredCount += 1;
  } else if (type === "blocked") {
    profile[category].blocked = true;
  }

  await saveUserFeedbackProfile(userId, profile);
}

export function getInteractionProfileForCategory(
  profile: HookFeedbackProfile, 
  category: DailyHookCategory,
  userId: string
): UserInteractionProfile {
  const cat = profile[category] || { positiveCount: 0, ignoredCount: 0, blocked: false };
  return {
    userId,
    positiveCount: cat.positiveCount,
    ignoredCount: cat.ignoredCount,
    blocked: cat.blocked
  };
}

function createEmptyProfile(): HookFeedbackProfile {
  return {
    weekly_plan: { positiveCount: 0, ignoredCount: 0, blocked: false },
    weather: { positiveCount: 0, ignoredCount: 0, blocked: false },
    travel_weather: { positiveCount: 0, ignoredCount: 0, blocked: false },
    holiday: { positiveCount: 0, ignoredCount: 0, blocked: false },
    local_event: { positiveCount: 0, ignoredCount: 0, blocked: false },
    health_protection: { positiveCount: 0, ignoredCount: 0, blocked: false },
    diet_awareness: { positiveCount: 0, ignoredCount: 0, blocked: false }
  };
}

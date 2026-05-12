import { describe, it } from "node:test";
import assert from "node:assert";
import { shouldUseHook } from "../relevance-gate";
import type { DailyHook, UserInteractionProfile } from "../types";

const baseHook: DailyHook = {
  id: "test-1",
  userId: "user1",
  category: "weather",
  title: "Strong rain",
  content: "Fortes chuvas previstas para hoje. Se treina ao ar livre, melhor adaptar para casa.",
  actionImpact: "high",
  objective: "adapt_training",
  mustMention: [],
  mustAvoid: [],
  source: {
    type: "weather_api",
    checkedAt: "2025-01-01T06:00:00.000Z",
  },
  createdAt: "2025-01-01T06:00:00.000Z",
  peakUntil: "2025-01-01T12:00:00.000Z",
  staleAfter: "2025-01-02T00:00:00.000Z",
};

const defaultProfile: UserInteractionProfile = {
  userId: "user1",
  positiveCount: 0,
  ignoredCount: 0,
  blocked: false,
};

const now = "2025-01-01T08:00:00.000Z";

describe("relevance-gate", () => {
  it("returns speak for high impact and not expired", () => {
    assert.strictEqual(shouldUseHook({ hook: baseHook, userInteractionProfile: defaultProfile, now }).decision, "speak");
  });

  it("returns silence_expired when staleAfter in the past", () => {
    const past = "2025-01-01T00:00:00.000Z";
    const futureNow = "2025-01-02T00:00:00.000Z";
    const hook: DailyHook = { ...baseHook, staleAfter: past };
    assert.strictEqual(shouldUseHook({ hook, userInteractionProfile: defaultProfile, now: futureNow }).decision, "silence");
  });

  it("returns silence_low_impact when actionImpact is none", () => {
    const hookNone: DailyHook = { ...baseHook, actionImpact: "none" };
    assert.strictEqual(shouldUseHook({ hook: hookNone, userInteractionProfile: defaultProfile, now }).decision, "silence");
  });

  it("returns silence when user blocked category", () => {
    const profile = { ...defaultProfile, blocked: true };
    assert.strictEqual(shouldUseHook({ hook: baseHook, userInteractionProfile: profile, now }).decision, "silence");
  });

  it("returns silence when user ignoring and impact is not critical or high", () => {
    const profile = { ...defaultProfile, ignoredCount: 2 };
    const hookMedium: DailyHook = { ...baseHook, actionImpact: "medium" };
    assert.strictEqual(shouldUseHook({ hook: hookMedium, userInteractionProfile: profile, now }).decision, "silence");
  });

  it("returns speak when user ignoring BUT impact is high", () => {
    const profile = { ...defaultProfile, ignoredCount: 2 };
    assert.strictEqual(shouldUseHook({ hook: baseHook, userInteractionProfile: profile, now }).decision, "speak");
  });

  it("returns silence when hook already used", () => {
    const hook: DailyHook = { ...baseHook, usedAt: "2025-01-01T07:00:00.000Z" };
    assert.strictEqual(shouldUseHook({ hook, userInteractionProfile: defaultProfile, now }).decision, "silence");
  });
});

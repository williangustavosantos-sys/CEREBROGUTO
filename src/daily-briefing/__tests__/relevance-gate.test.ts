import { describe, it } from "node:test";
import assert from "node:assert";
import { shouldUseHook } from "../relevance-gate";
import type { DailyHook } from "../types";

const baseHook: DailyHook = {
  id: "test-1",
  userId: "user1",
  category: "weather",
  title: "Strong rain",
  content: "Fortes chuvas previstas para hoje. Se treina ao ar livre, melhor adaptar para casa.",
  actionImpact: "high",
  changesAction: true,
  source: "weather_api",
  createdAt: "2025-01-01T06:00:00.000Z",
  peakUntil: "2025-01-01T12:00:00.000Z",
  staleAfter: "2025-01-02T00:00:00.000Z",
};

describe("relevance-gate", () => {
  it("returns speak for high impact and not expired", () => {
    assert.strictEqual(shouldUseHook(baseHook), "speak");
  });

  it("returns silence_expired when staleAfter in the past", () => {
    const past = "2025-01-01T00:00:00.000Z";
    const now = "2025-01-02T00:00:00.000Z";
    const hook: DailyHook = { ...baseHook, staleAfter: past };
    assert.strictEqual(shouldUseHook(hook, { now }), "silence_expired");
  });

  it("returns silence_cooldown when cooldownUntil in the future", () => {
    const now = "2025-01-01T08:00:00.000Z";
    const hook: DailyHook = {
      ...baseHook,
      cooldownUntil: "2025-01-01T12:00:00.000Z",
    };
    assert.strictEqual(shouldUseHook(hook, { now }), "silence_cooldown");
  });

  it("returns silence_low_impact when changesAction is false", () => {
    const hook: DailyHook = { ...baseHook, changesAction: false, actionImpact: "high" };
    assert.strictEqual(shouldUseHook(hook), "silence_low_impact");
  });

  it("returns silence_low_impact when actionImpact is none or low", () => {
    const hookLow: DailyHook = { ...baseHook, actionImpact: "low" };
    assert.strictEqual(shouldUseHook(hookLow), "silence_low_impact");

    const hookNone: DailyHook = { ...baseHook, actionImpact: "none" };
    assert.strictEqual(shouldUseHook(hookNone), "silence_low_impact");
  });

  it("returns silence when hook already used", () => {
    const hook: DailyHook = { ...baseHook, usedAt: "2025-01-01T07:00:00.000Z" };
    assert.strictEqual(shouldUseHook(hook), "silence");
  });
});

import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { injectDailyBriefIntoBrainPrompt, markHookUsedAfterResponse } from "../chat-brief-integrator";
import * as hookSelector from "../hook-selector";
import * as hookStore from "../hook-store";
import { beforeEach } from "node:test";
import { config } from "../../config";

const mockSelectBestHook = mock.method(hookSelector, "selectBestHook");
const mockMarkHookUsed = mock.method(hookStore, "markHookUsed");

const basePrompt = "VOCÊ É GUTO.\n...\nAgora responda.";

describe("chat-brief-integrator", () => {
  beforeEach(() => {
    mockSelectBestHook.mock.resetCalls();
    mockMarkHookUsed.mock.resetCalls();
    config.enableDailyBriefing = true; // ensure feature is on for these tests
  });

  it("returns same prompt when no hook is available", async () => {
    mockSelectBestHook.mock.mockImplementationOnce(async () => null);
    const result = await injectDailyBriefIntoBrainPrompt("user1", basePrompt);
    assert.strictEqual(result, basePrompt);
    assert.strictEqual(mockSelectBestHook.mock.calls.length, 1);
  });

  it("injects brief block when hook exists", async () => {
    const fakeHook = {
      id: "hook1",
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
      usedAt: null,
      cooldownUntil: null,
    } as const;
    mockSelectBestHook.mock.mockImplementationOnce(async () => fakeHook as any);
    const result = await injectDailyBriefIntoBrainPrompt("user1", basePrompt);
    assert.ok(result.includes("DAILY_CONTEXT_BRIEF"));
    assert.ok(result.includes("Fortes chuvas previstas"));
    assert.ok(result.includes("adapt_today_response"));
  });

  it("markHookUsedAfterResponse marks the best hook", async () => {
    const fakeHook = {
      id: "hook2",
      userId: "user1",
      category: "weather",
      title: "Heat",
      content: "Calor extremo",
      actionImpact: "high",
      changesAction: true,
      source: "weather_api",
      createdAt: "2025-01-01T06:00:00.000Z",
      peakUntil: "2025-01-01T12:00:00.000Z",
      staleAfter: "2025-01-02T00:00:00.000Z",
      usedAt: null,
      cooldownUntil: null,
    } as any;
    mockSelectBestHook.mock.mockImplementationOnce(async () => fakeHook);
    await markHookUsedAfterResponse("user1");
    assert.strictEqual(mockMarkHookUsed.mock.calls.length, 1);
    assert.strictEqual(mockMarkHookUsed.mock.calls[0].arguments[0], "user1");
    assert.strictEqual(mockMarkHookUsed.mock.calls[0].arguments[1], "hook2");
  });

  it("markHookUsedAfterResponse does nothing when no hook", async () => {
    mockSelectBestHook.mock.mockImplementationOnce(async () => null);
    await markHookUsedAfterResponse("user1");
    assert.strictEqual(mockMarkHookUsed.mock.calls.length, 0);
  });

  it("returns original prompt when feature flag is disabled", async () => {
    config.enableDailyBriefing = false;
    const result = await injectDailyBriefIntoBrainPrompt("user1", basePrompt);
    assert.strictEqual(result, basePrompt);
    assert.strictEqual(mockSelectBestHook.mock.calls.length, 0);
  });
});

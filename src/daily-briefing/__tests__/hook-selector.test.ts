import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { selectBestHook } from "../hook-selector";
import * as hookStore from "../hook-store";
import type { DailyHook } from "../types";

const mockGetActiveDailyHooks = mock.method(hookStore, "getActiveDailyHooks");

const createHook = (overrides: Partial<DailyHook> & { content: string }): DailyHook => ({
  id: "id-" + Math.random().toString(36).slice(2),
  userId: "user1",
  category: "weather",
  title: "Hook",
  actionImpact: "medium",
  changesAction: true,
  source: "weather_api",
  createdAt: "2025-01-01T06:00:00.000Z",
  peakUntil: "2025-01-01T12:00:00.000Z",
  staleAfter: "2025-01-02T00:00:00.000Z",
  ...overrides,
});

describe("hook-selector", () => {
  it("returns null when no active hooks", async () => {
    mockGetActiveDailyHooks.mock.mockImplementationOnce(async () => []);
    const result = await selectBestHook("user1");
    assert.strictEqual(result, null);
  });

  it("returns null when all hooks are irrelevant (gate blocks)", async () => {
    const hooks: DailyHook[] = [
      createHook({ content: "low impact", actionImpact: "low", changesAction: false }),
      createHook({ content: "expired", staleAfter: "2024-01-01T00:00:00.000Z" }),
    ];
    mockGetActiveDailyHooks.mock.mockImplementationOnce(async () => hooks);
    const result = await selectBestHook("user1", "2025-01-01T10:00:00.000Z");
    assert.strictEqual(result, null);
  });

  it("prefers high impact over medium", async () => {
    const high = createHook({ content: "high impact", actionImpact: "high", peakUntil: "2025-01-01T10:00:00.000Z", createdAt: "2025-01-01T05:00:00.000Z" });
    const medium = createHook({ content: "medium impact", actionImpact: "medium", peakUntil: "2025-01-01T09:00:00.000Z", createdAt: "2025-01-01T07:00:00.000Z" });
    mockGetActiveDailyHooks.mock.mockImplementationOnce(async () => [medium, high]);
    const result = await selectBestHook("user1");
    assert.strictEqual(result?.content, "high impact");
  });

  it("among same impact, picks hook with closest peakUntil", async () => {
    const farPeak = createHook({ content: "far peak", actionImpact: "high", peakUntil: "2025-01-01T18:00:00.000Z", createdAt: "2025-01-01T06:00:00.000Z" });
    const closePeak = createHook({ content: "close peak", actionImpact: "high", peakUntil: "2025-01-01T08:00:00.000Z", createdAt: "2025-01-01T06:00:00.000Z" });
    mockGetActiveDailyHooks.mock.mockImplementationOnce(async () => [farPeak, closePeak]);
    const result = await selectBestHook("user1");
    assert.strictEqual(result?.content, "close peak");
  });

  it("among same impact and same peakUntil, picks newest createdAt", async () => {
    const oldHook = createHook({ content: "old", actionImpact: "high", peakUntil: "2025-01-01T10:00:00.000Z", createdAt: "2025-01-01T05:00:00.000Z" });
    const newHook = createHook({ content: "new", actionImpact: "high", peakUntil: "2025-01-01T10:00:00.000Z", createdAt: "2025-01-01T07:00:00.000Z" });
    mockGetActiveDailyHooks.mock.mockImplementationOnce(async () => [oldHook, newHook]);
    const result = await selectBestHook("user1");
    assert.strictEqual(result?.content, "new");
  });
});

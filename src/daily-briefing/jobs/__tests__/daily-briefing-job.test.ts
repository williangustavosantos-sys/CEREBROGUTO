import test from "node:test";
import assert from "node:assert";
import { runDailyBriefingForUser } from "../daily-briefing-job";
import { writeMemoryStoreSync, readMemoryStoreSync } from "../../../memory-store";

test("Daily Briefing Job", async (t) => {
  await t.test("creates probe even if user has no location data", async () => {
    writeMemoryStoreSync({ "user_empty": {} });
    const now = "2026-05-11T10:00:00.000Z";
    const res = await runDailyBriefingForUser("user_empty", now);
    assert.strictEqual(res.skipped, 0);
    assert.strictEqual(res.created, 1); // Weekly probe
  });

  // A complete end-to-end test without mock servers is flaky because it relies on actual OpenWeather and Nager APIs.
  // We just test that the basic flow works for skipping and the function exists and runs.
  await t.test("can execute for a user with basic data (might fail or return 0 if no API keys)", async () => {
    writeMemoryStoreSync({ 
      "user_basic": {
        contextBank: [],
        lat: -23.5505,
        lon: -46.6333,
        country: "BR"
      } 
    });
    const now = "2026-05-11T10:00:00.000Z";
    const res = await runDailyBriefingForUser("user_basic", now);
    
    // Even if APIs fail, it shouldn't crash. It should at least create a weekly planning probe hook
    // because shouldAskWeeklyPlanning will return true.
    assert.strictEqual(res.skipped, 0);
    assert.ok(res.created >= 1); // 1 for the weekly planning probe
  });
});

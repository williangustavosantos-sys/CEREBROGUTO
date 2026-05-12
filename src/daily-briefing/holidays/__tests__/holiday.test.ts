import test from "node:test";
import assert from "node:assert";
import { holidayToDailyHook } from "../holiday-to-hook";
import { Holiday } from "../holiday-collector";

const MOCK_HOLIDAYS: Holiday[] = [
  {
    date: "2026-05-15",
    localName: "Feriado Teste",
    name: "Test Holiday",
    countryCode: "BR",
    global: true,
    types: ["Public"]
  }
];

test("Holiday Hooks", async (t) => {
  await t.test("returns hook for holiday in 3 days", () => {
    const now = "2026-05-12T10:00:00.000Z";
    const hook = holidayToDailyHook("user1", MOCK_HOLIDAYS, now);
    assert.ok(hook);
    assert.strictEqual(hook?.actionImpact, "medium");
    assert.strictEqual(hook?.objective, "prepare_holiday");
  });

  await t.test("returns hook for holiday in 5 days with low impact", () => {
    const now = "2026-05-10T10:00:00.000Z";
    const hook = holidayToDailyHook("user1", MOCK_HOLIDAYS, now);
    assert.ok(hook);
    assert.strictEqual(hook?.actionImpact, "low");
  });

  await t.test("returns null for holiday today", () => {
    const now = "2026-05-15T10:00:00.000Z";
    const hook = holidayToDailyHook("user1", MOCK_HOLIDAYS, now);
    assert.strictEqual(hook, null);
  });

  await t.test("returns null for holiday passed", () => {
    const now = "2026-05-16T10:00:00.000Z";
    const hook = holidayToDailyHook("user1", MOCK_HOLIDAYS, now);
    assert.strictEqual(hook, null);
  });
});

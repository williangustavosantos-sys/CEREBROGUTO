import test from "node:test";
import assert from "node:assert";
import { shouldAskWeeklyPlanning, buildWeeklyPlanningHook } from "../weekly-probe";
import { writeWeeklySignalsToContextBank } from "../weekly-context-writer";
import { getUserContextBank } from "../../../presence/context-bank";
import { writeMemoryStoreSync } from "../../../memory-store";

test("Weekly Planning MVP", async (t) => {
  await t.test("shouldAskWeeklyPlanning initially returns true", async () => {
    // Limpar memoria para o usuario de teste
    writeMemoryStoreSync({ "test_user": { contextBank: [] } });
    
    const now = "2026-05-11T10:00:00.000Z"; // Monday
    const result = await shouldAskWeeklyPlanning("test_user", now);
    assert.strictEqual(result, true);
  });

  await t.test("buildWeeklyPlanningHook creates correct hook", async () => {
    const now = "2026-05-11T10:00:00.000Z";
    const hook = await buildWeeklyPlanningHook("test_user", now);
    assert.strictEqual(hook.category, "weekly_plan");
    assert.strictEqual(hook.actionImpact, "critical");
    assert.ok(hook.content.includes("semana"));
  });

  await t.test("writeWeeklySignalsToContextBank writes marker and signals", async () => {
    const now = "2026-05-11T10:00:00.000Z";
    
    await writeWeeklySignalsToContextBank("test_user", [
      {
        type: "future_event",
        value: "Viagem para São Paulo na quarta",
        raw_phrase: "quarta viajo pra SP",
        confidence: 0.9,
        language_detected: "pt",
        needs_user_validation: false,
        meta: { destinationCity: "São Paulo" }
      }
    ], now);

    const bank = await getUserContextBank("test_user");
    
    // We expect 2 items: the "weekly_plan_completed" marker and the actual signal
    assert.strictEqual(bank.length, 2);
    
    const marker = bank.find(i => i.meta.kind === "weekly_plan_completed");
    assert.ok(marker);
    
    const travel = bank.find(i => i.meta.kind === "travel");
    assert.ok(travel);
    assert.strictEqual(travel?.meta.destinationCity, "São Paulo");

    // Once marked, shouldAskWeeklyPlanning must return false
    const askAgain = await shouldAskWeeklyPlanning("test_user", now);
    assert.strictEqual(askAgain, false);
  });
});

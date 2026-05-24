import { test } from "node:test";
import assert from "node:assert";
import { getMemory, saveMemory, invalidateDietIfNeeded } from "../server.js";
import { saveDietPlan } from "../src/diet-store.js";

function setupTestMemory(userId: string) {
  const mem = getMemory(userId);
  mem.weightKg = 70;
  mem.heightCm = 175;
  mem.dietGenerationStatus = "generated";
  saveMemory(mem);
  return mem;
}

test("diet invalidation logic internal", async (t) => {
  await t.test("changes to weightKg invalidate the diet", async () => {
    const mem = setupTestMemory("test-inv-internal-1");
    const changedFields = new Set(["weightKg"]);
    await invalidateDietIfNeeded(mem, changedFields);
    assert.strictEqual(mem.dietGenerationStatus, "needs_clarification");
  });

  await t.test("changes to foodRestrictions invalidate the diet", async () => {
    const mem = setupTestMemory("test-inv-internal-2");
    const changedFields = new Set(["foodRestrictions"]);
    await invalidateDietIfNeeded(mem, changedFields);
    assert.strictEqual(mem.dietGenerationStatus, "needs_clarification");
  });

  await t.test("changes to unlisted field do NOT invalidate the diet", async () => {
    const mem = setupTestMemory("test-inv-internal-3");
    const changedFields = new Set(["name", "language"]);
    await invalidateDietIfNeeded(mem, changedFields);
    assert.strictEqual(mem.dietGenerationStatus, "generated");
  });

  await t.test("diet lockedByCoach is preserved", async () => {
    const mem = setupTestMemory("test-inv-internal-4");

    await saveDietPlan({
      userId: "test-inv-internal-4",
      generatedAt: new Date().toISOString(),
      country: "Brasil",
      lockedByCoach: true,
      macros: { bmr: 1000, tdee: 1200, targetKcal: 1500, proteinG: 100, carbsG: 100, fatG: 50, goal: "consistency" },
      meals: []
    });

    const changedFields = new Set(["weightKg"]);
    await invalidateDietIfNeeded(mem, changedFields);

    assert.strictEqual(mem.dietGenerationStatus, "generated"); // preserved
    const audit = mem.memoryAudit?.find(a => a.source === "profile_sync");
    // MemoryAudit doesn't have an action, it has a source
    const hasAudit = mem.memoryAudit?.some(a => a.source === "profile_sync");
    assert.ok(hasAudit, "Deve registrar auditoria");
  });
});

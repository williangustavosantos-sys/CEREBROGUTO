import "./test-env.js";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  clearMemoryStoreCache,
  flushMemoryStoreWrites,
  persistUserMemory,
  readMemoryStoreSync,
  writeMemoryStoreSync,
} from "../src/memory-store.js";
import { config } from "../src/config.js";

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.store-merge-test.json");

describe("memory-store — merge anti-clobber por usuário", () => {
  beforeEach(() => {
    process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    config.memoryFile = testMemoryFile;
    mkdirSync(tmpDir, { recursive: true });
    rmSync(testMemoryFile, { force: true });
    clearMemoryStoreCache();
  });

  it("write parcial stale não apaga pacto, XP, evento nem consentimento", async () => {
    const userId = "memory-stale-initial-xp";
    const grantEvent = {
      id: "2026-07-08:grant_initial_xp",
      type: "grant_initial_xp",
      amount: 100,
      date: "2026-07-08",
      createdAt: "2026-07-08T00:00:00.000Z",
    };

    writeMemoryStoreSync({
      [userId]: {
        userId,
        name: "PIETRO",
        language: "pt-BR",
        consentHealthFitness: true,
        acceptedTerms: true,
        consentAcceptedAt: "2026-07-08T00:00:00.000Z",
      initialXpGranted: true,
      initialXpRewardSeen: false,
      totalXp: 100,
      xpEvents: [grantEvent],
      lastWorkoutPlan: { title: "Treino oficial", exercises: [{ id: "ex-1" }] },
      weeklyDietPlan: { meals: [{ name: "Almoço", foods: [{ name: "Tofu" }] }] },
      dietGenerationStatus: "generated",
    },
  });

    await persistUserMemory(userId, {
      userId,
      name: "PIETRO",
      language: "pt-BR",
      consentHealthFitness: false,
      acceptedTerms: false,
      initialXpGranted: false,
      initialXpRewardSeen: true,
      totalXp: 0,
      xpEvents: [],
      lastWorkoutPlan: null,
      weeklyDietPlan: null,
      dietGenerationStatus: "idle",
    });
    await flushMemoryStoreWrites();

    const saved = readMemoryStoreSync()[userId] as Record<string, unknown>;
    assert.equal(saved.consentHealthFitness, true);
    assert.equal(saved.acceptedTerms, true);
    assert.equal(saved.initialXpGranted, true);
    assert.equal(saved.initialXpRewardSeen, true);
    assert.equal(saved.totalXp, 100);
    assert.deepEqual(saved.xpEvents, [grantEvent]);
    assert.equal((saved.lastWorkoutPlan as { title?: string }).title, "Treino oficial");
    assert.equal((saved.weeklyDietPlan as { meals?: unknown[] }).meals?.length, 1);
    assert.equal(saved.dietGenerationStatus, "generated");
  });
});

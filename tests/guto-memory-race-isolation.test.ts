import "./test-env.js";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import jwt from "jsonwebtoken";

import { config } from "../src/config.js";
import { verifyToken } from "../src/auth-middleware.js";
import {
  clearMemoryStoreCache,
  flushMemoryStoreWrites,
  persistUserMemory,
  readMemoryStoreAsync,
  readMemoryStoreSync,
  readPersistedUserMemorySnapshot,
  setMemoryStoreRedisClientForTests,
  updateUserMemoryAtomically,
  writeMemoryStoreSync,
} from "../src/memory-store.js";

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.race-isolation-test.json");

describe("memory-store — request ordering and user isolation", () => {
  beforeEach(() => {
    process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    config.memoryFile = testMemoryFile;
    mkdirSync(tmpDir, { recursive: true });
    rmSync(testMemoryFile, { force: true });
    clearMemoryStoreCache();
  });

  afterEach(() => {
    setMemoryStoreRedisClientForTests(undefined);
  });

  it("preserves BORA and initial XP when logically concurrent writes arrive in reverse order", async () => {
    const userId = "bug1-concurrent-order";
    const grantEvent = {
      id: "2026-08-09:grant_initial_xp",
      type: "grant_initial_xp",
      amount: 100,
      date: "2026-08-09",
      createdAt: "2026-08-09T10:00:00.000Z",
    };

    writeMemoryStoreSync({
      [userId]: {
        userId,
        initialXpGranted: false,
        initialXpRewardSeen: false,
        totalXp: 0,
        xpEvents: [],
      },
    });

    await Promise.all([
      persistUserMemory(userId, {
        userId,
        initialXpGranted: false,
        initialXpRewardSeen: true,
        totalXp: 0,
        xpEvents: [],
      }),
      Promise.resolve().then(() => persistUserMemory(userId, {
        userId,
        initialXpGranted: true,
        initialXpRewardSeen: false,
        totalXp: 100,
        xpEvents: [grantEvent],
      })),
      Promise.resolve().then(() => persistUserMemory(userId, {
        userId,
        initialXpGranted: true,
        initialXpRewardSeen: false,
        totalXp: 100,
        xpEvents: [grantEvent],
      })),
    ]);
    await flushMemoryStoreWrites();

    const saved = readMemoryStoreSync()[userId] as Record<string, unknown>;
    assert.equal(saved.initialXpGranted, true);
    assert.equal(saved.initialXpRewardSeen, true);
    assert.equal(saved.totalXp, 100);
    assert.equal((saved.xpEvents as unknown[]).length, 1, "initial XP event must remain idempotent");
  });

  it("returns deep-isolated snapshots and never mutates cache without an explicit save", async () => {
    const remoteStore = {
      A: {
        userId: "A",
        activeExercise: { name: "elliptical machine", metadata: { level: 2 } },
      },
      B: {
        userId: "B",
        activeExercise: null,
      },
    };
    setMemoryStoreRedisClientForTests({
      get: async (key) => key === "guto:memory" ? structuredClone(remoteStore) : null,
      set: async () => "OK",
      eval: async () => 1,
    });

    const asyncRead = await readMemoryStoreAsync() as Record<string, Record<string, unknown>>;
    (asyncRead.A.activeExercise as { name: string; metadata: { level: number } }).name = "mutated async";
    (asyncRead.A.activeExercise as { name: string; metadata: { level: number } }).metadata.level = 99;

    const syncRead = readMemoryStoreSync() as Record<string, Record<string, unknown>>;
    assert.equal((syncRead.A.activeExercise as { name: string }).name, "elliptical machine");
    assert.equal((syncRead.A.activeExercise as { metadata: { level: number } }).metadata.level, 2);
    assert.equal(syncRead.B.activeExercise, null, "user A state must never reach user B");

    (syncRead.A.activeExercise as { name: string }).name = "mutated sync";
    const reread = readMemoryStoreSync() as Record<string, Record<string, unknown>>;
    assert.equal((reread.A.activeExercise as { name: string }).name, "elliptical machine");
    assert.equal(reread.B.activeExercise, null);
  });

  it("rejects undefined, null, empty and whitespace user IDs", async () => {
    const invalidIds = [undefined, null, "", "   "];
    for (const invalidId of invalidIds) {
      assert.throws(
        () => persistUserMemory(invalidId as unknown as string, {}),
        /non-empty GUTO userId/i,
      );
      await assert.rejects(
        readPersistedUserMemorySnapshot(invalidId as unknown as string),
        /non-empty GUTO userId/i,
      );
      await assert.rejects(
        updateUserMemoryAtomically(invalidId as unknown as string, () => ({})),
        /non-empty GUTO userId/i,
      );
    }

    const store = readMemoryStoreSync();
    assert.equal(Object.prototype.hasOwnProperty.call(store, ""), false);
    assert.equal(Object.prototype.hasOwnProperty.call(store, "   "), false);

    for (const invalidId of [undefined, null, "", "   "]) {
      const token = jwt.sign({ userId: invalidId, role: "student" }, config.jwtSecret);
      assert.equal(verifyToken(token), null, "invalid JWT identity must be rejected before memory access");
    }
  });
});

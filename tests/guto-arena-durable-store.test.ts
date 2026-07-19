import "./test-env.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mutateArenaStoreAsync,
  setArenaStoreRedisClientForTests,
  writeArenaStore,
} from "../src/arena-store.js";
import { awardArenaXpAsync } from "../src/arena.js";

function fakeRedis(initial: unknown, onArenaSet?: () => Promise<void>) {
  let arena = JSON.stringify(initial);
  let lock: string | null = null;
  return {
    client: {
      async get(key: string) {
        if (key.includes("write-lock")) return lock;
        return arena;
      },
      async set(key: string, value: unknown, options?: { nx: true; px: number }) {
        if (options?.nx) {
          if (lock) return null;
          lock = String(value);
          return "OK";
        }
        if (onArenaSet) await onArenaSet();
        arena = String(value);
        return "OK";
      },
      async eval(_script: string, _keys: string[], args: string[]) {
        if (lock === args[0]) lock = null;
        return 1;
      },
    },
    read: () => JSON.parse(arena) as { profiles: Record<string, unknown>; events: unknown[] },
  };
}

afterEach(() => {
  setArenaStoreRedisClientForTests(undefined);
  writeArenaStore({ profiles: {}, events: [] });
});

describe("Arena durable serverless persistence", () => {
  it("does not resolve a mutation before the Redis SET has completed", async () => {
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const redis = fakeRedis({ profiles: {}, events: [], schemaVersion: 2 }, async () => {
      markWriteStarted();
      await writeGate;
    });
    setArenaStoreRedisClientForTests(redis.client);

    let settled = false;
    const pending = mutateArenaStoreAsync((store) => {
      store.events.push({
        id: "event-1",
        userId: "u1",
        arenaGroupId: "g1",
        type: "bonus",
        xp: 100,
        createdAt: new Date().toISOString(),
      });
    }).then(() => { settled = true; });

    await writeStarted;
    assert.equal(settled, false);
    releaseWrite();
    await pending;
    assert.equal(redis.read().events.length, 1);
  });

  it("re-reads under the lease so serialized mutations preserve every profile", async () => {
    const redis = fakeRedis({ profiles: {}, events: [], schemaVersion: 2 });
    setArenaStoreRedisClientForTests(redis.client);

    await Promise.all([
      mutateArenaStoreAsync((store) => {
        store.profiles.a = { userId: "a" } as never;
      }),
      mutateArenaStoreAsync((store) => {
        store.profiles.b = { userId: "b" } as never;
      }),
    ]);

    assert.deepEqual(Object.keys(redis.read().profiles).sort(), ["a", "b"]);
  });

  it("counts the adapted-to-full completion delta in the period exactly once", async () => {
    setArenaStoreRedisClientForTests(null);
    writeArenaStore({ profiles: {}, events: [] });

    await awardArenaXpAsync({
      userId: "u-adapted",
      displayName: "Ada",
      arenaGroupId: "g1",
      type: "bonus",
      xp: 100,
      sourceValidationId: "pact",
    });
    await awardArenaXpAsync({
      userId: "u-adapted",
      displayName: "Ada",
      arenaGroupId: "g1",
      type: "reduced_mission_validated",
      xp: 50,
      sourceValidationId: "adapted-day",
    });
    await awardArenaXpAsync({
      userId: "u-adapted",
      displayName: "Ada",
      arenaGroupId: "g1",
      type: "workout_completion_delta",
      xp: 50,
      sourceValidationId: "full-validation",
    });
    const retry = await awardArenaXpAsync({
      userId: "u-adapted",
      displayName: "Ada",
      arenaGroupId: "g1",
      type: "workout_completion_delta",
      xp: 50,
      sourceValidationId: "full-validation",
    });

    assert.deepEqual(
      { xpAwarded: retry.xpAwarded, totalXp: retry.totalXp, weeklyXp: retry.weeklyXp, monthlyXp: retry.monthlyXp },
      { xpAwarded: 0, totalXp: 200, weeklyXp: 200, monthlyXp: 200 }
    );
  });
});

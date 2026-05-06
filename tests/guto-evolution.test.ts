import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ARENA_GROUP, getAvatarStage, getIndividualRanking, getNextEvolutionXp } from "../src/arena.js";
import { writeArenaStore } from "../src/arena-store.js";
import { getGutoEvolutionStage, GUTO_EVOLUTION_THRESHOLDS } from "../src/guto-evolution.js";
import { upsertUserAccess, writeUserAccessStoreRaw } from "../src/user-access-store.js";

function resetStores() {
  writeArenaStore({ profiles: {}, events: [] });
  writeUserAccessStoreRaw({ users: {} });
}

beforeEach(() => {
  resetStores();
});

after(() => {
  resetStores();
});

describe("GUTO evolution stages", () => {
  it("keeps the official threshold table stable", () => {
    assert.deepEqual(GUTO_EVOLUTION_THRESHOLDS, [
      { stage: "baby", minXp: 0 },
      { stage: "teen", minXp: 1500 },
      { stage: "adult", minXp: 5000 },
      { stage: "elite", minXp: 12000 },
    ]);
  });

  it("maps XP to canonical stages", () => {
    assert.equal(getGutoEvolutionStage(0), "baby");
    assert.equal(getGutoEvolutionStage(1499), "baby");
    assert.equal(getGutoEvolutionStage(1500), "teen");
    assert.equal(getGutoEvolutionStage(5000), "adult");
    assert.equal(getGutoEvolutionStage(12000), "elite");
  });

  it("never returns the legacy ELIT stage value", () => {
    const stages = [0, 1499, 1500, 5000, 12000, 50000].map(getAvatarStage);
    assert.equal(stages.includes("ELIT" as never), false);
    assert.deepEqual(new Set(stages), new Set(["baby", "teen", "adult", "elite"]));
  });

  it("returns the next official evolution threshold", () => {
    assert.equal(getNextEvolutionXp(0), 1500);
    assert.equal(getNextEvolutionXp(1500), 5000);
    assert.equal(getNextEvolutionXp(5000), 12000);
    assert.equal(getNextEvolutionXp(12000), null);
  });

  it("derives ranking stage from total XP instead of stale stored avatarStage", () => {
    const userId = "evolution-ranking-user";
    upsertUserAccess(userId, {
      role: "student",
      coachId: "coach-test",
      active: true,
      visibleInArena: true,
      archived: false,
      subscriptionStatus: "active",
      subscriptionEndsAt: null,
    });
    writeArenaStore({
      profiles: {
        [userId]: {
          userId,
          displayName: "Will",
          pairName: "GUTO & WILL",
          arenaGroupId: DEFAULT_ARENA_GROUP,
          avatarStage: "baby",
          totalXp: 12000,
          weeklyXp: 100,
          monthlyXp: 100,
          validatedWorkoutsTotal: 1,
          validatedWorkoutsWeek: 1,
          validatedWorkoutsMonth: 1,
          currentStreak: 1,
          lastWorkoutValidatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      events: [],
    });

    const ranking = getIndividualRanking(DEFAULT_ARENA_GROUP);
    assert.equal(ranking.items[0]?.avatarStage, "elite");
    assert.equal(ranking.items[0]?.xp, 12000);
  });
});

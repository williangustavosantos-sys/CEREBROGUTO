import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ARENA_GROUP,
  getGlobalIndividualRanking,
  getIndividualRanking,
  getMonthlyRanking,
  getWeeklyRanking,
} from "../src/arena.js";
import { writeArenaStore, type ArenaProfile } from "../src/arena-store.js";
import { upsertUserAccess, writeUserAccessStoreRaw } from "../src/user-access-store.js";

function resetStores() {
  writeArenaStore({ profiles: {}, events: [] });
  writeUserAccessStoreRaw({ users: {} });
}

function makeProfile(userId: string, arenaGroupId: string, totalXp: number, opts: Partial<ArenaProfile> = {}): ArenaProfile {
  const now = new Date().toISOString();
  return {
    userId,
    displayName: userId.toUpperCase(),
    pairName: `GUTO & ${userId.toUpperCase()}`,
    arenaGroupId,
    avatarStage: "baby",
    totalXp,
    weeklyXp: opts.weeklyXp ?? totalXp,
    monthlyXp: opts.monthlyXp ?? totalXp,
    validatedWorkoutsTotal: opts.validatedWorkoutsTotal ?? Math.floor(totalXp / 100),
    validatedWorkoutsWeek: opts.validatedWorkoutsWeek ?? 1,
    validatedWorkoutsMonth: opts.validatedWorkoutsMonth ?? 1,
    currentStreak: opts.currentStreak ?? 1,
    lastWorkoutValidatedAt: now,
    createdAt: now,
    updatedAt: now,
    ...opts,
  };
}

function seedActiveStudent(userId: string) {
  upsertUserAccess(userId, {
    role: "student",
    coachId: "coach-test",
    active: true,
    visibleInArena: true,
    archived: false,
    subscriptionStatus: "active",
    subscriptionEndsAt: null,
  });
}

beforeEach(() => {
  resetStores();
});

after(() => {
  resetStores();
});

describe("Arena ranking scoping (Times vs global)", () => {
  it("weekly ranking is scoped to the requested team only", () => {
    seedActiveStudent("a-team-a");
    seedActiveStudent("a-team-b");
    writeArenaStore({
      profiles: {
        "a-team-a": makeProfile("a-team-a", "TEAM_A", 500, { weeklyXp: 100 }),
        "a-team-b": makeProfile("a-team-b", "TEAM_B", 800, { weeklyXp: 200 }),
      },
      events: [],
    });

    const teamA = getWeeklyRanking("TEAM_A");
    assert.equal(teamA.items.length, 1);
    assert.equal(teamA.items[0]?.userId, "a-team-a");
  });

  it("monthly ranking is scoped to the requested team only", () => {
    seedActiveStudent("b-team-a");
    seedActiveStudent("b-team-b");
    writeArenaStore({
      profiles: {
        "b-team-a": makeProfile("b-team-a", "TEAM_A", 500, { monthlyXp: 100 }),
        "b-team-b": makeProfile("b-team-b", "TEAM_B", 800, { monthlyXp: 200 }),
      },
      events: [],
    });

    const teamB = getMonthlyRanking("TEAM_B");
    assert.equal(teamB.items.length, 1);
    assert.equal(teamB.items[0]?.userId, "b-team-b");
  });

  it("global individual ranking includes students from every Time", () => {
    seedActiveStudent("c-team-a");
    seedActiveStudent("c-team-b");
    seedActiveStudent("c-default");
    writeArenaStore({
      profiles: {
        "c-team-a": makeProfile("c-team-a", "TEAM_A", 500),
        "c-team-b": makeProfile("c-team-b", "TEAM_B", 1500),
        "c-default": makeProfile("c-default", DEFAULT_ARENA_GROUP, 200),
      },
      events: [],
    });

    const ranking = getGlobalIndividualRanking();
    assert.equal(ranking.arenaGroupId, "global");
    assert.equal(ranking.items.length, 3);
    // Sorted by totalXp desc
    assert.equal(ranking.items[0]?.userId, "c-team-b");
    assert.equal(ranking.items[1]?.userId, "c-team-a");
    assert.equal(ranking.items[2]?.userId, "c-default");
  });

  it("global ranking ignores non-students, archived, and invisible profiles", () => {
    seedActiveStudent("d-visible");
    upsertUserAccess("d-coach", { role: "coach", active: true, visibleInArena: true, archived: false, subscriptionStatus: "active", subscriptionEndsAt: null, coachId: "d-coach" });
    upsertUserAccess("d-archived", { role: "student", active: true, visibleInArena: true, archived: true, subscriptionStatus: "active", subscriptionEndsAt: null, coachId: "coach-x" });
    upsertUserAccess("d-hidden", { role: "student", active: true, visibleInArena: false, archived: false, subscriptionStatus: "active", subscriptionEndsAt: null, coachId: "coach-x" });
    writeArenaStore({
      profiles: {
        "d-visible": makeProfile("d-visible", "TEAM_X", 100),
        "d-coach": makeProfile("d-coach", "TEAM_X", 9999),
        "d-archived": makeProfile("d-archived", "TEAM_X", 9999),
        "d-hidden": makeProfile("d-hidden", "TEAM_X", 9999),
      },
      events: [],
    });

    const ranking = getGlobalIndividualRanking();
    assert.equal(ranking.items.length, 1);
    assert.equal(ranking.items[0]?.userId, "d-visible");
  });

  it("legacy team-scoped getIndividualRanking still works for coach panel", () => {
    seedActiveStudent("e-team-a-1");
    seedActiveStudent("e-team-a-2");
    seedActiveStudent("e-team-b-1");
    writeArenaStore({
      profiles: {
        "e-team-a-1": makeProfile("e-team-a-1", "TEAM_A", 1000),
        "e-team-a-2": makeProfile("e-team-a-2", "TEAM_A", 500),
        "e-team-b-1": makeProfile("e-team-b-1", "TEAM_B", 9999),
      },
      events: [],
    });

    const ranking = getIndividualRanking("TEAM_A");
    assert.equal(ranking.items.length, 2);
    assert.equal(ranking.items[0]?.userId, "e-team-a-1");
    assert.equal(ranking.items[1]?.userId, "e-team-a-2");
  });
});

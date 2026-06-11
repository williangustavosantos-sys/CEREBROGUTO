import "./test-env.js";
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  awardArenaXp,
  getIndividualRanking,
  getMonthlyRanking,
  getMyArenaProfile,
  getWeeklyRanking,
  projectPeriodCounters,
} from "../src/arena.js";
import { writeArenaStore, type ArenaProfile } from "../src/arena-store.js";
import { upsertUserAccess, writeUserAccessStoreRaw } from "../src/user-access-store.js";

// Bug do smoke test (DUDAAA): weeklyXp/monthlyXp têm reset PREGUIÇOSO — só
// zeram dentro de awardArenaXp, na próxima concessão. Sem projeção na leitura,
// o ranking semanal continuava exibindo XP da semana passada após a segunda.
// Estes testes cobrem a regra do ciclo: XP ganho hoje aparece em total/semana/
// mês; na virada de semana o weekly zera, na virada de mês o monthly zera,
// e o total nunca zera.

const GROUP = "g-period-test";

function resetStores() {
  writeArenaStore({ profiles: {}, events: [] });
  writeUserAccessStoreRaw({ users: {} });
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

function makeProfile(userId: string, opts: Partial<ArenaProfile> = {}): ArenaProfile {
  const now = new Date().toISOString();
  return {
    userId,
    displayName: userId.toUpperCase(),
    pairName: `GUTO & ${userId.toUpperCase()}`,
    arenaGroupId: GROUP,
    avatarStage: "baby",
    totalXp: 100,
    weeklyXp: 100,
    monthlyXp: 100,
    validatedWorkoutsTotal: 1,
    validatedWorkoutsWeek: 1,
    validatedWorkoutsMonth: 1,
    currentStreak: 1,
    lastWorkoutValidatedAt: now,
    createdAt: now,
    updatedAt: now,
    ...opts,
  };
}

beforeEach(() => resetStores());
after(() => resetStores());

describe("Arena XP — ganho de hoje aparece em total/semana/mês", () => {
  it("treino validado hoje: total=100, weekly=100, monthly=100 em todas as leituras", () => {
    seedActiveStudent("u-hoje");
    awardArenaXp({ userId: "u-hoje", displayName: "U", arenaGroupId: GROUP, type: "workout_validated", xp: 100 });

    assert.equal(getIndividualRanking(GROUP).items[0]?.xp, 100, "Individual mostra o total");
    assert.equal(getWeeklyRanking(GROUP).items[0]?.xp, 100, "Semana mostra o XP de hoje");
    assert.equal(getMonthlyRanking(GROUP).items[0]?.xp, 100, "Mês mostra o XP de hoje");
    assert.equal(getMyArenaProfile("u-hoje", GROUP)?.weeklyXp, 100);
    assert.equal(getMyArenaProfile("u-hoje", GROUP)?.monthlyXp, 100);
  });
});

describe("Arena XP — virada de período zera a LEITURA sem novo award", () => {
  it("última validação há 7 dias: weekly lê 0, total permanece", () => {
    seedActiveStudent("u-stale");
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    writeArenaStore({
      profiles: { "u-stale": makeProfile("u-stale", { lastWorkoutValidatedAt: lastWeek }) },
      events: [],
    });

    assert.equal(getWeeklyRanking(GROUP).items[0]?.xp, 0, "weekly zera na leitura após a virada");
    assert.equal(
      getWeeklyRanking(GROUP).items[0]?.validatedWorkouts,
      0,
      "contagem semanal de treinos acompanha o reset"
    );
    assert.equal(getIndividualRanking(GROUP).items[0]?.xp, 100, "total nunca zera");
    assert.equal(getMyArenaProfile("u-stale", GROUP)?.weeklyXp, 0, "perfil próprio também projeta");
    assert.equal(getMyArenaProfile("u-stale", GROUP)?.totalXp, 100);
  });

  it("última validação há 60 dias: weekly e monthly leem 0, total permanece", () => {
    seedActiveStudent("u-old");
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    writeArenaStore({
      profiles: { "u-old": makeProfile("u-old", { lastWorkoutValidatedAt: twoMonthsAgo }) },
      events: [],
    });

    assert.equal(getWeeklyRanking(GROUP).items[0]?.xp, 0);
    assert.equal(getMonthlyRanking(GROUP).items[0]?.xp, 0, "monthly zera na leitura após virar o mês");
    assert.equal(getIndividualRanking(GROUP).items[0]?.xp, 100, "total nunca zera");
  });

  it("ranking semanal ordena pela projeção: ativo desta semana passa na frente de XP velho maior", () => {
    seedActiveStudent("u-ativo");
    seedActiveStudent("u-velho");
    const lastWeek = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeArenaStore({
      profiles: {
        "u-velho": makeProfile("u-velho", { totalXp: 500, weeklyXp: 500, lastWorkoutValidatedAt: lastWeek }),
        "u-ativo": makeProfile("u-ativo", { totalXp: 100, weeklyXp: 100 }),
      },
      events: [],
    });

    const weekly = getWeeklyRanking(GROUP);
    assert.equal(weekly.items[0]?.userId, "u-ativo", "quem treinou esta semana lidera");
    assert.equal(weekly.items[0]?.xp, 100);
    assert.equal(weekly.items[1]?.userId, "u-velho");
    assert.equal(weekly.items[1]?.xp, 0, "XP da semana passada não vaza para esta semana");
  });
});

describe("projectPeriodCounters — fronteiras determinísticas", () => {
  const base = {
    weeklyXp: 100,
    monthlyXp: 100,
    validatedWorkoutsWeek: 2,
    validatedWorkoutsMonth: 4,
  };

  it("mesma semana: nada muda", () => {
    // Tue 2026-06-09 → Thu 2026-06-11 (mesma semana, segunda-based)
    const p = projectPeriodCounters(
      { ...base, lastWorkoutValidatedAt: new Date(2026, 5, 9, 10).toISOString() },
      new Date(2026, 5, 11, 10)
    );
    assert.deepEqual(p, base);
  });

  it("virou a semana mas não o mês: weekly zera, monthly persiste", () => {
    // Fri 2026-06-05 → Thu 2026-06-11 (semana de 08/06; mesmo junho)
    const p = projectPeriodCounters(
      { ...base, lastWorkoutValidatedAt: new Date(2026, 5, 5, 10).toISOString() },
      new Date(2026, 5, 11, 10)
    );
    assert.equal(p.weeklyXp, 0);
    assert.equal(p.validatedWorkoutsWeek, 0);
    assert.equal(p.monthlyXp, 100, "monthly persiste dentro do mesmo mês");
    assert.equal(p.validatedWorkoutsMonth, 4);
  });

  it("virou o mês dentro da mesma semana (29/12/2025 → 02/01/2026): monthly zera, weekly persiste", () => {
    const p = projectPeriodCounters(
      { ...base, lastWorkoutValidatedAt: new Date(2025, 11, 29, 10).toISOString() },
      new Date(2026, 0, 2, 10)
    );
    assert.equal(p.weeklyXp, 100, "mesma semana segunda-based atravessa o ano");
    assert.equal(p.monthlyXp, 0);
  });

  it("sem âncora (lastWorkoutValidatedAt null): contadores ficam como estão", () => {
    const p = projectPeriodCounters({ ...base, lastWorkoutValidatedAt: null });
    assert.deepEqual(p, base);
  });
});

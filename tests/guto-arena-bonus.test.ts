import "./test-env.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { awardArenaXp } from "../src/arena.js";
import { writeArenaStore, getArenaProfile, migrateArenaStoreToCurrentSchema } from "../src/arena-store.js";

// Regra fundadora vigente: o bônus do Pacto vale 100 nos três placares, sem
// fingir presença de treino. Arena, painel e Evoluir leem o mesmo estado.

describe("Arena XP — bônus do Pacto vale nos três placares sem criar presença", () => {
  beforeEach(() => writeArenaStore({ profiles: {}, events: [] }));

  it("bônus do pacto credita weekly, monthly e individual em 100", () => {
    const r = awardArenaXp({ userId: "u-bonus", displayName: "U", arenaGroupId: "g", type: "bonus", xp: 100 });
    assert.equal(r.totalXp, 100, "Individual recebe o pacto");
    assert.equal(r.weeklyXp, 100, "Semana recebe o bônus do pacto");
    assert.equal(r.monthlyXp, 100, "Mês recebe o bônus do pacto");
    const p = getArenaProfile("u-bonus");
    assert.equal(p?.currentStreak ?? 0, 0, "pacto não gera streak (streak é presença de treino)");
    assert.equal(p?.validatedWorkoutsTotal ?? 0, 0, "pacto não conta como treino validado");
    assert.equal(p?.lastWorkoutValidatedAt ?? null, null, "pacto não marca validação de treino");
    assert.ok(p?.lastXpAt, "pacto marca a âncora genérica de XP (dirige o reset do período)");
  });

  it("workout_validated conta no período e gera streak", () => {
    const r = awardArenaXp({ userId: "u-val", displayName: "U", arenaGroupId: "g", type: "workout_validated", xp: 100 });
    assert.equal(r.weeklyXp, 100, "validação conta no weekly");
    assert.equal(r.monthlyXp, 100, "validação conta no monthly");
    assert.equal(getArenaProfile("u-val")?.currentStreak, 1, "validação gera streak");
  });

  it("bônus + validação: os três placares somam ambos", () => {
    awardArenaXp({ userId: "u-mix", displayName: "U", arenaGroupId: "g", type: "bonus", xp: 100 });
    const r = awardArenaXp({ userId: "u-mix", displayName: "U", arenaGroupId: "g", type: "workout_validated", xp: 100 });
    assert.equal(r.totalXp, 200, "total = bônus + validação");
    assert.equal(r.weeklyXp, 200, "weekly = bônus + validação");
    assert.equal(r.monthlyXp, 200, "monthly = bônus + validação");
    assert.equal(getArenaProfile("u-mix")?.validatedWorkoutsTotal, 1, "só a validação conta como treino");
  });

  it("penalidade por falta (miss_penalty) entra no período e zera a streak", () => {
    awardArenaXp({ userId: "u-pen", displayName: "U", arenaGroupId: "g", type: "workout_validated", xp: 100 });
    const r = awardArenaXp({ userId: "u-pen", displayName: "U", arenaGroupId: "g", type: "miss_penalty", xp: -20 });
    assert.equal(r.totalXp, 80, "penalidade desconta do total");
    assert.equal(r.weeklyXp, 80, "penalidade desconta do weekly");
    assert.equal(r.monthlyXp, 80, "penalidade desconta do monthly");
    assert.equal(getArenaProfile("u-pen")?.currentStreak, 0, "faltar quebra a sequência");
  });

  it("migração v3 repõe o bônus removido pelo schema v2 e é idempotente", () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const store = {
      profiles: {
        legacy: {
          userId: "legacy", displayName: "Legacy", pairName: "GUTO & LEGACY", arenaGroupId: "g",
          avatarStage: "baby" as const, totalXp: 150, weeklyXp: 50, monthlyXp: 50,
          validatedWorkoutsTotal: 1, validatedWorkoutsWeek: 1, validatedWorkoutsMonth: 1,
          currentStreak: 1, lastWorkoutValidatedAt: "2026-07-18T10:00:00.000Z",
          lastXpAt: "2026-07-18T10:00:00.000Z", createdAt: now.toISOString(), updatedAt: now.toISOString(),
        },
      },
      schemaVersion: 2,
      events: [
        { id: "pact", userId: "legacy", arenaGroupId: "g", type: "bonus" as const, xp: 100, createdAt: "2026-07-16T10:00:00.000Z" },
        { id: "training", userId: "legacy", arenaGroupId: "g", type: "workout_validated" as const, xp: 50, createdAt: "2026-07-18T10:00:00.000Z" },
      ],
    };

    const migrated = migrateArenaStoreToCurrentSchema(store, now);
    assert.equal(migrated.profiles.legacy.weeklyXp, 150);
    assert.equal(migrated.profiles.legacy.monthlyXp, 150);
    assert.equal(migrated.profiles.legacy.totalXp, 150);
    assert.equal(migrateArenaStoreToCurrentSchema(migrated, now).profiles.legacy.weeklyXp, 150);
  });
});

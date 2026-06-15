import "./test-env.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { awardArenaXp } from "../src/arena.js";
import { writeArenaStore, getArenaProfile } from "../src/arena-store.js";

// REGRA DE PRODUTO ATUAL (revisão do fundador — substitui AR-5/X-4):
// TODO XP ganho aparece em Semana, Mês e Individual. A única diferença entre as
// superfícies é o RESET (semana zera na virada da semana, mês na virada do mês,
// individual/geral nunca zera). O pacto (type "bonus") NÃO pode mais mostrar 100
// no Individual e 0 na Semana/Mês — isso era o bug reportado em uso real.
// O que CONTINUA atrelado ao treino (não ao XP): contagem de treinos validados e
// streak. Pacto não vira treino validado nem sequência.

describe("Arena XP — XP ganho aparece em TODAS as superfícies; só o reset difere", () => {
  beforeEach(() => writeArenaStore({ profiles: {}, events: [] }));

  it("bônus do pacto credita total E weekly E monthly (mesma regra, reset diferente)", () => {
    const r = awardArenaXp({ userId: "u-bonus", displayName: "U", arenaGroupId: "g", type: "bonus", xp: 100 });
    assert.equal(r.totalXp, 100, "Individual recebe o pacto");
    assert.equal(r.weeklyXp, 100, "Semana também recebe o pacto (não pode ser 0)");
    assert.equal(r.monthlyXp, 100, "Mês também recebe o pacto (não pode ser 0)");
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

  it("bônus + validação: total/weekly/monthly somam os dois; 1 treino validado", () => {
    awardArenaXp({ userId: "u-mix", displayName: "U", arenaGroupId: "g", type: "bonus", xp: 100 });
    const r = awardArenaXp({ userId: "u-mix", displayName: "U", arenaGroupId: "g", type: "workout_validated", xp: 100 });
    assert.equal(r.totalXp, 200, "total = bônus + validação");
    assert.equal(r.weeklyXp, 200, "weekly = bônus + validação (pacto não é mais excluído)");
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
});

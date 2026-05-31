import "./test-env.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { awardArenaXp } from "../src/arena.js";
import { writeArenaStore, getArenaProfile } from "../src/arena-store.js";

// Regressão: o bônus do Pacto (type "bonus") é um buffer SÓ de totalXp.
// NÃO pode inflar weekly/monthly (AR-5) nem gerar streak (X-4). Era o que fazia
// a Arena (e o painel admin, que lê o mesmo arena profile) mostrar 100 XP
// semanal num usuário com 0 treinos validados, divergindo de Evoluir/Percurso.

describe("Arena XP — bônus do Pacto não infla período nem streak (AR-5/X-4)", () => {
  beforeEach(() => writeArenaStore({ profiles: {}, events: [] }));

  it("bonus credita só totalXp; weekly/monthly = 0 e sem streak", () => {
    const r = awardArenaXp({ userId: "u-bonus", displayName: "U", arenaGroupId: "g", type: "bonus", xp: 100 });
    assert.equal(r.totalXp, 100, "totalXp recebe o bônus");
    assert.equal(r.weeklyXp, 0, "weekly NÃO recebe o bônus (AR-5)");
    assert.equal(r.monthlyXp, 0, "monthly NÃO recebe o bônus (AR-5)");
    const p = getArenaProfile("u-bonus");
    assert.equal(p?.currentStreak ?? 0, 0, "bônus não gera streak (X-4)");
    assert.equal(p?.lastWorkoutValidatedAt ?? null, null, "bônus não marca validação");
  });

  it("workout_validated conta no período e gera streak", () => {
    const r = awardArenaXp({ userId: "u-val", displayName: "U", arenaGroupId: "g", type: "workout_validated", xp: 100 });
    assert.equal(r.weeklyXp, 100, "validação conta no weekly");
    assert.equal(r.monthlyXp, 100, "validação conta no monthly");
    assert.equal(getArenaProfile("u-val")?.currentStreak, 1, "validação gera streak");
  });

  it("bônus + validação: total=200, weekly=100 (só a validação)", () => {
    awardArenaXp({ userId: "u-mix", displayName: "U", arenaGroupId: "g", type: "bonus", xp: 100 });
    const r = awardArenaXp({ userId: "u-mix", displayName: "U", arenaGroupId: "g", type: "workout_validated", xp: 100 });
    assert.equal(r.totalXp, 200, "total = bônus + validação");
    assert.equal(r.weeklyXp, 100, "weekly = só a validação (bônus excluído)");
  });
});

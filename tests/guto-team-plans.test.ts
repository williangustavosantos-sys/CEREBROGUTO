import { test } from "node:test";
import assert from "node:assert";
import { GUTO_TEAM_PLAN_LIMITS } from "../src/team-plans.js";
import { getTeam, GUTO_CORE_TEAM_ID } from "../src/team-store.js";
import { upsertUserAccess, getEffectiveUserAccess, deleteUserAccessHard, getAllUserAccess } from "../src/user-access-store.js";

test("GUTO Time Plans exist and have correct limits", () => {
    assert.strictEqual(GUTO_TEAM_PLAN_LIMITS.start.maxCoaches, 2);
    assert.strictEqual(GUTO_TEAM_PLAN_LIMITS.start.maxStudents, 20);

    assert.strictEqual(GUTO_TEAM_PLAN_LIMITS.pro.maxCoaches, 4);
    assert.strictEqual(GUTO_TEAM_PLAN_LIMITS.pro.maxStudents, 50);

    assert.strictEqual(GUTO_TEAM_PLAN_LIMITS.elite.maxCoaches, 6);
    assert.strictEqual(GUTO_TEAM_PLAN_LIMITS.elite.maxStudents, 70);

    assert.strictEqual(GUTO_TEAM_PLAN_LIMITS.custom.maxCoaches, null);
    assert.strictEqual(GUTO_TEAM_PLAN_LIMITS.custom.maxStudents, null);
});

test("Default GUTO_CORE team exists", () => {
    const coreTeam = getTeam(GUTO_CORE_TEAM_ID);
    assert.ok(coreTeam, "GUTO_CORE team should exist");
    assert.strictEqual(coreTeam.id, "GUTO_CORE");
    assert.strictEqual(coreTeam.plan, "custom");
    assert.strictEqual(coreTeam.status, "active");
});

test("UserAccess fallback to GUTO_CORE and keeps explicit teamId", () => {
    const userId = "test-team-user";
    const userId2 = "test-team-user-explicit";

    deleteUserAccessHard(userId);
    deleteUserAccessHard(userId2);

    // 1. Cadastra usuário antigo sem teamId e atesta se phone não quebra e teamId preenche GUTO_CORE
    upsertUserAccess(userId, { role: "student", phone: "+551199999999" });
    // 2. Cadastra novo membro de Time com teamId explícito
    upsertUserAccess(userId2, { role: "coach", teamId: "custom-team" });

    const access1 = getEffectiveUserAccess(userId);
    assert.ok(access1, "User should exist");
    assert.strictEqual(access1.teamId, "GUTO_CORE", "Missing teamId should fallback to GUTO_CORE");
    assert.strictEqual(access1.phone, "+551199999999", "Phone should be updatable and readable");

    const access2 = getEffectiveUserAccess(userId2);
    assert.ok(access2, "User 2 should exist");
    assert.strictEqual(access2.teamId, "custom-team", "Explicit teamId should be kept");

    // 3. Testa se getAllUserAccess também normaliza o fallback
    const allUsers = getAllUserAccess();
    const fetched1 = allUsers.find(u => u.userId === userId);
    const fetched2 = allUsers.find(u => u.userId === userId2);
    assert.strictEqual(fetched1?.teamId, "GUTO_CORE", "getAllUserAccess should inject GUTO_CORE");
    assert.strictEqual(fetched2?.teamId, "custom-team", "getAllUserAccess should respect explicit teamId");

    // 4. Testa se o Upsert de um registro existente não apaga o teamId
    upsertUserAccess(userId2, { active: true });
    const access2AfterUpdate = getEffectiveUserAccess(userId2);
    assert.strictEqual(access2AfterUpdate?.teamId, "custom-team", "upsert should not wipe existing teamId");

    deleteUserAccessHard(userId);
    deleteUserAccessHard(userId2);
});
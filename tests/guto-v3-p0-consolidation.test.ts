import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionAdaptation } from "../src/v3/session-workout.js";
import { resolveDeclaredOperationalFacts } from "../src/v3/facts.js";
import { conflictsWithFoodDeclaration } from "../src/v3/food-declaration-policy.js";
import { provisionV3CredentialOnClient } from "../src/v3/panel-provisioning.js";
import { deriveV3Identity } from "../src/v3/legacy-identity.js";

const fakeClient = (rows: Array<Record<string, unknown>>) => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("SELECT password_hash,tenant_id,user_id,identity_id")) return { rows };
      return { rows: [] };
    },
  };
};

test("P0 session authority recognizes natural PT/EN/IT location and time phrases", () => {
  const cases: Array<[string, { effectiveLocation?: string; availableMinutes?: number }]> = [
    ["Hoje vou treinar em casa", { effectiveLocation: "home" }],
    ["Vou treinar em casa hoje", { effectiveLocation: "home" }],
    ["Estou em casa hoje, bora treinar", { effectiveLocation: "home" }],
    ["Hoje só tenho 20 minutos", { availableMinutes: 20 }],
    ["Só 15 min hoje, bora rápido", { availableMinutes: 15 }],
    ["20 minutos é tudo que eu tenho hoje", { availableMinutes: 20 }],
    ["Today I will workout at home", { effectiveLocation: "home" }],
    ["Solo 20 minuti oggi, allenamento rapido", { availableMinutes: 20 }],
  ];
  for (const [message, expected] of cases) {
    assert.deepEqual(resolveSessionAdaptation(message), expected, message);
  }
});

test("P0 pain routing detects doendo/dolore/hurting with body region", () => {
  for (const message of [
    "Está doendo minha lombar",
    "La schiena bassa sta facendo male",
    "My lower back is hurting",
  ]) {
    const facts = resolveDeclaredOperationalFacts(message);
    assert.ok(facts.some((fact) => fact.factType === "PHYSICAL_CONSTRAINT"), message);
  }
});

test("P0 food exclusions remain cumulative and block candidates", () => {
  const declaration = "Não como maçã. Também não como banana.";
  assert.equal(conflictsWithFoodDeclaration("apple", declaration), true);
  assert.equal(conflictsWithFoodDeclaration("banana", declaration), true);
});

test("P0 provisioning collision fails closed before credential update", async () => {
  const derivedB = deriveV3Identity("user-b", "team-b");
  const client = fakeClient([{
    password_hash: "old-hash",
    tenant_id: derivedB.tenantId,
    user_id: deriveV3Identity("user-a", "team-a").userId,
    identity_id: deriveV3Identity("user-a", "team-a").identityId,
  }]);
  await assert.rejects(() => provisionV3CredentialOnClient(client as never, {
    userId: "user-b",
    email: "same@example.com",
    passwordHash: "new-hash",
    teamId: "team-b",
  }), /another V3 identity/);
  assert.equal(client.calls.filter((call) => call.sql.startsWith("UPDATE guto_v3.auth_credentials")).length, 0);
});

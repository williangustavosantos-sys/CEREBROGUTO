import "./test-env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type pg from "pg";
import { V3Error } from "../src/v3/errors.js";
import { PostgresOfficialStateRepository } from "../src/v3/postgres.js";

class HealthClient {
  readonly calls: string[] = [];

  constructor(private readonly sessionUser: string) {}

  async query(sql: string): Promise<any> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.calls.push(normalized);
    if (normalized === "SELECT session_user AS session_user") {
      return { rows: [{ session_user: this.sessionUser }], rowCount: 1 };
    }
    if (normalized === "SELECT current_user AS active_role") {
      return { rows: [{ active_role: "guto_v3_app" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

function fakePool(client: HealthClient): pg.Pool {
  return { connect: async () => client } as unknown as pg.Pool;
}

async function withStrictRuntimeRole<T>(fn: () => Promise<T>): Promise<T> {
  const previousOnly = process.env.GUTO_V3_ONLY;
  const previousRole = process.env.GUTO_V3_RUNTIME_DB_ROLE;
  process.env.GUTO_V3_ONLY = "true";
  process.env.GUTO_V3_RUNTIME_DB_ROLE = "guto_v3_runtime";
  try {
    return await fn();
  } finally {
    if (previousOnly === undefined) delete process.env.GUTO_V3_ONLY;
    else process.env.GUTO_V3_ONLY = previousOnly;
    if (previousRole === undefined) delete process.env.GUTO_V3_RUNTIME_DB_ROLE;
    else process.env.GUTO_V3_RUNTIME_DB_ROLE = previousRole;
  }
}

test("PostgreSQL V3 health proves the restricted runtime and app-role table access", async () => {
  await withStrictRuntimeRole(async () => {
    const client = new HealthClient("guto_v3_runtime");
    const health = await new PostgresOfficialStateRepository(fakePool(client)).health();

    assert.equal(health.ok, true);
    assert.equal(health.sessionUser, "guto_v3_runtime");
    assert.equal(health.activeRole, "guto_v3_app");
    assert.ok(client.calls.indexOf("SET LOCAL ROLE guto_v3_app") > client.calls.indexOf("SELECT session_user AS session_user"));
    for (const table of ["users", "user_journey_state", "user_profile", "workout_plans", "diet_plans", "conversation_threads", "first_contact_state", "confirmed_user_contexts"]) {
      assert.ok(client.calls.includes(`SELECT 1 FROM guto_v3.${table} LIMIT 0`));
    }
    assert.equal(client.calls.at(-1), "COMMIT");
  });
});

test("PostgreSQL V3 health rejects an admin session before assuming the app role", async () => {
  await withStrictRuntimeRole(async () => {
    const client = new HealthClient("postgres");
    const repository = new PostgresOfficialStateRepository(fakePool(client));

    await assert.rejects(
      repository.health(),
      (error: unknown) => error instanceof V3Error && error.code === "V3_DATABASE_RUNTIME_ROLE_REQUIRED" && error.status === 503,
    );
    assert.equal(client.calls.includes("SET LOCAL ROLE guto_v3_app"), false);
    assert.equal(client.calls.at(-1), "ROLLBACK");
  });
});

test("V3 readiness explicitly requires and reports isolated V3-only mode", () => {
  const router = readFileSync(new URL("../src/v3/router.ts", import.meta.url), "utf8");
  assert.match(router, /v3Only: v3OnlyEnabled\(\)/);
  assert.match(router, /v3Only: configured\.v3Only/);
  assert.match(router, /Object\.values\(configured\)\.every\(Boolean\)/);
});

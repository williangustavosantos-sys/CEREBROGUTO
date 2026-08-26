import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcrypt";
import type pg from "pg";
import { bootstrapV3AuthCredential } from "../src/v3/postgres-auth.js";

type QueryCall = { sql: string; values: unknown[] };

class ExistingCredentialClient {
  readonly calls: QueryCall[] = [];

  constructor(private readonly credential: {
    tenant_id: string;
    user_id: string;
    identity_id: string;
    login_identifier: string;
    password_hash: string;
    role: "student" | "coach" | "admin" | "super_admin";
    status: "active" | "disabled" | "locked";
    credential_version: number;
    failed_attempts: number;
    locked_until: string | null;
  }) {}

  async query(sql: string, values: unknown[] = []): Promise<any> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.calls.push({ sql: normalized, values });
    if (normalized.startsWith("INSERT INTO guto_v3.tenants")) {
      return { rows: [{ id: this.credential.tenant_id }], rowCount: 1 };
    }
    if (normalized.includes("FROM guto_v3.auth_credentials WHERE login_identifier=$1")) {
      return { rows: [this.credential], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE guto_v3.auth_credentials")) {
      const authorityChanged = values[3] === true;
      return {
        rows: [{ credential_version: this.credential.credential_version + (authorityChanged ? 1 : 0) }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: normalized.startsWith("UPDATE") ? 1 : null };
  }

  release(): void {}
}

function fakePool(client: ExistingCredentialClient): pg.Pool {
  return { connect: async () => client } as unknown as pg.Pool;
}

async function existingCredential(overrides: Partial<ConstructorParameters<typeof ExistingCredentialClient>[0]> = {}) {
  return {
    tenant_id: "10000000-0000-4000-8000-000000000001",
    user_id: "20000000-0000-4000-8000-000000000001",
    identity_id: "30000000-0000-4000-8000-000000000001",
    login_identifier: "founder@example.com",
    password_hash: await bcrypt.hash("senha-preview", 4),
    role: "student" as const,
    status: "active" as const,
    credential_version: 7,
    failed_attempts: 5,
    locked_until: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

test("V3 bootstrap unlocks an existing Preview credential without rotating an unchanged authority", async () => {
  const client = new ExistingCredentialClient(await existingCredential());
  const result = await bootstrapV3AuthCredential(fakePool(client), {
    tenantSlug: "guto-v3-preview",
    tenantName: "GUTO Cérebro V3 Preview",
    loginIdentifier: "founder@example.com",
    password: "senha-preview",
    role: "student",
    status: "active",
  });

  assert.equal(result.created, false);
  assert.equal(result.credentialVersion, 7);
  const update = client.calls.find((call) => call.sql.startsWith("UPDATE guto_v3.auth_credentials"));
  assert.ok(update);
  assert.equal(update.values[3], false);
  assert.match(update.sql, /failed_attempts=0,locked_until=NULL/);
  assert.equal(client.calls.some((call) => call.sql.startsWith("UPDATE guto_v3.auth_sessions")), false);
});

test("V3 bootstrap versions authority changes, revokes sessions and replaces an explicit display name", async () => {
  const client = new ExistingCredentialClient(await existingCredential({ role: "coach", status: "disabled" }));
  const result = await bootstrapV3AuthCredential(fakePool(client), {
    tenantSlug: "guto-v3-preview",
    tenantName: "GUTO Cérebro V3 Preview",
    loginIdentifier: "founder@example.com",
    password: "senha-preview",
    displayName: "Fundador V3 A",
    role: "student",
    status: "active",
  });

  assert.equal(result.credentialVersion, 8);
  const update = client.calls.find((call) => call.sql.startsWith("UPDATE guto_v3.auth_credentials"));
  assert.ok(update);
  assert.deepEqual(update.values.slice(1, 4), ["student", "active", true]);
  assert.ok(client.calls.some((call) =>
    call.sql.startsWith("UPDATE guto_v3.auth_sessions") && call.sql.includes("bootstrap_authority_changed")));
  const displayUpdate = client.calls.find((call) => call.sql.startsWith("UPDATE guto_v3.users"));
  assert.ok(displayUpdate);
  assert.match(displayUpdate.sql, /SET display_name=\$1/);
  assert.doesNotMatch(displayUpdate.sql, /COALESCE/);
});

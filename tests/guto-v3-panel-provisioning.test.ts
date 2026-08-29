import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { deriveV3Identity } from "../src/v3/legacy-identity.js";
import {
  provisionV3CredentialForStudent,
  provisionV3CredentialOnClient,
} from "../src/v3/panel-provisioning.js";
import { isV3AdministrativePanelPath } from "../src/v3/router.js";

type QueryCall = { sql: string; values: unknown[] };

class RecordingClient {
  readonly calls: QueryCall[] = [];

  constructor(private readonly existingHash: string | null) {}

  async query(sql: string, values: unknown[] = []): Promise<any> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.calls.push({ sql: normalized, values });
    if (normalized.includes("FROM guto_v3.auth_credentials") && normalized.includes("login_identifier=$1")) {
      return this.existingHash
        ? { rows: [{
            password_hash: this.existingHash,
            tenant_id: "0662ab60-eb32-4d59-b008-49b1daabefea",
            user_id: "26495df3-5002-49f5-8f26-57b5f2ce4479",
            identity_id: "26bddbf3-0ce4-4b7a-b0a7-3685749cd3ae",
          }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  }

  release(): void {}
}

function fakePool(client: RecordingClient): pg.Pool {
  return { connect: async () => client } as unknown as pg.Pool;
}

const HASH = "$2b$10$abcdefghijklmnopqrstuvwxyzABCDEF";

test("deriveV3Identity é determinístico e espelha o esquema da migração legada", () => {
  const derived = deriveV3Identity("G-JOAO-SILVA", "GUTO_CORE");
  assert.equal(derived.externalSubject, "G-JOAO-SILVA");
  assert.equal(derived.tenantSlug, "GUTO_CORE");
  assert.equal(derived.tenantId, "0662ab60-eb32-4d59-b008-49b1daabefea");
  assert.equal(derived.identityId, "26bddbf3-0ce4-4b7a-b0a7-3685749cd3ae");
  assert.equal(derived.userId, "26495df3-5002-49f5-8f26-57b5f2ce4479");
});

test("deriveV3Identity usa 'guto-core' quando teamId está ausente", () => {
  const derived = deriveV3Identity("u-abc", null);
  assert.equal(derived.tenantSlug, "guto-core");
  assert.equal(derived.externalSubject, "u-abc");
});

test("provisiona credencial nova de aluno do painel no Postgres V3", async () => {
  const client = new RecordingClient(null);
  const result = await provisionV3CredentialOnClient(client as unknown as pg.PoolClient, {
    userId: "G-JOAO-SILVA",
    email: "joao@example.com",
    passwordHash: HASH,
    displayName: "João Silva",
    teamId: "GUTO_CORE",
  });
  assert.equal(result.created, true);

  const tenantInsert = client.calls.find((call) => call.sql.startsWith("INSERT INTO guto_v3.tenants"));
  assert.ok(tenantInsert);
  assert.equal(tenantInsert.values[0], "0662ab60-eb32-4d59-b008-49b1daabefea");
  assert.equal(tenantInsert.values[1], "GUTO_CORE");

  const identityInsert = client.calls.find((call) => call.sql.startsWith("INSERT INTO guto_v3.identities"));
  assert.ok(identityInsert);
  assert.equal(identityInsert.values[2], "G-JOAO-SILVA"); // external_subject = userId legado

  const userInsert = client.calls.find((call) => call.sql.startsWith("INSERT INTO guto_v3.users"));
  assert.ok(userInsert);
  assert.equal(userInsert.values[0], "26495df3-5002-49f5-8f26-57b5f2ce4479");
  assert.equal(userInsert.values[1], "0662ab60-eb32-4d59-b008-49b1daabefea");

  const credentialInsert = client.calls.find((call) => call.sql.startsWith("INSERT INTO guto_v3.auth_credentials"));
  assert.ok(credentialInsert);
  assert.equal(credentialInsert.values[3], "joao@example.com"); // login_identifier = email
  assert.equal(credentialInsert.values[4], HASH);
  assert.match(credentialInsert.sql, /'student'/);
  assert.match(credentialInsert.sql, /'active'/);
});

test("não rotaciona credencial nem revoga sessões quando a senha não muda", async () => {
  const client = new RecordingClient(HASH);
  const result = await provisionV3CredentialOnClient(client as unknown as pg.PoolClient, {
    userId: "G-JOAO-SILVA",
    email: "joao@example.com",
    passwordHash: HASH,
    teamId: "GUTO_CORE",
  });
  assert.equal(result.created, false);
  const update = client.calls.find((call) => call.sql.startsWith("UPDATE guto_v3.auth_credentials"));
  assert.ok(update);
  assert.equal(update.values[1], false); // authorityChanged = false
  assert.equal(client.calls.some((call) => call.sql.startsWith("UPDATE guto_v3.auth_sessions")), false);
});

test("rotaciona credencial e revoga sessões quando a senha muda", async () => {
  const client = new RecordingClient("$2b$10$outra.senha.completamente.diferente");
  const result = await provisionV3CredentialOnClient(client as unknown as pg.PoolClient, {
    userId: "G-JOAO-SILVA",
    email: "joao@example.com",
    passwordHash: HASH,
    teamId: "GUTO_CORE",
  });
  assert.equal(result.created, false);
  const update = client.calls.find((call) => call.sql.startsWith("UPDATE guto_v3.auth_credentials"));
  assert.ok(update);
  assert.equal(update.values[1], true); // authorityChanged = true
  assert.ok(client.calls.some((call) =>
    call.sql.startsWith("UPDATE guto_v3.auth_sessions") && call.sql.includes("panel_authority_changed")));
});

test("wrapper é no-op quando o V3 não está habilitado", async () => {
  const previous = process.env.GUTO_V3_ENABLED;
  process.env.GUTO_V3_ENABLED = "false";
  try {
    const result = await provisionV3CredentialForStudent({
      userId: "G-JOAO-SILVA",
      email: "joao@example.com",
      passwordHash: HASH,
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, false);
    assert.equal(result.skippedReason, "v3_disabled");
  } finally {
    if (previous === undefined) delete process.env.GUTO_V3_ENABLED;
    else process.env.GUTO_V3_ENABLED = previous;
  }
});

test("painel administrativo é uma exceção explícita e nunca abre rotas do Companion", () => {
  const previous = process.env.GUTO_V3_PANEL_ENABLED;
  process.env.GUTO_V3_PANEL_ENABLED = "true";
  try {
    assert.equal(isV3AdministrativePanelPath("/admin/students"), true);
    assert.equal(isV3AdministrativePanelPath("/auth/admin/login"), true);
    assert.equal(isV3AdministrativePanelPath("/guto/memory"), false);
    assert.equal(isV3AdministrativePanelPath("/auth/user/login"), false);
  } finally {
    if (previous === undefined) delete process.env.GUTO_V3_PANEL_ENABLED;
    else process.env.GUTO_V3_PANEL_ENABLED = previous;
  }
});

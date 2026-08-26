import "dotenv/config";
import "../src/v3/observability/instrumentation.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { createV3Genkit, GeminiInteractionsDecisionModel } from "../src/v3/ai.js";
import { readV3AuthConfigFromEnvironment, V3AuthService, type V3AuthResult } from "../src/v3/auth.js";
import { ConservativeCatalogCandidateProviderV3 } from "../src/v3/candidate-provider.js";
import { GutoContextBuilderV3 } from "../src/v3/context-builder.js";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import { InngestDurableEventPublisher } from "../src/v3/durable-events.js";
import { V3Error } from "../src/v3/errors.js";
import { createGutoTurnFlow } from "../src/v3/flow.js";
import { shutdownV3Telemetry } from "../src/v3/observability/instrumentation.js";
import { withV3Span, withV3Trace } from "../src/v3/observability/tracing.js";
import { RedisV3OperationalState } from "../src/v3/operational-state.js";
import { bootstrapV3AuthCredential, PostgresV3AuthStore } from "../src/v3/postgres-auth.js";
import { PostgresOfficialStateRepository, createV3Pool } from "../src/v3/postgres.js";
import { Mem0RelationshipMemoryStore } from "../src/v3/relationship-memory.js";
import type { ActiveContext, ActorContext } from "../src/v3/types.js";

function requiredValue(name: string, preserveWhitespace = false): string {
  const raw = process.env[name] || "";
  if (!raw.trim()) throw new Error(`Missing required V3 integration variable: ${name}`);
  return preserveWhitespace ? raw : raw.trim();
}

function parseDatabaseAuthority(name: "DATABASE_URL" | "GUTO_V3_ADMIN_DATABASE_URL"): {
  connectionString: string;
  role: string;
  projectRef?: string;
  database: string;
} {
  const connectionString = requiredValue(name);
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`${name} is not a valid PostgreSQL URL.`);
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.username || !parsed.password) {
    throw new Error(`${name} must contain an explicit PostgreSQL role and secret.`);
  }
  const username = decodeURIComponent(parsed.username).toLowerCase();
  const role = username.split(".")[0] || "";
  const usernameProjectRef = username.includes(".") ? username.split(".").at(-1) : undefined;
  const hostLabels = parsed.hostname.toLowerCase().split(".");
  const hostProjectRef = hostLabels[0] === "db" ? hostLabels[1] : undefined;
  const projectRef = [usernameProjectRef, hostProjectRef]
    .find((value) => Boolean(value && /^[a-z0-9]{10,40}$/.test(value)));
  return { connectionString, role, projectRef, database: parsed.pathname || "/" };
}

function assertSeparatedDatabaseAuthorities(
  runtime: ReturnType<typeof parseDatabaseAuthority>,
  admin: ReturnType<typeof parseDatabaseAuthority>,
  expectedProjectRef: string,
): void {
  const expectedRuntimeRole = process.env.GUTO_V3_RUNTIME_DB_ROLE || "guto_v3_runtime";
  if (expectedRuntimeRole !== "guto_v3_runtime" || runtime.role !== expectedRuntimeRole) {
    throw new Error("DATABASE_URL must authenticate as the restricted guto_v3_runtime role.");
  }
  if (admin.role === expectedRuntimeRole) {
    throw new Error("GUTO_V3_ADMIN_DATABASE_URL must not reuse the runtime role.");
  }
  if (runtime.connectionString === admin.connectionString) {
    throw new Error("Runtime and admin PostgreSQL URLs must be distinct.");
  }
  if (runtime.projectRef !== expectedProjectRef || admin.projectRef !== expectedProjectRef) {
    throw new Error("Runtime and admin PostgreSQL URLs must target the isolated Preview project.");
  }
  if (runtime.database !== admin.database) {
    throw new Error("Runtime and admin PostgreSQL URLs must target the same database.");
  }
}

function projectRefFromSupabaseUrl(value: string): string {
  let hostname = "";
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    throw new Error("SUPABASE_URL is not valid for the V3 integration verifier.");
  }
  const projectRef = hostname.split(".")[0] || "";
  if (!/^[a-z0-9]{10,40}$/.test(projectRef)) {
    throw new Error("SUPABASE_URL does not identify an isolated Supabase project.");
  }
  return projectRef;
}

const required = [
  "DATABASE_URL",
  "GUTO_V3_ADMIN_DATABASE_URL",
  "SUPABASE_URL",
  "GEMINI_API_KEY",
  "MEM0_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "GUTO_V3_JWT_SECRET",
  "GUTO_V3_VERIFY_USER_A_EMAIL",
  "GUTO_V3_VERIFY_USER_A_PASSWORD",
  "GUTO_V3_VERIFY_USER_B_EMAIL",
  "GUTO_V3_VERIFY_USER_B_PASSWORD",
] as const;

const missing: string[] = required.filter((name) => !process.env[name]);
if (!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)) missing.push("UPSTASH_REDIS_REST_URL|KV_REST_API_URL");
if (!(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)) missing.push("UPSTASH_REDIS_REST_TOKEN|KV_REST_API_TOKEN");
if (missing.length) throw new Error(`Missing required V3 integration variables: ${missing.join(", ")}`);
const inngestConfigured = Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY);

const isExplicitPreview = process.env.VERCEL_ENV === "preview" || process.env.GUTO_V3_TARGET_ENV === "preview";
if (!isExplicitPreview || process.env.VERCEL_ENV === "production") {
  throw new Error("Refusing to run the real V3 verifier outside the explicit Preview target.");
}
if (process.env.GUTO_V3_ENABLED !== "true" || process.env.GUTO_V3_ONLY !== "true") {
  throw new Error("The real V3 verifier requires GUTO_V3_ENABLED=true and GUTO_V3_ONLY=true.");
}
const expectedProjectRef = process.env.GUTO_V3_TEST_PROJECT_REF?.trim().toLowerCase()
  || projectRefFromSupabaseUrl(requiredValue("SUPABASE_URL"));
if (!/^[a-z0-9]{10,40}$/.test(expectedProjectRef)) {
  throw new Error("GUTO_V3_TEST_PROJECT_REF is invalid.");
}
const runtimeDatabase = parseDatabaseAuthority("DATABASE_URL");
const adminDatabase = parseDatabaseAuthority("GUTO_V3_ADMIN_DATABASE_URL");
assertSeparatedDatabaseAuthorities(runtimeDatabase, adminDatabase, expectedProjectRef);
const runtimePool = createV3Pool(runtimeDatabase.connectionString);
const adminPool = createV3Pool(adminDatabase.connectionString);
const repository = new PostgresOfficialStateRepository(runtimePool);
const operational = RedisV3OperationalState.fromEnvironment();
const relationshipMemory = new Mem0RelationshipMemoryStore();
const rawRedis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "",
});
const service = new V3CutoverService(repository);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stage(name: string): void {
  process.stderr.write(`[verify-v3] ${name}\n`);
}

async function initializeActor(actor: ActorContext): Promise<void> {
  let state = await service.load(actor);
  if (!state.journey.consentAcceptedAt) state = await service.acceptConsent(actor, randomUUID());
  if (!state.journey.sovereignNameConfirmedAt) {
    state = await service.saveMemory(actor, { requestId: randomUUID(), name: "Verifier", confirmedName: true });
  }
  if (!state.profile || !state.goal || state.profile.weeklyFrequencyDaysPerWeek == null) {
    await repository.persistCalibration(actor, {
      requestId: randomUUID(),
      profile: {
        biologicalSex: "prefer_not_to_say",
        age: 35,
        weightKg: 80,
        heightCm: 180,
        trainingStatus: "active",
        weeklyFrequencyDaysPerWeek: 4,
      },
      goal: { code: "consistency" },
    });
    state = await service.load(actor);
  }
  if (!state.journey.pactAcceptedAt) {
    state = await service.saveMemory(actor, { requestId: randomUUID(), name: "Verifier", xpEvent: "grant_initial_xp" });
  }
  if (state.firstContact.status === "COMPLETED") return;
  if (state.firstContact.status === "NOT_STARTED") state = await service.startFirstContact(actor, randomUUID());
  if (state.firstContact.step === "food_restrictions") {
    state = await service.respondFirstContact(actor, { requestId: randomUUID(), expectedStep: "food_restrictions", answer: "Sem restrições alimentares declaradas." });
  }
  if (state.firstContact.step === "training_limitations") {
    state = await service.respondFirstContact(actor, { requestId: randomUUID(), expectedStep: "training_limitations", answer: "Sem dores ou limitações declaradas." });
  }
  if (state.firstContact.step === "confirmation") {
    await service.confirmFirstContact(actor, { requestId: randomUUID(), confirmed: true });
  }
}

async function assertConfirmedContextIntegrity(actor: ActorContext): Promise<number> {
  const [state, snapshot] = await Promise.all([service.load(actor), repository.loadOfficialSnapshot(actor)]);
  assert.equal(state.firstContact.status, "COMPLETED");
  assert.ok(state.confirmedContext);
  assert.ok(state.workout);
  assert.ok(state.diet);
  assert.equal(state.firstContact.confirmedContextVersion, state.confirmedContext.version);
  assert.equal(state.workout.confirmedContextVersion, state.confirmedContext.version);
  assert.equal(state.diet.confirmedContextVersion, state.confirmedContext.version);
  assert.equal(snapshot.confirmedContext?.version, state.confirmedContext.version);
  assert.equal(snapshot.profile.version, snapshot.confirmedContext?.profileVersion);
  assert.equal(snapshot.goal.version, snapshot.confirmedContext?.goalVersion);
  assert.equal(snapshot.profile.trainingLocation, "gym");
  return state.confirmedContext.version;
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof V3Error && error.code === "V3_AUTH_REQUIRED" && error.status === 401;
}

async function assertAuthSchemaAndIsolation(authA: V3AuthResult, authB: V3AuthResult): Promise<{
  forcedRls: boolean;
  legacyRolesDenied: boolean;
  isolatedSessions: number;
}> {
  const client = await adminPool.connect();
  try {
    const tables = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='guto_v3' AND c.relname=ANY($1::text[])
        ORDER BY c.relname`,
      [["auth_credentials", "auth_sessions"]],
    );
    assert.deepEqual(tables.rows.map((row) => row.relname), ["auth_credentials", "auth_sessions"]);
    assert.ok(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));

    const roleAttributes = await client.query<{
      rolname: string;
      rolsuper: boolean;
      rolinherit: boolean;
      rolbypassrls: boolean;
      rolreplication: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolname,rolsuper,rolinherit,rolbypassrls,rolreplication,rolcanlogin
         FROM pg_catalog.pg_roles
        WHERE rolname=ANY($1::text[])
        ORDER BY rolname`,
      [["guto_v3_app", "guto_v3_auth", "guto_v3_runtime"]],
    );
    assert.deepEqual(roleAttributes.rows.map((row) => row.rolname), ["guto_v3_app", "guto_v3_auth", "guto_v3_runtime"]);
    assert.ok(roleAttributes.rows.every((row) =>
      !row.rolsuper && !row.rolinherit && !row.rolbypassrls && !row.rolreplication));
    assert.equal(roleAttributes.rows.find((row) => row.rolname === "guto_v3_runtime")?.rolcanlogin, true);
    assert.ok(roleAttributes.rows.filter((row) => row.rolname !== "guto_v3_runtime").every((row) => !row.rolcanlogin));

    const memberships = await client.query<{ member_role: string; granted_role: string; admin_option: boolean }>(
      `SELECT member_role.rolname AS member_role,
              granted_role.rolname AS granted_role,
              membership.admin_option
         FROM pg_catalog.pg_auth_members membership
         JOIN pg_catalog.pg_roles granted_role ON granted_role.oid=membership.roleid
         JOIN pg_catalog.pg_roles member_role ON member_role.oid=membership.member
        WHERE member_role.rolname=ANY($1::text[])
        ORDER BY member_role.rolname,granted_role.rolname`,
      [["guto_v3_app", "guto_v3_auth", "guto_v3_runtime"]],
    );
    assert.deepEqual(memberships.rows, [
      { member_role: "guto_v3_runtime", granted_role: "guto_v3_app", admin_option: false },
      { member_role: "guto_v3_runtime", granted_role: "guto_v3_auth", admin_option: false },
    ]);

    const deniedRoles = ["anon", "authenticated", "guto_v3_app"];
    const privileges = await client.query<{
      rolname: string;
      credentials_select: boolean;
      credentials_insert: boolean;
      credentials_update: boolean;
      credentials_delete: boolean;
      sessions_select: boolean;
      sessions_insert: boolean;
      sessions_update: boolean;
      sessions_delete: boolean;
    }>(
      `SELECT rolname,
              has_table_privilege(rolname,'guto_v3.auth_credentials','SELECT') AS credentials_select,
              has_table_privilege(rolname,'guto_v3.auth_credentials','INSERT') AS credentials_insert,
              has_table_privilege(rolname,'guto_v3.auth_credentials','UPDATE') AS credentials_update,
              has_table_privilege(rolname,'guto_v3.auth_credentials','DELETE') AS credentials_delete,
              has_table_privilege(rolname,'guto_v3.auth_sessions','SELECT') AS sessions_select,
              has_table_privilege(rolname,'guto_v3.auth_sessions','INSERT') AS sessions_insert,
              has_table_privilege(rolname,'guto_v3.auth_sessions','UPDATE') AS sessions_update,
              has_table_privilege(rolname,'guto_v3.auth_sessions','DELETE') AS sessions_delete
         FROM pg_catalog.pg_roles
        WHERE rolname=ANY($1::text[])
        ORDER BY rolname`,
      [deniedRoles],
    );
    assert.deepEqual(privileges.rows.map((row) => row.rolname), ["anon", "authenticated", "guto_v3_app"]);
    assert.ok(privileges.rows.every((row) =>
      !row.credentials_select && !row.credentials_insert && !row.credentials_update && !row.credentials_delete &&
      !row.sessions_select && !row.sessions_insert && !row.sessions_update && !row.sessions_delete));

    const policies = await client.query<{ tablename: string; policyname: string }>(
      `SELECT tablename,policyname
         FROM pg_catalog.pg_policies
        WHERE schemaname='guto_v3'
          AND tablename=ANY($1::text[])
        ORDER BY tablename,policyname`,
      [["auth_credentials", "auth_sessions", "identities"]],
    );
    assert.equal(
      policies.rows.some((row) => row.tablename === "identities" && row.policyname === "tenant_isolation"),
      false,
    );
    for (const expected of [
      "auth_backend_lookup",
      "auth_credential_update",
      "auth_session_insert",
      "auth_session_select",
      "auth_session_update",
      "auth_identity_lookup",
    ]) {
      assert.ok(policies.rows.some((row) => row.policyname === expected), `Missing V3 auth RLS policy: ${expected}`);
    }

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE guto_v3_auth");
    await client.query(
      `SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),
              set_config('app.identity_id',$3,true),set_config('app.session_id',$4,true)`,
      [
        authA.principal.actor.tenantId,
        authA.principal.actor.userId,
        authA.principal.identityId,
        authA.principal.sessionId,
      ],
    );

    const sessionRows = await client.query<{ id: string }>(
      "SELECT id FROM guto_v3.auth_sessions WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[authA.principal.sessionId, authB.principal.sessionId]],
    );
    assert.deepEqual(sessionRows.rows.map((row) => row.id), [authA.principal.sessionId]);

    const userRows = await client.query<{ id: string }>(
      "SELECT id FROM guto_v3.users WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[authA.principal.actor.userId, authB.principal.actor.userId]],
    );
    assert.deepEqual(userRows.rows.map((row) => row.id), [authA.principal.actor.userId]);

    const identityRows = await client.query<{ id: string }>(
      "SELECT id FROM guto_v3.identities WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[authA.principal.identityId, authB.principal.identityId]],
    );
    assert.deepEqual(identityRows.rows.map((row) => row.id), [authA.principal.identityId]);

    const credentialUpdate = await client.query(
      `UPDATE guto_v3.auth_credentials
          SET failed_attempts=failed_attempts
        WHERE user_id=ANY($1::uuid[])`,
      [[authA.principal.actor.userId, authB.principal.actor.userId]],
    );
    assert.equal(credentialUpdate.rowCount, 1);
    await client.query("ROLLBACK");

    return { forcedRls: true, legacyRolesDenied: true, isolatedSessions: 2 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assertPostgresV3Auth(): Promise<{
  actorA: ActorContext;
  actorB: ActorContext;
  report: {
    ok: true;
    users: number;
    concurrentLogins: number;
    bootstrapIdempotent: true;
    sessionsRevoked: number;
    forcedRls: boolean;
    legacyRolesDenied: boolean;
    isolatedSessions: number;
  };
}> {
  const users = [
    {
      loginIdentifier: requiredValue("GUTO_V3_VERIFY_USER_A_EMAIL").toLowerCase(),
      password: requiredValue("GUTO_V3_VERIFY_USER_A_PASSWORD", true),
      displayName: "Verificador V3 A",
    },
    {
      loginIdentifier: requiredValue("GUTO_V3_VERIFY_USER_B_EMAIL").toLowerCase(),
      password: requiredValue("GUTO_V3_VERIFY_USER_B_PASSWORD", true),
      displayName: "Verificador V3 B",
    },
  ] as const;
  assert.notEqual(users[0].loginIdentifier, users[1].loginIdentifier, "V3 auth users A and B must be distinct");
  const protectedIdentifiers = [
    process.env.GUTO_V3_TEST_USER_A_EMAIL,
    process.env.GUTO_V3_TEST_USER_B_EMAIL,
    process.env.ADMIN_EMAIL,
  ].filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim().toLowerCase());
  for (const user of users) {
    assert.equal(
      protectedIdentifiers.includes(user.loginIdentifier),
      false,
      "Verifier credentials must never reuse a founder/manual-test identity",
    );
  }

  const firstBootstrap = [];
  for (const user of users) {
    firstBootstrap.push(await bootstrapV3AuthCredential(adminPool, {
      tenantSlug: "guto-v3-verifier",
      tenantName: "GUTO Cérebro V3 Verifier",
      loginIdentifier: user.loginIdentifier,
      password: user.password,
      displayName: user.displayName,
      role: "student",
      status: "active",
    }));
  }
  for (let index = 0; index < users.length; index += 1) {
    const repeated = await bootstrapV3AuthCredential(adminPool, {
      tenantSlug: "guto-v3-verifier",
      tenantName: "GUTO Cérebro V3 Verifier",
      loginIdentifier: users[index]!.loginIdentifier,
      password: users[index]!.password,
      displayName: users[index]!.displayName,
      role: "student",
      status: "active",
    });
    assert.equal(repeated.created, false);
    assert.equal(repeated.userId, firstBootstrap[index]!.userId);
    assert.equal(repeated.identityId, firstBootstrap[index]!.identityId);
    assert.equal(repeated.credentialVersion, firstBootstrap[index]!.credentialVersion);
  }

  const auth = new V3AuthService(
    new PostgresV3AuthStore(runtimePool),
    readV3AuthConfigFromEnvironment(),
  );
  const [loginA, loginB] = await Promise.all([
    auth.login(users[0].loginIdentifier, users[0].password),
    auth.login(users[1].loginIdentifier, users[1].password),
  ]);
  const [authenticatedA, authenticatedB] = await Promise.all([
    auth.authenticateToken(loginA.token),
    auth.authenticateToken(loginB.token),
  ]);
  assert.notEqual(authenticatedA.principal.actor.userId, authenticatedB.principal.actor.userId);
  assert.notEqual(authenticatedA.principal.identityId, authenticatedB.principal.identityId);
  assert.notEqual(authenticatedA.principal.sessionId, authenticatedB.principal.sessionId);

  const isolation = await assertAuthSchemaAndIsolation(authenticatedA, authenticatedB);
  await auth.logout(authenticatedA);
  await assert.rejects(() => auth.authenticateToken(loginA.token), isAuthRequired);
  const stillAuthenticatedB = await auth.authenticateToken(loginB.token);
  await auth.logout(stillAuthenticatedB);
  await assert.rejects(() => auth.authenticateToken(loginB.token), isAuthRequired);

  return {
    actorA: authenticatedA.principal.actor,
    actorB: authenticatedB.principal.actor,
    report: {
      ok: true,
      users: 2,
      concurrentLogins: 2,
      bootstrapIdempotent: true,
      sessionsRevoked: 2,
      ...isolation,
    },
  };
}

async function assertRlsIsolation(actorA: ActorContext, actorB: ActorContext): Promise<void> {
  const client = await adminPool.connect();
  try {
    const tables = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='guto_v3' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
      [["confirmed_user_contexts", "first_contact_state"]],
    );
    assert.deepEqual(tables.rows.map((row) => row.relname), ["confirmed_user_contexts", "first_contact_state"]);
    assert.ok(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
    const contextPrivileges = await client.query<{ can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(
      `SELECT has_table_privilege('guto_v3_app','guto_v3.confirmed_user_contexts','SELECT') AS can_select,
              has_table_privilege('guto_v3_app','guto_v3.confirmed_user_contexts','INSERT') AS can_insert,
              has_table_privilege('guto_v3_app','guto_v3.confirmed_user_contexts','UPDATE') AS can_update,
              has_table_privilege('guto_v3_app','guto_v3.confirmed_user_contexts','DELETE') AS can_delete`,
    );
    assert.deepEqual(contextPrivileges.rows[0], { can_select: true, can_insert: true, can_update: false, can_delete: false });
    const policies = await client.query<{ tablename: string; policyname: string }>(
      `SELECT tablename,policyname FROM pg_catalog.pg_policies
        WHERE schemaname='guto_v3' AND tablename=ANY($1::text[]) ORDER BY tablename,policyname`,
      [["confirmed_user_contexts", "first_contact_state"]],
    );
    for (const expected of ["confirmed_user_contexts:actor_insert", "confirmed_user_contexts:actor_select", "first_contact_state:actor_isolation"]) {
      assert.ok(policies.rows.some((row) => `${row.tablename}:${row.policyname}` === expected), `Missing V3.2 RLS policy: ${expected}`);
    }

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [actorA.tenantId, actorA.userId]);
    await client.query("SET LOCAL ROLE guto_v3_app");
    const visible = await client.query<{ id: string }>(
      "SELECT id FROM guto_v3.users WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[actorA.userId, actorB.userId]],
    );
    assert.deepEqual(visible.rows.map((row) => row.id), [actorA.userId]);
    const visibleFirstContact = await client.query<{ user_id: string }>(
      "SELECT user_id FROM guto_v3.first_contact_state WHERE user_id=ANY($1::uuid[]) ORDER BY user_id",
      [[actorA.userId, actorB.userId]],
    );
    assert.deepEqual(visibleFirstContact.rows.map((row) => row.user_id), [actorA.userId]);
    const visibleContexts = await client.query<{ user_id: string }>(
      "SELECT user_id FROM guto_v3.confirmed_user_contexts WHERE user_id=ANY($1::uuid[]) ORDER BY user_id",
      [[actorA.userId, actorB.userId]],
    );
    assert.ok(visibleContexts.rows.length > 0);
    assert.ok(visibleContexts.rows.every((row) => row.user_id === actorA.userId));
    const crossUserUpdate = await client.query(
      "UPDATE guto_v3.users SET display_name='RLS MUST BLOCK' WHERE id=$1",
      [actorB.userId],
    );
    assert.equal(crossUserUpdate.rowCount, 0);
    const crossFirstContactUpdate = await client.query(
      "UPDATE guto_v3.first_contact_state SET version=version WHERE user_id=$1",
      [actorB.userId],
    );
    assert.equal(crossFirstContactUpdate.rowCount, 0);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function context(actor: ActorContext, version: number, label: string): ActiveContext {
  return {
    id: randomUUID(),
    version,
    kind: "workout",
    planId: randomUUID(),
    planVersion: 1,
    itemId: randomUUID(),
    itemLabel: label,
    rejectedCandidateIds: [],
    updatedAt: new Date().toISOString(),
  };
}

async function assertRedisIsolationAndConcurrency(actorA: ActorContext, actorB: ActorContext): Promise<void> {
  const initialA = context(actorA, 1, "user-a");
  const initialB = context(actorB, 1, "user-b");
  await Promise.all([
    operational.compareAndSetActiveContext(actorA, null, initialA),
    operational.compareAndSetActiveContext(actorB, null, initialB),
  ]);
  assert.equal((await operational.getActiveContext(actorA))?.itemLabel, "user-a");
  assert.equal((await operational.getActiveContext(actorB))?.itemLabel, "user-b");
  const [ttlA, ttlB] = await Promise.all([
    rawRedis.ttl(`guto:v3:{${actorA.tenantId}:${actorA.userId}}:active-context`),
    rawRedis.ttl(`guto:v3:{${actorB.tenantId}:${actorB.userId}}:active-context`),
  ]);
  assert.ok(ttlA > 0, "Redis context A must have a positive TTL");
  assert.ok(ttlB > 0, "Redis context B must have a positive TTL");

  const competing = await Promise.allSettled([
    operational.compareAndSetActiveContext(actorA, 1, { ...initialA, version: 2, itemLabel: "winner-one" }),
    operational.compareAndSetActiveContext(actorA, 1, { ...initialA, version: 2, itemLabel: "winner-two" }),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(competing.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await operational.getActiveContext(actorA))?.version, 2);

  await Promise.all([
    operational.clearActiveContext(actorA, 2),
    operational.clearActiveContext(actorB, 1),
  ]);
}

async function assertMem0RelationshipMemory(actor: ActorContext): Promise<number> {
  const marker = `guto-v3-preview-${randomUUID()}`;
  const semanticQuery = "preferência sintética por confirmações curtas e código relacional de teste";
  await relationshipMemory.submit(actor, [{
    classification: "RELATIONSHIP",
    fact: `O usuário sintético do teste prefere confirmações curtas e usa o código relacional ${marker}.`,
    evidence: "Declaração sintética do verificador de integração V3.",
  }], randomUUID());

  for (let attempt = 0; attempt < 8; attempt += 1) {
    // Random UUIDs are intentionally poor embedding queries. Retrieve by the
    // semantic fact, but require the unique marker in the returned memory so a
    // stale prior write can never produce a false PASS.
    const memories = await relationshipMemory.search(actor, semanticQuery, 10);
    if (memories.some((memory) => memory.text.includes(marker))) return memories.length;
    await wait(2_000);
  }
  assert.fail("Mem0 accepted the write but did not return relational memory after retries");
}

async function assertInngestRelationshipMemory(actor: ActorContext): Promise<number> {
  const marker = `guto-v3-inngest-${randomUUID()}`;
  const semanticQuery = "usuário sintético do fluxo durável prefere confirmação objetiva";
  await new InngestDurableEventPublisher().enqueueRelationshipMemorySync({
    actor,
    correlationId: randomUUID(),
    facts: [{
      classification: "RELATIONSHIP",
      fact: `O usuário sintético do fluxo durável prefere confirmação objetiva. ${marker}`,
      evidence: "Evento sintético do verificador de integração V3.",
    }],
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    // Query the semantic content Mem0 embeds, while still requiring the unique
    // marker so an older relationship memory can never produce a false PASS.
    const memories = await relationshipMemory.search(actor, semanticQuery, 10);
    if (memories.some((memory) => memory.text.includes(marker))) return memories.length;
    await wait(2_000);
  }
  assert.fail("Inngest accepted the event but did not complete the durable relationship-memory sync");
}

async function assertLangfuseTrace(traceId: string): Promise<{ traceId: string; observationCount: number }> {
  const baseUrl = (process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/+$/, "");
  const authorization = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
  const headers = { Authorization: `Basic ${authorization}` };

  const maxAttempts = Number(process.env.GUTO_V3_LANGFUSE_VERIFY_ATTEMPTS || 12);
  const pollDelayMs = Number(process.env.GUTO_V3_LANGFUSE_VERIFY_POLL_DELAY_MS || 2_000);
  const requestTimeoutMs = Number(process.env.GUTO_V3_LANGFUSE_VERIFY_TIMEOUT_MS || 15_000);
  const requiredObservations = [
    "GUTO_TURN",
    "CONTEXT_BUILD",
    "GEMINI_CALL",
    "GEMINI_INTERACTION",
    "DECISION_VALIDATION",
    "POLICY_GATE",
    "EXECUTOR",
    "FACT_STATE_PERSIST",
  ];
  let lastObserved = "";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const observationsResponse = await fetch(`${baseUrl}/api/public/v2/observations?traceId=${encodeURIComponent(traceId)}&limit=100&fields=core%2Cbasic`, {
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (observationsResponse.ok) {
      const body = (await observationsResponse.json()) as { data?: Array<{ name?: string }> };
      const observations = body.data || [];
      const names = observations.map((observation) => observation.name);
      const observed = names.filter((name): name is string => Boolean(name)).join(",");
      if (requiredObservations.every((name) => names.includes(name))) {
        return { traceId, observationCount: observations.length };
      }
      lastObserved = observed;
    }
    if (!observationsResponse.ok && observationsResponse.status !== 404) {
      assert.fail(`Langfuse observation query failed with status ${observationsResponse.status}`);
    }
    await wait(pollDelayMs);
  }
  assert.fail(`Langfuse did not expose all flushed V3 observations after retries; observed=${lastObserved}`);
}

let telemetryShutdown = false;
try {
  const traceRequestId = randomUUID();
  stage("trace-start");
  const result = await withV3Trace({
    requestId: traceRequestId,
    externalSubject: "guto-v3-integration-verifier",
    attributes: { "guto.input_category": "real_integration_verification" },
  }, async () => {
    stage("postgres-and-redis-health");
    const [postgres, redis] = await Promise.all([repository.health(), operational.health()]);
    assert.equal(postgres.ok, true);
    assert.equal(redis.ok, true);

    stage("postgres-v3-auth-bootstrap-login-rls-revocation");
    const authResult = await withV3Span("POSTGRES_V3_AUTH_TEST", {}, () => assertPostgresV3Auth());
    const { actorA, actorB } = authResult;
    stage("initialize-authenticated-test-actors");
    await Promise.all([initializeActor(actorA), initializeActor(actorB)]);
    const [contextVersionA, contextVersionB] = await Promise.all([
      assertConfirmedContextIntegrity(actorA),
      assertConfirmedContextIntegrity(actorB),
    ]);
    stage("rls-and-redis-isolation");
    await withV3Span("RLS_ISOLATION_TEST", {}, () => assertRlsIsolation(actorA, actorB));
    await withV3Span("REDIS_CONCURRENCY_TEST", {}, () => assertRedisIsolationAndConcurrency(actorA, actorB));

    stage("gemini-interactions-genkit-flow");
    const ai = createV3Genkit();
    const contextBuilder = new GutoContextBuilderV3(
      repository,
      operational,
      relationshipMemory,
      new ConservativeCatalogCandidateProviderV3(),
    );
    const flow = createGutoTurnFlow({
      ai,
      repository,
      operational,
      relationshipMemory,
      contextBuilder,
      decisionModel: new GeminiInteractionsDecisionModel(),
      durableEvents: new InngestDurableEventPublisher(),
    });
    const decision = await flow({
      actor: actorA,
      message: "Oi GUTO. Confirma que está comigo sem alterar meu plano.",
      requestId: randomUUID(),
    });
    assert.equal(decision.brainVersion, "guto-cerebro-v3");
    assert.ok(decision.speech.length > 0);

    stage("mem0-direct-relationship-memory");
    const mem0ResultCount = await assertMem0RelationshipMemory(actorA);
    stage("inngest-durable-relationship-memory");
    const inngestResultCount = inngestConfigured ? await assertInngestRelationshipMemory(actorA) : null;

    return {
      langfuseTraceId: decision.traceId,
      postgres: { ok: true, latencyMs: postgres.latencyMs },
      auth: authResult.report,
      rls: {
        ok: true,
        isolatedUsers: 2,
        authTablesForced: authResult.report.forcedRls,
        legacyRolesDenied: authResult.report.legacyRolesDenied,
        firstContactAndConfirmedContextForced: true,
      },
      confirmedContext: { ok: true, actorA: contextVersionA, actorB: contextVersionB, workoutAndDietShareVersion: true },
      redis: { ok: true, latencyMs: redis.latencyMs, isolatedUsers: 2, concurrentWinners: 1, ttlValidated: true },
      gemini: { ok: true, api: "interactions", action: decision.action, decisionEnvelopeValidated: true, genkitFlowValidated: true },
      mem0: { ok: true, classification: "RELATIONSHIP", resultCount: mem0ResultCount },
      inngest: inngestConfigured
        ? { ok: true, durableRelationshipMemoryResultCount: inngestResultCount }
        : { ok: false, reason: "INNGEST_EVENT_KEY is not configured for this isolated Preview" },
    };
  });
  await shutdownV3Telemetry();
  telemetryShutdown = true;
  stage(`langfuse-trace-read:${result.langfuseTraceId}`);
  const langfuse = await assertLangfuseTrace(result.langfuseTraceId);
  const verification = {
    ...result,
    langfuse: { ok: true, traceFlushed: true, ...langfuse },
  };
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  if (!verification.inngest.ok) process.exitCode = 1;
} finally {
  await Promise.all([runtimePool.end(), adminPool.end()]);
  if (!telemetryShutdown) await shutdownV3Telemetry();
}

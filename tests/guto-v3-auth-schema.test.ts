import "./test-env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const migration = readFileSync(join(process.cwd(), "migrations/v3/0004_v3_postgres_auth.sql"), "utf8");
const roleHardeningMigration = readFileSync(join(process.cwd(), "migrations/v3/0005_v3_runtime_role_hardening.sql"), "utf8");
const membershipGuardMigration = readFileSync(join(process.cwd(), "migrations/v3/0006_v3_runtime_membership_guard.sql"), "utf8");
const replicationGuardMigration = readFileSync(join(process.cwd(), "migrations/v3/0007_v3_runtime_replication_guard.sql"), "utf8");
const migrationRunner = readFileSync(join(process.cwd(), "scripts/run-v3-migrations.ts"), "utf8");
const previewSeed = readFileSync(join(process.cwd(), "scripts/seed-v3-preview-users.ts"), "utf8");
const realVerifier = readFileSync(join(process.cwd(), "scripts/verify-v3-real-integrations.ts"), "utf8");

test("PostgreSQL V3 auth migration is idempotent and forces RLS on credentials and sessions", () => {
  for (const table of ["auth_credentials", "auth_sessions"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS guto_v3\\.${table} \\(`));
    assert.match(migration, new RegExp(`ALTER TABLE guto_v3\\.${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(migration, new RegExp(`ALTER TABLE guto_v3\\.${table} FORCE ROW LEVEL SECURITY;`));
  }
  assert.match(migration, /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'guto_v3_auth'\)/);
  assert.match(migration, /DROP POLICY IF EXISTS auth_backend_lookup ON guto_v3\.auth_credentials;/);
  assert.match(migration, /DROP POLICY IF EXISTS auth_session_select ON guto_v3\.auth_sessions;/);
});

test("V3 auth authority is unavailable to app and Supabase client roles", () => {
  assert.match(
    migration,
    /REVOKE ALL ON guto_v3\.auth_credentials, guto_v3\.auth_sessions\s+FROM PUBLIC, guto_v3_app, guto_v3_auth;/,
  );
  assert.match(migration, /REVOKE ALL ON guto_v3\.auth_credentials, guto_v3\.auth_sessions FROM anon;/);
  assert.match(migration, /REVOKE ALL ON guto_v3\.auth_credentials, guto_v3\.auth_sessions FROM authenticated;/);
  assert.doesNotMatch(migration, /GRANT[\s\S]*?\sTO\s+(?:guto_v3_app|anon|authenticated)\s*;/i);
  assert.match(migration, /DROP POLICY IF EXISTS tenant_isolation ON guto_v3\.identities;/);
});

test("V3 runtime migration rejects unsafe role attributes without versioning credentials", () => {
  assert.match(roleHardeningMigration, /rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls/);
  assert.match(roleHardeningMigration, /rolname IN \('guto_v3_app', 'guto_v3_auth'\) AND rolcanlogin/);
  assert.match(roleHardeningMigration, /rolname = 'guto_v3_runtime' AND NOT rolcanlogin/);
  assert.match(roleHardeningMigration, /RAISE EXCEPTION 'Unsafe pre-existing GUTO V3 database role attributes'/);
  assert.doesNotMatch(roleHardeningMigration, /\b(?:ALTER|CREATE)\s+ROLE[^;]*(?:PASSWORD|VALID UNTIL)/i);
});

test("V3 runtime membership is limited to app and auth without admin option", () => {
  assert.match(membershipGuardMigration, /FROM pg_catalog\.pg_auth_members membership/);
  assert.match(membershipGuardMigration, /member_role\.rolname = 'guto_v3_runtime'/);
  assert.match(membershipGuardMigration, /granted_role\.rolname IN \('guto_v3_app', 'guto_v3_auth'\)/);
  assert.match(membershipGuardMigration, /membership\.admin_option = false/);
  assert.match(membershipGuardMigration, /RAISE EXCEPTION 'Unexpected GUTO V3 database role membership'/);
  assert.match(membershipGuardMigration, /RAISE EXCEPTION 'Missing GUTO V3 runtime database role membership'/);
});

test("V3 execution roles cannot hold replication authority", () => {
  assert.match(replicationGuardMigration, /AND rolreplication/);
  assert.match(replicationGuardMigration, /RAISE EXCEPTION 'Unexpected GUTO V3 database replication authority'/);
});

test("V3 auth RLS keeps global credential lookup read-only and scopes mutations and sessions", () => {
  assert.match(
    migration,
    /CREATE POLICY auth_backend_lookup ON guto_v3\.auth_credentials\s+FOR SELECT TO guto_v3_auth\s+USING \(true\);/,
  );
  assert.match(
    migration,
    /CREATE POLICY auth_credential_update ON guto_v3\.auth_credentials\s+FOR UPDATE TO guto_v3_auth[\s\S]*?app\.tenant_id[\s\S]*?app\.user_id/,
  );
  for (const command of ["SELECT", "INSERT", "UPDATE"]) {
    assert.match(
      migration,
      new RegExp(`CREATE POLICY auth_session_${command.toLowerCase()} ON guto_v3\\.auth_sessions\\s+FOR ${command} TO guto_v3_auth`),
    );
  }
  assert.match(
    migration,
    /CREATE POLICY auth_session_select[\s\S]*?app\.session_id[\s\S]*?app\.tenant_id[\s\S]*?app\.user_id/,
  );
});

test("Preview bootstrap is PostgreSQL-only and refuses non-Preview execution", () => {
  assert.match(previewSeed, /bootstrapV3AuthCredential/);
  assert.match(previewSeed, /createV3Pool/);
  assert.match(previewSeed, /process\.env\.VERCEL_ENV === "preview"/);
  assert.match(previewSeed, /process\.env\.GUTO_V3_TARGET_ENV === "preview"/);
  assert.match(previewSeed, /process\.env\.VERCEL_ENV === "production"/);
  assert.match(previewSeed, /GUTO_V3_TEST_SEED_ENABLED/);
  assert.match(previewSeed, /assertPreviewDatabase\(databaseUrl, projectRef\)/);
  assert.match(previewSeed, /required\("GUTO_V3_ADMIN_DATABASE_URL"\)/);
  assert.doesNotMatch(previewSeed, /required\("DATABASE_URL"\)/);
  assert.doesNotMatch(previewSeed, /user-access-store|globalMemoryStore|upsertUserAccess|bcrypt/i);
});

test("V3 migrations require the job-only admin DSN and reject the runtime role", () => {
  assert.match(migrationRunner, /process\.env\.GUTO_V3_ADMIN_DATABASE_URL/);
  assert.doesNotMatch(migrationRunner, /process\.env\.DATABASE_URL/);
  assert.match(migrationRunner, /username\.startsWith\("guto_v3_runtime"\)/);
});

test("Real integration verifier covers V3 auth A/B login, RLS and revocation without emitting credentials", () => {
  const requiredBlock = realVerifier.slice(
    realVerifier.indexOf("const required = ["),
    realVerifier.indexOf("const missing:"),
  );
  const verifierUsersBlock = realVerifier.slice(
    realVerifier.indexOf("  const users = [", realVerifier.indexOf("async function assertPostgresV3Auth")),
    realVerifier.indexOf("  const protectedIdentifiers = [", realVerifier.indexOf("async function assertPostgresV3Auth")),
  );
  const collisionGuardBlock = realVerifier.slice(
    realVerifier.indexOf("  const protectedIdentifiers = [", realVerifier.indexOf("async function assertPostgresV3Auth")),
    realVerifier.indexOf("  const firstBootstrap = []", realVerifier.indexOf("async function assertPostgresV3Auth")),
  );

  assert.match(realVerifier, /assertPostgresV3Auth/);
  assert.match(realVerifier, /assertAuthSchemaAndIsolation/);
  assert.match(requiredBlock, /GUTO_V3_ADMIN_DATABASE_URL/);
  assert.match(requiredBlock, /SUPABASE_URL/);
  assert.match(realVerifier, /process\.env\.GUTO_V3_TARGET_ENV === "preview"/);
  assert.match(realVerifier, /process\.env\.VERCEL_ENV === "production"/);
  assert.match(realVerifier, /process\.env\.GUTO_V3_ENABLED !== "true" \|\| process\.env\.GUTO_V3_ONLY !== "true"/);
  assert.match(realVerifier, /projectRefFromSupabaseUrl\(requiredValue\("SUPABASE_URL"\)\)/);
  assert.match(realVerifier, /runtime\.projectRef !== expectedProjectRef \|\| admin\.projectRef !== expectedProjectRef/);
  assert.match(realVerifier, /const runtimePool = createV3Pool\(runtimeDatabase\.connectionString\)/);
  assert.match(realVerifier, /const adminPool = createV3Pool\(adminDatabase\.connectionString\)/);
  assert.match(realVerifier, /runtime\.role !== expectedRuntimeRole/);
  assert.match(realVerifier, /admin\.role === expectedRuntimeRole/);
  assert.match(realVerifier, /new PostgresOfficialStateRepository\(runtimePool\)/);
  assert.match(realVerifier, /new PostgresV3AuthStore\(runtimePool\)/);
  assert.doesNotMatch(realVerifier, /new PostgresV3AuthStore\(adminPool/);
  assert.match(realVerifier, /const decision = await flow\(\{\s*actor: actorA,/);
  assert.match(realVerifier, /concurrentLogins: 2/);
  assert.match(realVerifier, /sessionsRevoked: 2/);
  assert.match(realVerifier, /legacyRolesDenied/);
  assert.match(requiredBlock, /GUTO_V3_VERIFY_USER_A_EMAIL/);
  assert.match(requiredBlock, /GUTO_V3_VERIFY_USER_B_EMAIL/);
  assert.doesNotMatch(requiredBlock, /GUTO_V3_TEST_USER_[AB]_(?:EMAIL|PASSWORD(?:_HASH)?)/);
  assert.match(verifierUsersBlock, /GUTO_V3_VERIFY_USER_A_EMAIL/);
  assert.match(verifierUsersBlock, /GUTO_V3_VERIFY_USER_B_EMAIL/);
  assert.doesNotMatch(verifierUsersBlock, /GUTO_V3_TEST_USER_[AB]_(?:EMAIL|PASSWORD(?:_HASH)?)/);
  assert.match(collisionGuardBlock, /GUTO_V3_TEST_USER_A_EMAIL/);
  assert.match(collisionGuardBlock, /GUTO_V3_TEST_USER_B_EMAIL/);
  assert.doesNotMatch(collisionGuardBlock, /GUTO_V3_TEST_USER_[AB]_PASSWORD(?:_HASH)?/);
  assert.match(realVerifier, /tenantSlug: "guto-v3-verifier"/);
  assert.match(realVerifier, /process\.env\.INNGEST_EVENT_KEY && process\.env\.INNGEST_SIGNING_KEY/);
  assert.doesNotMatch(realVerifier, /process\.stdout\.write\([^\n]*(?:password|token|loginIdentifier)/i);
});

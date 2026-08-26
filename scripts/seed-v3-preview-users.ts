import "dotenv/config";
import { bootstrapV3AuthCredential } from "../src/v3/postgres-auth.js";
import { createV3Pool } from "../src/v3/postgres.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing V3 Preview seed variable: ${name}`);
  return value;
}

function requiredSecret(name: string): string {
  const value = process.env[name] || "";
  if (!value.trim()) throw new Error(`Missing V3 Preview seed variable: ${name}`);
  return value;
}

function credentialSecret(slot: "A" | "B"): { password?: string; passwordHash?: string } {
  const password = process.env[`GUTO_V3_TEST_USER_${slot}_PASSWORD`] || "";
  const passwordHash = process.env[`GUTO_V3_TEST_USER_${slot}_PASSWORD_HASH`] || "";
  if (Boolean(password) === Boolean(passwordHash)) {
    throw new Error(`Set exactly one V3 Preview credential for user ${slot}.`);
  }
  return password
    ? { password: requiredSecret(`GUTO_V3_TEST_USER_${slot}_PASSWORD`) }
    : { passwordHash: requiredSecret(`GUTO_V3_TEST_USER_${slot}_PASSWORD_HASH`) };
}

function projectRefFromSupabaseUrl(value: string): string {
  let hostname = "";
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    throw new Error("SUPABASE_URL is invalid for the V3 Preview seed.");
  }
  const projectRef = hostname.split(".")[0] || "";
  if (!/^[a-z0-9]{10,40}$/.test(projectRef)) {
    throw new Error("SUPABASE_URL does not identify an isolated Supabase project.");
  }
  return projectRef;
}

function assertPreviewDatabase(databaseUrl: string, projectRef: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is invalid for the V3 Preview seed.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username).toLowerCase();
  const belongsToExpectedProject = hostname.includes(projectRef) || username.endsWith(`.${projectRef}`);
  if (!belongsToExpectedProject) {
    throw new Error("DATABASE_URL does not match the isolated Supabase Preview project.");
  }
}

const isExplicitPreview = process.env.VERCEL_ENV === "preview" || process.env.GUTO_V3_TARGET_ENV === "preview";
if (!isExplicitPreview || process.env.VERCEL_ENV === "production") {
  throw new Error("Refusing to seed V3 test users outside the explicit Preview target.");
}
if (process.env.GUTO_V3_ENABLED !== "true") {
  throw new Error("GUTO_V3_ENABLED=true is required to seed V3 Preview users.");
}
if (process.env.GUTO_V3_ONLY !== "true") {
  throw new Error("GUTO_V3_ONLY=true is required to seed V3 Preview users.");
}
if (process.env.GUTO_V3_TEST_SEED_ENABLED !== "true") {
  throw new Error("GUTO_V3_TEST_SEED_ENABLED=true is required to seed V3 test users.");
}

const databaseUrl = required("GUTO_V3_ADMIN_DATABASE_URL");
const projectRef = process.env.GUTO_V3_TEST_PROJECT_REF?.trim().toLowerCase()
  || projectRefFromSupabaseUrl(required("SUPABASE_URL"));
if (!/^[a-z0-9]{10,40}$/.test(projectRef)) {
  throw new Error("GUTO_V3_TEST_PROJECT_REF is invalid.");
}
assertPreviewDatabase(databaseUrl, projectRef);

const users = [
  {
    slot: "A",
    loginIdentifier: required("GUTO_V3_TEST_USER_A_EMAIL").toLowerCase(),
    credential: credentialSecret("A"),
    displayName: "Fundador V3 A",
  },
  {
    slot: "B",
    loginIdentifier: required("GUTO_V3_TEST_USER_B_EMAIL").toLowerCase(),
    credential: credentialSecret("B"),
    displayName: "Concorrência V3 B",
  },
] as const;

if (users[0].loginIdentifier === users[1].loginIdentifier) {
  throw new Error("V3 Preview seed users A and B must have different login identifiers.");
}

const pool = createV3Pool(databaseUrl);
try {
  const seeded = [];
  for (const user of users) {
    const result = await bootstrapV3AuthCredential(pool, {
      tenantSlug: "guto-v3-preview",
      tenantName: "GUTO Cérebro V3 Preview",
      loginIdentifier: user.loginIdentifier,
      ...user.credential,
      displayName: user.displayName,
      role: "student",
      status: "active",
    });
    seeded.push({
      slot: user.slot,
      created: result.created,
      credentialVersion: result.credentialVersion,
    });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, environment: "preview", authority: "postgresql-v3", users: seeded })}\n`);
} finally {
  await pool.end();
}

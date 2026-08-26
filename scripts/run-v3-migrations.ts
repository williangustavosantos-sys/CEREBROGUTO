import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const connectionString = process.env.GUTO_V3_ADMIN_DATABASE_URL || "";
if (!connectionString) throw new Error("GUTO_V3_ADMIN_DATABASE_URL is required for V3 migrations.");
if ((process.env.VERCEL_ENV !== "preview" && process.env.GUTO_V3_TARGET_ENV !== "preview") || process.env.VERCEL_ENV === "production") {
  throw new Error("Refusing to run V3 migrations outside the explicit Preview target.");
}
if (process.env.GUTO_V3_ONLY !== "true") throw new Error("V3 migrations require GUTO_V3_ONLY=true.");
try {
  const parsed = new URL(connectionString);
  const username = decodeURIComponent(parsed.username).toLowerCase();
  if (username.startsWith("guto_v3_runtime")) {
    throw new Error("The restricted V3 runtime DSN cannot execute migrations.");
  }
  const supabaseHost = new URL(process.env.SUPABASE_URL || "").hostname.toLowerCase();
  const expectedProjectRef = (process.env.GUTO_V3_TEST_PROJECT_REF || supabaseHost.split(".")[0] || "").toLowerCase();
  const usernameProjectRef = username.includes(".") ? username.split(".").at(-1) : undefined;
  const hostLabels = parsed.hostname.toLowerCase().split(".");
  const hostProjectRef = hostLabels[0] === "db" ? hostLabels[1] : undefined;
  if (!expectedProjectRef || ![usernameProjectRef, hostProjectRef].includes(expectedProjectRef)) {
    throw new Error("GUTO_V3_ADMIN_DATABASE_URL does not target the isolated Preview Supabase project.");
  }
} catch (error) {
  if (error instanceof Error && (error.message.includes("restricted V3 runtime DSN") || error.message.includes("isolated Preview Supabase project"))) throw error;
  throw new Error("GUTO_V3_ADMIN_DATABASE_URL is invalid for V3 migrations.");
}

const { Pool } = pg;
const pool = new Pool({
  connectionString,
  ssl: process.env.GUTO_V3_PG_SSL === "disable" ? false : { rejectUnauthorized: false },
  max: 1,
});

const migrationDirectory = join(process.cwd(), "migrations", "v3");
const files = readdirSync(migrationDirectory).filter((file) => file.endsWith(".sql")).sort();
const client = await pool.connect();

try {
  await client.query("SELECT pg_advisory_lock(hashtext('guto_v3_migrations'))");
  await client.query("CREATE SCHEMA IF NOT EXISTS guto_v3");
  await client.query(`CREATE TABLE IF NOT EXISTS guto_v3.schema_migrations (
    filename text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const filename of files) {
    const sql = readFileSync(join(migrationDirectory, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query<{ checksum: string }>(
      "SELECT checksum FROM guto_v3.schema_migrations WHERE filename = $1",
      [filename],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${filename}`);
      process.stdout.write(`[v3-migration] already applied ${filename}\n`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO guto_v3.schema_migrations (filename, checksum) VALUES ($1,$2)", [filename, checksum]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    process.stdout.write(`[v3-migration] applied ${filename}\n`);
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('guto_v3_migrations'))").catch(() => undefined);
  client.release();
  await pool.end();
}

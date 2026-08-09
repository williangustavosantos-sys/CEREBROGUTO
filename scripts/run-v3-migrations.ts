import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const connectionString = process.env.DATABASE_URL || "";
if (!connectionString) throw new Error("DATABASE_URL is required.");

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

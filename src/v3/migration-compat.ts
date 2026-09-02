import type { PoolClient } from "pg";

/**
 * Some pre-run V3 databases have the V3.3 canonical column but no migration
 * ledger. Migration 0003 backfills legacy facts before 0009 normalizes that
 * column. Let 0003 write those rows, then let 0009 deterministically fill and
 * reassert the invariant in the same locked migration run.
 */
export async function relaxLegacyFactCanonicalValue(client: Pick<PoolClient, "query">): Promise<boolean> {
  const column = await client.query<{ is_nullable: "YES" | "NO" }>(
    `SELECT is_nullable
       FROM information_schema.columns
      WHERE table_schema='guto_v3' AND table_name='user_facts' AND column_name='canonical_value'`,
  );
  if (column.rows[0]?.is_nullable !== "NO") return false;
  await client.query("ALTER TABLE guto_v3.user_facts ALTER COLUMN canonical_value DROP NOT NULL");
  return true;
}

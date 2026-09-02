import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { relaxLegacyFactCanonicalValue } from "../src/v3/migration-compat.js";

test("legacy canonical_value is relaxed only before 0009 can backfill it", async () => {
  const database = new PGlite();
  try {
    await database.query("CREATE SCHEMA guto_v3");
    await database.query("CREATE TABLE guto_v3.user_facts (canonical_value text NOT NULL)");
    assert.equal(await relaxLegacyFactCanonicalValue(database as never), true);
    await database.query("INSERT INTO guto_v3.user_facts (canonical_value) VALUES (NULL)");
    const row = await database.query<{ canonical_value: string | null }>("SELECT canonical_value FROM guto_v3.user_facts");
    assert.equal(row.rows[0]?.canonical_value, null);
  } finally {
    await database.close();
  }
});

test("fresh V3 schema needs no compatibility relaxation", async () => {
  const database = new PGlite();
  try {
    await database.query("CREATE SCHEMA guto_v3");
    assert.equal(await relaxLegacyFactCanonicalValue(database as never), false);
  } finally {
    await database.close();
  }
});

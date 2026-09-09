import assert from "node:assert/strict";
import test from "node:test";
import { previewIdentity } from "../src/v3/preview-identity.js";

test("Preview identity exposes project binding, never credentials or DSN", () => {
  const project = "abcdefghijklmnopqrst";
  for (const url of [
    `postgres://guto_v3_runtime.${project}:secret-password@aws-1-eu-west-2.pooler.supabase.com:6543/postgres`,
    `postgres://guto_v3_runtime:secret-password@db.${project}.supabase.co:5432/postgres`,
  ]) {
    const identity = previewIdentity({ VERCEL_ENV: "preview", DATABASE_URL: url,
      VERCEL_URL: "backend-qa.vercel.app", GUTO_SOURCE_SHA: "a".repeat(40) });
    assert.deepEqual(identity?.database, { projectRef: project, schema: "guto_v3" });
    assert.equal(identity?.sourceSha, "a".repeat(40));
    assert.equal(identity?.deploymentHost, "backend-qa.vercel.app");
    assert.equal(JSON.stringify(identity).includes("secret-password"), false);
    assert.equal(JSON.stringify(identity).includes("postgres://"), false);
  }
});

test("Preview flag cannot enable diagnostics in production or unknown runtime", () => {
  for (const environment of ["production", "development", undefined]) {
    assert.equal(previewIdentity({ VERCEL_ENV: environment, GUTO_V3_TARGET_ENV: "preview" }), undefined);
  }
});

test("Malformed and unrelated DSNs remain undisclosed and cannot impersonate Supabase", () => {
  for (const url of ["bad-secret", "postgres://user:secret@db.abcdefghijklmnopqrst.supabase.co.evil.com/postgres",
    "postgres://user.abcdefghijklmnopqrst:secret@pooler.evil.com/postgres"]) {
    const identity = previewIdentity({ VERCEL_ENV: "preview", DATABASE_URL: url, GUTO_SOURCE_SHA: "secret", VERCEL_URL: "https://secret" });
    assert.deepEqual(identity, { environment: "preview", sourceSha: null, deploymentHost: null, database: null });
  }
});

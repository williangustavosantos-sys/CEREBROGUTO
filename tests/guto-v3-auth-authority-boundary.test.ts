import "./test-env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("V3 HTTP auth and router have no V1/V2 store dependency or actor auto-provision", () => {
  const auth = source("../src/v3/auth.ts");
  const postgresAuth = source("../src/v3/postgres-auth.ts");
  const router = source("../src/v3/router.ts");
  const inspected = `${auth}\n${postgresAuth}\n${router}`;

  assert.doesNotMatch(inspected, /from ["'][^"']*(user-access-store|memory-store|team-store)/);
  assert.doesNotMatch(router, /repository\.provisionActor\s*\(/);
  assert.doesNotMatch(router, /resolveActor\([^)]*provision/);
  assert.match(router, /req\.gutoV3Auth\?\.principal\.actor/);
  assert.match(router, /getV3AuthService\(\)\.authenticateHeader\(req\.headers\.authorization\)/);
  const loginRoute = router.slice(
    router.indexOf('router.post("/guto/v3/auth/login"'),
    router.indexOf('router.use("/guto/v3"'),
  );
  assert.match(loginRoute, /getV3AuthService\(\)\.login/);
  assert.doesNotMatch(loginRoute, /getV3Runtime\(\)/);
});

test("strict Preview gates legacy routes before legacy auth and webhook handlers", () => {
  const server = source("../server.ts");
  const strictGate = server.indexOf("if (!v3OnlyEnabled() || isV3OnlyAllowedPath(req.path) || isV3AdministrativePanelPath(req.path))");
  const webhook = server.indexOf('app.post("/guto/billing/webhook"');
  const v3Router = server.indexOf("app.use(createV3Router({");
  const legacyAuth = server.indexOf("app.use(parseAuth)");
  const v3RequestLog = server.indexOf('app.use("/guto/v3", requestLog)');
  const jsonParser = server.indexOf('app.use(express.json({ limit: "6mb" }))');

  assert.ok(strictGate >= 0 && strictGate < webhook, "strict gate must run before the legacy webhook");
  const router = source("../src/v3/router.ts");
  assert.match(router, /GUTO_V3_PANEL_ENABLED/);
  assert.match(server, /isV3AdministrativePanelPath\(req\.path\)/);
  assert.ok(v3RequestLog >= 0 && v3RequestLog < jsonParser, "V3 requests must be logged before JSON parsing");
  assert.ok(v3Router >= 0 && v3Router < legacyAuth, "V3 auth must run before the legacy JWT parser");
  assert.match(server, /V3_LEGACY_AUTHORITY_DISABLED/);
  assert.match(server, /entity\.parse\.failed/);
  assert.match(server, /error: "V3_INVALID_REQUEST"/);
});

test("legacy access, memory, team and Arena stores do not hydrate in a V3-only cold start", () => {
  for (const path of [
    "../src/user-access-store.ts",
    "../src/memory-store.ts",
    "../src/team-store.ts",
    "../src/arena-store.ts",
  ]) {
    const file = source(path);
    assert.match(file, /process\.env\.GUTO_V3_ONLY\s*!==\s*["']true["']/,
      `${path} must guard legacy bootstrap under GUTO_V3_ONLY`);
  }
});

test("Preview seed provisions identity only through PostgreSQL V3 auth", () => {
  const seed = source("../scripts/seed-v3-preview-users.ts");
  assert.match(seed, /bootstrapV3AuthCredential/);
  assert.match(seed, /createV3Pool/);
  assert.doesNotMatch(seed, /user-access-store|memory-store|globalMemoryStore/);
});

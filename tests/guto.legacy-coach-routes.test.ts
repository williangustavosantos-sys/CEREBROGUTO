import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";

const testMemoryDir = join(process.cwd(), "tmp");
const testMemoryFile = join(testMemoryDir, "guto-memory.legacy-coach-routes-test.json");

let app: { listen: (port: number, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";

function signTestToken(role: "coach" | "admin" | "super_admin", userId = `${role}-test-user`) {
  return jwt.sign(
    { userId, role, coachId: role === "coach" ? userId : undefined },
    process.env.JWT_SECRET || "dev-secret-change-in-production"
  );
}

async function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

before(async () => {
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  process.env.GUTO_DISABLE_LISTEN = "1";
  delete process.env.GUTO_ENABLE_LEGACY_COACH_ROUTES;

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, callback?: () => void) => Server };
  };
  app = serverModule.app;

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(testMemoryDir, { recursive: true, force: true });
});

describe("legacy /guto/coach quarantine", () => {
  it("/admin remains reachable for admin contracts", async () => {
    const response = await request("/admin/students", {
      headers: { Authorization: `Bearer ${signTestToken("admin")}` },
    });

    assert.equal(response.status, 200);
  });

  it("keeps the read-only legacy rankings endpoint for the current frontend", async () => {
    const response = await request("/guto/coach/rankings", {
      headers: { Authorization: `Bearer ${signTestToken("coach")}` },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.ok(Array.isArray((body["weekly"] as { items?: unknown[] }).items));
    assert.ok(Array.isArray((body["monthly"] as { items?: unknown[] }).items));
    assert.ok(Array.isArray((body["individual"] as { items?: unknown[] }).items));
  });

  it("blocks non-ranking legacy coach routes by default", async () => {
    const response = await request("/guto/coach/students", {
      headers: { Authorization: `Bearer ${signTestToken("coach")}` },
    });

    assert.equal(response.status, 410);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "LEGACY_COACH_ROUTES_DISABLED");
  });

  it("keeps nuke-all unavailable by default even for super_admin tokens", async () => {
    const response = await request("/guto/coach/nuke-all", {
      method: "POST",
      headers: { Authorization: `Bearer ${signTestToken("super_admin")}` },
    });

    assert.equal(response.status, 410);
  });

  it("requires super_admin for legacy nuke-all even if the router is mounted explicitly", async () => {
    const { parseAuth } = await import(pathToFileURL(join(process.cwd(), "src", "auth-middleware.ts")).href);
    const { coachRouter } = await import(pathToFileURL(join(process.cwd(), "src", "coach-router.ts")).href);
    const legacyApp = express();
    legacyApp.use(express.json());
    legacyApp.use(parseAuth);
    legacyApp.use("/guto/coach", coachRouter);

    const legacyServer = await new Promise<Server>((resolve) => {
      const listeningServer = legacyApp.listen(0, () => resolve(listeningServer));
    });

    try {
      const address = legacyServer.address();
      if (!address || typeof address === "string") throw new Error("Failed to bind legacy test server.");

      const response = await fetch(`http://127.0.0.1:${address.port}/guto/coach/nuke-all`, {
        method: "POST",
        headers: { Authorization: `Bearer ${signTestToken("coach")}` },
      });

      assert.equal(response.status, 403);
    } finally {
      await new Promise<void>((resolve, reject) => {
        legacyServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

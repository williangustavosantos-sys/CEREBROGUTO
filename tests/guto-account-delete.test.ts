import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import {
  getUserAccess,
  writeUserAccessStoreRaw,
  type UserAccess,
} from "../src/user-access-store.js";
import { GUTO_CORE_TEAM_ID } from "../src/team-store.js";

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.account-delete-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";

function makeAccess(userId: string, role: UserAccess["role"], patch: Partial<UserAccess> = {}): UserAccess {
  const now = new Date().toISOString();
  return {
    userId,
    role,
    coachId: role === "student" ? "coach-test" : userId,
    teamId: GUTO_CORE_TEAM_ID,
    active: true,
    visibleInArena: true,
    archived: false,
    createdAt: now,
    updatedAt: now,
    subscriptionStatus: "active",
    subscriptionEndsAt: null,
    ...patch,
  };
}

function tokenFor(user: UserAccess): string {
  return jwt.sign(
    { userId: user.userId, role: user.role, coachId: user.coachId },
    process.env.JWT_SECRET || "dev-secret-change-in-production"
  );
}

async function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

before(async () => {
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  process.env.GUTO_DISABLE_LISTEN = "1";

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  app = serverModule.app;

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(testMemoryFile, { force: true });
});

describe("DELETE /guto/account (self-service)", () => {
  beforeEach(() => {
    const student = makeAccess("student-self-delete", "student");
    const coach = makeAccess("coach-self-delete", "coach");
    const admin = makeAccess("admin-self-delete", "admin");
    writeUserAccessStoreRaw({
      users: {
        [student.userId]: student,
        [coach.userId]: coach,
        [admin.userId]: admin,
      },
    });
  });

  it("requires authentication", async () => {
    const response = await request("/guto/account", { method: "DELETE" });
    assert.equal(response.status, 401);
  });

  it("rejects without confirmation body", async () => {
    const student = makeAccess("student-self-delete", "student");
    const response = await request("/guto/account", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenFor(student)}` },
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "GUTO_DELETE_CONFIRMATION_REQUIRED");
  });

  it("rejects with wrong confirmation string", async () => {
    const student = makeAccess("student-self-delete", "student");
    const response = await request("/guto/account", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${tokenFor(student)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation: "delete" }),
    });
    assert.equal(response.status, 400);
  });

  it("rejects coach role even with valid confirmation", async () => {
    const coach = makeAccess("coach-self-delete", "coach");
    const response = await request("/guto/account", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${tokenFor(coach)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation: "EXCLUIR" }),
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "GUTO_DELETE_NOT_STUDENT");
    assert.ok(getUserAccess(coach.userId), "coach access should not be deleted");
  });

  it("rejects admin role even with valid confirmation", async () => {
    const admin = makeAccess("admin-self-delete", "admin");
    const response = await request("/guto/account", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${tokenFor(admin)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation: "EXCLUIR" }),
    });
    assert.equal(response.status, 403);
    assert.ok(getUserAccess(admin.userId), "admin access should not be deleted");
  });

  it("deletes student account with valid confirmation and revokes access", async () => {
    const student = makeAccess("student-self-delete", "student");
    assert.ok(getUserAccess(student.userId), "precondition: student exists");

    const deleteResponse = await request("/guto/account", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${tokenFor(student)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation: "EXCLUIR" }),
    });
    assert.equal(deleteResponse.status, 204);
    assert.ok(!getUserAccess(student.userId), "student access should be removed");
    // Note: in production, GUTO_ALLOW_DEV_ACCESS is false, so a follow-up request
    // with the same JWT returns 403. In tests dev access is on, so the follow-up
    // would get a synthetic student record — we only verify the storage cleared.
  });
});

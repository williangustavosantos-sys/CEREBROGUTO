import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import {
  assertTeamPlanCapacity,
  createTeam,
  getTeamPlanUsage,
  GutoTeamPlanLimitError,
} from "../src/team-store.js";
import {
  getUserAccess,
  writeUserAccessStoreRaw,
  type UserAccess,
} from "../src/user-access-store.js";

const tmpDir = join(process.cwd(), "tmp");
const userAccessFile = join(tmpDir, "user-access.json");
const testMemoryFile = join(tmpDir, "guto-memory.team-limits-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalUserAccess: string | null = null;

function access(userId: string, role: UserAccess["role"], teamId: string, patch: Partial<UserAccess> = {}): UserAccess {
  const now = new Date().toISOString();
  return {
    userId,
    role,
    coachId: role === "coach" ? userId : patch.coachId || "coach-start-1",
    teamId,
    active: true,
    visibleInArena: role === "student",
    archived: false,
    createdAt: now,
    updatedAt: now,
    subscriptionStatus: "active",
    subscriptionEndsAt: null,
    ...patch,
  };
}

function seedTeams(): void {
  const now = new Date().toISOString();
  createTeam({ id: "TEAM_START_LIMIT", name: "Start Limit", plan: "start", status: "active", createdAt: now, updatedAt: now });
  createTeam({ id: "TEAM_PRO_LIMIT", name: "Pro Limit", plan: "pro", status: "active", createdAt: now, updatedAt: now });
  createTeam({ id: "TEAM_ELITE_LIMIT", name: "Elite Limit", plan: "elite", status: "active", createdAt: now, updatedAt: now });
  createTeam({
    id: "TEAM_CUSTOM_LIMIT",
    name: "Custom Limit",
    plan: "custom",
    customLimits: { maxCoaches: 8, maxStudents: 120 },
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

function seedFullStartTeam(): void {
  const users: Record<string, UserAccess> = {
    "admin-start-limit": access("admin-start-limit", "admin", "TEAM_START_LIMIT"),
    "coach-start-1": access("coach-start-1", "coach", "TEAM_START_LIMIT"),
    "coach-start-2": access("coach-start-2", "coach", "TEAM_START_LIMIT"),
  };
  for (let i = 1; i <= 20; i += 1) {
    users[`student-start-${i}`] = access(`student-start-${i}`, "student", "TEAM_START_LIMIT", {
      coachId: i <= 10 ? "coach-start-1" : "coach-start-2",
    });
  }
  writeUserAccessStoreRaw({ users });
}

function token(userId: string, role: UserAccess["role"] = "admin"): string {
  return jwt.sign(
    { userId, role, coachId: userId },
    process.env.JWT_SECRET || "dev-secret-change-in-production"
  );
}

async function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

before(async () => {
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  mkdirSync(tmpDir, { recursive: true });
  originalUserAccess = existsSync(userAccessFile) ? readFileSync(userAccessFile, "utf8") : null;

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  app = serverModule.app;
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind team limits test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  seedTeams();
  seedFullStartTeam();
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (originalUserAccess === null) rmSync(userAccessFile, { force: true });
  else writeFileSync(userAccessFile, originalUserAccess);
  rmSync(testMemoryFile, { force: true });
});

describe("GUTO Time plan capacity helpers", () => {
  it("reports official plan limits for Start, Pro, Elite and Custom", () => {
    const users = Object.values({
      startCoach: access("start-coach", "coach", "TEAM_START_LIMIT"),
      proCoach: access("pro-coach", "coach", "TEAM_PRO_LIMIT"),
      eliteCoach: access("elite-coach", "coach", "TEAM_ELITE_LIMIT"),
      customCoach: access("custom-coach", "coach", "TEAM_CUSTOM_LIMIT"),
    });

    assert.deepEqual(
      [
        getTeamPlanUsage("TEAM_START_LIMIT", users).maxCoaches,
        getTeamPlanUsage("TEAM_START_LIMIT", users).maxStudents,
        getTeamPlanUsage("TEAM_PRO_LIMIT", users).maxCoaches,
        getTeamPlanUsage("TEAM_PRO_LIMIT", users).maxStudents,
        getTeamPlanUsage("TEAM_ELITE_LIMIT", users).maxCoaches,
        getTeamPlanUsage("TEAM_ELITE_LIMIT", users).maxStudents,
        getTeamPlanUsage("TEAM_CUSTOM_LIMIT", users).maxCoaches,
        getTeamPlanUsage("TEAM_CUSTOM_LIMIT", users).maxStudents,
      ],
      [2, 20, 4, 50, 6, 70, 8, 120]
    );
  });

  it("blocks Start when coach or student capacity is full", () => {
    const allUsers = Array.from({ length: 20 }, (_, index) =>
      access(`student-full-${index}`, "student", "TEAM_START_LIMIT")
    ).concat([
      access("coach-full-1", "coach", "TEAM_START_LIMIT"),
      access("coach-full-2", "coach", "TEAM_START_LIMIT"),
    ]);

    assert.throws(
      () => assertTeamPlanCapacity("TEAM_START_LIMIT", "student", allUsers),
      (error) => error instanceof GutoTeamPlanLimitError && error.subject === "student"
    );
    assert.throws(
      () => assertTeamPlanCapacity("TEAM_START_LIMIT", "coach", allUsers),
      (error) => error instanceof GutoTeamPlanLimitError && error.subject === "coach"
    );
  });

  it("does not count archived users against plan capacity", () => {
    const users = Array.from({ length: 20 }, (_, index) =>
      access(`student-archived-${index}`, "student", "TEAM_START_LIMIT", {
        archived: index === 0,
      })
    );

    const usage = assertTeamPlanCapacity("TEAM_START_LIMIT", "student", users);
    assert.equal(usage.students, 19);
  });
});

describe("GUTO Time plan capacity HTTP routes", () => {
  it("blocks student creation when the Time reached maxStudents", async () => {
    const response = await request("/admin/students", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token("admin-start-limit")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "student-over-limit",
        firstName: "Aluno",
        lastName: "Extra",
        email: "student-over-limit@guto.test",
        phone: "+390212345678",
        teamId: "TEAM_START_LIMIT",
      }),
    });

    assert.equal(response.status, 409);
    const body = (await response.json()) as { code?: string; subject?: string };
    assert.equal(body.code, "GUTO_TEAM_PLAN_LIMIT_REACHED");
    assert.equal(body.subject, "student");
    assert.equal(getUserAccess("student-over-limit"), undefined);
  });

  it("blocks coach creation when the Time reached maxCoaches", async () => {
    const response = await request("/admin/coaches", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token("admin-start-limit")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "coach-over-limit",
        name: "Coach Extra",
        email: "coach-extra@guto.test",
        teamId: "TEAM_START_LIMIT",
      }),
    });

    assert.equal(response.status, 409);
    const body = (await response.json()) as { code?: string; subject?: string };
    assert.equal(body.code, "GUTO_TEAM_PLAN_LIMIT_REACHED");
    assert.equal(body.subject, "coach");
    assert.equal(getUserAccess("coach-over-limit"), undefined);
  });
});

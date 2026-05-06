import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import {
  assertCanAccessUserAccess,
  canAccessUserAccess,
  getScopedUserAccessList,
  normalizeAccessTeamId,
} from "../src/auth-middleware.js";
import {
  getUserAccess,
  writeUserAccessStoreRaw,
  type UserAccess,
} from "../src/user-access-store.js";
import { GUTO_CORE_TEAM_ID, createTeam } from "../src/team-store.js";
import { config } from "../src/config.js";

const tmpDir = join(process.cwd(), "tmp");
const userAccessFile = join(tmpDir, "user-access.json");
const inviteFile = join(tmpDir, "invites.json");
const auditLogFile = join(tmpDir, "audit-logs.json");
const testMemoryFile = join(tmpDir, "guto-memory.team-isolation-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalUserAccess: string | null = null;
let originalInvites: string | null = null;
let originalAuditLogs: string | null = null;

const adminA = access("admin-team-a", "admin", "admin-team-a", "TEAM_A");
const adminB = access("admin-team-b", "admin", "admin-team-b", "TEAM_B");
const coachA = access("coach-team-a", "coach", "coach-team-a", "TEAM_A");
const coachOtherA = access("coach-other-team-a", "coach", "coach-other-team-a", "TEAM_A");
const coachB = access("coach-team-b", "coach", "coach-team-b", "TEAM_B");
const studentA = access("student-team-a", "student", coachA.userId, "TEAM_A");
const studentOtherCoachA = access("student-other-coach-a", "student", coachOtherA.userId, "TEAM_A");
const studentB = access("student-team-b", "student", coachB.userId, "TEAM_B");
const archivedStudentA = access("student-archived-team-a", "student", coachA.userId, "TEAM_A", { archived: true });
const legacyCoreStudent = access("legacy-core-student", "student", "legacy-coach", undefined);
const coreAdmin = access("core-admin", "admin", "core-admin", undefined);

function access(userId: string, role: UserAccess["role"], coachId: string, teamId?: string, patch: Partial<UserAccess> = {}): UserAccess {
  const now = new Date().toISOString();
  return {
    userId,
    role,
    coachId,
    teamId,
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

function seedTeams(): void {
  const now = new Date().toISOString();
  createTeam({ id: "TEAM_A", name: "Time A", plan: "pro", status: "active", createdAt: now, updatedAt: now });
  createTeam({ id: "TEAM_B", name: "Time B", plan: "pro", status: "active", createdAt: now, updatedAt: now });
}

function seedAccessStore(): void {
  writeUserAccessStoreRaw({
    users: {
      [adminA.userId]: adminA,
      [adminB.userId]: adminB,
      [coachA.userId]: coachA,
      [coachOtherA.userId]: coachOtherA,
      [coachB.userId]: coachB,
      [studentA.userId]: studentA,
      [studentOtherCoachA.userId]: studentOtherCoachA,
      [studentB.userId]: studentB,
      [archivedStudentA.userId]: archivedStudentA,
      [legacyCoreStudent.userId]: legacyCoreStudent,
      [coreAdmin.userId]: coreAdmin,
    },
  });
}

function token(user: UserAccess): string {
  return jwt.sign(
    { userId: user.userId, role: user.role, coachId: user.coachId },
    process.env.JWT_SECRET || "dev-secret-change-in-production"
  );
}

function superToken(): string {
  return jwt.sign(
    { userId: "super-admin-team-test", role: "super_admin" },
    process.env.JWT_SECRET || "dev-secret-change-in-production"
  );
}

async function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

before(async () => {
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  config.memoryFile = testMemoryFile;
  mkdirSync(tmpDir, { recursive: true });
  originalUserAccess = existsSync(userAccessFile) ? readFileSync(userAccessFile, "utf8") : null;
  originalInvites = existsSync(inviteFile) ? readFileSync(inviteFile, "utf8") : null;
  originalAuditLogs = existsSync(auditLogFile) ? readFileSync(auditLogFile, "utf8") : null;

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  app = serverModule.app;

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind team isolation test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  seedTeams();
  seedAccessStore();
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (originalUserAccess === null) rmSync(userAccessFile, { force: true });
  else writeFileSync(userAccessFile, originalUserAccess);
  if (originalInvites === null) rmSync(inviteFile, { force: true });
  else writeFileSync(inviteFile, originalInvites);
  if (originalAuditLogs === null) rmSync(auditLogFile, { force: true });
  else writeFileSync(auditLogFile, originalAuditLogs);
  rmSync(testMemoryFile, { force: true });
});

describe("GUTO Time isolation helpers", () => {
  it("allows admin of Team A to access a Team A student", () => {
    assert.equal(canAccessUserAccess(adminA, studentA), true);
  });

  it("blocks admin of Team A from accessing a Team B student", () => {
    assert.equal(canAccessUserAccess(adminA, studentB), false);
    assert.throws(() => assertCanAccessUserAccess(adminA, studentB), /Time sem permissão/);
  });

  it("allows coach of Team A to access a linked Team A student", () => {
    assert.equal(canAccessUserAccess(coachA, studentA), true);
  });

  it("blocks coach from accessing another coach's student in the same Team", () => {
    assert.equal(canAccessUserAccess(coachA, studentOtherCoachA), false);
  });

  it("blocks coach from accessing a Team B student even with matching payload attempts elsewhere", () => {
    assert.equal(canAccessUserAccess(coachA, studentB), false);
  });

  it("allows super_admin to access any Time", () => {
    assert.equal(canAccessUserAccess({ userId: "super", role: "super_admin", coachId: "super" }, studentB), true);
  });

  it("blocks student from administrative access", () => {
    assert.equal(canAccessUserAccess(studentA, studentA), false);
  });

  it("scopes admin listing to the actor teamId", () => {
    const scoped = getScopedUserAccessList(adminA, [adminA, adminB, coachA, studentA, studentB]);
    assert.deepEqual(scoped.map((user) => user.userId).sort(), [adminA.userId, coachA.userId, studentA.userId].sort());
  });

  it("scopes coach listing to linked students only", () => {
    const scoped = getScopedUserAccessList(coachA, [coachA, studentA, studentOtherCoachA, studentB]);
    assert.deepEqual(scoped.map((user) => user.userId), [studentA.userId]);
  });

  it("treats legacy users without teamId as GUTO_CORE without opening global access", () => {
    assert.equal(normalizeAccessTeamId(legacyCoreStudent.teamId), GUTO_CORE_TEAM_ID);
    assert.equal(canAccessUserAccess(coreAdmin, legacyCoreStudent), true);
    assert.equal(canAccessUserAccess(coreAdmin, studentA), false);
  });
});

describe("GUTO Time isolation HTTP routes", () => {
  it("returns team summary for admin with official plan limits and ignores archived users", async () => {
    const response = await request("/admin/team/summary", {
      headers: { Authorization: `Bearer ${token(adminA)}` },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      team: { id: string; name: string; planLabel: string };
      limits: { maxStudents: number; maxCoaches: number };
      usage: { students: number; coaches: number };
    };
    assert.equal(body.team.id, "TEAM_A");
    assert.equal(body.team.name, "Time A");
    assert.equal(body.team.planLabel, "GUTO Time Pro");
    assert.equal(body.limits.maxStudents, 50);
    assert.equal(body.limits.maxCoaches, 4);
    assert.equal(body.usage.students, 2);
    assert.equal(body.usage.coaches, 2);
  });

  it("returns team summary for coach scoped to the coach Time", async () => {
    const response = await request("/admin/team/summary", {
      headers: { Authorization: `Bearer ${token(coachA)}` },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { team: { id: string }; usage: { students: number; coaches: number } };
    assert.equal(body.team.id, "TEAM_A");
    assert.equal(body.usage.students, 2);
    assert.equal(body.usage.coaches, 2);
  });

  it("blocks student tokens from team summary", async () => {
    const response = await request("/admin/team/summary", {
      headers: { Authorization: `Bearer ${token(studentA)}` },
    });

    assert.equal(response.status, 403);
  });

  it("blocks admin from requesting another Time summary", async () => {
    const response = await request("/admin/team/summary?teamId=TEAM_B", {
      headers: { Authorization: `Bearer ${token(adminA)}` },
    });

    assert.equal(response.status, 403);
  });

  it("returns only same-team users for admin listing", async () => {
    const response = await request("/admin/students", {
      headers: { Authorization: `Bearer ${token(adminA)}` },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { students: UserAccess[]; users: UserAccess[] };
    assert.deepEqual(body.students.map((user) => user.userId).sort(), [studentA.userId, studentOtherCoachA.userId, archivedStudentA.userId].sort());
    assert.equal(body.users.some((user) => user.userId === studentB.userId), false);
  });

  it("filters students without leaking another Time", async () => {
    const response = await request(`/admin/students?search=${studentB.userId}`, {
      headers: { Authorization: `Bearer ${token(adminA)}` },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { students: UserAccess[] };
    assert.equal(body.students.length, 0);
  });

  it("keeps coach filters scoped to the coach's own students", async () => {
    const response = await request(`/admin/students?coachId=${coachOtherA.userId}`, {
      headers: { Authorization: `Bearer ${token(coachA)}` },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { students: UserAccess[] };
    assert.equal(body.students.length, 0);
  });

  it("blocks admin from reading a student in another Time", async () => {
    const response = await request(`/admin/students/${studentB.userId}`, {
      headers: { Authorization: `Bearer ${token(adminA)}` },
    });

    assert.equal(response.status, 403);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "TEAM_ACCESS_FORBIDDEN");
  });

  it("allows super_admin to read a student in any Time", async () => {
    const response = await request(`/admin/students/${studentB.userId}`, {
      headers: { Authorization: `Bearer ${superToken()}` },
    });

    assert.equal(response.status, 200);
  });

  it("blocks student tokens from administrative routes", async () => {
    const response = await request("/admin/students", {
      headers: { Authorization: `Bearer ${token(studentA)}` },
    });

    assert.equal(response.status, 403);
  });

  it("forces admin-created students into the admin teamId", async () => {
    const response = await request("/admin/students", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token(adminA)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: "created-by-admin-a", name: "Aluno Admin", teamId: "TEAM_A" }),
    });

    assert.equal(response.status, 201);
    assert.equal(getUserAccess("created-by-admin-a")?.teamId, "TEAM_A");
  });

  it("rejects admin attempts to create students in another teamId", async () => {
    const response = await request("/admin/students", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token(adminA)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: "admin-cross-team-create", name: "Bypass", teamId: "TEAM_B" }),
    });

    assert.equal(response.status, 403);
    assert.equal(getUserAccess("admin-cross-team-create"), undefined);
  });

  it("forces coach-created students into the coach teamId and coachId", async () => {
    const response = await request("/admin/students", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token(coachA)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: "created-by-coach-a", name: "Aluno Coach", teamId: "TEAM_A" }),
    });

    assert.equal(response.status, 201);
    const created = getUserAccess("created-by-coach-a");
    assert.equal(created?.teamId, "TEAM_A");
    assert.equal(created?.coachId, coachA.userId);
  });

  it("rejects coach attempts to create students for another coach", async () => {
    const response = await request("/admin/students", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token(coachA)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: "coach-cross-coach-create", name: "Bypass", coachId: coachOtherA.userId }),
    });

    assert.equal(response.status, 403);
    assert.equal(getUserAccess("coach-cross-coach-create"), undefined);
  });
});

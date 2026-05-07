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

describe("GUTO Phase 5 – admin team operations", () => {
  // A) super_admin creates a team
  it("allows super_admin to create a team", async () => {
    const response = await request("/admin/teams", {
      method: "POST",
      headers: { Authorization: `Bearer ${superToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Novo Time Beta", plan: "pro" }),
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as { team: { id: string; name: string; plan: string } };
    assert.equal(body.team.name, "Novo Time Beta");
    assert.equal(body.team.plan, "pro");
    assert.ok(body.team.id.startsWith("team-"));
  });

  // B) admin common cannot create a team
  it("rejects admin from creating a team", async () => {
    const response = await request("/admin/teams", {
      method: "POST",
      headers: { Authorization: `Bearer ${token(adminA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bypass Team", plan: "start" }),
    });

    assert.equal(response.status, 403);
  });

  // C) super_admin creates student with explicit teamId
  it("allows super_admin to create a student in a specific team", async () => {
    const response = await request("/admin/students", {
      method: "POST",
      headers: { Authorization: `Bearer ${superToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "super-created-student", name: "Aluno Super", teamId: "TEAM_A" }),
    });

    assert.equal(response.status, 201);
    assert.equal(getUserAccess("super-created-student")?.teamId, "TEAM_A");
  });

  // D) admin creates student in own team
  it("allows admin to create a student in their own team (teamId implicit)", async () => {
    const response = await request("/admin/students", {
      method: "POST",
      headers: { Authorization: `Bearer ${token(adminA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "admin-own-team-student", name: "Aluno Proprio" }),
    });

    assert.equal(response.status, 201);
    assert.equal(getUserAccess("admin-own-team-student")?.teamId, "TEAM_A");
  });

  // E) admin cannot create student in another team
  it("rejects admin from creating a student in another team", async () => {
    const response = await request("/admin/students", {
      method: "POST",
      headers: { Authorization: `Bearer ${token(adminA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "admin-other-team-student", name: "Aluno Outro Time", teamId: "TEAM_B" }),
    });

    assert.equal(response.status, 403);
    assert.equal(getUserAccess("admin-other-team-student"), undefined);
  });

  // F) coach creates student in own team linked to themselves
  it("forces coach-created student into coach teamId and coachId", async () => {
    const response = await request("/admin/students", {
      method: "POST",
      headers: { Authorization: `Bearer ${token(coachA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "coach-own-student", name: "Aluno Coach Proprio" }),
    });

    assert.equal(response.status, 201);
    const created = getUserAccess("coach-own-student");
    assert.equal(created?.teamId, "TEAM_A");
    assert.equal(created?.coachId, coachA.userId);
  });

  // H) coach without teamId defaults safely to GUTO_CORE
  it("super_admin creates coach without explicit teamId and defaults to GUTO_CORE", async () => {
    const response = await request("/admin/coaches", {
      method: "POST",
      headers: { Authorization: `Bearer ${superToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Coach Sem Time", email: "coachsemtime@guto.test", password: "GUTOtest123" }),
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as { coach: { teamId?: string } };
    assert.ok(body.coach.teamId === "GUTO_CORE" || body.coach.teamId === undefined || !body.coach.teamId);
  });

  // I) plan full continues to block
  it("team/summary lists real plan limits (plan limit already tested in guto-team-limits.test.ts)", async () => {
    const response = await request("/admin/team/summary", {
      headers: { Authorization: `Bearer ${token(adminA)}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { limits: { maxStudents: number } };
    assert.ok(body.limits.maxStudents > 0);
  });

  // J) invite can be retrieved after creation
  it("allows admin to retrieve invite link for a newly created student", async () => {
    const createRes = await request("/admin/students", {
      method: "POST",
      headers: { Authorization: `Bearer ${token(adminA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "invite-student", name: "Aluno Convite" }),
    });
    assert.equal(createRes.status, 201);
    const { inviteLink: createdLink } = (await createRes.json()) as { inviteLink: string };
    assert.ok(createdLink.includes("/convite/"));

    const getRes = await request("/admin/students/invite-student/invite", {
      headers: { Authorization: `Bearer ${token(adminA)}` },
    });
    assert.equal(getRes.status, 200);
    const { inviteLink } = (await getRes.json()) as { inviteLink: string | null };
    assert.equal(inviteLink, createdLink);
  });

  // K) another team cannot retrieve invite
  it("blocks admin of another team from retrieving student invite", async () => {
    const createRes = await request("/admin/students", {
      method: "POST",
      headers: { Authorization: `Bearer ${token(adminA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "invite-student-b-block", name: "Aluno Block" }),
    });
    assert.equal(createRes.status, 201);

    const getRes = await request("/admin/students/invite-student-b-block/invite", {
      headers: { Authorization: `Bearer ${token(adminB)}` },
    });
    assert.equal(getRes.status, 403);
  });

  // L) password reset scoped correctly
  it("allows admin to generate a temporary password for their student", async () => {
    const createRes = await request("/admin/students", {
      method: "POST",
      headers: { Authorization: `Bearer ${token(adminA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "reset-pwd-student", name: "Aluno Reset" }),
    });
    assert.equal(createRes.status, 201);

    const resetRes = await request("/admin/students/reset-pwd-student/reset-password", {
      method: "POST",
      headers: { Authorization: `Bearer ${token(adminA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(resetRes.status, 200);
    const body = (await resetRes.json()) as { temporaryPassword?: string };
    assert.ok(body.temporaryPassword && body.temporaryPassword.startsWith("GUTO-"));
  });

  it("blocks admin from resetting password of a student in another team", async () => {
    const resetRes = await request(`/admin/students/${studentB.userId}/reset-password`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token(adminA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(resetRes.status, 403);
  });

  // invite regeneration
  it("allows admin to regenerate a student invite and invalidate the previous one", async () => {
    const createRes = await request("/admin/students", {
      method: "POST",
      headers: { Authorization: `Bearer ${token(adminA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "regen-invite-student", name: "Aluno Regen" }),
    });
    assert.equal(createRes.status, 201);
    const { inviteLink: originalLink } = (await createRes.json()) as { inviteLink: string };

    const regenRes = await request("/admin/students/regen-invite-student/invite/regenerate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token(adminA)}` },
    });
    assert.equal(regenRes.status, 200);
    const { inviteLink: newLink } = (await regenRes.json()) as { inviteLink: string };
    assert.ok(newLink.includes("/convite/"));
    assert.notEqual(newLink, originalLink);
  });

  // super_admin GET /admin/teams
  it("allows super_admin to list all teams", async () => {
    const response = await request("/admin/teams", {
      headers: { Authorization: `Bearer ${superToken()}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { teams: { id: string }[] };
    assert.ok(Array.isArray(body.teams));
    assert.ok(body.teams.some((t) => t.id === "TEAM_A"));
    assert.ok(body.teams.some((t) => t.id === "TEAM_B"));
  });

  it("returns only own team for admin when listing teams", async () => {
    const response = await request("/admin/teams", {
      headers: { Authorization: `Bearer ${token(adminA)}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { teams: { id: string }[] };
    assert.equal(body.teams.length, 1);
    assert.equal(body.teams[0].id, "TEAM_A");
  });

  it("rejects student tokens from listing teams", async () => {
    const response = await request("/admin/teams", {
      headers: { Authorization: `Bearer ${token(studentA)}` },
    });
    assert.equal(response.status, 403);
  });
});

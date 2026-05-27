import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import { getUserAccess, writeUserAccessStoreRaw, type UserAccess } from "../src/user-access-store.js";
import { createTeam } from "../src/team-store.js";
import { config } from "../src/config.js";

// Painel P0 — contrato de criação/convite de aluno.
// Cobre: nome soberano único, telefone opcional, email duplicado, criação de
// UserAccess, geração de convite vs senha temporária e escopo de coach.

const tmpDir = join(process.cwd(), "tmp");
const userAccessFile = join(tmpDir, "user-access.json");
const inviteFile = join(tmpDir, "invites.json");
const auditLogFile = join(tmpDir, "audit-logs.json");
const testMemoryFile = join(tmpDir, "guto-memory.panel-student-create-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalUserAccess: string | null = null;
let originalInvites: string | null = null;
let originalAuditLogs: string | null = null;

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

const adminA = access("admin-a", "admin", "admin-a", "TEAM_A");
const coachA = access("coach-a", "coach", "coach-a", "TEAM_A");
const coachOtherA = access("coach-other-a", "coach", "coach-other-a", "TEAM_A");
const coachB = access("coach-b", "coach", "coach-b", "TEAM_B");

function seedTeams(): void {
  const now = new Date().toISOString();
  createTeam({ id: "TEAM_A", name: "Time A", plan: "pro", status: "active", createdAt: now, updatedAt: now });
  createTeam({ id: "TEAM_B", name: "Time B", plan: "pro", status: "active", createdAt: now, updatedAt: now });
}

function seedAccessStore(): void {
  writeUserAccessStoreRaw({
    users: {
      [adminA.userId]: adminA,
      [coachA.userId]: coachA,
      [coachOtherA.userId]: coachOtherA,
      [coachB.userId]: coachB,
    },
  });
}

function token(user: UserAccess): string {
  return jwt.sign({ userId: user.userId, role: user.role, coachId: user.coachId }, config.jwtSecret);
}

function superToken(): string {
  return jwt.sign({ userId: "super-panel-test", role: "super_admin" }, config.jwtSecret);
}

function post(path: string, authToken: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string, authToken: string) {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${authToken}` } });
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
  if (!address || typeof address === "string") throw new Error("Failed to bind panel student-create test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  seedTeams();
  seedAccessStore();
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  writeFileSync(inviteFile, JSON.stringify({ invites: {} }, null, 2));
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

describe("Painel P0 — criar/convidar aluno", () => {
  it("coach cria aluno com nome único e sem telefone → 201, convite gerado, UserAccess criado", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Will Santos",
      email: "will.santos@guto.test",
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      user: UserAccess;
      inviteLink?: string;
      temporaryPassword?: string;
    };
    // Sem senha → convite, não senha temporária.
    assert.ok(body.inviteLink && body.inviteLink.length > 0, "deve retornar inviteLink");
    assert.equal(body.temporaryPassword, undefined);
    // UserAccess real criado, escopado ao time/coach do operador, e pendente.
    const created = getUserAccess(body.user.userId);
    assert.ok(created, "UserAccess deve existir");
    assert.equal(created!.role, "student");
    assert.equal(created!.teamId, "TEAM_A");
    assert.equal(created!.coachId, coachA.userId);
    assert.equal(created!.active, false);
    assert.equal(created!.email, "will.santos@guto.test");
  });

  it("aceita nome único de uma palavra (sobrenome opcional)", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Madonna",
      email: "madonna@guto.test",
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { user: UserAccess };
    const created = getUserAccess(body.user.userId);
    assert.ok(created, "UserAccess deve existir mesmo sem sobrenome");
    assert.equal(created!.role, "student");
  });

  it("com senha inicial → 201, senha temporária retornada, acesso ativo, sem convite", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Ana Lima",
      email: "ana.lima@guto.test",
      password: "GUTOtest123",
      active: true,
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { user: UserAccess; inviteLink?: string };
    const created = getUserAccess(body.user.userId);
    assert.ok(created, "UserAccess deve existir");
    assert.equal(created!.active, true);
    // Com senha definida não há link de convite ativo.
    assert.ok(!body.inviteLink, "não deve gerar convite quando senha foi definida");
  });

  it("email duplicado → 409 GUTO_EMAIL_DUPLICATE", async () => {
    const first = await post("/admin/students", token(coachA), {
      name: "Bruno Mendes",
      email: "duplicado@guto.test",
    });
    assert.equal(first.status, 201);

    const second = await post("/admin/students", token(coachA), {
      name: "Outro Nome",
      email: "duplicado@guto.test",
    });
    assert.equal(second.status, 409);
    const body = (await second.json()) as { code?: string };
    assert.equal(body.code, "GUTO_EMAIL_DUPLICATE");
  });

  it("email inválido → 400 GUTO_EMAIL_INVALID", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Sem Email",
      email: "nao-e-email",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "GUTO_EMAIL_INVALID");
  });

  it("telefone inválido (quando enviado) → 400 GUTO_PHONE_INVALID", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Telefone Ruim",
      email: "telefone.ruim@guto.test",
      phone: "123",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "GUTO_PHONE_INVALID");
  });

  it("coach não pode criar aluno para outro coach → 403 COACH_STUDENT_ACCESS_FORBIDDEN", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Aluno Alheio",
      email: "alheio@guto.test",
      coachId: coachOtherA.userId,
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "COACH_STUDENT_ACCESS_FORBIDDEN");
  });

  it("super_admin sem teamId → 400 GUTO_TEAM_REQUIRED", async () => {
    const response = await post("/admin/students", superToken(), {
      name: "Sem Time",
      email: "semtime@guto.test",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "GUTO_TEAM_REQUIRED");
  });

  it("super_admin cria aluno em empresa cliente SEM coach → 400 GUTO_COACH_REQUIRED", async () => {
    const response = await post("/admin/students", superToken(), {
      name: "Sem Coach",
      email: "semcoach@guto.test",
      teamId: "TEAM_A",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "GUTO_COACH_REQUIRED");
  });

  it("super_admin cria aluno com coach de OUTRO time → 403 TEAM_ACCESS_FORBIDDEN", async () => {
    const response = await post("/admin/students", superToken(), {
      name: "Coach Errado",
      email: "coacherrado@guto.test",
      teamId: "TEAM_A",
      coachId: coachB.userId,
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "TEAM_ACCESS_FORBIDDEN");
  });

  it("super_admin cria aluno em empresa cliente COM coach da empresa → 201, vinculado", async () => {
    const response = await post("/admin/students", superToken(), {
      name: "Aluno Vinculado",
      email: "vinculado@guto.test",
      teamId: "TEAM_A",
      coachId: coachA.userId,
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { user: UserAccess };
    const created = getUserAccess(body.user.userId);
    assert.equal(created!.teamId, "TEAM_A");
    assert.equal(created!.coachId, coachA.userId);
  });

  it("super_admin cria aluno em GUTO_CORE SEM coach → 201 (exceção documentada)", async () => {
    const response = await post("/admin/students", superToken(), {
      name: "Aluno Core",
      email: "alunocore@guto.test",
      teamId: "GUTO_CORE",
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { user: UserAccess };
    const created = getUserAccess(body.user.userId);
    assert.equal(created!.teamId, "GUTO_CORE");
  });

  it("convite criado é recuperável via GET /admin/students/:userId/invite", async () => {
    const create = await post("/admin/students", token(coachA), {
      name: "Convite Recuperavel",
      email: "convite.recuperavel@guto.test",
    });
    assert.equal(create.status, 201);
    const created = (await create.json()) as { user: UserAccess; inviteLink: string };

    const inviteRes = await get(`/admin/students/${created.user.userId}/invite`, token(coachA));
    assert.equal(inviteRes.status, 200);
    const inviteBody = (await inviteRes.json()) as { inviteLink: string | null };
    assert.equal(inviteBody.inviteLink, created.inviteLink);
  });
});

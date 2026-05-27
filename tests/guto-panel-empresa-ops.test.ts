import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import { getUserAccess, writeUserAccessStoreRaw, type UserAccess } from "../src/user-access-store.js";
import { createTeam, getTeam } from "../src/team-store.js";
import { config } from "../src/config.js";

// Painel Ops — cadastro operacional de empresa: campos de contato, validação,
// exclusão guardada e limpeza de empresas vazias; coach/aluno vinculados.

const tmpDir = join(process.cwd(), "tmp");
const userAccessFile = join(tmpDir, "user-access.json");
const inviteFile = join(tmpDir, "invites.json");
const auditLogFile = join(tmpDir, "audit-logs.json");
const teamsFile = join(tmpDir, "teams.json");
const testMemoryFile = join(tmpDir, "guto-memory.panel-empresa-ops-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalUserAccess: string | null = null;
let originalInvites: string | null = null;
let originalAuditLogs: string | null = null;
let originalTeams: string | null = null;

function access(userId: string, role: UserAccess["role"], coachId: string, teamId?: string, patch: Partial<UserAccess> = {}): UserAccess {
  const now = new Date().toISOString();
  return { userId, role, coachId, teamId, active: true, visibleInArena: true, archived: false, createdAt: now, updatedAt: now, subscriptionStatus: "active", subscriptionEndsAt: null, ...patch };
}

const adminA = access("admin-a", "admin", "admin-a", "TEAM_A");

function seedTeams(): void {
  const now = new Date().toISOString();
  createTeam({ id: "TEAM_A", name: "Time A", plan: "pro", status: "active", createdAt: now, updatedAt: now });
  createTeam({ id: "TEAM_EMPTY", name: "Time Vazio", plan: "start", status: "active", createdAt: now, updatedAt: now });
}

function seedAccessStore(): void {
  writeUserAccessStoreRaw({ users: { [adminA.userId]: adminA, "coach-a": access("coach-a", "coach", "coach-a", "TEAM_A"), "student-a": access("student-a", "student", "coach-a", "TEAM_A") } });
}

function superToken(): string { return jwt.sign({ userId: "super-ops-test", role: "super_admin" }, config.jwtSecret); }
function token(u: UserAccess): string { return jwt.sign({ userId: u.userId, role: u.role, coachId: u.coachId }, config.jwtSecret); }

function post(path: string, t: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function del(path: string, t: string) {
  return fetch(`${baseUrl}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${t}` } });
}

before(async () => {
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  config.memoryFile = testMemoryFile;
  mkdirSync(tmpDir, { recursive: true });
  originalUserAccess = existsSync(userAccessFile) ? readFileSync(userAccessFile, "utf8") : null;
  originalInvites = existsSync(inviteFile) ? readFileSync(inviteFile, "utf8") : null;
  originalAuditLogs = existsSync(auditLogFile) ? readFileSync(auditLogFile, "utf8") : null;
  originalTeams = existsSync(teamsFile) ? readFileSync(teamsFile, "utf8") : null;

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  app = serverModule.app;
  await new Promise<void>((resolve, reject) => { server = app.listen(0, "127.0.0.1", () => resolve()); server.once("error", reject); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind empresa-ops test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  seedTeams();
  seedAccessStore();
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  writeFileSync(inviteFile, JSON.stringify({ invites: {} }, null, 2));
});

after(async () => {
  await new Promise<void>((resolve, reject) => { server.close((e) => (e ? reject(e) : resolve())); });
  for (const [file, original] of [[userAccessFile, originalUserAccess], [inviteFile, originalInvites], [auditLogFile, originalAuditLogs], [teamsFile, originalTeams]] as const) {
    if (original === null) rmSync(file, { force: true });
    else writeFileSync(file, original);
  }
  rmSync(testMemoryFile, { force: true });
});

describe("Painel Ops — empresa", () => {
  it("super_admin cria empresa com dados de contato → 201 e campos persistidos", async () => {
    const res = await post("/admin/teams", superToken(), {
      name: "Action Fit", plan: "pro", email: "Contato@ActionFit.com", phone: "+55 11 98765-4321",
      addressLine: "Rua A, 100", city: "São Paulo", country: "Brasil", status: "active",
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { team: { id: string; email?: string; phone?: string; city?: string; status: string } };
    assert.equal(body.team.email, "contato@actionfit.com");
    assert.equal(body.team.city, "São Paulo");
    assert.equal(body.team.status, "active");
    assert.ok(getTeam(body.team.id)?.phone);
  });

  it("empresa com email inválido → 400 GUTO_EMAIL_INVALID", async () => {
    const res = await post("/admin/teams", superToken(), { name: "Bad Email Co", plan: "start", email: "nao-e-email" });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "GUTO_EMAIL_INVALID");
  });

  it("empresa sem email ainda é aceita (contato é opcional no backend) → 201", async () => {
    const res = await post("/admin/teams", superToken(), { name: "Sem Email Co", plan: "start" });
    assert.equal(res.status, 201);
  });

  it("coach criado dentro da empresa fica vinculado ao teamId → 201", async () => {
    const res = await post("/admin/coaches", superToken(), { name: "Bruno Coach", email: "bruno@actionfit.com", teamId: "TEAM_A" });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { coach: UserAccess };
    assert.equal(getUserAccess(body.coach.userId)?.teamId, "TEAM_A");
    assert.equal(getUserAccess(body.coach.userId)?.role, "coach");
  });

  it("aluno criado fica vinculado à empresa e ao coach → 201", async () => {
    const res = await post("/admin/students", superToken(), { name: "Will Santos", email: "will@exemplo.com", teamId: "TEAM_A", coachId: "coach-a" });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { user: UserAccess };
    const created = getUserAccess(body.user.userId);
    assert.equal(created?.teamId, "TEAM_A");
    assert.equal(created?.coachId, "coach-a");
  });

  it("DELETE empresa vazia → 200", async () => {
    const res = await del("/admin/teams/TEAM_EMPTY", superToken());
    assert.equal(res.status, 200);
    assert.equal(getTeam("TEAM_EMPTY"), undefined);
  });

  it("DELETE empresa com coaches/alunos → 409 GUTO_TEAM_NOT_EMPTY", async () => {
    const res = await del("/admin/teams/TEAM_A", superToken());
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, "GUTO_TEAM_NOT_EMPTY");
    assert.ok(getTeam("TEAM_A"), "empresa não-vazia não pode ser removida");
  });

  it("DELETE GUTO_CORE → 400 GUTO_CORE_PROTECTED", async () => {
    const res = await del("/admin/teams/GUTO_CORE", superToken());
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "GUTO_CORE_PROTECTED");
  });

  it("admin comum não pode deletar empresa → 403", async () => {
    const res = await del("/admin/teams/TEAM_EMPTY", token(adminA));
    assert.equal(res.status, 403);
    assert.ok(getTeam("TEAM_EMPTY"), "empresa permanece");
  });

  it("cleanup-empty-teams remove só os vazios, preserva GUTO_CORE e empresas com membros", async () => {
    const res = await post("/admin/maintenance/cleanup-empty-teams", superToken(), {});
    assert.equal(res.status, 200);
    const body = (await res.json()) as { removedCount: number; removed: { id: string }[] };
    assert.ok(body.removed.some((r) => r.id === "TEAM_EMPTY"), "TEAM_EMPTY deve ser removido");
    assert.equal(body.removed.some((r) => r.id === "TEAM_A"), false, "TEAM_A (com membros) preservado");
    assert.equal(body.removed.some((r) => r.id === "GUTO_CORE"), false, "GUTO_CORE preservado");
    assert.ok(getTeam("TEAM_A"));
    assert.equal(getTeam("TEAM_EMPTY"), undefined);
  });

  it("cleanup exige super_admin → 403 para admin comum", async () => {
    const res = await post("/admin/maintenance/cleanup-empty-teams", token(adminA), {});
    assert.equal(res.status, 403);
  });
});

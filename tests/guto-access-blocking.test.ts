import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import { writeUserAccessStoreRaw, type UserAccess } from "../src/user-access-store.js";
import { config } from "../src/config.js";

// Regressão do Item 15 (Fase 1): distinguir ACCESS_PAUSED de SUBSCRIPTION_EXPIRED.
// NÃO cobre morte/lockdown (GUTO_DECEASED) — fora de escopo.

const tmpDir = join(process.cwd(), "tmp");
const userAccessFile = join(tmpDir, "user-access.json");
const testMemoryFile = join(tmpDir, "guto-memory.access-blocking-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalUserAccess: string | null = null;

const PASSWORD = "senha-teste-123";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 8);

function access(userId: string, patch: Partial<UserAccess> = {}): UserAccess {
  const now = new Date().toISOString();
  return {
    userId,
    role: "student",
    coachId: "coach-access-test",
    teamId: "GUTO_CORE",
    active: true,
    visibleInArena: true,
    archived: false,
    createdAt: now,
    updatedAt: now,
    subscriptionStatus: "active",
    subscriptionEndsAt: null,
    email: `${userId}@guto.test`,
    passwordHash: PASSWORD_HASH,
    ...patch,
  };
}

const pastIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

const activeStudent = access("acc-active");
const pausedStudent = access("acc-paused", { active: false });
const archivedStudent = access("acc-archived", { archived: true });
const expiredStudent = access("acc-expired", { subscriptionStatus: "expired" });
const cancelledStudent = access("acc-cancelled", { subscriptionStatus: "cancelled" });
const endsPastStudent = access("acc-ends-past", { subscriptionEndsAt: pastIso });
const endsFutureStudent = access("acc-ends-future", { subscriptionEndsAt: futureIso });

function seedAccessStore(): void {
  writeUserAccessStoreRaw({
    users: {
      [activeStudent.userId]: activeStudent,
      [pausedStudent.userId]: pausedStudent,
      [archivedStudent.userId]: archivedStudent,
      [expiredStudent.userId]: expiredStudent,
      [cancelledStudent.userId]: cancelledStudent,
      [endsPastStudent.userId]: endsPastStudent,
      [endsFutureStudent.userId]: endsFutureStudent,
    },
  });
}

function token(user: UserAccess): string {
  return jwt.sign({ userId: user.userId, role: user.role, coachId: user.coachId }, config.jwtSecret);
}

async function getMemoryAs(user: UserAccess) {
  const res = await fetch(`${baseUrl}/guto/memory`, {
    headers: { Authorization: `Bearer ${token(user)}` },
  });
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  return { status: res.status, code: (body as { code?: string }).code };
}

async function login(emailOrId: string, password: string) {
  const res = await fetch(`${baseUrl}/auth/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emailOrId, password }),
  });
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  return { status: res.status, code: (body as { code?: string }).code };
}

before(async () => {
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  mkdirSync(tmpDir, { recursive: true });
  config.memoryFile = testMemoryFile;
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
  if (!address || typeof address === "string") throw new Error("Failed to bind access-blocking test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (originalUserAccess === null) rmSync(userAccessFile, { force: true });
  else writeFileSync(userAccessFile, originalUserAccess);
  rmSync(testMemoryFile, { force: true });
});

beforeEach(() => {
  seedAccessStore();
});

describe("Fase 1 / Item 15 — código de bloqueio de acesso (requireActiveUser)", () => {
  it("usuário ativo → 200 (sem bloqueio)", async () => {
    const r = await getMemoryAs(activeStudent);
    assert.equal(r.status, 200);
  });

  it("assinatura com fim futuro → 200 (sem bloqueio)", async () => {
    const r = await getMemoryAs(endsFutureStudent);
    assert.equal(r.status, 200);
  });

  it("usuário pausado (active:false) → 403 ACCESS_PAUSED", async () => {
    const r = await getMemoryAs(pausedStudent);
    assert.equal(r.status, 403);
    assert.equal(r.code, "ACCESS_PAUSED");
  });

  it("usuário arquivado → 403 ACCESS_PAUSED", async () => {
    const r = await getMemoryAs(archivedStudent);
    assert.equal(r.status, 403);
    assert.equal(r.code, "ACCESS_PAUSED");
  });

  it("assinatura expirada → 403 SUBSCRIPTION_EXPIRED", async () => {
    const r = await getMemoryAs(expiredStudent);
    assert.equal(r.status, 403);
    assert.equal(r.code, "SUBSCRIPTION_EXPIRED");
  });

  it("assinatura cancelada → 403 SUBSCRIPTION_EXPIRED", async () => {
    const r = await getMemoryAs(cancelledStudent);
    assert.equal(r.status, 403);
    assert.equal(r.code, "SUBSCRIPTION_EXPIRED");
  });

  it("subscriptionEndsAt no passado → 403 SUBSCRIPTION_EXPIRED", async () => {
    const r = await getMemoryAs(endsPastStudent);
    assert.equal(r.status, 403);
    assert.equal(r.code, "SUBSCRIPTION_EXPIRED");
  });
});

describe("Fase 1 / Item 15 — código de bloqueio no login (POST /auth/user/login)", () => {
  it("login de usuário pausado → 403 ACCESS_PAUSED", async () => {
    const r = await login(pausedStudent.email!, PASSWORD);
    assert.equal(r.status, 403);
    assert.equal(r.code, "ACCESS_PAUSED");
  });

  it("login de usuário expirado → 403 SUBSCRIPTION_EXPIRED", async () => {
    const r = await login(expiredStudent.email!, PASSWORD);
    assert.equal(r.status, 403);
    assert.equal(r.code, "SUBSCRIPTION_EXPIRED");
  });

  it("login de usuário cancelado → 403 SUBSCRIPTION_EXPIRED", async () => {
    const r = await login(cancelledStudent.email!, PASSWORD);
    assert.equal(r.status, 403);
    assert.equal(r.code, "SUBSCRIPTION_EXPIRED");
  });
});

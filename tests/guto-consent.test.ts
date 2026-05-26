import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import { writeUserAccessStoreRaw, type UserAccess } from "../src/user-access-store.js";
import { config } from "../src/config.js";

// Fase 2A — Consentimento: o ACEITE deve ser persistido no backend (não só localStorage).
// Mirror do padrão de guto-access-blocking.test.ts.

const tmpDir = join(process.cwd(), "tmp");
const userAccessFile = join(tmpDir, "user-access.json");
const testMemoryFile = join(tmpDir, "guto-memory.consent-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalUserAccess: string | null = null;

function access(userId: string, patch: Partial<UserAccess> = {}): UserAccess {
  const now = new Date().toISOString();
  return {
    userId,
    role: "student",
    coachId: "coach-consent-test",
    teamId: "GUTO_CORE",
    active: true,
    visibleInArena: true,
    archived: false,
    createdAt: now,
    updatedAt: now,
    subscriptionStatus: "active",
    subscriptionEndsAt: null,
    email: `${userId}@guto.test`,
    ...patch,
  };
}

const userA = access("consent-user-a");
const userB = access("consent-user-b");

function seedAccessStore(): void {
  writeUserAccessStoreRaw({ users: { [userA.userId]: userA, [userB.userId]: userB } });
}

function token(user: UserAccess): string {
  return jwt.sign({ userId: user.userId, role: user.role, coachId: user.coachId }, config.jwtSecret);
}

async function getMemory(user: UserAccess) {
  const res = await fetch(`${baseUrl}/guto/memory`, { headers: { Authorization: `Bearer ${token(user)}` } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

async function acceptConsent(user: UserAccess) {
  const res = await fetch(`${baseUrl}/guto/consent/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token(user)}` },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

async function revokeConsent(user: UserAccess) {
  const res = await fetch(`${baseUrl}/guto/consent/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token(user)}` },
  });
  return { status: res.status };
}

before(async () => {
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  mkdirSync(tmpDir, { recursive: true });
  config.memoryFile = testMemoryFile;
  originalUserAccess = existsSync(userAccessFile) ? readFileSync(userAccessFile, "utf8") : null;
  // Start from empty memory so users begin with NO consent.
  writeFileSync(testMemoryFile, JSON.stringify({}));

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  app = serverModule.app;

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind consent test server.");
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
  writeFileSync(testMemoryFile, JSON.stringify({}));
});

describe("Fase 2A — persistência do consentimento", () => {
  it("usuário sem consentimento NÃO é tratado como consentido", async () => {
    const { status, body } = await getMemory(userA);
    assert.equal(status, 200);
    assert.notEqual(body.consentHealthFitness, true);
    assert.notEqual(body.acceptedTerms, true);
  });

  it("aceitar consentimento salva no backend e retorna a memória consentida", async () => {
    const accepted = await acceptConsent(userA);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.consentHealthFitness, true);
    assert.equal(accepted.body.acceptedTerms, true);
    assert.equal(typeof accepted.body.consentAcceptedAt, "string");
  });

  it("GET /guto/memory reflete o consentimento aceito (equivale a reload)", async () => {
    await acceptConsent(userA);
    const { status, body } = await getMemory(userA);
    assert.equal(status, 200);
    assert.equal(body.consentHealthFitness, true);
    assert.equal(body.acceptedTerms, true);
    assert.equal(typeof body.consentAcceptedAt, "string");
  });

  it("revogar consentimento continua funcionando (flag volta a false)", async () => {
    await acceptConsent(userA);
    const revoked = await revokeConsent(userA);
    assert.equal(revoked.status, 204);
    const { body } = await getMemory(userA);
    assert.equal(body.consentHealthFitness, false);
    assert.equal(body.acceptedTerms, false);
  });

  it("re-consentir após revogar volta a true e limpa consentRevokedAt", async () => {
    await acceptConsent(userA);
    await revokeConsent(userA);
    const reaccepted = await acceptConsent(userA);
    assert.equal(reaccepted.status, 200);
    assert.equal(reaccepted.body.consentHealthFitness, true);
    assert.equal(reaccepted.body.consentRevokedAt, undefined);
  });

  it("aceite/revogação NÃO vazam entre usuários", async () => {
    await acceptConsent(userA);
    const b = await getMemory(userB);
    assert.notEqual(b.body.consentHealthFitness, true);
    assert.notEqual(b.body.acceptedTerms, true);
  });
});

import "./test-env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import bcrypt from "bcrypt";
import { V3AuthService, hashV3Token, type V3AuthCredential, type V3AuthPrincipal, type V3AuthStore } from "../src/v3/auth.js";
import { V3Error } from "../src/v3/errors.js";

type StoredSession = {
  credential: V3AuthCredential;
  tokenHash: string;
  expiresAt: Date;
  revoked: boolean;
};

class InMemoryV3AuthStore implements V3AuthStore {
  readonly credentials = new Map<string, V3AuthCredential>();
  readonly sessions = new Map<string, StoredSession>();

  async health(): Promise<{ ok: boolean; sessionUser: string; activeRole: string }> {
    return { ok: true, sessionUser: "test", activeRole: "guto_v3_auth" };
  }

  async findCredential(loginIdentifier: string): Promise<V3AuthCredential | null> {
    return this.credentials.get(loginIdentifier) || null;
  }

  async recordFailedLogin(credential: V3AuthCredential): Promise<void> {
    credential.failedAttempts += 1;
  }

  async recordSuccessfulLogin(credential: V3AuthCredential): Promise<void> {
    credential.failedAttempts = 0;
  }

  async createSession(input: {
    sessionId: string;
    credential: V3AuthCredential;
    tokenHash: string;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    this.sessions.set(input.sessionId, {
      credential: input.credential,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revoked: false,
    });
  }

  async validateSession(input: {
    sessionId: string;
    tenantId: string;
    userId: string;
    credentialVersion: number;
    tokenHash: string;
  }): Promise<V3AuthPrincipal | null> {
    const session = this.sessions.get(input.sessionId);
    if (
      !session || session.revoked || session.expiresAt.getTime() <= Date.now() ||
      session.tokenHash !== input.tokenHash ||
      session.credential.tenantId !== input.tenantId ||
      session.credential.userId !== input.userId ||
      session.credential.credentialVersion !== input.credentialVersion
    ) return null;
    const credential = session.credential;
    return {
      actor: {
        tenantId: credential.tenantId,
        userId: credential.userId,
        externalSubject: credential.externalSubject,
        role: credential.role,
      },
      identityId: credential.identityId,
      sessionId: input.sessionId,
      credentialVersion: credential.credentialVersion,
      displayName: credential.displayName,
      loginIdentifier: credential.loginIdentifier,
    };
  }

  async revokeSession(input: {
    sessionId: string;
    tenantId: string;
    userId: string;
    tokenHash: string;
    reason: string;
  }): Promise<boolean> {
    const session = this.sessions.get(input.sessionId);
    if (
      !session || session.revoked || session.tokenHash !== input.tokenHash ||
      session.credential.tenantId !== input.tenantId || session.credential.userId !== input.userId
    ) return false;
    session.revoked = true;
    return true;
  }
}

const config = {
  secret: "v3-test-secret-that-is-longer-than-thirty-two-bytes",
  issuer: "guto-cerebro-v3-test",
  audience: "guto-cerebro-v3-preview-test",
  sessionTtlSeconds: 600,
};

async function credential(identifier: string, subject: string): Promise<V3AuthCredential> {
  return {
    tenantId: randomUUID(),
    userId: randomUUID(),
    identityId: randomUUID(),
    externalSubject: subject,
    loginIdentifier: identifier,
    passwordHash: await bcrypt.hash("senha-correta", 12),
    role: "student",
    status: "active",
    credentialVersion: 1,
    failedAttempts: 0,
    lockedUntil: null,
    displayName: subject,
  };
}

function isAuthError(code: string) {
  return (error: unknown) => error instanceof V3Error && error.code === code && error.status === 401;
}

test("V3 auth creates a PostgreSQL-authoritative session and logout revokes the same token", async () => {
  const store = new InMemoryV3AuthStore();
  const actor = await credential("fundador@example.com", "founder-v3");
  store.credentials.set(actor.loginIdentifier, actor);
  const auth = new V3AuthService(store, config);

  const login = await auth.login(" Fundador@Example.com ", "senha-correta");
  assert.equal(login.principal.actor.userId, actor.userId);
  assert.equal(login.principal.actor.externalSubject, "founder-v3");
  assert.equal(store.sessions.get(login.principal.sessionId)?.tokenHash, hashV3Token(login.token));

  const authenticated = await auth.authenticateHeader(`Bearer ${login.token}`);
  assert.equal(authenticated.principal.actor.userId, actor.userId);
  await auth.logout(authenticated);
  await assert.rejects(auth.authenticateToken(login.token), isAuthError("V3_AUTH_REQUIRED"));
});

test("V3 auth rejects legacy/wrong-audience tokens before consulting a valid session", async () => {
  const store = new InMemoryV3AuthStore();
  const actor = await credential("pessoa@example.com", "person-v3");
  store.credentials.set(actor.loginIdentifier, actor);
  const auth = new V3AuthService(store, config);
  const login = await auth.login(actor.loginIdentifier, "senha-correta");

  const wrongAuthority = new V3AuthService(store, { ...config, audience: "legacy-guto" });
  await assert.rejects(wrongAuthority.authenticateToken(login.token), isAuthError("V3_AUTH_REQUIRED"));
  await assert.rejects(auth.authenticateHeader(undefined), isAuthError("V3_AUTH_REQUIRED"));
});

test("V3 auth keeps simultaneous users and sessions isolated", async () => {
  const store = new InMemoryV3AuthStore();
  const actorA = await credential("a@example.com", "actor-a-v3");
  const actorB = await credential("b@example.com", "actor-b-v3");
  store.credentials.set(actorA.loginIdentifier, actorA);
  store.credentials.set(actorB.loginIdentifier, actorB);
  const auth = new V3AuthService(store, config);

  const [loginA, loginB] = await Promise.all([
    auth.login(actorA.loginIdentifier, "senha-correta"),
    auth.login(actorB.loginIdentifier, "senha-correta"),
  ]);
  const [authenticatedA, authenticatedB] = await Promise.all([
    auth.authenticateToken(loginA.token),
    auth.authenticateToken(loginB.token),
  ]);

  assert.equal(authenticatedA.principal.actor.userId, actorA.userId);
  assert.equal(authenticatedB.principal.actor.userId, actorB.userId);
  assert.notEqual(authenticatedA.principal.sessionId, authenticatedB.principal.sessionId);
  await auth.logout(authenticatedA);
  assert.equal((await auth.authenticateToken(loginB.token)).principal.actor.userId, actorB.userId);
});

test("unknown identifier and wrong password are indistinguishable", async () => {
  const store = new InMemoryV3AuthStore();
  const actor = await credential("known@example.com", "known-v3");
  store.credentials.set(actor.loginIdentifier, actor);
  const auth = new V3AuthService(store, config);

  const errors: V3Error[] = [];
  for (const attempt of [
    () => auth.login("missing@example.com", "senha-correta"),
    () => auth.login(actor.loginIdentifier, "senha-errada"),
  ]) {
    try {
      await attempt();
    } catch (error) {
      assert.ok(error instanceof V3Error);
      errors.push(error);
    }
  }
  assert.deepEqual(errors.map(({ code, status, message }) => ({ code, status, message })), [
    { code: "V3_INVALID_CREDENTIALS", status: 401, message: "Credenciais inválidas." },
    { code: "V3_INVALID_CREDENTIALS", status: 401, message: "Credenciais inválidas." },
  ]);
});

test("dummy credential uses the same bcrypt work factor as newly bootstrapped V3 credentials", () => {
  const authSource = readFileSync(new URL("../src/v3/auth.ts", import.meta.url), "utf8");
  const postgresAuthSource = readFileSync(new URL("../src/v3/postgres-auth.ts", import.meta.url), "utf8");
  assert.match(authSource, /DUMMY_BCRYPT_HASH = "\$2b\$12\$/);
  assert.match(postgresAuthSource, /bcrypt\.hash\([^,]+, 12\)/);
});

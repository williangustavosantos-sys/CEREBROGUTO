import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { ActorRole, ActorContext } from "./types.js";
import { V3Error } from "./errors.js";

export interface V3AuthCredential {
  tenantId: string;
  userId: string;
  identityId: string;
  externalSubject: string;
  loginIdentifier: string;
  passwordHash: string;
  role: ActorRole;
  status: "active" | "disabled" | "locked";
  credentialVersion: number;
  failedAttempts: number;
  lockedUntil: string | null;
  displayName?: string;
}

export interface V3AuthPrincipal {
  actor: ActorContext;
  identityId: string;
  sessionId: string;
  credentialVersion: number;
  displayName?: string;
  loginIdentifier: string;
}

export interface V3AuthStore {
  health(): Promise<{ ok: boolean; sessionUser: string; activeRole: string }>;
  findCredential(loginIdentifier: string): Promise<V3AuthCredential | null>;
  recordFailedLogin(credential: V3AuthCredential): Promise<void>;
  recordSuccessfulLogin(credential: V3AuthCredential): Promise<void>;
  createSession(input: {
    sessionId: string;
    credential: V3AuthCredential;
    tokenHash: string;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<void>;
  validateSession(input: {
    sessionId: string;
    tenantId: string;
    userId: string;
    credentialVersion: number;
    tokenHash: string;
  }): Promise<V3AuthPrincipal | null>;
  revokeSession(input: {
    sessionId: string;
    tenantId: string;
    userId: string;
    tokenHash: string;
    reason: string;
  }): Promise<boolean>;
}

export interface V3AuthConfig {
  secret: string;
  issuer: string;
  audience: string;
  sessionTtlSeconds: number;
}

export interface V3AuthResult {
  token: string;
  principal: V3AuthPrincipal;
}

type V3JwtClaims = JwtPayload & {
  uid: string;
  tid: string;
  sid: string;
  role: ActorRole;
  cv: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Keep the non-existent-user path at the same work factor as V3 bootstrap
// hashes so the generic 401 response is not undermined by a timing oracle.
const DUMMY_BCRYPT_HASH = "$2b$12$LwcXOgGVfaoyNRMnCoaFw.9dHb4m1vvAvjvF75pbSxQ1Q4czeoDpe";

export function normalizeV3LoginIdentifier(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function hashV3Token(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function readV3AuthConfigFromEnvironment(): V3AuthConfig {
  const secret = process.env.GUTO_V3_JWT_SECRET || "";
  if (secret.length < 32) {
    throw new V3Error("V3_AUTH_NOT_CONFIGURED", "Autenticação V3 não configurada.", 503);
  }
  const sessionTtlSeconds = Number(process.env.GUTO_V3_SESSION_TTL_SECONDS || 7 * 24 * 60 * 60);
  if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 300 || sessionTtlSeconds > 30 * 24 * 60 * 60) {
    throw new V3Error("V3_AUTH_INVALID_TTL", "TTL da sessão V3 inválido.", 503);
  }
  return {
    secret,
    issuer: process.env.GUTO_V3_JWT_ISSUER || "guto-cerebro-v3",
    audience: process.env.GUTO_V3_JWT_AUDIENCE || "guto-cerebro-v3-preview",
    sessionTtlSeconds,
  };
}

function invalidCredentials(): V3Error {
  return new V3Error("V3_INVALID_CREDENTIALS", "Credenciais inválidas.", 401);
}

function authRequired(): V3Error {
  return new V3Error("V3_AUTH_REQUIRED", "Autenticação necessária para o Cérebro V3.", 401);
}

function isLocked(credential: V3AuthCredential): boolean {
  if (credential.status !== "active") return true;
  return credential.lockedUntil !== null && Date.parse(credential.lockedUntil) > Date.now();
}

function parseClaims(value: string | JwtPayload): V3JwtClaims {
  if (typeof value === "string") throw authRequired();
  const role = value.role;
  if (
    typeof value.sub !== "string" || !value.sub.trim() ||
    typeof value.uid !== "string" || !UUID_PATTERN.test(value.uid) ||
    typeof value.tid !== "string" || !UUID_PATTERN.test(value.tid) ||
    typeof value.sid !== "string" || !UUID_PATTERN.test(value.sid) ||
    typeof value.cv !== "number" || !Number.isInteger(value.cv) || value.cv < 1 ||
    typeof role !== "string" || !["student", "coach", "admin", "super_admin"].includes(role)
  ) {
    throw authRequired();
  }
  return value as V3JwtClaims;
}

export class V3AuthService {
  constructor(
    private readonly store: V3AuthStore,
    private readonly config: V3AuthConfig,
  ) {}

  health(): Promise<{ ok: boolean; sessionUser: string; activeRole: string }> {
    return this.store.health();
  }

  async login(identifier: string, password: string): Promise<V3AuthResult> {
    const loginIdentifier = normalizeV3LoginIdentifier(identifier);
    if (loginIdentifier.length < 3 || loginIdentifier.length > 254 || !password || password.length > 512) {
      await bcrypt.compare(password || "", DUMMY_BCRYPT_HASH);
      throw invalidCredentials();
    }

    const credential = await this.store.findCredential(loginIdentifier);
    const candidateHash = credential?.passwordHash || DUMMY_BCRYPT_HASH;
    let candidateRounds = 0;
    try { candidateRounds = bcrypt.getRounds(candidateHash); } catch { /* compare below fails closed */ }
    const comparison = bcrypt.compare(password, candidateHash);
    // Preview may bootstrap an existing bcrypt-10 founder hash. Run canonical
    // bcrypt-12 work in parallel so that account is not distinguishable from an
    // unknown identifier or a newly bootstrapped bcrypt-12 credential.
    const matches = credential && candidateRounds < 12
      ? (await Promise.all([comparison, bcrypt.compare(password, DUMMY_BCRYPT_HASH)]))[0]
      : await comparison;
    if (!credential || !matches || isLocked(credential)) {
      if (credential && !isLocked(credential)) await this.store.recordFailedLogin(credential);
      throw invalidCredentials();
    }

    await this.store.recordSuccessfulLogin(credential);
    const sessionId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + this.config.sessionTtlSeconds * 1_000);
    const token = jwt.sign(
      {
        uid: credential.userId,
        tid: credential.tenantId,
        sid: sessionId,
        role: credential.role,
        cv: credential.credentialVersion,
      },
      this.config.secret,
      {
        algorithm: "HS256",
        issuer: this.config.issuer,
        audience: this.config.audience,
        subject: credential.externalSubject,
        expiresIn: this.config.sessionTtlSeconds,
      },
    );
    await this.store.createSession({
      sessionId,
      credential,
      tokenHash: hashV3Token(token),
      issuedAt,
      expiresAt,
    });
    return {
      token,
      principal: {
        actor: {
          tenantId: credential.tenantId,
          userId: credential.userId,
          externalSubject: credential.externalSubject,
          role: credential.role,
        },
        identityId: credential.identityId,
        sessionId,
        credentialVersion: credential.credentialVersion,
        displayName: credential.displayName,
        loginIdentifier: credential.loginIdentifier,
      },
    };
  }

  async authenticateToken(token: string): Promise<V3AuthResult> {
    if (!token) throw authRequired();
    let claims: V3JwtClaims;
    try {
      claims = parseClaims(jwt.verify(token, this.config.secret, {
        algorithms: ["HS256"],
        issuer: this.config.issuer,
        audience: this.config.audience,
      }));
    } catch (error) {
      if (error instanceof V3Error) throw error;
      throw authRequired();
    }
    const principal = await this.store.validateSession({
      sessionId: claims.sid,
      tenantId: claims.tid,
      userId: claims.uid,
      credentialVersion: claims.cv,
      tokenHash: hashV3Token(token),
    });
    if (!principal || principal.actor.externalSubject !== claims.sub || principal.actor.role !== claims.role) {
      throw authRequired();
    }
    return { token, principal };
  }

  async authenticateHeader(header: string | undefined): Promise<V3AuthResult> {
    if (!header?.startsWith("Bearer ")) throw authRequired();
    return this.authenticateToken(header.slice(7).trim());
  }

  async logout(auth: V3AuthResult): Promise<void> {
    const revoked = await this.store.revokeSession({
      sessionId: auth.principal.sessionId,
      tenantId: auth.principal.actor.tenantId,
      userId: auth.principal.actor.userId,
      tokenHash: hashV3Token(auth.token),
      reason: "user_logout",
    });
    if (!revoked) throw authRequired();
  }
}

declare global {
  namespace Express {
    interface Request {
      gutoV3Auth?: V3AuthResult;
    }
  }
}

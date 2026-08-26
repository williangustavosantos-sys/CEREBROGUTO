import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import pg, { type PoolClient } from "pg";
import { V3Error } from "./errors.js";
import {
  normalizeV3LoginIdentifier,
  type V3AuthCredential,
  type V3AuthPrincipal,
  type V3AuthStore,
} from "./auth.js";
import type { ActorRole } from "./types.js";

type CredentialRow = {
  tenant_id: string;
  user_id: string;
  identity_id: string;
  login_identifier: string;
  password_hash: string;
  role: ActorRole;
  status: V3AuthCredential["status"];
  credential_version: string | number;
  failed_attempts: number;
  locked_until: Date | string | null;
};

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function setAuthActorContext(
  client: PoolClient,
  input: { tenantId: string; userId: string; identityId?: string; sessionId?: string },
): Promise<void> {
  await client.query(
    `SELECT
       set_config('app.tenant_id', $1, true),
       set_config('app.user_id', $2, true),
       set_config('app.identity_id', $3, true),
       set_config('app.session_id', $4, true)`,
    [input.tenantId, input.userId, input.identityId || "", input.sessionId || ""],
  );
}

export class PostgresV3AuthStore implements V3AuthStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: { allowAdminConnection?: boolean } = {},
  ) {}

  private async withAuthTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (process.env.GUTO_V3_ONLY === "true" && !this.options.allowAdminConnection) {
        const roleResult = await client.query<{ session_user: string }>("SELECT session_user AS session_user");
        const expectedRole = process.env.GUTO_V3_RUNTIME_DB_ROLE || "guto_v3_runtime";
        if (roleResult.rows[0]?.session_user !== expectedRole) {
          throw new V3Error(
            "V3_DATABASE_RUNTIME_ROLE_REQUIRED",
            "A conexão runtime do Cérebro V3 não usa o papel restrito esperado.",
            503,
          );
        }
      }
      await client.query("SET LOCAL ROLE guto_v3_auth");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async health(): Promise<{ ok: boolean; sessionUser: string; activeRole: string }> {
    return this.withAuthTransaction(async (client) => {
      const result = await client.query<{
        session_user: string;
        active_role: string;
        credentials_table: string | null;
        sessions_table: string | null;
      }>(
        `SELECT session_user AS session_user,current_user AS active_role,
                to_regclass('guto_v3.auth_credentials')::text AS credentials_table,
                to_regclass('guto_v3.auth_sessions')::text AS sessions_table`,
      );
      const row = result.rows[0];
      return {
        ok: row?.active_role === "guto_v3_auth" && Boolean(row.credentials_table) && Boolean(row.sessions_table),
        sessionUser: row?.session_user || "unknown",
        activeRole: row?.active_role || "unknown",
      };
    });
  }

  async findCredential(loginIdentifier: string): Promise<V3AuthCredential | null> {
    return this.withAuthTransaction(async (client) => {
      const credentialResult = await client.query<CredentialRow>(
        `SELECT tenant_id,user_id,identity_id,login_identifier,password_hash,role,status,
                credential_version,failed_attempts,locked_until
           FROM guto_v3.auth_credentials
          WHERE login_identifier=$1`,
        [loginIdentifier],
      );
      const row = credentialResult.rows[0];
      if (!row) return null;
      await setAuthActorContext(client, {
        tenantId: row.tenant_id,
        userId: row.user_id,
        identityId: row.identity_id,
      });
      const actorResult = await client.query<{ external_subject: string; display_name: string | null }>(
        `SELECT i.external_subject,u.display_name
           FROM guto_v3.users u
           JOIN guto_v3.identities i ON i.id=u.identity_id AND i.tenant_id=u.tenant_id
          WHERE u.tenant_id=$1 AND u.id=$2 AND i.id=$3`,
        [row.tenant_id, row.user_id, row.identity_id],
      );
      const actor = actorResult.rows[0];
      if (!actor) throw new V3Error("V3_AUTH_IDENTITY_INTEGRITY", "Identidade V3 inconsistente.", 409);
      return {
        tenantId: row.tenant_id,
        userId: row.user_id,
        identityId: row.identity_id,
        externalSubject: actor.external_subject,
        loginIdentifier: row.login_identifier,
        passwordHash: row.password_hash,
        role: row.role,
        status: row.status,
        credentialVersion: Number(row.credential_version),
        failedAttempts: row.failed_attempts,
        lockedUntil: iso(row.locked_until),
        displayName: actor.display_name || undefined,
      };
    });
  }

  async recordFailedLogin(credential: V3AuthCredential): Promise<void> {
    await this.withAuthTransaction(async (client) => {
      await setAuthActorContext(client, credential);
      await client.query(
        `UPDATE guto_v3.auth_credentials
            SET failed_attempts=failed_attempts+1,
                locked_until=CASE
                  WHEN failed_attempts+1 >= $3 THEN now()+($4::int * interval '1 minute')
                  ELSE locked_until
                END
          WHERE tenant_id=$1 AND user_id=$2`,
        [credential.tenantId, credential.userId, MAX_FAILED_ATTEMPTS, LOCK_MINUTES],
      );
    });
  }

  async recordSuccessfulLogin(credential: V3AuthCredential): Promise<void> {
    await this.withAuthTransaction(async (client) => {
      await setAuthActorContext(client, credential);
      await client.query(
        `UPDATE guto_v3.auth_credentials
            SET failed_attempts=0,locked_until=NULL
          WHERE tenant_id=$1 AND user_id=$2`,
        [credential.tenantId, credential.userId],
      );
    });
  }

  async createSession(input: {
    sessionId: string;
    credential: V3AuthCredential;
    tokenHash: string;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    await this.withAuthTransaction(async (client) => {
      await setAuthActorContext(client, {
        tenantId: input.credential.tenantId,
        userId: input.credential.userId,
        identityId: input.credential.identityId,
        sessionId: input.sessionId,
      });
      await client.query(
        `INSERT INTO guto_v3.auth_sessions
          (id,tenant_id,user_id,identity_id,token_hash,credential_version,issued_at,last_seen_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
        [
          input.sessionId,
          input.credential.tenantId,
          input.credential.userId,
          input.credential.identityId,
          input.tokenHash,
          input.credential.credentialVersion,
          input.issuedAt,
          input.expiresAt,
        ],
      );
    });
  }

  async validateSession(input: {
    sessionId: string;
    tenantId: string;
    userId: string;
    credentialVersion: number;
    tokenHash: string;
  }): Promise<V3AuthPrincipal | null> {
    return this.withAuthTransaction(async (client) => {
      await setAuthActorContext(client, input);
      const sessionResult = await client.query<{
        identity_id: string;
        credential_version: string | number;
      }>(
        `SELECT identity_id,credential_version
           FROM guto_v3.auth_sessions
          WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND token_hash=$4
            AND credential_version=$5 AND revoked_at IS NULL AND expires_at>now()`,
        [input.sessionId, input.tenantId, input.userId, input.tokenHash, input.credentialVersion],
      );
      const session = sessionResult.rows[0];
      if (!session) return null;
      await setAuthActorContext(client, { ...input, identityId: session.identity_id });
      const principalResult = await client.query<{
        external_subject: string;
        display_name: string | null;
        login_identifier: string;
        role: ActorRole;
        credential_version: string | number;
      }>(
        `SELECT i.external_subject,u.display_name,c.login_identifier,c.role,c.credential_version
           FROM guto_v3.auth_credentials c
           JOIN guto_v3.users u ON u.tenant_id=c.tenant_id AND u.id=c.user_id
           JOIN guto_v3.identities i ON i.tenant_id=c.tenant_id AND i.id=c.identity_id
          WHERE c.tenant_id=$1 AND c.user_id=$2 AND c.identity_id=$3
            AND c.status='active' AND c.credential_version=$4`,
        [input.tenantId, input.userId, session.identity_id, input.credentialVersion],
      );
      const principal = principalResult.rows[0];
      if (!principal) return null;
      await client.query(
        `UPDATE guto_v3.auth_sessions
            SET last_seen_at=now(),version=version+1
          WHERE id=$1 AND last_seen_at<now()-interval '5 minutes'`,
        [input.sessionId],
      );
      return {
        actor: {
          tenantId: input.tenantId,
          userId: input.userId,
          externalSubject: principal.external_subject,
          role: principal.role,
        },
        identityId: session.identity_id,
        sessionId: input.sessionId,
        credentialVersion: Number(principal.credential_version),
        displayName: principal.display_name || undefined,
        loginIdentifier: principal.login_identifier,
      };
    });
  }

  async revokeSession(input: {
    sessionId: string;
    tenantId: string;
    userId: string;
    tokenHash: string;
    reason: string;
  }): Promise<boolean> {
    return this.withAuthTransaction(async (client) => {
      await setAuthActorContext(client, input);
      const result = await client.query(
        `UPDATE guto_v3.auth_sessions
            SET revoked_at=now(),revoked_reason=$5,version=version+1
          WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND token_hash=$4 AND revoked_at IS NULL`,
        [input.sessionId, input.tenantId, input.userId, input.tokenHash, input.reason],
      );
      return result.rowCount === 1;
    });
  }
}

export interface BootstrapV3AuthInput {
  tenantSlug: string;
  tenantName: string;
  loginIdentifier: string;
  displayName?: string;
  role?: ActorRole;
  status?: V3AuthCredential["status"];
  password?: string;
  passwordHash?: string;
}

export async function bootstrapV3AuthCredential(
  pool: pg.Pool,
  input: BootstrapV3AuthInput,
): Promise<{ tenantId: string; userId: string; identityId: string; created: boolean; credentialVersion: number }> {
  const loginIdentifier = normalizeV3LoginIdentifier(input.loginIdentifier);
  const tenantSlug = input.tenantSlug.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!tenantSlug || loginIdentifier.length < 3 || loginIdentifier.length > 254) {
    throw new V3Error("V3_AUTH_BOOTSTRAP_INVALID", "Bootstrap de autenticação V3 inválido.", 400);
  }
  if (Boolean(input.password) === Boolean(input.passwordHash)) {
    throw new V3Error("V3_AUTH_BOOTSTRAP_SECRET_INVALID", "Informe uma única credencial para o bootstrap V3.", 400);
  }
  if (input.password && input.password.length > 512) {
    throw new V3Error("V3_AUTH_BOOTSTRAP_SECRET_INVALID", "Credencial de bootstrap V3 inválida.", 400);
  }
  if (input.passwordHash && !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(input.passwordHash)) {
    throw new V3Error("V3_AUTH_BOOTSTRAP_SECRET_INVALID", "Hash de bootstrap V3 inválido.", 400);
  }
  if (input.passwordHash) {
    const rounds = bcrypt.getRounds(input.passwordHash);
    if (rounds < 10 || rounds > 12) {
      throw new V3Error("V3_AUTH_BOOTSTRAP_SECRET_INVALID", "Custo bcrypt de bootstrap V3 inválido.", 400);
    }
  }
  const desiredRole = input.role || "student";
  const desiredStatus = input.status || "active";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('guto_v3_auth_bootstrap'))");
    const tenantResult = await client.query<{ id: string }>(
      `INSERT INTO guto_v3.tenants (slug,name) VALUES ($1,$2)
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name
       RETURNING id`,
      [tenantSlug, input.tenantName.trim() || tenantSlug],
    );
    const tenantId = tenantResult.rows[0]!.id;
    const existingResult = await client.query<CredentialRow>(
      `SELECT tenant_id,user_id,identity_id,login_identifier,password_hash,role,status,
              credential_version,failed_attempts,locked_until
         FROM guto_v3.auth_credentials WHERE login_identifier=$1`,
      [loginIdentifier],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.tenant_id !== tenantId) {
        throw new V3Error("V3_AUTH_IDENTIFIER_TENANT_CONFLICT", "Identificador já pertence a outro tenant.", 409);
      }
      const passwordMatches = input.password
        ? await bcrypt.compare(input.password, existing.password_hash)
        : input.passwordHash === existing.password_hash;
      const authorityChanged = !passwordMatches || existing.role !== desiredRole || existing.status !== desiredStatus;
      const nextHash = passwordMatches
        ? existing.password_hash
        : input.passwordHash || await bcrypt.hash(input.password!, 12);
      const updated = await client.query<{ credential_version: string | number }>(
        `UPDATE guto_v3.auth_credentials
            SET password_hash=$1,role=$2,status=$3,
                credential_version=credential_version+CASE WHEN $4::boolean THEN 1 ELSE 0 END,
                failed_attempts=0,locked_until=NULL
          WHERE tenant_id=$5 AND user_id=$6
          RETURNING credential_version`,
        [nextHash, desiredRole, desiredStatus, authorityChanged, tenantId, existing.user_id],
      );
      const credentialVersion = Number(updated.rows[0]!.credential_version);
      if (authorityChanged) {
        await client.query(
          `UPDATE guto_v3.auth_sessions
              SET revoked_at=COALESCE(revoked_at,now()),
                  revoked_reason=COALESCE(revoked_reason,'bootstrap_authority_changed'),
                  version=version+1
            WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
          [tenantId, existing.user_id],
        );
      }
      if (input.displayName?.trim()) {
        await client.query(
          `UPDATE guto_v3.users SET display_name=$1 WHERE tenant_id=$2 AND id=$3`,
          [input.displayName.trim(), tenantId, existing.user_id],
        );
      }
      await client.query("COMMIT");
      return {
        tenantId,
        userId: existing.user_id,
        identityId: existing.identity_id,
        created: false,
        credentialVersion,
      };
    }

    const identityResult = await client.query<{ id: string }>(
      `INSERT INTO guto_v3.identities (tenant_id,provider,external_subject)
       VALUES ($1,'guto-jwt',$2) RETURNING id`,
      [tenantId, `v3:${randomUUID()}`],
    );
    const identityId = identityResult.rows[0]!.id;
    const userResult = await client.query<{ id: string }>(
      `INSERT INTO guto_v3.users (tenant_id,identity_id,display_name)
       VALUES ($1,$2,$3) RETURNING id`,
      [tenantId, identityId, input.displayName?.trim() || null],
    );
    const userId = userResult.rows[0]!.id;
    const passwordHash = input.passwordHash || await bcrypt.hash(input.password!, 12);
    await client.query(
      `INSERT INTO guto_v3.auth_credentials
        (tenant_id,user_id,identity_id,login_identifier,password_hash,role,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, userId, identityId, loginIdentifier, passwordHash, desiredRole, desiredStatus],
    );
    await client.query("COMMIT");
    return { tenantId, userId, identityId, created: true, credentialVersion: 1 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

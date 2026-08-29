import type pg from "pg";
import { normalizeV3LoginIdentifier } from "./auth.js";
import { deriveV3Identity } from "./legacy-identity.js";
import { createV3Pool } from "./postgres.js";

// Ponte PAINEL → Cérebro V3 (push na escrita).
//
// O painel administrativo continua sendo a autoridade administrativa (grava em
// user-access-store/Redis). Quando ele DEFINE a senha de um aluno, este módulo
// projeta a MESMA credencial para o Postgres V3 (guto_v3.auth_credentials),
// reusando o passwordHash bcrypt legado (custo 10, aceito pelo V3) e o email
// como login_identifier. A identidade V3 é derivada de forma DETERMINÍSTICA
// (legacy-identity.ts) a partir do userId legado + teamId — a mesma usada pela
// migração em massa, então nunca nasce identidade duplicada.
//
// O Cérebro V3 nunca lê o user-access-store: a fonte de verdade do Companion é
// o Postgres. O painel só empurra a credencial no momento da escrita.

export interface ProvisionStudentV3CredentialInput {
  userId: string;
  email?: string | null;
  passwordHash: string;
  displayName?: string | null;
  teamId?: string | null;
}

export interface ProvisionStudentV3CredentialResult {
  ok: boolean;
  created: boolean;
  skippedReason?: "invalid_input" | "v3_disabled" | "no_admin_database" | "error";
}

export function isV3ProvisioningEnabled(): boolean {
  return process.env.GUTO_V3_ENABLED === "true" && Boolean(
    process.env.GUTO_V3_ADMIN_DATABASE_URL ||
    (process.env.GUTO_V3_PANEL_ENABLED === "true" && process.env.DATABASE_URL),
  );
}

let sharedAdminPool: ReturnType<typeof createV3Pool> | null = null;

function getSharedAdminPool(): ReturnType<typeof createV3Pool> {
  sharedAdminPool ??= createV3Pool(process.env.GUTO_V3_ADMIN_DATABASE_URL);
  return sharedAdminPool;
}

let sharedRuntimePool: ReturnType<typeof createV3Pool> | null = null;
function getSharedRuntimePool(): ReturnType<typeof createV3Pool> {
  sharedRuntimePool ??= createV3Pool(process.env.DATABASE_URL);
  return sharedRuntimePool;
}

async function provisionV3CredentialViaPanelBridge(
  pool: pg.Pool,
  input: ProvisionStudentV3CredentialInput,
): Promise<{ created: boolean }> {
  const sourceUserId = input.userId.trim();
  const loginIdentifier = normalizeV3LoginIdentifier(input.email?.trim() ? input.email : sourceUserId);
  const derived = deriveV3Identity(sourceUserId, input.teamId);
  const result = await pool.query<{ created: boolean }>(
    `SELECT guto_v3.provision_panel_student_credential($1,$2,$3,$4,$5,$6,$7,$8) AS created`,
    [derived.tenantId, derived.tenantSlug, derived.identityId, derived.userId, derived.externalSubject, loginIdentifier, input.passwordHash, input.displayName?.trim() || null],
  );
  return { created: Boolean(result.rows[0]?.created) };
}

// Lógica pura (SQL) sobre um client já transacional. Separada do wrapper para
// ser testável sem conexão real. Presume BEGIN/COMMIT externos.
export async function provisionV3CredentialOnClient(
  client: pg.PoolClient,
  input: ProvisionStudentV3CredentialInput,
): Promise<{ created: boolean }> {
  const sourceUserId = input.userId.trim();
  const loginIdentifier = normalizeV3LoginIdentifier(input.email?.trim() ? input.email : sourceUserId);
  const derived = deriveV3Identity(sourceUserId, input.teamId);
  const displayName = input.displayName?.trim() || null;

  // Mesmo advisory lock do bootstrap, para serializar com o seed/verifier.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('guto_v3_auth_bootstrap'))`);

  await client.query(
    `INSERT INTO guto_v3.tenants (id, slug, name) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [derived.tenantId, derived.tenantSlug, derived.tenantSlug],
  );

  await client.query(
    `INSERT INTO guto_v3.identities (id, tenant_id, provider, external_subject)
     VALUES ($1,$2,'guto-jwt',$3)
     ON CONFLICT (provider, external_subject) DO NOTHING`,
    [derived.identityId, derived.tenantId, derived.externalSubject],
  );

  await client.query(
    `INSERT INTO guto_v3.users (id, tenant_id, identity_id, display_name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [derived.userId, derived.tenantId, derived.identityId, displayName],
  );

  const existing = await client.query<{ password_hash: string; tenant_id: string; user_id: string; identity_id: string }>(
    `SELECT password_hash,tenant_id,user_id,identity_id
       FROM guto_v3.auth_credentials
      WHERE login_identifier=$1
      FOR UPDATE`,
    [loginIdentifier],
  );
  const row = existing.rows[0];
  if (row) {
    // login_identifier is a lookup key, never the identity authority. A
    // collision must fail closed before any credential/session mutation.
    if (row.tenant_id !== derived.tenantId || row.user_id !== derived.userId || row.identity_id !== derived.identityId) {
      throw new Error("login identifier already belongs to another V3 identity");
    }
    const authorityChanged = row.password_hash !== input.passwordHash;
    await client.query(
      `UPDATE guto_v3.auth_credentials
          SET password_hash=$1, role='student', status='active',
              credential_version=credential_version + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
              failed_attempts=0, locked_until=NULL
        WHERE login_identifier=$3`,
      [input.passwordHash, authorityChanged, loginIdentifier],
    );
    if (authorityChanged) {
      await client.query(
        `UPDATE guto_v3.auth_sessions
            SET revoked_at=COALESCE(revoked_at,now()),
                revoked_reason=COALESCE(revoked_reason,'panel_authority_changed'),
                version=version+1
          WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
        [derived.tenantId, derived.userId],
      );
    }
    return { created: false };
  }

  await client.query(
    `INSERT INTO guto_v3.auth_credentials
       (tenant_id, user_id, identity_id, login_identifier, password_hash, role, status)
     VALUES ($1,$2,$3,$4,$5,'student','active')`,
    [derived.tenantId, derived.userId, derived.identityId, loginIdentifier, input.passwordHash],
  );
  return { created: true };
}

// Wrapper fail-safe chamado pelos routers legados. Nunca lança para o chamador:
// se o V3 não estiver habilitado/configurado, é no-op; se falhar, loga e segue
// o fluxo legado intacto.
export async function provisionV3CredentialForStudent(
  input: ProvisionStudentV3CredentialInput,
  poolOverride?: pg.Pool,
): Promise<ProvisionStudentV3CredentialResult> {
  if (!input.userId?.trim() || !input.passwordHash) {
    return { ok: false, created: false, skippedReason: "invalid_input" };
  }
  if (process.env.GUTO_V3_ENABLED !== "true") {
    return { ok: true, created: false, skippedReason: "v3_disabled" };
  }
  const adminPool = poolOverride ?? (process.env.GUTO_V3_ADMIN_DATABASE_URL ? getSharedAdminPool() : null);
  const usePreviewBridge = !adminPool && process.env.GUTO_V3_PANEL_ENABLED === "true" && Boolean(process.env.DATABASE_URL);
  const pool = adminPool ?? (usePreviewBridge ? getSharedRuntimePool() : null);
  if (!pool) {
    return { ok: false, created: false, skippedReason: "no_admin_database" };
  }
  if (usePreviewBridge) {
    try {
      const result = await provisionV3CredentialViaPanelBridge(pool, input);
      return { ok: true, created: result.created };
    } catch (error) {
      console.warn("[GUTO_V3_PANEL_PROVISIONING] falha ao provisionar credencial do aluno", {
        subject: input.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, created: false, skippedReason: "error" };
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await provisionV3CredentialOnClient(client, input);
    await client.query("COMMIT");
    return { ok: true, created: result.created };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.warn("[GUTO_V3_PANEL_PROVISIONING] falha ao provisionar credencial do aluno", {
      subject: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, created: false, skippedReason: "error" };
  } finally {
    client.release();
  }
}

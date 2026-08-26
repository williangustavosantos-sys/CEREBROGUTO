CREATE TABLE IF NOT EXISTS guto_v3.auth_credentials (
  user_id uuid PRIMARY KEY REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  identity_id uuid NOT NULL UNIQUE REFERENCES guto_v3.identities(id) ON DELETE RESTRICT,
  login_identifier text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student','coach','admin','super_admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','locked')),
  credential_version bigint NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, identity_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES guto_v3.users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, identity_id) REFERENCES guto_v3.identities(tenant_id, id) ON DELETE RESTRICT,
  CHECK (login_identifier = lower(btrim(login_identifier))),
  CHECK (length(login_identifier) BETWEEN 3 AND 254),
  CHECK (length(password_hash) BETWEEN 20 AND 255)
);

CREATE TABLE IF NOT EXISTS guto_v3.auth_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES guto_v3.identities(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  credential_version bigint NOT NULL CHECK (credential_version > 0),
  issued_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (tenant_id, user_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES guto_v3.users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, identity_id) REFERENCES guto_v3.identities(tenant_id, id) ON DELETE RESTRICT,
  CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CHECK (expires_at > issued_at),
  CHECK (last_seen_at >= issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND length(btrim(revoked_reason)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS auth_sessions_active_user_idx
  ON guto_v3.auth_sessions (tenant_id, user_id, expires_at)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS auth_credentials_touch_updated_at ON guto_v3.auth_credentials;
CREATE TRIGGER auth_credentials_touch_updated_at
  BEFORE UPDATE ON guto_v3.auth_credentials
  FOR EACH ROW EXECUTE FUNCTION guto_v3.touch_updated_at();

DROP TRIGGER IF EXISTS auth_sessions_touch_updated_at ON guto_v3.auth_sessions;
CREATE TRIGGER auth_sessions_touch_updated_at
  BEFORE UPDATE ON guto_v3.auth_sessions
  FOR EACH ROW EXECUTE FUNCTION guto_v3.touch_updated_at();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guto_v3_auth') THEN
    CREATE ROLE guto_v3_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guto_v3_runtime') THEN
    CREATE ROLE guto_v3_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA guto_v3 TO guto_v3_auth;
REVOKE ALL ON guto_v3.auth_credentials, guto_v3.auth_sessions
  FROM PUBLIC, guto_v3_app, guto_v3_auth;
REVOKE ALL ON guto_v3.users, guto_v3.identities FROM guto_v3_auth;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON guto_v3.auth_credentials, guto_v3.auth_sessions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON guto_v3.auth_credentials, guto_v3.auth_sessions FROM authenticated;
  END IF;
END
$$;

GRANT SELECT ON guto_v3.auth_credentials TO guto_v3_auth;
GRANT UPDATE (failed_attempts, locked_until, updated_at) ON guto_v3.auth_credentials TO guto_v3_auth;
GRANT SELECT ON guto_v3.auth_sessions TO guto_v3_auth;
GRANT INSERT (
  id, tenant_id, user_id, identity_id, token_hash,
  credential_version, issued_at, last_seen_at, expires_at
) ON guto_v3.auth_sessions TO guto_v3_auth;
GRANT UPDATE (last_seen_at, revoked_at, revoked_reason, updated_at, version) ON guto_v3.auth_sessions TO guto_v3_auth;
GRANT SELECT (id, tenant_id, identity_id, display_name) ON guto_v3.users TO guto_v3_auth;
GRANT SELECT (id, tenant_id, external_subject) ON guto_v3.identities TO guto_v3_auth;
GRANT guto_v3_auth TO postgres;
GRANT guto_v3_app, guto_v3_auth TO guto_v3_runtime;

ALTER TABLE guto_v3.auth_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.auth_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.auth_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_backend_lookup ON guto_v3.auth_credentials;
CREATE POLICY auth_backend_lookup ON guto_v3.auth_credentials
  FOR SELECT TO guto_v3_auth
  USING (true);

DROP POLICY IF EXISTS auth_credential_update ON guto_v3.auth_credentials;
CREATE POLICY auth_credential_update ON guto_v3.auth_credentials
  FOR UPDATE TO guto_v3_auth
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS auth_session_scope ON guto_v3.auth_sessions;
DROP POLICY IF EXISTS auth_session_select ON guto_v3.auth_sessions;
CREATE POLICY auth_session_select ON guto_v3.auth_sessions
  FOR SELECT TO guto_v3_auth
  USING (
    id = nullif(current_setting('app.session_id', true), '')::uuid
    AND tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS auth_session_insert ON guto_v3.auth_sessions;
CREATE POLICY auth_session_insert ON guto_v3.auth_sessions
  FOR INSERT TO guto_v3_auth
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND identity_id = nullif(current_setting('app.identity_id', true), '')::uuid
    AND id = nullif(current_setting('app.session_id', true), '')::uuid
  );

DROP POLICY IF EXISTS auth_session_update ON guto_v3.auth_sessions;
CREATE POLICY auth_session_update ON guto_v3.auth_sessions
  FOR UPDATE TO guto_v3_auth
  USING (
    id = nullif(current_setting('app.session_id', true), '')::uuid
    AND tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    id = nullif(current_setting('app.session_id', true), '')::uuid
    AND tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS auth_actor_lookup ON guto_v3.users;
CREATE POLICY auth_actor_lookup ON guto_v3.users
  FOR SELECT TO guto_v3_auth
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND id = nullif(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS auth_identity_lookup ON guto_v3.identities;
DROP POLICY IF EXISTS tenant_isolation ON guto_v3.identities;
CREATE POLICY auth_identity_lookup ON guto_v3.identities
  FOR SELECT TO guto_v3_auth
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND id = nullif(current_setting('app.identity_id', true), '')::uuid
  );

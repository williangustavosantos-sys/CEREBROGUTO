-- Supabase's managed postgres role cannot remove SUPERUSER/BYPASSRLS from an
-- unsafe pre-existing role. Refuse the migration instead of silently accepting
-- elevated authority. Fresh roles are created with these exact attributes by
-- 0002/0004. Passwords remain an operational Preview secret and are never
-- stored in versioned SQL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('guto_v3_app', 'guto_v3_auth', 'guto_v3_runtime')
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Unsafe pre-existing GUTO V3 database role attributes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('guto_v3_app', 'guto_v3_auth') AND rolcanlogin
  ) OR EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'guto_v3_runtime' AND NOT rolcanlogin
  ) THEN
    RAISE EXCEPTION 'Unexpected GUTO V3 database role login authority';
  END IF;
END
$$;

GRANT guto_v3_app, guto_v3_auth TO guto_v3_runtime;

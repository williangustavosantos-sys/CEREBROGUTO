-- Replication authority bypasses ordinary application boundaries and is never
-- valid for a GUTO V3 execution role.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname IN ('guto_v3_app', 'guto_v3_auth', 'guto_v3_runtime')
       AND rolreplication
  ) THEN
    RAISE EXCEPTION 'Unexpected GUTO V3 database replication authority';
  END IF;
END
$$;

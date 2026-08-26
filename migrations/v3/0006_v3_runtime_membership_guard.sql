-- Fail closed if any V3 execution role can SET ROLE beyond the two explicit
-- runtime capabilities. The expected grants must never carry ADMIN OPTION.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
     WHERE member_role.rolname IN ('guto_v3_app', 'guto_v3_auth', 'guto_v3_runtime')
       AND NOT (
         member_role.rolname = 'guto_v3_runtime'
         AND granted_role.rolname IN ('guto_v3_app', 'guto_v3_auth')
         AND membership.admin_option = false
       )
  ) THEN
    RAISE EXCEPTION 'Unexpected GUTO V3 database role membership';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
     WHERE member_role.rolname = 'guto_v3_runtime'
       AND granted_role.rolname IN ('guto_v3_app', 'guto_v3_auth')
       AND membership.admin_option = false
  ) <> 2 THEN
    RAISE EXCEPTION 'Missing GUTO V3 runtime database role membership';
  END IF;
END
$$;

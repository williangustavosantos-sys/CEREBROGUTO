-- Preview-only Panel -> Auth V3 bridge.  The Companion runtime stays on the
-- restricted DB role and never receives an admin DSN.  This narrowly scoped
-- function is callable only by guto_v3_runtime after the panel's existing
-- admin authorization has already accepted the administrative write.

CREATE OR REPLACE FUNCTION guto_v3.provision_panel_student_credential(
  p_tenant_id uuid,
  p_tenant_slug text,
  p_identity_id uuid,
  p_user_id uuid,
  p_external_subject text,
  p_login_identifier text,
  p_password_hash text,
  p_display_name text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, guto_v3
AS $$
DECLARE
  v_existing_hash text;
  v_existing_user uuid;
  v_created boolean := false;
BEGIN
  IF coalesce(btrim(p_external_subject),'') = '' OR coalesce(btrim(p_login_identifier),'') = '' OR coalesce(btrim(p_password_hash),'') = '' THEN
    RAISE EXCEPTION 'invalid panel credential input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO guto_v3.tenants (id,slug,name) VALUES (p_tenant_id,p_tenant_slug,p_tenant_slug)
  ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name;
  INSERT INTO guto_v3.identities (id,tenant_id,provider,external_subject)
  VALUES (p_identity_id,p_tenant_id,'guto-jwt',p_external_subject)
  ON CONFLICT (provider,external_subject) DO NOTHING;
  INSERT INTO guto_v3.users (id,tenant_id,identity_id,display_name)
  VALUES (p_user_id,p_tenant_id,p_identity_id,NULLIF(btrim(p_display_name),''))
  ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name;

  SELECT user_id,password_hash INTO v_existing_user,v_existing_hash
    FROM guto_v3.auth_credentials WHERE login_identifier=p_login_identifier FOR UPDATE;
  IF v_existing_user IS NOT NULL AND v_existing_user <> p_user_id THEN
    RAISE EXCEPTION 'login identifier already belongs to another V3 identity' USING ERRCODE = '23505';
  END IF;
  IF v_existing_user IS NULL THEN
    INSERT INTO guto_v3.auth_credentials
      (tenant_id,user_id,identity_id,login_identifier,password_hash,role,status)
    VALUES (p_tenant_id,p_user_id,p_identity_id,p_login_identifier,p_password_hash,'student','active');
    v_created := true;
  ELSE
    UPDATE guto_v3.auth_credentials
       SET password_hash=p_password_hash, role='student', status='active', failed_attempts=0, locked_until=NULL,
           credential_version=credential_version + CASE WHEN password_hash <> p_password_hash THEN 1 ELSE 0 END
     WHERE login_identifier=p_login_identifier;
    IF v_existing_hash <> p_password_hash THEN
      UPDATE guto_v3.auth_sessions
         SET revoked_at=coalesce(revoked_at,now()), revoked_reason=coalesce(revoked_reason,'panel_authority_changed'), version=version+1
       WHERE tenant_id=p_tenant_id AND user_id=p_user_id AND revoked_at IS NULL;
    END IF;
  END IF;
  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION guto_v3.provision_panel_student_credential(uuid,text,uuid,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guto_v3.provision_panel_student_credential(uuid,text,uuid,uuid,text,text,text,text) TO guto_v3_runtime;

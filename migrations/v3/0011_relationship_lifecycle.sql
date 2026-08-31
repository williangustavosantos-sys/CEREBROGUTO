-- Relationship Lifecycle — deterministic relational state machine (Closed Beta).
--
-- The official relationship lifecycle is a durable, tenant-scoped, idempotent
-- state. The LLM never decides it: transitions are computed deterministically
-- from official presence/interaction data + time/absence + policy (see
-- src/v3/relationship-lifecycle.ts). These tables make the state survive
-- reload, logout/login, new backend instances and reprocessing.

CREATE TABLE IF NOT EXISTS guto_v3.relationship_lifecycle (
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','AT_RISK','DECAYING','TERMINAL')),
  entered_state_at timestamptz,
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  last_presence_day date,
  consecutive_absence_days integer NOT NULL DEFAULT 0 CHECK (consecutive_absence_days >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

-- Append-only audit of lifecycle transitions (deterministic + auditable).
CREATE TABLE IF NOT EXISTS guto_v3.relationship_lifecycle_events (
  sequence_id bigserial PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  from_state text NOT NULL CHECK (from_state IN ('ACTIVE','AT_RISK','DECAYING','TERMINAL')),
  to_state text NOT NULL CHECK (to_state IN ('ACTIVE','AT_RISK','DECAYING','TERMINAL')),
  reason text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, request_id, from_state, to_state)
);

CREATE INDEX IF NOT EXISTS relationship_lifecycle_events_user_idx
  ON guto_v3.relationship_lifecycle_events (tenant_id, user_id, sequence_id DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['relationship_lifecycle','relationship_lifecycle_events']
  LOOP
    EXECUTE format('ALTER TABLE guto_v3.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE guto_v3.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS actor_isolation ON guto_v3.%I', table_name);
    EXECUTE format(
      'CREATE POLICY actor_isolation ON guto_v3.%I TO guto_v3_app
         USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
                AND user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
                     AND user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch_updated_at ON guto_v3.%I', table_name, table_name);
    IF table_name = 'relationship_lifecycle' THEN
      EXECUTE format(
        'CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON guto_v3.%I FOR EACH ROW EXECUTE FUNCTION guto_v3.touch_updated_at()',
        table_name,
        table_name
      );
    END IF;
  END LOOP;
END
$$;

REVOKE ALL ON guto_v3.relationship_lifecycle, guto_v3.relationship_lifecycle_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON guto_v3.relationship_lifecycle TO guto_v3_app;
GRANT SELECT, INSERT ON guto_v3.relationship_lifecycle_events TO guto_v3_app;
REVOKE UPDATE, DELETE ON guto_v3.relationship_lifecycle_events FROM guto_v3_app;

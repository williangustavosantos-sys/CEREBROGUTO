CREATE TABLE IF NOT EXISTS guto_v3.conversation_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  thread_key text NOT NULL DEFAULT 'companion' CHECK (length(btrim(thread_key)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  last_interaction_id text,
  last_interaction_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, thread_key)
);

CREATE TABLE IF NOT EXISTS guto_v3.conversation_decision_states (
  thread_id uuid PRIMARY KEY REFERENCES guto_v3.conversation_threads(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  active_topic text,
  active_goal text,
  known_facts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(known_facts) = 'array'),
  resolved_slots jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(resolved_slots) = 'array'),
  missing_information jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_information) = 'array'),
  uncertainty_type text NOT NULL DEFAULT 'none' CHECK (uncertainty_type IN ('none','operational','clinical','safety','out_of_scope')),
  decision_sufficiency text NOT NULL DEFAULT 'ACTION_SUFFICIENT' CHECK (decision_sufficiency IN ('ACTION_SUFFICIENT','ACTION_NEEDS_INFORMATION')),
  pending_action text,
  next_allowed_action text,
  previous_interaction_id text,
  status text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('OUT_OF_SCOPE','ACTION_BLOCKED_FOR_SAFETY','READY_TO_EXECUTE','IN_PROGRESS')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, thread_id)
);

CREATE TABLE IF NOT EXISTS guto_v3.conversation_state_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES guto_v3.conversation_threads(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  previous_version bigint NOT NULL,
  next_version bigint NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, request_id, next_version)
);

CREATE TABLE IF NOT EXISTS guto_v3.user_facts (
  user_fact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  fact_type text NOT NULL CHECK (length(btrim(fact_type)) > 0),
  value_json jsonb NOT NULL CHECK (jsonb_typeof(value_json) IN ('object','array','string','number','boolean','null')),
  source text NOT NULL CHECK (source IN ('user_declared','derived','system','migration')),
  confirmation_status text NOT NULL CHECK (confirmation_status IN ('FACT_CONFIRMED','FACT_UNKNOWN')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  superseded_by uuid,
  created_by text NOT NULL DEFAULT 'guto-v3',
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (superseded_at IS NULL OR superseded_at >= recorded_at)
);

ALTER TABLE guto_v3.user_facts
  DROP CONSTRAINT IF EXISTS user_facts_superseded_by_fkey;
ALTER TABLE guto_v3.user_facts
  ADD CONSTRAINT user_facts_superseded_by_fkey
  FOREIGN KEY (superseded_by) REFERENCES guto_v3.user_facts(user_fact_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS guto_v3.gemini_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES guto_v3.conversation_threads(id) ON DELETE CASCADE,
  interaction_id text NOT NULL,
  previous_interaction_id text,
  decision_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, interaction_id)
);

CREATE INDEX IF NOT EXISTS user_facts_current_idx
  ON guto_v3.user_facts (tenant_id, user_id, fact_type, recorded_at DESC)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS gemini_interactions_expiry_idx
  ON guto_v3.gemini_interactions (expires_at)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS conversation_state_events_thread_idx
  ON guto_v3.conversation_state_events (tenant_id, user_id, thread_id, created_at DESC);

INSERT INTO guto_v3.user_facts
  (tenant_id, user_id, fact_type, value_json, source, confirmation_status, valid_from, recorded_at, created_by)
SELECT h.tenant_id,
       h.user_id,
       CASE WHEN h.kind = 'food_restriction' THEN 'food_restriction' ELSE 'physical_constraint' END,
       jsonb_build_object('kind', h.kind, 'bodyRegion', h.body_region, 'description', h.description, 'severity', h.severity),
       'migration',
       CASE WHEN h.confirmed THEN 'FACT_CONFIRMED' ELSE 'FACT_UNKNOWN' END,
       h.created_at,
       h.created_at,
       'v3_1_migration'
  FROM guto_v3.user_health_constraints h
 WHERE NOT EXISTS (
   SELECT 1 FROM guto_v3.user_facts f
    WHERE f.tenant_id = h.tenant_id
      AND f.user_id = h.user_id
      AND f.fact_type = CASE WHEN h.kind = 'food_restriction' THEN 'food_restriction' ELSE 'physical_constraint' END
      AND f.value_json = jsonb_build_object('kind', h.kind, 'bodyRegion', h.body_region, 'description', h.description, 'severity', h.severity)
      AND f.source = 'migration'
 );

INSERT INTO guto_v3.user_facts
  (tenant_id, user_id, fact_type, value_json, source, confirmation_status, valid_from, recorded_at, created_by)
SELECT g.tenant_id, g.user_id, 'goal', jsonb_build_object('code', g.goal_code), 'migration', 'FACT_CONFIRMED', g.created_at, g.created_at, 'v3_1_migration'
  FROM guto_v3.user_goals g
 WHERE NOT EXISTS (
   SELECT 1 FROM guto_v3.user_facts f
    WHERE f.tenant_id = g.tenant_id AND f.user_id = g.user_id AND f.fact_type = 'goal'
      AND f.value_json = jsonb_build_object('code', g.goal_code) AND f.source = 'migration'
 );

-- The historical self-reference is intentionally deferred while facts are
-- written. Drain its trigger queue before changing RLS on the same table.
SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['conversation_threads','conversation_decision_states','conversation_state_events','user_facts','gemini_interactions']
  LOOP
    EXECUTE format('ALTER TABLE guto_v3.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS actor_isolation ON guto_v3.%I', table_name);
    EXECUTE format(
      'CREATE POLICY actor_isolation ON guto_v3.%I TO guto_v3_app USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid AND user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid AND user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  guto_v3.conversation_threads,
  guto_v3.conversation_decision_states,
  guto_v3.conversation_state_events,
  guto_v3.user_facts,
  guto_v3.gemini_interactions
TO guto_v3_app;

DROP TRIGGER IF EXISTS conversation_threads_touch_updated_at ON guto_v3.conversation_threads;
CREATE TRIGGER conversation_threads_touch_updated_at
  BEFORE UPDATE ON guto_v3.conversation_threads
  FOR EACH ROW EXECUTE FUNCTION guto_v3.touch_updated_at();
DROP TRIGGER IF EXISTS conversation_decision_states_touch_updated_at ON guto_v3.conversation_decision_states;
CREATE TRIGGER conversation_decision_states_touch_updated_at
  BEFORE UPDATE ON guto_v3.conversation_decision_states
  FOR EACH ROW EXECUTE FUNCTION guto_v3.touch_updated_at();

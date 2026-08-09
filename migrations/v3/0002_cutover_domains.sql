CREATE TABLE IF NOT EXISTS guto_v3.user_journey_state (
  user_id uuid PRIMARY KEY REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  preferred_language text NOT NULL DEFAULT 'pt-BR' CHECK (preferred_language IN ('pt-BR','en-US','it-IT')),
  consent_accepted_at timestamptz,
  sovereign_name_confirmed_at timestamptz,
  pact_accepted_at timestamptz,
  initial_xp_reward_seen boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

ALTER TABLE guto_v3.xp_ledger
  ADD COLUMN IF NOT EXISTS source_key text;

UPDATE guto_v3.xp_ledger
   SET source_key = request_id::text
 WHERE source_key IS NULL;

ALTER TABLE guto_v3.xp_ledger
  ALTER COLUMN source_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS xp_ledger_source_unique
  ON guto_v3.xp_ledger (tenant_id, user_id, reason_code, source_key);

ALTER TABLE guto_v3.workout_plan_items
  ADD COLUMN IF NOT EXISTS canonical_name_pt text,
  ADD COLUMN IF NOT EXISTS rest_text text,
  ADD COLUMN IF NOT EXISTS cue text,
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS video_url text,
  ADD COLUMN IF NOT EXISTS source_file_name text;

DROP TRIGGER IF EXISTS user_journey_state_touch_updated_at ON guto_v3.user_journey_state;
CREATE TRIGGER user_journey_state_touch_updated_at
  BEFORE UPDATE ON guto_v3.user_journey_state
  FOR EACH ROW EXECUTE FUNCTION guto_v3.touch_updated_at();

ALTER TABLE guto_v3.user_journey_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guto_v3_app') THEN
    CREATE ROLE guto_v3_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA guto_v3 TO guto_v3_app;
REVOKE ALL ON ALL TABLES IN SCHEMA guto_v3 FROM guto_v3_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  guto_v3.users,
  guto_v3.user_profile,
  guto_v3.user_preferences,
  guto_v3.user_goals,
  guto_v3.user_health_constraints,
  guto_v3.workout_plans,
  guto_v3.workout_plan_items,
  guto_v3.workout_sessions,
  guto_v3.diet_plans,
  guto_v3.diet_meals,
  guto_v3.diet_items,
  guto_v3.active_plan_versions,
  guto_v3.guto_events,
  guto_v3.xp_ledger,
  guto_v3.memory_facts,
  guto_v3.user_journey_state,
  guto_v3.outbox_events
TO guto_v3_app;
GRANT USAGE, SELECT ON SEQUENCE guto_v3.guto_events_sequence_id_seq TO guto_v3_app;
GRANT guto_v3_app TO postgres;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users','user_profile','user_preferences','user_goals','user_health_constraints',
    'workout_plans','workout_sessions','diet_plans','active_plan_versions','guto_events',
    'xp_ledger','memory_facts','user_journey_state'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON guto_v3.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS actor_isolation ON guto_v3.%I', table_name);
    EXECUTE format(
      'CREATE POLICY actor_isolation ON guto_v3.%I TO guto_v3_app USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid AND %s) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid AND %s)',
      table_name,
      CASE WHEN table_name = 'users'
        THEN 'id = nullif(current_setting(''app.user_id'', true), '''')::uuid'
        ELSE 'user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid'
      END,
      CASE WHEN table_name = 'users'
        THEN 'id = nullif(current_setting(''app.user_id'', true), '''')::uuid'
        ELSE 'user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid'
      END
    );
  END LOOP;
END
$$;

DROP POLICY IF EXISTS tenant_isolation ON guto_v3.workout_plan_items;
DROP POLICY IF EXISTS actor_isolation ON guto_v3.workout_plan_items;
CREATE POLICY actor_isolation ON guto_v3.workout_plan_items TO guto_v3_app
USING (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM guto_v3.workout_plans p
     WHERE p.id = workout_plan_items.plan_id
       AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
)
WITH CHECK (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM guto_v3.workout_plans p
     WHERE p.id = workout_plan_items.plan_id
       AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
);

DROP POLICY IF EXISTS tenant_isolation ON guto_v3.diet_meals;
DROP POLICY IF EXISTS actor_isolation ON guto_v3.diet_meals;
CREATE POLICY actor_isolation ON guto_v3.diet_meals TO guto_v3_app
USING (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM guto_v3.diet_plans p
     WHERE p.id = diet_meals.plan_id
       AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
)
WITH CHECK (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM guto_v3.diet_plans p
     WHERE p.id = diet_meals.plan_id
       AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
);

DROP POLICY IF EXISTS tenant_isolation ON guto_v3.diet_items;
DROP POLICY IF EXISTS actor_isolation ON guto_v3.diet_items;
CREATE POLICY actor_isolation ON guto_v3.diet_items TO guto_v3_app
USING (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND EXISTS (
    SELECT 1
      FROM guto_v3.diet_meals m
      JOIN guto_v3.diet_plans p ON p.id = m.plan_id
     WHERE m.id = diet_items.meal_id
       AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
)
WITH CHECK (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND EXISTS (
    SELECT 1
      FROM guto_v3.diet_meals m
      JOIN guto_v3.diet_plans p ON p.id = m.plan_id
     WHERE m.id = diet_items.meal_id
       AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
);

DROP POLICY IF EXISTS tenant_isolation ON guto_v3.outbox_events;
DROP POLICY IF EXISTS actor_isolation ON guto_v3.outbox_events;
CREATE POLICY actor_isolation ON guto_v3.outbox_events TO guto_v3_app
USING (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND aggregate_type = 'user'
  AND aggregate_id = nullif(current_setting('app.user_id', true), '')::uuid
)
WITH CHECK (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND aggregate_type = 'user'
  AND aggregate_id = nullif(current_setting('app.user_id', true), '')::uuid
);

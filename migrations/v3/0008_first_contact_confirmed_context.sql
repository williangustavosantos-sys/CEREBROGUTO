ALTER TABLE guto_v3.user_profile
  ADD COLUMN IF NOT EXISTS weekly_frequency smallint;

ALTER TABLE guto_v3.user_profile
  ALTER COLUMN city DROP NOT NULL,
  ALTER COLUMN country DROP NOT NULL,
  ALTER COLUMN training_location SET DEFAULT 'gym';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_profile_weekly_frequency_check'
       AND conrelid = 'guto_v3.user_profile'::regclass
  ) THEN
    ALTER TABLE guto_v3.user_profile
      ADD CONSTRAINT user_profile_weekly_frequency_check
      CHECK (weekly_frequency IS NULL OR weekly_frequency BETWEEN 1 AND 7);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS guto_v3.confirmed_user_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  profile_version bigint NOT NULL CHECK (profile_version > 0),
  goal_version bigint NOT NULL CHECK (goal_version > 0),
  food_declaration text NOT NULL CHECK (length(btrim(food_declaration)) > 0),
  limitation_declaration text NOT NULL CHECK (length(btrim(limitation_declaration)) > 0),
  training_location text NOT NULL DEFAULT 'gym' CHECK (training_location = 'gym'),
  weekly_frequency smallint NOT NULL CHECK (weekly_frequency BETWEEN 1 AND 7),
  context_snapshot jsonb NOT NULL CHECK (jsonb_typeof(context_snapshot) = 'object'),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, version),
  UNIQUE (tenant_id, user_id, id, version)
);

CREATE TABLE IF NOT EXISTS guto_v3.first_contact_state (
  user_id uuid PRIMARY KEY REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED')),
  step text NOT NULL DEFAULT 'food_restrictions' CHECK (step IN ('food_restrictions','training_limitations','confirmation','completed')),
  food_declaration text,
  limitation_declaration text,
  confirmed_context_id uuid,
  confirmed_context_version bigint,
  started_at timestamptz,
  completed_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  CHECK ((confirmed_context_id IS NULL) = (confirmed_context_version IS NULL)),
  CHECK ((status = 'NOT_STARTED' AND started_at IS NULL AND completed_at IS NULL)
      OR (status = 'IN_PROGRESS' AND started_at IS NOT NULL AND completed_at IS NULL)
      OR (status = 'COMPLETED' AND step = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
          AND confirmed_context_id IS NOT NULL AND confirmed_context_version IS NOT NULL))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'first_contact_state_invariants_check'
       AND conrelid = 'guto_v3.first_contact_state'::regclass
  ) THEN
    ALTER TABLE guto_v3.first_contact_state ADD CONSTRAINT first_contact_state_invariants_check CHECK (
      (status = 'NOT_STARTED' AND step = 'food_restrictions' AND food_declaration IS NULL AND limitation_declaration IS NULL
        AND started_at IS NULL AND completed_at IS NULL AND confirmed_context_id IS NULL)
      OR
      (status = 'IN_PROGRESS' AND started_at IS NOT NULL AND completed_at IS NULL AND confirmed_context_id IS NULL AND (
        (step = 'food_restrictions' AND food_declaration IS NULL AND limitation_declaration IS NULL)
        OR (step = 'training_limitations' AND food_declaration IS NOT NULL AND limitation_declaration IS NULL)
        OR (step = 'confirmation' AND food_declaration IS NOT NULL AND limitation_declaration IS NOT NULL)
      ))
      OR
      (status = 'COMPLETED' AND step = 'completed' AND food_declaration IS NOT NULL AND limitation_declaration IS NOT NULL
        AND started_at IS NOT NULL AND completed_at IS NOT NULL AND confirmed_context_id IS NOT NULL AND confirmed_context_version IS NOT NULL)
    );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'first_contact_confirmed_context_fkey'
       AND conrelid = 'guto_v3.first_contact_state'::regclass
  ) THEN
    ALTER TABLE guto_v3.first_contact_state
      ADD CONSTRAINT first_contact_confirmed_context_fkey
      FOREIGN KEY (tenant_id,user_id,confirmed_context_id,confirmed_context_version)
      REFERENCES guto_v3.confirmed_user_contexts (tenant_id,user_id,id,version)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

ALTER TABLE guto_v3.workout_plans
  ADD COLUMN IF NOT EXISTS confirmed_context_id uuid,
  ADD COLUMN IF NOT EXISTS confirmed_context_version bigint;

ALTER TABLE guto_v3.diet_plans
  ADD COLUMN IF NOT EXISTS confirmed_context_id uuid,
  ADD COLUMN IF NOT EXISTS confirmed_context_version bigint;

ALTER TABLE guto_v3.active_plan_versions
  ADD COLUMN IF NOT EXISTS confirmed_context_id uuid,
  ADD COLUMN IF NOT EXISTS confirmed_context_version bigint;

DO $$
DECLARE
  table_name text;
  constraint_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workout_plans','diet_plans','active_plan_versions']
  LOOP
    constraint_name := table_name || '_confirmed_context_pair_check';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = constraint_name
         AND conrelid = format('guto_v3.%I', table_name)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE guto_v3.%I ADD CONSTRAINT %I CHECK ((confirmed_context_id IS NULL) = (confirmed_context_version IS NULL))',
        table_name,
        constraint_name
      );
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  table_name text;
  constraint_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workout_plans','diet_plans','active_plan_versions']
  LOOP
    constraint_name := table_name || '_confirmed_context_fkey';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = constraint_name
         AND conrelid = format('guto_v3.%I', table_name)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE guto_v3.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id,user_id,confirmed_context_id,confirmed_context_version) REFERENCES guto_v3.confirmed_user_contexts (tenant_id,user_id,id,version) DEFERRABLE INITIALLY DEFERRED',
        table_name,
        constraint_name
      );
    END IF;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'workout_plan_context_identity_unique'
       AND conrelid = 'guto_v3.workout_plans'::regclass
  ) THEN
    ALTER TABLE guto_v3.workout_plans
      ADD CONSTRAINT workout_plan_context_identity_unique
      UNIQUE (tenant_id,user_id,id,version,confirmed_context_id,confirmed_context_version);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'diet_plan_context_identity_unique'
       AND conrelid = 'guto_v3.diet_plans'::regclass
  ) THEN
    ALTER TABLE guto_v3.diet_plans
      ADD CONSTRAINT diet_plan_context_identity_unique
      UNIQUE (tenant_id,user_id,id,version,confirmed_context_id,confirmed_context_version);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'active_workout_confirmed_context_fkey'
       AND conrelid = 'guto_v3.active_plan_versions'::regclass
  ) THEN
    ALTER TABLE guto_v3.active_plan_versions
      ADD CONSTRAINT active_workout_confirmed_context_fkey
      FOREIGN KEY (tenant_id,user_id,workout_plan_id,workout_plan_version,confirmed_context_id,confirmed_context_version)
      REFERENCES guto_v3.workout_plans (tenant_id,user_id,id,version,confirmed_context_id,confirmed_context_version)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'active_diet_confirmed_context_fkey'
       AND conrelid = 'guto_v3.active_plan_versions'::regclass
  ) THEN
    ALTER TABLE guto_v3.active_plan_versions
      ADD CONSTRAINT active_diet_confirmed_context_fkey
      FOREIGN KEY (tenant_id,user_id,diet_plan_id,diet_plan_version,confirmed_context_id,confirmed_context_version)
      REFERENCES guto_v3.diet_plans (tenant_id,user_id,id,version,confirmed_context_id,confirmed_context_version)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS first_contact_state_touch_updated_at ON guto_v3.first_contact_state;
CREATE TRIGGER first_contact_state_touch_updated_at
  BEFORE UPDATE ON guto_v3.first_contact_state
  FOR EACH ROW EXECUTE FUNCTION guto_v3.touch_updated_at();

ALTER TABLE guto_v3.first_contact_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.first_contact_state FORCE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.confirmed_user_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.confirmed_user_contexts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS actor_isolation ON guto_v3.first_contact_state;
CREATE POLICY actor_isolation ON guto_v3.first_contact_state TO guto_v3_app
USING (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
)
WITH CHECK (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
);

DROP POLICY IF EXISTS actor_isolation ON guto_v3.confirmed_user_contexts;
DROP POLICY IF EXISTS actor_select ON guto_v3.confirmed_user_contexts;
CREATE POLICY actor_select ON guto_v3.confirmed_user_contexts FOR SELECT TO guto_v3_app
USING (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
);
DROP POLICY IF EXISTS actor_insert ON guto_v3.confirmed_user_contexts;
CREATE POLICY actor_insert ON guto_v3.confirmed_user_contexts FOR INSERT TO guto_v3_app
WITH CHECK (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
);

REVOKE ALL ON guto_v3.first_contact_state, guto_v3.confirmed_user_contexts FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON guto_v3.first_contact_state, guto_v3.confirmed_user_contexts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON guto_v3.first_contact_state, guto_v3.confirmed_user_contexts FROM authenticated;
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE ON guto_v3.first_contact_state TO guto_v3_app;
GRANT SELECT, INSERT ON guto_v3.confirmed_user_contexts TO guto_v3_app;
REVOKE UPDATE, DELETE ON guto_v3.confirmed_user_contexts FROM guto_v3_app;

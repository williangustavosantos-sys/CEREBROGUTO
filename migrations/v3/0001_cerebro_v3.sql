CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS guto_v3;

CREATE OR REPLACE FUNCTION guto_v3.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS guto_v3.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (length(btrim(slug)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guto_v3.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  external_subject text NOT NULL CHECK (length(btrim(external_subject)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_subject),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS guto_v3.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  identity_id uuid NOT NULL UNIQUE REFERENCES guto_v3.identities(id) ON DELETE RESTRICT,
  display_name text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS guto_v3.user_profile (
  user_id uuid PRIMARY KEY REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  biological_sex text NOT NULL CHECK (biological_sex IN ('male','female','other','prefer_not_to_say')),
  age smallint NOT NULL CHECK (age BETWEEN 13 AND 120),
  weight_kg numeric(6,2) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 500),
  height_cm numeric(5,1) NOT NULL CHECK (height_cm BETWEEN 100 AND 250),
  training_status text NOT NULL,
  training_location text NOT NULL,
  language text NOT NULL CHECK (language IN ('pt-BR','en-US','it-IT')),
  city text NOT NULL,
  country text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS guto_v3.user_preferences (
  user_id uuid PRIMARY KEY REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  diet_style text,
  interaction_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(interaction_preferences) = 'object')
);

CREATE TABLE IF NOT EXISTS guto_v3.user_goals (
  user_id uuid PRIMARY KEY REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  goal_code text NOT NULL CHECK (length(btrim(goal_code)) > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guto_v3.user_health_constraints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('limitation','injury','illness','allergy','food_restriction')),
  body_region text,
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  severity text NOT NULL DEFAULT 'unknown' CHECK (severity IN ('low','medium','high','unknown')),
  confirmed boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'calibration',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, kind, description)
);

CREATE TABLE IF NOT EXISTS guto_v3.workout_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','active','completed','superseded')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  generated_from jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(generated_from) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS workout_one_active_per_user
  ON guto_v3.workout_plans (tenant_id, user_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS guto_v3.workout_plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES guto_v3.workout_plans(id) ON DELETE CASCADE,
  exercise_id text NOT NULL,
  name text NOT NULL,
  purpose text NOT NULL,
  muscle_group text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  sets smallint CHECK (sets > 0),
  reps text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, position),
  UNIQUE (plan_id, id)
);

CREATE TABLE IF NOT EXISTS guto_v3.workout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES guto_v3.workout_plans(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('planned','started','completed','abandoned')),
  started_at timestamptz,
  completed_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guto_v3.diet_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('draft','active','completed','superseded')),
  total_calories numeric(10,2) NOT NULL CHECK (total_calories > 0),
  protein_grams numeric(10,2) NOT NULL CHECK (protein_grams >= 0),
  carbs_grams numeric(10,2) NOT NULL CHECK (carbs_grams >= 0),
  fat_grams numeric(10,2) NOT NULL CHECK (fat_grams >= 0),
  calculation_method text NOT NULL DEFAULT 'item_sum_v1',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  generated_from jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(generated_from) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS diet_one_active_per_user
  ON guto_v3.diet_plans (tenant_id, user_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS guto_v3.diet_meals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES guto_v3.diet_plans(id) ON DELETE CASCADE,
  name text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  calories numeric(10,2) NOT NULL CHECK (calories >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, position),
  UNIQUE (plan_id, id)
);

CREATE TABLE IF NOT EXISTS guto_v3.diet_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  meal_id uuid NOT NULL REFERENCES guto_v3.diet_meals(id) ON DELETE CASCADE,
  food_id text NOT NULL,
  name text NOT NULL,
  quantity_grams numeric(10,2) NOT NULL CHECK (quantity_grams > 0),
  calories numeric(10,2) NOT NULL CHECK (calories >= 0),
  protein_grams numeric(10,2) NOT NULL CHECK (protein_grams >= 0),
  carbs_grams numeric(10,2) NOT NULL CHECK (carbs_grams >= 0),
  fat_grams numeric(10,2) NOT NULL CHECK (fat_grams >= 0),
  position integer NOT NULL CHECK (position >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meal_id, position),
  UNIQUE (meal_id, id)
);

CREATE TABLE IF NOT EXISTS guto_v3.active_plan_versions (
  user_id uuid PRIMARY KEY REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  workout_plan_id uuid REFERENCES guto_v3.workout_plans(id) ON DELETE SET NULL,
  workout_plan_version bigint,
  diet_plan_id uuid REFERENCES guto_v3.diet_plans(id) ON DELETE SET NULL,
  diet_plan_version bigint,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guto_v3.guto_events (
  sequence_id bigserial PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(payload) = 'object'),
  UNIQUE (tenant_id, user_id, request_id, event_type)
);

CREATE TABLE IF NOT EXISTS guto_v3.xp_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  amount integer NOT NULL,
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, request_id, reason_code)
);

CREATE TABLE IF NOT EXISTS guto_v3.memory_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  classification text NOT NULL CHECK (classification IN ('OFFICIAL','SENSITIVE')),
  fact_type text NOT NULL,
  fact_value jsonb NOT NULL,
  source_event_id uuid REFERENCES guto_v3.guto_events(event_id) ON DELETE SET NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, fact_type)
);

CREATE TABLE IF NOT EXISTS guto_v3.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS identities_external_subject_idx ON guto_v3.identities (external_subject);
CREATE INDEX IF NOT EXISTS workout_plans_user_idx ON guto_v3.workout_plans (tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS diet_plans_user_idx ON guto_v3.diet_plans (tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS health_constraints_user_idx ON guto_v3.user_health_constraints (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS guto_events_user_idx ON guto_v3.guto_events (tenant_id, user_id, sequence_id DESC);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON guto_v3.outbox_events (created_at) WHERE published_at IS NULL;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants','users','user_profile','user_preferences','user_goals','user_health_constraints',
    'workout_plans','workout_plan_items','workout_sessions','diet_plans','diet_meals','diet_items',
    'active_plan_versions','memory_facts'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I_touch_updated_at ON guto_v3.%I',
      table_name,
      table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON guto_v3.%I FOR EACH ROW EXECUTE FUNCTION guto_v3.touch_updated_at()',
      table_name,
      table_name
    );
  END LOOP;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'identities','users','user_profile','user_preferences','user_goals','user_health_constraints',
    'workout_plans','workout_plan_items','workout_sessions','diet_plans','diet_meals','diet_items',
    'active_plan_versions','guto_events','xp_ledger','memory_facts','outbox_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE guto_v3.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON guto_v3.%I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON guto_v3.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END;
$$;

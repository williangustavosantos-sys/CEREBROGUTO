-- GUTO V3.3: official temporal facts, domain knowledge and the first
-- deterministic workout-evolution ledger.  This migration extends the V3
-- foundation; it never reads or writes V1/V2 memory stores.

ALTER TABLE guto_v3.user_facts
  ADD COLUMN IF NOT EXISTS canonical_value text,
  ADD COLUMN IF NOT EXISTS fact_scope text NOT NULL DEFAULT 'profile'
    CHECK (fact_scope IN ('profile','session')),
  ADD COLUMN IF NOT EXISTS fact_schema_version integer NOT NULL DEFAULT 1;

UPDATE guto_v3.user_facts
   SET canonical_value = COALESCE(
     NULLIF(value_json->>'canonicalValue',''),
     NULLIF(value_json->>'code',''),
     NULLIF(value_json->>'declaration',''),
     value_json::text
   )
 WHERE canonical_value IS NULL OR btrim(canonical_value) = '';

ALTER TABLE guto_v3.user_facts
  ALTER COLUMN canonical_value SET NOT NULL;

CREATE INDEX IF NOT EXISTS user_facts_temporal_current_idx
  ON guto_v3.user_facts (tenant_id,user_id,fact_type,fact_scope,recorded_at DESC)
  WHERE superseded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_facts_current_value_unique
  ON guto_v3.user_facts (tenant_id,user_id,fact_type,fact_scope,canonical_value)
  WHERE superseded_at IS NULL;

ALTER TABLE guto_v3.user_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.user_facts FORCE ROW LEVEL SECURITY;

-- Canonical domain knowledge. Rows are global reference data, versioned and
-- independent of any LLM; user-specific decisions only store their IDs.
CREATE TABLE IF NOT EXISTS guto_v3.exercise_knowledge (
  exercise_id text PRIMARY KEY,
  names jsonb NOT NULL CHECK (jsonb_typeof(names) = 'object'),
  aliases jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(aliases) = 'object'),
  movement_pattern text NOT NULL,
  primary_muscles jsonb NOT NULL CHECK (jsonb_typeof(primary_muscles) = 'array'),
  secondary_muscles jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(secondary_muscles) = 'array'),
  equipment jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(equipment) = 'array'),
  difficulty text NOT NULL,
  exercise_family text NOT NULL,
  functional_tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(functional_tags) = 'array'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  knowledge_version integer NOT NULL DEFAULT 1 CHECK (knowledge_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guto_v3.food_knowledge (
  food_id text PRIMARY KEY,
  names jsonb NOT NULL CHECK (jsonb_typeof(names) = 'object'),
  aliases jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(aliases) = 'object'),
  category text NOT NULL,
  macro_profile jsonb NOT NULL CHECK (jsonb_typeof(macro_profile) = 'object'),
  dietary_tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dietary_tags) = 'array'),
  ingredient_tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ingredient_tags) = 'array'),
  substitution_group text,
  localization jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(localization) = 'object'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  knowledge_version integer NOT NULL DEFAULT 1 CHECK (knowledge_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guto_v3.knowledge_substitutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN ('exercise','food')),
  source_id text NOT NULL,
  candidate_id text NOT NULL,
  relationship text NOT NULL CHECK (relationship IN ('equivalent','regression','progression','availability','restriction_safe')),
  reason_code text NOT NULL,
  expected_impact jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(expected_impact) = 'object'),
  knowledge_version integer NOT NULL DEFAULT 1 CHECK (knowledge_version > 0),
  UNIQUE (source_kind,source_id,candidate_id,relationship)
);

REVOKE ALL ON guto_v3.exercise_knowledge,guto_v3.food_knowledge,guto_v3.knowledge_substitutions FROM PUBLIC;
GRANT SELECT ON guto_v3.exercise_knowledge,guto_v3.food_knowledge,guto_v3.knowledge_substitutions TO guto_v3_app;

-- Per-exercise session facts are the immutable input for deterministic
-- evolution. Gemini can explain the decision but cannot write it directly.
CREATE TABLE IF NOT EXISTS guto_v3.workout_session_exercises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES guto_v3.workout_sessions(id) ON DELETE CASCADE,
  exercise_id text NOT NULL,
  load_value numeric,
  repetitions integer,
  sets_completed integer,
  completed boolean NOT NULL DEFAULT false,
  perceived_difficulty smallint CHECK (perceived_difficulty BETWEEN 1 AND 10),
  substituted_from_exercise_id text,
  substitution_reason text,
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context_snapshot) = 'object'),
  performed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guto_v3.workout_evolution_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  exercise_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('MAINTAIN','PROGRESS','REGRESS','SUBSTITUTE','REVIEW')),
  reason_code text NOT NULL,
  source_session_exercise_id uuid REFERENCES guto_v3.workout_session_exercises(id) ON DELETE SET NULL,
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context_snapshot) = 'object'),
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE guto_v3.workout_session_exercises ENABLE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.workout_session_exercises FORCE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.workout_evolution_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.workout_evolution_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS actor_isolation ON guto_v3.workout_session_exercises;
CREATE POLICY actor_isolation ON guto_v3.workout_session_exercises TO guto_v3_app
USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid)
WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);
DROP POLICY IF EXISTS actor_isolation ON guto_v3.workout_evolution_decisions;
CREATE POLICY actor_isolation ON guto_v3.workout_evolution_decisions TO guto_v3_app
USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid)
WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT,INSERT ON guto_v3.workout_session_exercises,guto_v3.workout_evolution_decisions TO guto_v3_app;

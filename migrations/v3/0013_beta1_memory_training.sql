-- BETA1: memória curada persistente (user_memories) + execução set-level
-- (workout_set_executions) + campo de conclusão self-report.
--
-- Padrões OKF: memória tipada por categoria+key, provenance obrigatória,
-- status/supersession, versionamento. Postgres é a autoridade; memória nunca
-- é transcript (a conversa não vira memória; só declarações explícitas curadas
-- por schema estrito + policy determinística em src/v3/beta1-memory.ts).
-- STALE fica para a Beta 2 (nenhuma categoria Beta 1 exige TTL).

CREATE TABLE IF NOT EXISTS guto_v3.user_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN (
    'IDENTITY',
    'TRAINING_PREFERENCES',
    'TRAINING_ENVIRONMENT',
    'TRAINING_LIMITATIONS',
    'ROUTINE',
    'FOOD_PREFERENCES',
    'TRAINING_LEARNINGS'
  )),
  key text NOT NULL CHECK (length(btrim(key)) > 0 AND length(key) <= 96),
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED','RETRACTED')),
  confidence text NOT NULL DEFAULT 'explicit' CHECK (confidence IN ('explicit','derived')),
  source_type text NOT NULL CHECK (source_type IN (
    'conversation','first_contact','workout_execution','food_swap',
    'explicit_profile_edit','system_derived'
  )),
  source_request_id text,
  source_event_id uuid,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  supersedes_id uuid REFERENCES guto_v3.user_memories(id) DEFERRABLE INITIALLY DEFERRED
);

-- Uma única verdade por chave enquanto ativa. Index PARCIAL (só ACTIVE)
-- preserva o histórico de linhas SUPERSEDED/RETRACTED sem colisão.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_memories_one_active_per_key
  ON guto_v3.user_memories (tenant_id, user_id, category, key)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_user_memories_actor_category
  ON guto_v3.user_memories (tenant_id, user_id, category, status);
CREATE INDEX IF NOT EXISTS idx_user_memories_actor_key
  ON guto_v3.user_memories (tenant_id, user_id, key, status);
CREATE INDEX IF NOT EXISTS idx_user_memories_actor_updated
  ON guto_v3.user_memories (tenant_id, user_id, updated_at);

-- Histórico completo (para leitura de histórico sem bypass de RLS).
-- Sem INCLUDING INDEXES para não colidir nomes de índice no mesmo schema.
CREATE TABLE IF NOT EXISTS guto_v3.user_memories_history (
  LIKE guto_v3.user_memories INCLUDING DEFAULTS INCLUDING CONSTRAINTS
);

-- Execução REAL por série (set-level). Nunca inferida da prescrição.
-- technique_type diferencia sets principais de extensões de intensidade
-- (drop/rest-pause) para o motor de progressão não somá-las ingenuamente.
CREATE TABLE IF NOT EXISTS guto_v3.workout_set_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES guto_v3.workout_sessions(id) ON DELETE CASCADE,
  session_exercise_id uuid REFERENCES guto_v3.workout_session_exercises(id) ON DELETE CASCADE,
  exercise_id text NOT NULL,
  set_number integer NOT NULL CHECK (set_number >= 1),
  load_kg numeric CHECK (load_kg IS NULL OR load_kg >= 0),
  reps integer CHECK (reps IS NULL OR reps >= 0),
  technique_type text NOT NULL DEFAULT 'STRAIGHT_SET' CHECK (technique_type IN ('STRAIGHT_SET','SUPERSET','DROP_SET','REST_PAUSE')),
  technique_group text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, session_id, exercise_id, set_number, technique_type, technique_group)
);

CREATE INDEX IF NOT EXISTS idx_set_exec_history
  ON guto_v3.workout_set_executions (tenant_id, user_id, exercise_id, created_at);
CREATE INDEX IF NOT EXISTS idx_set_exec_session
  ON guto_v3.workout_set_executions (tenant_id, user_id, session_id);

-- Feedback subjetivo estruturado por exercício (FÁCIL/BOA/PESADA/DOR → RPE).
ALTER TABLE guto_v3.workout_session_exercises
  ADD COLUMN IF NOT EXISTS difficulty_label text CHECK (difficulty_label IN ('FACIL','BOA','PESADA','DOR'));

-- Técnica avançada estruturada na PRESCRIÇÃO (nunca texto solto em note).
-- Contrato da aplicação: TechniquePrescription (src/v3/beta1-progression.ts).
ALTER TABLE guto_v3.workout_plan_items
  ADD COLUMN IF NOT EXISTS technique jsonb;

-- Conclusão Beta 1 por self-report (selfie BETA_2; /workout/validate preservado).
ALTER TABLE guto_v3.workout_sessions
  ADD COLUMN IF NOT EXISTS completion_mode text CHECK (completion_mode IN ('self_report','validated'));

-- RLS idêntica às tabelas de treino (actor isolation).
ALTER TABLE guto_v3.user_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.user_memories FORCE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.user_memories_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.user_memories_history FORCE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.workout_set_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.workout_set_executions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS actor_isolation ON guto_v3.user_memories;
CREATE POLICY actor_isolation ON guto_v3.user_memories TO guto_v3_app
USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid)
WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS actor_isolation ON guto_v3.user_memories_history;
CREATE POLICY actor_isolation ON guto_v3.user_memories_history TO guto_v3_app
USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid)
WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT,INSERT,UPDATE ON guto_v3.user_memories TO guto_v3_app;
GRANT SELECT,INSERT,UPDATE ON guto_v3.user_memories_history TO guto_v3_app;
GRANT SELECT,INSERT ON guto_v3.workout_set_executions TO guto_v3_app;

-- A policy da wse é (re)assertada no FIM deste arquivo, depois de TODO o DDL:
-- criá-la imediatamente após o CREATE TABLE na mesma sessão deixou a policy sem
-- efeito no PGlite (quirk de catálogo; bisect W1/S3 em tmp/beta1-gate). O
-- Postgres real não exige isso, mas o padrão defensivo da casa (0009) — policy
-- por último — já cobre o caso.
DROP POLICY IF EXISTS actor_isolation ON guto_v3.workout_set_executions;
CREATE POLICY actor_isolation ON guto_v3.workout_set_executions TO guto_v3_app
USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid)
WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);

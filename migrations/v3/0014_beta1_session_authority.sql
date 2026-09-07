-- Beta1 P1 remediation: one authoritative subjective feedback per workout session.
CREATE TABLE IF NOT EXISTS guto_v3.workout_session_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guto_v3.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES guto_v3.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES guto_v3.workout_sessions(id) ON DELETE CASCADE,
  overall_difficulty text NOT NULL CHECK (overall_difficulty IN ('FACIL','BOA','PESADA','DOR')),
  pain boolean NOT NULL DEFAULT false,
  cause_explanation text,
  cause_category text CHECK (cause_category IS NULL OR cause_category IN ('user_state','training')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, session_id)
);

CREATE INDEX IF NOT EXISTS workout_session_feedback_history_idx
  ON guto_v3.workout_session_feedback (tenant_id, user_id, created_at DESC);

ALTER TABLE guto_v3.workout_session_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE guto_v3.workout_session_feedback FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS actor_isolation ON guto_v3.workout_session_feedback;
CREATE POLICY actor_isolation ON guto_v3.workout_session_feedback TO guto_v3_app
USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid)
WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT,INSERT,UPDATE ON guto_v3.workout_session_feedback TO guto_v3_app;
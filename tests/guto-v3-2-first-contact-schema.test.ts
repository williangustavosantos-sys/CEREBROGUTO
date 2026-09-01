import "./test-env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CalibrationMutationSchema } from "../src/v3/contracts.js";

const migration = readFileSync(join(process.cwd(), "migrations/v3/0008_first_contact_confirmed_context.sql"), "utf8");
const frequencyDomainMigration = readFileSync(join(process.cwd(), "migrations/v3/0012_training_frequency_domain.sql"), "utf8");
const verifier = readFileSync(join(process.cwd(), "scripts/verify-v3-real-integrations.ts"), "utf8");

test("V3.2 migration is fail-closed, tenant isolated and keeps confirmed contexts append-only", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS weekly_frequency smallint/);
  assert.doesNotMatch(migration, /UPDATE guto_v3\.user_profile[\s\S]*weekly_frequency/i);
  assert.doesNotMatch(migration, /weekly_frequency SET NOT NULL/i);
  assert.match(migration, /ALTER COLUMN city DROP NOT NULL/);
  assert.match(migration, /ALTER COLUMN country DROP NOT NULL/);
  for (const table of ["first_contact_state", "confirmed_user_contexts"]) {
    assert.match(migration, new RegExp(`ALTER TABLE guto_v3\\.${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(migration, new RegExp(`ALTER TABLE guto_v3\\.${table} FORCE ROW LEVEL SECURITY;`));
  }
  assert.match(migration, /first_contact_state_invariants_check/);
  assert.match(migration, /GRANT SELECT, INSERT ON guto_v3\.confirmed_user_contexts TO guto_v3_app/);
  assert.match(migration, /REVOKE UPDATE, DELETE ON guto_v3\.confirmed_user_contexts FROM guto_v3_app/);
  assert.doesNotMatch(migration, /GRANT[^;]*UPDATE[^;]*confirmed_user_contexts/i);
  assert.match(migration, /constraint_name := table_name \|\| '_confirmed_context_fkey'/);
  assert.match(migration, /ARRAY\['workout_plans','diet_plans','active_plan_versions'\]/);
  assert.match(migration, /active_workout_confirmed_context_fkey/);
  assert.match(migration, /active_diet_confirmed_context_fkey/);
});

test("V3.2 objective calibration rejects removed legacy questionnaire fields", () => {
  const base = {
    requestId: "20000000-0000-4000-8000-000000000001",
    profile: {
      biologicalSex: "male",
      age: 33,
      weightKg: 82,
      heightCm: 181,
      trainingStatus: "active",
      weeklyFrequencyDaysPerWeek: 4,
    },
    goal: { code: "muscle_gain" },
  };
  assert.equal(CalibrationMutationSchema.safeParse(base).success, true);
  for (const valid of [2, 3, 4, 5, 6]) {
    assert.equal(CalibrationMutationSchema.safeParse({
      ...base,
      profile: { ...base.profile, weeklyFrequencyDaysPerWeek: valid },
    }).success, true);
  }
  for (const invalid of [0, 1, 7, 10, 15, 25, 99]) {
    assert.equal(CalibrationMutationSchema.safeParse({
      ...base,
      profile: { ...base.profile, weeklyFrequencyDaysPerWeek: invalid },
    }).success, false);
  }
  assert.equal(CalibrationMutationSchema.safeParse({ ...base, trainingLocation: "home" }).success, false);
  assert.equal(CalibrationMutationSchema.safeParse({ ...base, profile: { ...base.profile, city: "Roma" } }).success, false);
});

test("training frequency authority is constrained to 2..6 in PostgreSQL", () => {
  assert.match(frequencyDomainMigration, /user_profile[\s\S]*weekly_frequency NOT BETWEEN 2 AND 6/);
  assert.match(frequencyDomainMigration, /confirmed_user_contexts[\s\S]*weekly_frequency NOT BETWEEN 2 AND 6/);
  assert.match(frequencyDomainMigration, /CHECK \(weekly_frequency IS NULL OR weekly_frequency BETWEEN 2 AND 6\)/);
  assert.match(frequencyDomainMigration, /CHECK \(weekly_frequency BETWEEN 2 AND 6\)/);
});

test("real verifier completes First Contact and proves shared plan context plus RLS", () => {
  assert.match(verifier, /startFirstContact/);
  assert.match(verifier, /expectedStep: "food_restrictions"/);
  assert.match(verifier, /expectedStep: "training_limitations"/);
  assert.match(verifier, /confirmFirstContact/);
  assert.match(verifier, /assertConfirmedContextIntegrity/);
  assert.match(verifier, /state\.workout\.confirmedContextVersion, state\.confirmedContext\.version/);
  assert.match(verifier, /state\.diet\.confirmedContextVersion, state\.confirmedContext\.version/);
  assert.match(verifier, /guto_v3\.first_contact_state/);
  assert.match(verifier, /guto_v3\.confirmed_user_contexts/);
});

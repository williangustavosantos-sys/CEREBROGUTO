import { performance } from "node:perf_hooks";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import type { CalibrationMutation } from "./contracts.js";
import { V3Error } from "./errors.js";
import type { DietPlanDraft, FoodReplacement, OfficialStateRepository, WorkoutPlanDraft } from "./repository.js";
import type {
  ActorContext,
  CalibrationResult,
  CandidateOption,
  DietItem,
  DietMeal,
  DietPlan,
  HealthConstraint,
  OfficialGoal,
  OfficialPreferences,
  OfficialProfile,
  OfficialSnapshot,
  WorkoutItem,
  WorkoutPlan,
} from "./types.js";

const { Pool } = pg;

function asNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new V3Error("V3_INVALID_DATABASE_NUMBER", "Número inválido no estado oficial.");
  return parsed;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createV3Pool(connectionString = process.env.DATABASE_URL || ""): pg.Pool {
  if (!connectionString) {
    throw new V3Error("V3_DATABASE_NOT_CONFIGURED", "DATABASE_URL não configurada para o Cérebro V3.", 503);
  }
  return new Pool({
    connectionString,
    max: Number(process.env.GUTO_V3_PG_POOL_MAX || 10),
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 8_000,
    ssl: process.env.GUTO_V3_PG_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
}

export class PostgresOfficialStateRepository implements OfficialStateRepository {
  constructor(private readonly pool: pg.Pool) {}

  private async withTenantTransaction<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async health(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = performance.now();
    await this.pool.query("SELECT 1");
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  }

  async resolveActor(externalSubject: string, role: ActorContext["role"]): Promise<ActorContext | null> {
    const subject = externalSubject.trim();
    if (!subject) return null;
    const result = await this.pool.query<{
      tenant_id: string;
      user_id: string;
      external_subject: string;
    }>(
      `SELECT i.tenant_id, u.id AS user_id, i.external_subject
         FROM guto_v3.identities i
         JOIN guto_v3.users u ON u.identity_id = i.id AND u.tenant_id = i.tenant_id
        WHERE i.provider = 'guto-jwt' AND i.external_subject = $1`,
      [subject],
    );
    const row = result.rows[0];
    return row
      ? { tenantId: row.tenant_id, userId: row.user_id, externalSubject: row.external_subject, role }
      : null;
  }

  async provisionActor(input: {
    externalSubject: string;
    role: ActorContext["role"];
    tenantKey: string;
    tenantName: string;
    displayName?: string;
  }): Promise<ActorContext> {
    const externalSubject = input.externalSubject.trim();
    const tenantSlug = input.tenantKey.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!externalSubject || !tenantSlug) {
      throw new V3Error("V3_INVALID_IDENTITY", "Identidade ou tenant inválido.", 400);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tenantResult = await client.query<{ id: string }>(
        `INSERT INTO guto_v3.tenants (slug, name) VALUES ($1,$2)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [tenantSlug, input.tenantName.trim() || tenantSlug],
      );
      const tenantId = tenantResult.rows[0]!.id;
      const identityResult = await client.query<{ id: string; tenant_id: string }>(
        `INSERT INTO guto_v3.identities (tenant_id, provider, external_subject)
         VALUES ($1,'guto-jwt',$2)
         ON CONFLICT (provider, external_subject) DO UPDATE SET external_subject = EXCLUDED.external_subject
         RETURNING id, tenant_id`,
        [tenantId, externalSubject],
      );
      const identity = identityResult.rows[0]!;
      if (identity.tenant_id !== tenantId) {
        throw new V3Error("V3_IDENTITY_TENANT_CONFLICT", "Identidade já pertence a outro tenant.", 409);
      }
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO guto_v3.users (tenant_id, identity_id, display_name)
         VALUES ($1,$2,$3)
         ON CONFLICT (identity_id) DO UPDATE SET
           display_name = COALESCE(guto_v3.users.display_name, EXCLUDED.display_name)
         RETURNING id`,
        [tenantId, identity.id, input.displayName?.trim() || null],
      );
      await client.query("COMMIT");
      return {
        tenantId,
        userId: userResult.rows[0]!.id,
        externalSubject,
        role: input.role,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadOfficialSnapshot(actor: ActorContext): Promise<OfficialSnapshot> {
    return this.withTenantTransaction(actor.tenantId, async (client) => {
      const [userResult, profileResult, goalResult, preferencesResult, healthResult, workoutResult, dietResult] = await Promise.all([
        client.query(`SELECT version, display_name FROM guto_v3.users WHERE tenant_id = $1 AND id = $2`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.user_profile WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.user_goals WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.user_preferences WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.user_health_constraints WHERE tenant_id = $1 AND user_id = $2 AND confirmed = true ORDER BY created_at`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.workout_plans WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.diet_plans WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [actor.tenantId, actor.userId]),
      ]);

      const user = userResult.rows[0];
      const profileRow = profileResult.rows[0];
      const goalRow = goalResult.rows[0];
      if (!user || !profileRow || !goalRow) {
        throw new V3Error("V3_OFFICIAL_PROFILE_INCOMPLETE", "Perfil oficial V3 ainda não foi migrado.", 409);
      }

      const workout = workoutResult.rows[0]
        ? await this.loadWorkout(client, workoutResult.rows[0])
        : null;
      const diet = dietResult.rows[0]
        ? await this.loadDiet(client, dietResult.rows[0])
        : null;

      const profile: OfficialProfile = {
        version: asNumber(profileRow.version),
        displayName: user.display_name || undefined,
        language: profileRow.language,
        city: profileRow.city,
        country: profileRow.country,
        biologicalSex: profileRow.biological_sex,
        age: asNumber(profileRow.age),
        weightKg: asNumber(profileRow.weight_kg),
        heightCm: asNumber(profileRow.height_cm),
        trainingStatus: profileRow.training_status,
        trainingLocation: profileRow.training_location,
      };
      const goal: OfficialGoal = { version: asNumber(goalRow.version), code: goalRow.goal_code };
      const preferencesRow = preferencesResult.rows[0];
      const preferences: OfficialPreferences = {
        version: preferencesRow ? asNumber(preferencesRow.version) : 1,
        dietStyle: preferencesRow?.diet_style || undefined,
      };
      const healthConstraints: HealthConstraint[] = healthResult.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        bodyRegion: row.body_region || undefined,
        description: row.description,
        severity: row.severity,
        confirmed: row.confirmed,
      }));

      return {
        actor,
        memoryVersion: asNumber(user.version),
        profile,
        goal,
        preferences,
        healthConstraints,
        workout,
        diet,
      };
    });
  }

  private async loadWorkout(client: PoolClient, row: QueryResultRow): Promise<WorkoutPlan> {
    const items = await client.query(`SELECT * FROM guto_v3.workout_plan_items WHERE plan_id = $1 ORDER BY position`, [row.id]);
    return {
      id: row.id,
      version: asNumber(row.version),
      title: row.title,
      status: row.status,
      items: items.rows.map((item): WorkoutItem => ({
        id: item.id,
        exerciseId: item.exercise_id,
        name: item.name,
        purpose: item.purpose,
        muscleGroup: item.muscle_group,
        position: asNumber(item.position),
        sets: item.sets == null ? undefined : asNumber(item.sets),
        reps: item.reps || undefined,
      })),
    };
  }

  private async loadDiet(client: PoolClient, row: QueryResultRow): Promise<DietPlan> {
    const mealsResult = await client.query(`SELECT * FROM guto_v3.diet_meals WHERE plan_id = $1 ORDER BY position`, [row.id]);
    const meals: DietMeal[] = [];
    for (const mealRow of mealsResult.rows) {
      const itemsResult = await client.query(`SELECT * FROM guto_v3.diet_items WHERE meal_id = $1 ORDER BY position`, [mealRow.id]);
      const items: DietItem[] = itemsResult.rows.map((item) => ({
        id: item.id,
        foodId: item.food_id,
        name: item.name,
        quantityGrams: asNumber(item.quantity_grams),
        calories: asNumber(item.calories),
        proteinGrams: asNumber(item.protein_grams),
        carbsGrams: asNumber(item.carbs_grams),
        fatGrams: asNumber(item.fat_grams),
        position: asNumber(item.position),
      }));
      meals.push({
        id: mealRow.id,
        name: mealRow.name,
        position: asNumber(mealRow.position),
        calories: asNumber(mealRow.calories),
        items,
      });
    }
    return {
      id: row.id,
      version: asNumber(row.version),
      status: row.status,
      totalCalories: asNumber(row.total_calories),
      proteinGrams: asNumber(row.protein_grams),
      carbsGrams: asNumber(row.carbs_grams),
      fatGrams: asNumber(row.fat_grams),
      meals,
    };
  }

  async persistCalibration(actor: ActorContext, input: CalibrationMutation): Promise<CalibrationResult> {
    return this.withTenantTransaction(actor.tenantId, async (client) => {
      const existing = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM guto_v3.guto_events
          WHERE tenant_id = $1 AND user_id = $2 AND request_id = $3 AND event_type = 'calibration.saved'`,
        [actor.tenantId, actor.userId, input.requestId],
      );
      if (existing.rows[0]) {
        const payload = jsonObject(existing.rows[0].payload);
        return {
          status: "confirmed",
          requestId: input.requestId,
          profileVersion: asNumber(payload.profileVersion),
          memoryVersion: asNumber(payload.memoryVersion),
        };
      }

      const profileResult = await client.query<{ version: string }>(
        `INSERT INTO guto_v3.user_profile (
           tenant_id, user_id, biological_sex, age, weight_kg, height_cm, training_status,
           training_location, language, city, country
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id) DO UPDATE SET
           biological_sex = EXCLUDED.biological_sex,
           age = EXCLUDED.age,
           weight_kg = EXCLUDED.weight_kg,
           height_cm = EXCLUDED.height_cm,
           training_status = EXCLUDED.training_status,
           training_location = EXCLUDED.training_location,
           language = EXCLUDED.language,
           city = EXCLUDED.city,
           country = EXCLUDED.country,
           version = guto_v3.user_profile.version + 1
         RETURNING version`,
        [
          actor.tenantId,
          actor.userId,
          input.profile.biologicalSex,
          input.profile.age,
          input.profile.weightKg,
          input.profile.heightCm,
          input.profile.trainingStatus,
          input.profile.trainingLocation,
          input.profile.language,
          input.profile.city,
          input.profile.country,
        ],
      );
      await client.query(
        `INSERT INTO guto_v3.user_preferences (tenant_id, user_id, diet_style)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET diet_style = EXCLUDED.diet_style,
           version = guto_v3.user_preferences.version + 1`,
        [actor.tenantId, actor.userId, input.preferences.dietStyle || null],
      );
      await client.query(
        `INSERT INTO guto_v3.user_goals (tenant_id, user_id, goal_code)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET goal_code = EXCLUDED.goal_code,
           version = guto_v3.user_goals.version + 1`,
        [actor.tenantId, actor.userId, input.goal.code],
      );
      await client.query(`DELETE FROM guto_v3.user_health_constraints WHERE tenant_id = $1 AND user_id = $2 AND source = 'calibration'`, [actor.tenantId, actor.userId]);
      for (const constraint of input.healthConstraints) {
        await client.query(
          `INSERT INTO guto_v3.user_health_constraints
             (tenant_id, user_id, kind, body_region, description, severity, confirmed, source)
           VALUES ($1,$2,$3,$4,$5,$6,true,'calibration')`,
          [actor.tenantId, actor.userId, constraint.kind, constraint.bodyRegion || null, constraint.description, constraint.severity],
        );
      }
      const userResult = await client.query<{ version: string }>(
        `UPDATE guto_v3.users SET version = version + 1 WHERE tenant_id = $1 AND id = $2 RETURNING version`,
        [actor.tenantId, actor.userId],
      );
      const result: CalibrationResult = {
        status: "confirmed",
        requestId: input.requestId,
        profileVersion: asNumber(profileResult.rows[0]?.version),
        memoryVersion: asNumber(userResult.rows[0]?.version),
      };
      await client.query(
        `INSERT INTO guto_v3.guto_events (tenant_id,user_id,request_id,event_type,payload)
         VALUES ($1,$2,$3,'calibration.saved',$4::jsonb)`,
        [actor.tenantId, actor.userId, input.requestId, JSON.stringify(result)],
      );
      await client.query(
        `INSERT INTO guto_v3.outbox_events (tenant_id,aggregate_type,aggregate_id,event_type,payload)
         VALUES ($1,'user',$2,'calibration.saved',$3::jsonb)`,
        [actor.tenantId, actor.userId, JSON.stringify({ requestId: input.requestId, profileVersion: result.profileVersion })],
      );
      return result;
    });
  }

  async replaceWorkoutPlan(input: { actor: ActorContext; requestId: string; draft: WorkoutPlanDraft }): Promise<WorkoutPlan> {
    return this.withTenantTransaction(input.actor.tenantId, async (client) => {
      const existing = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM guto_v3.guto_events WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3 AND event_type='workout.generated'`,
        [input.actor.tenantId, input.actor.userId, input.requestId],
      );
      const existingPlanId = existing.rows[0] ? String(jsonObject(existing.rows[0].payload).planId || "") : "";
      if (existingPlanId) {
        const plan = await client.query(`SELECT * FROM guto_v3.workout_plans WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [input.actor.tenantId, input.actor.userId, existingPlanId]);
        if (plan.rows[0]) return this.loadWorkout(client, plan.rows[0]);
      }
      await client.query(`UPDATE guto_v3.workout_plans SET status='superseded' WHERE tenant_id=$1 AND user_id=$2 AND status='active'`, [input.actor.tenantId, input.actor.userId]);
      const planResult = await client.query<QueryResultRow>(
        `INSERT INTO guto_v3.workout_plans (tenant_id,user_id,title,status,generated_from)
         VALUES ($1,$2,$3,'active',$4::jsonb) RETURNING *`,
        [input.actor.tenantId, input.actor.userId, input.draft.title, JSON.stringify(input.draft.generatedFrom)],
      );
      const planRow = planResult.rows[0]!;
      for (const item of input.draft.items) {
        await client.query(
          `INSERT INTO guto_v3.workout_plan_items (tenant_id,plan_id,exercise_id,name,purpose,muscle_group,position,sets,reps)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [input.actor.tenantId, planRow.id, item.exerciseId, item.name, item.purpose, item.muscleGroup, item.position, item.sets || null, item.reps || null],
        );
      }
      await client.query(
        `INSERT INTO guto_v3.active_plan_versions (tenant_id,user_id,workout_plan_id,workout_plan_version)
         VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET workout_plan_id=EXCLUDED.workout_plan_id,
           workout_plan_version=EXCLUDED.workout_plan_version, version=guto_v3.active_plan_versions.version+1`,
        [input.actor.tenantId, input.actor.userId, planRow.id, planRow.version],
      );
      await this.appendMutationEvent(client, input.actor, input.requestId, "workout.generated", { planId: planRow.id, planVersion: asNumber(planRow.version) });
      return this.loadWorkout(client, planRow);
    });
  }

  async replaceDietPlan(input: { actor: ActorContext; requestId: string; draft: DietPlanDraft }): Promise<DietPlan> {
    return this.withTenantTransaction(input.actor.tenantId, async (client) => {
      const existing = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM guto_v3.guto_events WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3 AND event_type='diet.generated'`,
        [input.actor.tenantId, input.actor.userId, input.requestId],
      );
      const existingPlanId = existing.rows[0] ? String(jsonObject(existing.rows[0].payload).planId || "") : "";
      if (existingPlanId) {
        const plan = await client.query(`SELECT * FROM guto_v3.diet_plans WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [input.actor.tenantId, input.actor.userId, existingPlanId]);
        if (plan.rows[0]) return this.loadDiet(client, plan.rows[0]);
      }
      await client.query(`UPDATE guto_v3.diet_plans SET status='superseded' WHERE tenant_id=$1 AND user_id=$2 AND status='active'`, [input.actor.tenantId, input.actor.userId]);
      const planResult = await client.query<QueryResultRow>(
        `INSERT INTO guto_v3.diet_plans
           (tenant_id,user_id,status,total_calories,protein_grams,carbs_grams,fat_grams,calculation_method,generated_from)
         VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
        [input.actor.tenantId, input.actor.userId, input.draft.totalCalories, input.draft.proteinGrams, input.draft.carbsGrams, input.draft.fatGrams, input.draft.calculationMethod, JSON.stringify(input.draft.generatedFrom)],
      );
      const planRow = planResult.rows[0]!;
      for (const meal of input.draft.meals) {
        const mealResult = await client.query<{ id: string }>(
          `INSERT INTO guto_v3.diet_meals (tenant_id,plan_id,name,position,calories) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [input.actor.tenantId, planRow.id, meal.name, meal.position, meal.calories],
        );
        for (const item of meal.items) {
          await client.query(
            `INSERT INTO guto_v3.diet_items
               (tenant_id,meal_id,food_id,name,quantity_grams,calories,protein_grams,carbs_grams,fat_grams,position)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [input.actor.tenantId, mealResult.rows[0]!.id, item.foodId, item.name, item.quantityGrams, item.calories, item.proteinGrams, item.carbsGrams, item.fatGrams, item.position],
          );
        }
      }
      await client.query(
        `INSERT INTO guto_v3.active_plan_versions (tenant_id,user_id,diet_plan_id,diet_plan_version)
         VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET diet_plan_id=EXCLUDED.diet_plan_id,
           diet_plan_version=EXCLUDED.diet_plan_version, version=guto_v3.active_plan_versions.version+1`,
        [input.actor.tenantId, input.actor.userId, planRow.id, planRow.version],
      );
      await this.appendMutationEvent(client, input.actor, input.requestId, "diet.generated", { planId: planRow.id, planVersion: asNumber(planRow.version) });
      return this.loadDiet(client, planRow);
    });
  }

  async swapExercise(input: {
    actor: ActorContext;
    requestId: string;
    planId: string;
    expectedPlanVersion: number;
    itemId: string;
    candidate: CandidateOption;
  }): Promise<{ planVersion: number }> {
    return this.withTenantTransaction(input.actor.tenantId, async (client) => {
      const plan = await client.query<{ version: string }>(
        `SELECT version FROM guto_v3.workout_plans
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND status = 'active' FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId, input.planId],
      );
      if (!plan.rows[0]) throw new V3Error("V3_WORKOUT_NOT_FOUND", "Treino oficial não encontrado.", 409);
      if (asNumber(plan.rows[0].version) !== input.expectedPlanVersion) {
        throw new V3Error("V3_STALE_WORKOUT_VERSION", "O treino mudou; recarregue o estado oficial.", 409);
      }
      const updated = await client.query(
        `UPDATE guto_v3.workout_plan_items SET
           exercise_id = $1, name = $2, purpose = $3, muscle_group = $4, version = version + 1
         WHERE tenant_id = $5 AND plan_id = $6 AND id = $7`,
        [
          input.candidate.id,
          input.candidate.label,
          String(input.candidate.metadata.purpose || input.candidate.purpose),
          String(input.candidate.metadata.muscleGroup || "unknown"),
          input.actor.tenantId,
          input.planId,
          input.itemId,
        ],
      );
      if (updated.rowCount !== 1) throw new V3Error("V3_WORKOUT_ITEM_NOT_FOUND", "Exercício oficial não encontrado.", 409);
      const versionResult = await client.query<{ version: string }>(
        `UPDATE guto_v3.workout_plans SET version = version + 1
          WHERE tenant_id = $1 AND id = $2 RETURNING version`,
        [input.actor.tenantId, input.planId],
      );
      const planVersion = asNumber(versionResult.rows[0]?.version);
      await client.query(
        `UPDATE guto_v3.active_plan_versions SET workout_plan_version = $1, version = version + 1
          WHERE tenant_id = $2 AND user_id = $3`,
        [planVersion, input.actor.tenantId, input.actor.userId],
      );
      await this.appendMutationEvent(client, input.actor, input.requestId, "workout.exercise_swapped", {
        planId: input.planId,
        itemId: input.itemId,
        candidateId: input.candidate.id,
        planVersion,
      });
      return { planVersion };
    });
  }

  async swapFood(input: {
    actor: ActorContext;
    requestId: string;
    plan: DietPlan;
    itemId: string;
    replacement: FoodReplacement;
  }): Promise<{ planVersion: number }> {
    return this.withTenantTransaction(input.actor.tenantId, async (client) => {
      const planResult = await client.query<{ version: string }>(
        `SELECT version FROM guto_v3.diet_plans
          WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND status = 'active' FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId, input.plan.id],
      );
      if (!planResult.rows[0]) throw new V3Error("V3_DIET_NOT_FOUND", "Dieta oficial não encontrada.", 409);
      if (asNumber(planResult.rows[0].version) !== input.plan.version) {
        throw new V3Error("V3_STALE_DIET_VERSION", "A dieta mudou; recarregue o estado oficial.", 409);
      }
      const updated = await client.query<{ meal_id: string }>(
        `UPDATE guto_v3.diet_items SET
           food_id=$1, name=$2, quantity_grams=$3, calories=$4,
           protein_grams=$5, carbs_grams=$6, fat_grams=$7, version=version+1
         WHERE tenant_id=$8 AND id=$9
         RETURNING meal_id`,
        [
          input.replacement.candidate.id,
          input.replacement.candidate.label,
          input.replacement.quantityGrams,
          input.replacement.calories,
          input.replacement.proteinGrams,
          input.replacement.carbsGrams,
          input.replacement.fatGrams,
          input.actor.tenantId,
          input.itemId,
        ],
      );
      const mealId = updated.rows[0]?.meal_id;
      if (!mealId) throw new V3Error("V3_DIET_ITEM_NOT_FOUND", "Alimento oficial não encontrado.", 409);
      await client.query(
        `UPDATE guto_v3.diet_meals m SET calories = totals.calories, version = m.version + 1
           FROM (SELECT meal_id, round(sum(calories),2) AS calories FROM guto_v3.diet_items WHERE meal_id=$1 GROUP BY meal_id) totals
          WHERE m.id = totals.meal_id`,
        [mealId],
      );
      const totals = await client.query<{
        calories: string;
        protein: string;
        carbs: string;
        fat: string;
      }>(
        `SELECT round(sum(i.calories),2) AS calories,
                round(sum(i.protein_grams),2) AS protein,
                round(sum(i.carbs_grams),2) AS carbs,
                round(sum(i.fat_grams),2) AS fat
           FROM guto_v3.diet_items i
           JOIN guto_v3.diet_meals m ON m.id = i.meal_id
          WHERE m.plan_id = $1`,
        [input.plan.id],
      );
      const row = totals.rows[0];
      const versionResult = await client.query<{ version: string }>(
        `UPDATE guto_v3.diet_plans SET total_calories=$1, protein_grams=$2, carbs_grams=$3,
           fat_grams=$4, version=version+1 WHERE tenant_id=$5 AND id=$6 RETURNING version`,
        [row.calories, row.protein, row.carbs, row.fat, input.actor.tenantId, input.plan.id],
      );
      const planVersion = asNumber(versionResult.rows[0]?.version);
      await client.query(
        `UPDATE guto_v3.active_plan_versions SET diet_plan_version=$1, version=version+1
          WHERE tenant_id=$2 AND user_id=$3`,
        [planVersion, input.actor.tenantId, input.actor.userId],
      );
      await this.appendMutationEvent(client, input.actor, input.requestId, "diet.food_swapped", {
        planId: input.plan.id,
        itemId: input.itemId,
        candidateId: input.replacement.candidate.id,
        planVersion,
      });
      return { planVersion };
    });
  }

  async recordTurn(input: { actor: ActorContext; requestId: string; action: string; resultCode: string }): Promise<void> {
    await this.withTenantTransaction(input.actor.tenantId, async (client) => {
      await client.query(
        `INSERT INTO guto_v3.guto_events (tenant_id,user_id,request_id,event_type,payload)
         VALUES ($1,$2,$3,'turn.completed',$4::jsonb)
         ON CONFLICT (tenant_id,user_id,request_id,event_type) DO NOTHING`,
        [input.actor.tenantId, input.actor.userId, input.requestId, JSON.stringify({ action: input.action, resultCode: input.resultCode })],
      );
    });
  }

  private async appendMutationEvent(
    client: PoolClient,
    actor: ActorContext,
    requestId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO guto_v3.guto_events (tenant_id,user_id,request_id,event_type,payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [actor.tenantId, actor.userId, requestId, eventType, JSON.stringify(payload)],
    );
    await client.query(
      `INSERT INTO guto_v3.outbox_events (tenant_id,aggregate_type,aggregate_id,event_type,payload)
       VALUES ($1,'user',$2,$3,$4::jsonb)`,
      [actor.tenantId, actor.userId, eventType, JSON.stringify({ requestId, ...payload })],
    );
  }
}

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
  V3AppState,
  WorkoutItem,
  WorkoutPlan,
  XpReasonCode,
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

  private async withActorTransaction<T>(actor: ActorContext, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [actor.tenantId, actor.userId]);
      await client.query("SET LOCAL ROLE guto_v3_app");
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
    const state = await this.loadAppState(actor);
    if (!state.profile || !state.goal) {
      throw new V3Error("V3_OFFICIAL_PROFILE_INCOMPLETE", "Perfil oficial V3 ainda não foi migrado.", 409);
    }
    return {
      actor,
      memoryVersion: state.memoryVersion,
      profile: state.profile,
      goal: state.goal,
      preferences: state.preferences,
      healthConstraints: state.healthConstraints,
      workout: state.workout,
      diet: state.diet,
    };
  }

  async loadAppState(actor: ActorContext): Promise<V3AppState> {
    return this.withActorTransaction(actor, async (client) => {
      const [userResult, profileResult, goalResult, preferencesResult, healthResult, workoutResult, dietResult, journeyResult, xpResult] = await Promise.all([
        client.query(`SELECT version, display_name FROM guto_v3.users WHERE tenant_id = $1 AND id = $2`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.user_profile WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.user_goals WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.user_preferences WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.user_health_constraints WHERE tenant_id = $1 AND user_id = $2 AND confirmed = true ORDER BY created_at`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.workout_plans WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.diet_plans WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [actor.tenantId, actor.userId]),
        client.query(`SELECT * FROM guto_v3.user_journey_state WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]),
        client.query(`SELECT id, reason_code, amount, source_key, created_at FROM guto_v3.xp_ledger WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at, id`, [actor.tenantId, actor.userId]),
      ]);

      const user = userResult.rows[0];
      const profileRow = profileResult.rows[0];
      const goalRow = goalResult.rows[0];
      if (!user) throw new V3Error("V3_IDENTITY_NOT_MIGRATED", "Identidade V3 ausente.", 409);

      const workout = workoutResult.rows[0]
        ? await this.loadWorkout(client, workoutResult.rows[0])
        : null;
      const diet = dietResult.rows[0]
        ? await this.loadDiet(client, dietResult.rows[0])
        : null;

      const profile: OfficialProfile | null = profileRow ? {
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
      } : null;
      const goal: OfficialGoal | null = goalRow ? { version: asNumber(goalRow.version), code: goalRow.goal_code } : null;
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

      const journeyRow = journeyResult.rows[0];
      const xpEvents = xpResult.rows.map((row) => ({
        id: String(row.id),
        reasonCode: row.reason_code as XpReasonCode,
        amount: asNumber(row.amount),
        sourceKey: String(row.source_key),
        createdAt: new Date(row.created_at).toISOString(),
      }));
      const totalXp = xpEvents.reduce((sum, event) => sum + event.amount, 0);
      const today = this.todayKey();
      return {
        actor,
        memoryVersion: asNumber(user.version),
        displayName: user.display_name || "",
        journey: {
          preferredLanguage: journeyRow?.preferred_language || profile?.language || "pt-BR",
          consentAcceptedAt: journeyRow?.consent_accepted_at ? new Date(journeyRow.consent_accepted_at).toISOString() : null,
          sovereignNameConfirmedAt: journeyRow?.sovereign_name_confirmed_at ? new Date(journeyRow.sovereign_name_confirmed_at).toISOString() : null,
          pactAcceptedAt: journeyRow?.pact_accepted_at ? new Date(journeyRow.pact_accepted_at).toISOString() : null,
          initialXpRewardSeen: Boolean(journeyRow?.initial_xp_reward_seen),
        },
        profile,
        goal,
        preferences,
        healthConstraints,
        workout,
        diet,
        progression: {
          totalXp,
          evolutionStage: totalXp >= 12_000 ? "elite" : totalXp >= 5_000 ? "adult" : totalXp >= 1_500 ? "teen" : "baby",
          trainedToday: xpEvents.some((event) => event.reasonCode === "complete_daily_mission" && event.sourceKey === today),
          adaptedMissionToday: xpEvents.some((event) => event.reasonCode === "accept_adapted_mission" && event.sourceKey === today),
          xpEvents,
        },
      };
    });
  }

  async persistJourney(input: {
    actor: ActorContext;
    requestId: string;
    displayName?: string;
    preferredLanguage?: "pt-BR" | "en-US" | "it-IT";
    acceptConsent?: boolean;
    confirmName?: boolean;
    initialXpRewardSeen?: boolean;
  }): Promise<void> {
    await this.withActorTransaction(input.actor, async (client) => {
      await client.query(
        `INSERT INTO guto_v3.user_journey_state
           (tenant_id,user_id,preferred_language,consent_accepted_at,sovereign_name_confirmed_at,initial_xp_reward_seen)
         VALUES ($1,$2,COALESCE($3,'pt-BR'),CASE WHEN $4 THEN now() ELSE NULL END,CASE WHEN $5 THEN now() ELSE NULL END,COALESCE($6,false))
         ON CONFLICT (user_id) DO UPDATE SET
           preferred_language=COALESCE($3,guto_v3.user_journey_state.preferred_language),
           consent_accepted_at=CASE WHEN $4 THEN COALESCE(guto_v3.user_journey_state.consent_accepted_at,now()) ELSE guto_v3.user_journey_state.consent_accepted_at END,
           sovereign_name_confirmed_at=CASE WHEN $5 THEN COALESCE(guto_v3.user_journey_state.sovereign_name_confirmed_at,now()) ELSE guto_v3.user_journey_state.sovereign_name_confirmed_at END,
           initial_xp_reward_seen=COALESCE($6,guto_v3.user_journey_state.initial_xp_reward_seen),
           version=guto_v3.user_journey_state.version+1`,
        [input.actor.tenantId, input.actor.userId, input.preferredLanguage || null, Boolean(input.acceptConsent), Boolean(input.confirmName), input.initialXpRewardSeen ?? null],
      );
      if (input.displayName?.trim()) {
        await client.query(`UPDATE guto_v3.users SET display_name=$1, version=version+1 WHERE tenant_id=$2 AND id=$3`, [input.displayName.trim(), input.actor.tenantId, input.actor.userId]);
      }
      await this.appendMutationEvent(client, input.actor, input.requestId, "journey.updated", {
        consentAccepted: Boolean(input.acceptConsent),
        nameConfirmed: Boolean(input.confirmName),
      });
    });
  }

  private todayKey(): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.GUTO_TIME_ZONE || "Europe/Rome",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
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
        canonicalNamePt: item.canonical_name_pt || undefined,
        rest: item.rest_text || undefined,
        cue: item.cue || undefined,
        note: item.note || undefined,
        videoUrl: item.video_url || undefined,
        sourceFileName: item.source_file_name || undefined,
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
    return this.withActorTransaction(actor, async (client) => {
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

  async completePact(input: {
    actor: ActorContext;
    requestId: string;
    displayName: string;
    workoutDraft: WorkoutPlanDraft;
    dietDraft: DietPlanDraft;
  }): Promise<void> {
    await this.withActorTransaction(input.actor, async (client) => {
      await client.query(
        `INSERT INTO guto_v3.user_journey_state (tenant_id,user_id,preferred_language)
         SELECT $1,$2,COALESCE(p.language,'pt-BR') FROM guto_v3.user_profile p
          WHERE p.tenant_id=$1 AND p.user_id=$2
         ON CONFLICT (user_id) DO NOTHING`,
        [input.actor.tenantId, input.actor.userId],
      );
      const journey = await client.query<{ consent_accepted_at: Date | null; pact_accepted_at: Date | null }>(
        `SELECT consent_accepted_at,pact_accepted_at FROM guto_v3.user_journey_state
          WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (!journey.rows[0]?.consent_accepted_at) {
        throw new V3Error("V3_CONSENT_REQUIRED", "Consentimento oficial necessário antes do pacto.", 409);
      }
      if (journey.rows[0].pact_accepted_at) return;
      const profile = await client.query(`SELECT 1 FROM guto_v3.user_profile WHERE tenant_id=$1 AND user_id=$2`, [input.actor.tenantId, input.actor.userId]);
      if (!profile.rows[0]) throw new V3Error("V3_CALIBRATION_REQUIRED", "Calibragem oficial necessária antes do pacto.", 409);

      const activeWorkout = await client.query<{ id: string }>(
        `SELECT id FROM guto_v3.workout_plans WHERE tenant_id=$1 AND user_id=$2 AND status='active' FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (!activeWorkout.rows[0]) {
        const plan = await client.query<{ id: string; version: string }>(
          `INSERT INTO guto_v3.workout_plans (tenant_id,user_id,title,status,generated_from)
           VALUES ($1,$2,$3,'active',$4::jsonb) RETURNING id,version`,
          [input.actor.tenantId, input.actor.userId, input.workoutDraft.title, JSON.stringify(input.workoutDraft.generatedFrom)],
        );
        for (const item of input.workoutDraft.items) {
          await client.query(
            `INSERT INTO guto_v3.workout_plan_items
               (tenant_id,plan_id,exercise_id,name,purpose,muscle_group,position,sets,reps,canonical_name_pt,rest_text,cue,note,video_url,source_file_name)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [input.actor.tenantId, plan.rows[0]!.id, item.exerciseId, item.name, item.purpose, item.muscleGroup, item.position, item.sets || null, item.reps || null, item.canonicalNamePt || null, item.rest || null, item.cue || null, item.note || null, item.videoUrl || null, item.sourceFileName || null],
          );
        }
        await client.query(
          `INSERT INTO guto_v3.active_plan_versions (tenant_id,user_id,workout_plan_id,workout_plan_version)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id) DO UPDATE SET workout_plan_id=EXCLUDED.workout_plan_id,workout_plan_version=EXCLUDED.workout_plan_version,version=guto_v3.active_plan_versions.version+1`,
          [input.actor.tenantId, input.actor.userId, plan.rows[0]!.id, plan.rows[0]!.version],
        );
      }

      const activeDiet = await client.query<{ id: string }>(
        `SELECT id FROM guto_v3.diet_plans WHERE tenant_id=$1 AND user_id=$2 AND status='active' FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (!activeDiet.rows[0]) {
        const plan = await client.query<{ id: string; version: string }>(
          `INSERT INTO guto_v3.diet_plans
             (tenant_id,user_id,status,total_calories,protein_grams,carbs_grams,fat_grams,calculation_method,generated_from)
           VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8::jsonb) RETURNING id,version`,
          [input.actor.tenantId, input.actor.userId, input.dietDraft.totalCalories, input.dietDraft.proteinGrams, input.dietDraft.carbsGrams, input.dietDraft.fatGrams, input.dietDraft.calculationMethod, JSON.stringify(input.dietDraft.generatedFrom)],
        );
        for (const meal of input.dietDraft.meals) {
          const insertedMeal = await client.query<{ id: string }>(
            `INSERT INTO guto_v3.diet_meals (tenant_id,plan_id,name,position,calories) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [input.actor.tenantId, plan.rows[0]!.id, meal.name, meal.position, meal.calories],
          );
          for (const item of meal.items) {
            await client.query(
              `INSERT INTO guto_v3.diet_items
                 (tenant_id,meal_id,food_id,name,quantity_grams,calories,protein_grams,carbs_grams,fat_grams,position)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [input.actor.tenantId, insertedMeal.rows[0]!.id, item.foodId, item.name, item.quantityGrams, item.calories, item.proteinGrams, item.carbsGrams, item.fatGrams, item.position],
            );
          }
        }
        await client.query(
          `INSERT INTO guto_v3.active_plan_versions (tenant_id,user_id,diet_plan_id,diet_plan_version)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id) DO UPDATE SET diet_plan_id=EXCLUDED.diet_plan_id,diet_plan_version=EXCLUDED.diet_plan_version,version=guto_v3.active_plan_versions.version+1`,
          [input.actor.tenantId, input.actor.userId, plan.rows[0]!.id, plan.rows[0]!.version],
        );
      }

      await client.query(
        `INSERT INTO guto_v3.xp_ledger (tenant_id,user_id,request_id,amount,reason_code,source_key)
         VALUES ($1,$2,$3,100,'grant_initial_xp','lifetime')
         ON CONFLICT (tenant_id,user_id,reason_code,source_key) DO NOTHING`,
        [input.actor.tenantId, input.actor.userId, input.requestId],
      );
      await client.query(
        `UPDATE guto_v3.user_journey_state SET
           sovereign_name_confirmed_at=COALESCE(sovereign_name_confirmed_at,now()),
           pact_accepted_at=now(),version=version+1
         WHERE tenant_id=$1 AND user_id=$2`,
        [input.actor.tenantId, input.actor.userId],
      );
      await client.query(
        `UPDATE guto_v3.users SET display_name=$1,version=version+1 WHERE tenant_id=$2 AND id=$3`,
        [input.displayName.trim(), input.actor.tenantId, input.actor.userId],
      );
      await this.appendMutationEvent(client, input.actor, input.requestId, "pact.completed", {
        workoutReady: true,
        dietReady: true,
        initialXp: 100,
      });
    });
  }

  async recordXp(input: {
    actor: ActorContext;
    requestId: string;
    reasonCode: XpReasonCode;
    sourceKey: string;
  }): Promise<void> {
    await this.withActorTransaction(input.actor, async (client) => {
      let amount = input.reasonCode === "grant_initial_xp" || input.reasonCode === "complete_daily_mission"
        ? 100
        : input.reasonCode === "accept_adapted_mission"
          ? 50
          : -20;
      if (input.reasonCode === "complete_daily_mission") {
        const adapted = await client.query(
          `SELECT 1 FROM guto_v3.xp_ledger WHERE tenant_id=$1 AND user_id=$2 AND reason_code='accept_adapted_mission' AND source_key=$3`,
          [input.actor.tenantId, input.actor.userId, input.sourceKey],
        );
        if (adapted.rows[0]) amount = 50;
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO guto_v3.xp_ledger (tenant_id,user_id,request_id,amount,reason_code,source_key)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id,user_id,reason_code,source_key) DO NOTHING
         RETURNING id`,
        [input.actor.tenantId, input.actor.userId, input.requestId, amount, input.reasonCode, input.sourceKey],
      );
      if (!inserted.rows[0]) return;
      if (input.reasonCode === "complete_daily_mission" || input.reasonCode === "accept_adapted_mission") {
        const workout = await client.query<{ id: string }>(
          `SELECT id FROM guto_v3.workout_plans WHERE tenant_id=$1 AND user_id=$2 AND status='active'`,
          [input.actor.tenantId, input.actor.userId],
        );
        if (!workout.rows[0]) throw new V3Error("V3_WORKOUT_NOT_FOUND", "Missão oficial sem treino ativo.", 409);
        await client.query(
          `INSERT INTO guto_v3.workout_sessions (tenant_id,user_id,plan_id,status,started_at,completed_at)
           VALUES ($1,$2,$3,'completed',now(),now())`,
          [input.actor.tenantId, input.actor.userId, workout.rows[0].id],
        );
      }
      await client.query(`UPDATE guto_v3.users SET version=version+1 WHERE tenant_id=$1 AND id=$2`, [input.actor.tenantId, input.actor.userId]);
      await this.appendMutationEvent(client, input.actor, input.requestId, "xp.recorded", {
        reasonCode: input.reasonCode,
        sourceKey: input.sourceKey,
        amount,
      });
    });
  }

  async replaceWorkoutPlan(input: { actor: ActorContext; requestId: string; draft: WorkoutPlanDraft }): Promise<WorkoutPlan> {
    return this.withActorTransaction(input.actor, async (client) => {
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
          `INSERT INTO guto_v3.workout_plan_items
             (tenant_id,plan_id,exercise_id,name,purpose,muscle_group,position,sets,reps,canonical_name_pt,rest_text,cue,note,video_url,source_file_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [input.actor.tenantId, planRow.id, item.exerciseId, item.name, item.purpose, item.muscleGroup, item.position, item.sets || null, item.reps || null, item.canonicalNamePt || null, item.rest || null, item.cue || null, item.note || null, item.videoUrl || null, item.sourceFileName || null],
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
    return this.withActorTransaction(input.actor, async (client) => {
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
    return this.withActorTransaction(input.actor, async (client) => {
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
           exercise_id=$1,name=$2,purpose=$3,muscle_group=$4,
           canonical_name_pt=$5,video_url=$6,source_file_name=$7,version=version+1
         WHERE tenant_id=$8 AND plan_id=$9 AND id=$10`,
        [
          input.candidate.id,
          input.candidate.label,
          String(input.candidate.metadata.purpose || input.candidate.purpose),
          String(input.candidate.metadata.muscleGroup || "unknown"),
          String(input.candidate.metadata.canonicalNamePt || input.candidate.label),
          String(input.candidate.metadata.videoUrl || ""),
          String(input.candidate.metadata.sourceFileName || ""),
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
    return this.withActorTransaction(input.actor, async (client) => {
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
    await this.withActorTransaction(input.actor, async (client) => {
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
    const event = await client.query<{ event_id: string }>(
      `INSERT INTO guto_v3.guto_events (tenant_id,user_id,request_id,event_type,payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (tenant_id,user_id,request_id,event_type) DO NOTHING
       RETURNING event_id`,
      [actor.tenantId, actor.userId, requestId, eventType, JSON.stringify(payload)],
    );
    if (!event.rows[0]) return;
    await client.query(
      `INSERT INTO guto_v3.outbox_events (tenant_id,aggregate_type,aggregate_id,event_type,payload)
       VALUES ($1,'user',$2,$3,$4::jsonb)`,
      [actor.tenantId, actor.userId, eventType, JSON.stringify({ requestId, ...payload })],
    );
  }
}

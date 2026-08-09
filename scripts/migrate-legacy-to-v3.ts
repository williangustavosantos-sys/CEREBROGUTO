import "dotenv/config";
import { createHash } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { getDietPlan } from "../src/diet-store.js";
import { resolveFoodIdByName } from "../src/food-catalog.js";
import { readMemoryStoreAsync } from "../src/memory-store.js";
import { getEffectiveUserAccessAsync } from "../src/user-access-store.js";
import { isValidUserId } from "../src/user-id.js";
import { assertNutritionPlanValid } from "../src/v3/nutrition-engine.js";
import { RedisV3OperationalState } from "../src/v3/operational-state.js";
import type { ActorContext, DietPlan } from "../src/v3/types.js";

const APPLY = process.argv.includes("--apply");
const connectionString = process.env.DATABASE_URL || "";
if (APPLY && !connectionString) throw new Error("DATABASE_URL is required with --apply.");

type JsonRecord = Record<string, unknown>;

interface CanonicalWorkout {
  id: string;
  title: string;
  version: number;
  items: Array<{ id: string; exerciseId: string; name: string; purpose: string; muscleGroup: string; position: number; sets?: number; reps?: string }>;
}

interface MigrationBundle {
  sourceUserId: string;
  subjectHash: string;
  tenantSlug: string;
  actor: ActorContext;
  profile: {
    displayName?: string;
    biologicalSex: "male" | "female" | "other" | "prefer_not_to_say";
    age: number;
    weightKg: number;
    heightCm: number;
    trainingStatus: string;
    trainingLocation: string;
    language: "pt-BR" | "en-US" | "it-IT";
    city: string;
    country: string;
  };
  goal: string;
  dietStyle?: string;
  constraints: Array<{ id: string; kind: string; bodyRegion?: string; description: string }>;
  totalXp: number;
  journey: {
    consentAccepted: boolean;
    nameConfirmed: boolean;
    pactAccepted: boolean;
    initialXpRewardSeen: boolean;
  };
  workout: CanonicalWorkout | null;
  diet: DietPlan | null;
  activeContext: JsonRecord | null;
  errors: string[];
  warnings: string[];
}

function record(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function finite(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function opaque(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
function language(value: unknown): MigrationBundle["profile"]["language"] | null {
  const normalized = text(value).toLowerCase();
  if (normalized.startsWith("pt")) return "pt-BR";
  if (normalized.startsWith("en")) return "en-US";
  if (normalized.startsWith("it")) return "it-IT";
  return null;
}
function sex(value: unknown): MigrationBundle["profile"]["biologicalSex"] | null {
  const normalized = text(value).toLowerCase();
  if (["male", "masculino", "m"].includes(normalized)) return "male";
  if (["female", "feminino", "f"].includes(normalized)) return "female";
  if (["other", "outro"].includes(normalized)) return "other";
  return null;
}

function transformWorkout(userId: string, value: unknown, errors: string[]): CanonicalWorkout | null {
  const plan = record(value);
  if (Object.keys(plan).length === 0) return null;
  const exercises = Array.isArray(plan.exercises) ? plan.exercises.map(record) : [];
  if (exercises.length === 0) { errors.push("WORKOUT_EXERCISES_MISSING"); return null; }
  const planId = deterministicUuid(`v3-workout:${userId}:${text(plan.scheduledFor) || "active"}`);
  const items = exercises.map((exercise, index) => {
    const exerciseId = text(exercise.id);
    const name = text(exercise.name);
    const muscleGroup = text(exercise.muscleGroup);
    if (!exerciseId || !name || !muscleGroup) errors.push(`WORKOUT_ITEM_INVALID:${index}`);
    return {
      id: deterministicUuid(`${planId}:item:${index}:${exerciseId || name}`),
      exerciseId,
      name,
      purpose: text(exercise.movementPattern) || muscleGroup,
      muscleGroup,
      position: index,
      sets: finite(exercise.sets) || undefined,
      reps: text(exercise.reps) || undefined,
    };
  });
  return {
    id: planId,
    title: text(plan.title) || text(plan.focus) || "Treino oficial migrado",
    version: 1,
    items,
  };
}

function quantityGrams(value: unknown): number | null {
  const match = text(value).match(/^(\d+(?:[.,]\d+)?)\s*g$/i);
  return match ? Number(match[1].replace(",", ".")) : null;
}

function transformDiet(userId: string, value: unknown, errors: string[]): DietPlan | null {
  const legacy = record(value);
  if (Object.keys(legacy).length === 0) return null;
  const legacyMeals = Array.isArray(legacy.meals) ? legacy.meals.map(record) : [];
  if (legacyMeals.length === 0) { errors.push("DIET_MEALS_MISSING"); return null; }
  const planId = deterministicUuid(`v3-diet:${userId}:${text(legacy.generatedAt) || "active"}`);
  const meals = legacyMeals.map((meal, mealIndex) => {
    const mealId = deterministicUuid(`${planId}:meal:${mealIndex}`);
    const foods = Array.isArray(meal.foods) ? meal.foods.map(record) : [];
    const items = foods.map((food, foodIndex) => {
      const name = text(food.name);
      const foodId = resolveFoodIdByName(name) || "";
      const grams = quantityGrams(food.quantity);
      const calories = finite(food.kcal);
      const protein = finite(food.proteinG);
      const carbs = finite(food.carbsG);
      const fat = finite(food.fatG);
      if (!foodId) errors.push(`DIET_FOOD_UNKNOWN:${mealIndex}:${foodIndex}`);
      if (grams === null) errors.push(`DIET_QUANTITY_NOT_GRAMS:${mealIndex}:${foodIndex}`);
      if (calories === null || protein === null || carbs === null || fat === null) errors.push(`DIET_NUTRIENTS_MISSING:${mealIndex}:${foodIndex}`);
      return {
        id: deterministicUuid(`${mealId}:item:${foodIndex}:${foodId || name}`),
        foodId,
        name,
        quantityGrams: grams || 0,
        calories: calories || 0,
        proteinGrams: protein || 0,
        carbsGrams: carbs || 0,
        fatGrams: fat || 0,
        position: foodIndex,
      };
    });
    return {
      id: mealId,
      name: text(meal.name) || `Meal ${mealIndex + 1}`,
      position: mealIndex,
      calories: items.reduce((sum, item) => sum + item.calories, 0),
      items,
    };
  });
  const items = meals.flatMap((meal) => meal.items);
  const plan: DietPlan = {
    id: planId,
    version: 1,
    status: "active",
    totalCalories: items.reduce((sum, item) => sum + item.calories, 0),
    proteinGrams: items.reduce((sum, item) => sum + item.proteinGrams, 0),
    carbsGrams: items.reduce((sum, item) => sum + item.carbsGrams, 0),
    fatGrams: items.reduce((sum, item) => sum + item.fatGrams, 0),
    meals,
  };
  if (!errors.some((error) => error.startsWith("DIET_"))) {
    try { assertNutritionPlanValid(plan); } catch { errors.push("DIET_NUTRITION_INVARIANT_FAILED"); }
  }
  return plan;
}

async function transform(userId: string, value: unknown): Promise<MigrationBundle> {
  const memory = record(value);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isValidUserId(userId) || !userId.trim()) errors.push("IDENTITY_INVALID");
  const access = await getEffectiveUserAccessAsync(userId).catch(() => null);
  const tenantSlug = text(access?.teamId) || "guto-core";
  const lang = language(memory.language);
  const biologicalSex = sex(memory.biologicalSex);
  const age = finite(memory.userAge ?? memory.trainingAge);
  const weightKg = finite(memory.weightKg);
  const heightCm = finite(memory.heightCm);
  const city = text(memory.city);
  const country = text(memory.country);
  const trainingStatus = text(memory.trainingStatus);
  const trainingLocation = text(memory.trainingLocation || memory.preferredTrainingLocation);
  const goal = text(memory.trainingGoal);
  if (!lang) errors.push("LANGUAGE_INVALID");
  if (!biologicalSex) errors.push("BIOLOGICAL_SEX_INVALID");
  if (!age || age < 13 || age > 120) errors.push("AGE_INVALID");
  if (!weightKg || weightKg <= 0) errors.push("WEIGHT_INVALID");
  if (!heightCm || heightCm < 100) errors.push("HEIGHT_INVALID");
  if (!city) errors.push("CITY_MISSING");
  if (!country) errors.push("COUNTRY_MISSING");
  if (!trainingStatus) errors.push("TRAINING_STATUS_MISSING");
  if (!trainingLocation) errors.push("TRAINING_LOCATION_MISSING");
  if (!goal) errors.push("GOAL_MISSING");

  const tenantId = deterministicUuid(`v3-tenant:${tenantSlug}`);
  const canonicalUserId = deterministicUuid(`v3-user:${tenantId}:${userId}`);
  const constraints: MigrationBundle["constraints"] = [];
  const limitation = text(memory.trainingLimitations || memory.trainingPathology);
  const foodRestriction = text(memory.foodRestrictions);
  if (limitation) constraints.push({ id: deterministicUuid(`${canonicalUserId}:limitation:${limitation}`), kind: "limitation", description: limitation });
  if (foodRestriction) constraints.push({ id: deterministicUuid(`${canonicalUserId}:food:${foodRestriction}`), kind: "food_restriction", description: foodRestriction });
  const workout = transformWorkout(userId, memory.lastWorkoutPlan, errors);
  const legacyDiet = await getDietPlan(userId).catch(() => null);
  const diet = transformDiet(userId, legacyDiet, errors);
  const activeContext = Object.keys(record(memory.activeContext)).length ? record(memory.activeContext) : null;
  if (activeContext && !workout && !diet) warnings.push("ACTIVE_CONTEXT_WITHOUT_MIGRATABLE_PLAN");

  return {
    sourceUserId: userId,
    subjectHash: opaque(userId),
    tenantSlug,
    actor: { tenantId, userId: canonicalUserId, externalSubject: userId, role: "student" },
    profile: {
      displayName: text(memory.name) || undefined,
      biologicalSex: biologicalSex || "prefer_not_to_say",
      age: age || 0,
      weightKg: weightKg || 0,
      heightCm: heightCm || 0,
      trainingStatus,
      trainingLocation,
      language: lang || "pt-BR",
      city,
      country,
    },
    goal,
    dietStyle: /vegetar/iu.test(foodRestriction) ? "vegetarian" : undefined,
    constraints,
    totalXp: Math.max(0, Math.round(finite(memory.totalXp) || 0)),
    journey: {
      consentAccepted: Boolean(memory.consentHealthFitness || memory.acceptedTerms || text(memory.consentAcceptedAt)),
      nameConfirmed: Boolean(text(memory.sovereignNameConfirmedAt) || memory.confirmedName),
      pactAccepted: Boolean(memory.initialXpGranted),
      initialXpRewardSeen: Boolean(memory.initialXpRewardSeen),
    },
    workout,
    diet,
    activeContext,
    errors,
    warnings,
  };
}

async function insertBundle(client: PoolClient, bundle: MigrationBundle): Promise<void> {
  const identityId = deterministicUuid(`v3-identity:${bundle.tenantSlug}:${bundle.sourceUserId}`);
  const requestId = deterministicUuid(`v3-migration-request:${bundle.sourceUserId}`);
  await client.query("BEGIN");
  try {
    await client.query(`INSERT INTO guto_v3.tenants (id,slug,name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [bundle.actor.tenantId, bundle.tenantSlug, bundle.tenantSlug]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [bundle.actor.tenantId]);
    await client.query(`INSERT INTO guto_v3.identities (id,tenant_id,provider,external_subject) VALUES ($1,$2,'guto-jwt',$3) ON CONFLICT (provider,external_subject) DO NOTHING`, [identityId, bundle.actor.tenantId, bundle.sourceUserId]);
    await client.query(`INSERT INTO guto_v3.users (id,tenant_id,identity_id,display_name) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [bundle.actor.userId, bundle.actor.tenantId, identityId, bundle.profile.displayName || null]);
    await client.query(`INSERT INTO guto_v3.user_profile (tenant_id,user_id,biological_sex,age,weight_kg,height_cm,training_status,training_location,language,city,country)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (user_id) DO NOTHING`, [bundle.actor.tenantId,bundle.actor.userId,bundle.profile.biologicalSex,bundle.profile.age,bundle.profile.weightKg,bundle.profile.heightCm,bundle.profile.trainingStatus,bundle.profile.trainingLocation,bundle.profile.language,bundle.profile.city,bundle.profile.country]);
    await client.query(`INSERT INTO guto_v3.user_preferences (tenant_id,user_id,diet_style) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING`, [bundle.actor.tenantId,bundle.actor.userId,bundle.dietStyle || null]);
    await client.query(`INSERT INTO guto_v3.user_goals (tenant_id,user_id,goal_code) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING`, [bundle.actor.tenantId,bundle.actor.userId,bundle.goal]);
    await client.query(`INSERT INTO guto_v3.user_journey_state
      (tenant_id,user_id,preferred_language,consent_accepted_at,sovereign_name_confirmed_at,pact_accepted_at,initial_xp_reward_seen)
      VALUES ($1,$2,$3,CASE WHEN $4 THEN now() END,CASE WHEN $5 THEN now() END,CASE WHEN $6 THEN now() END,$7)
      ON CONFLICT (user_id) DO UPDATE SET
        preferred_language=EXCLUDED.preferred_language,
        consent_accepted_at=COALESCE(guto_v3.user_journey_state.consent_accepted_at,EXCLUDED.consent_accepted_at),
        sovereign_name_confirmed_at=COALESCE(guto_v3.user_journey_state.sovereign_name_confirmed_at,EXCLUDED.sovereign_name_confirmed_at),
        pact_accepted_at=COALESCE(guto_v3.user_journey_state.pact_accepted_at,EXCLUDED.pact_accepted_at),
        initial_xp_reward_seen=guto_v3.user_journey_state.initial_xp_reward_seen OR EXCLUDED.initial_xp_reward_seen`,
      [bundle.actor.tenantId,bundle.actor.userId,bundle.profile.language,bundle.journey.consentAccepted,bundle.journey.nameConfirmed,bundle.journey.pactAccepted,bundle.journey.initialXpRewardSeen]);
    for (const constraint of bundle.constraints) await client.query(`INSERT INTO guto_v3.user_health_constraints (id,tenant_id,user_id,kind,body_region,description,confirmed,source) VALUES ($1,$2,$3,$4,$5,$6,true,'legacy_migration') ON CONFLICT DO NOTHING`, [constraint.id,bundle.actor.tenantId,bundle.actor.userId,constraint.kind,constraint.bodyRegion || null,constraint.description]);
    if (bundle.workout) {
      await client.query(`INSERT INTO guto_v3.workout_plans (id,tenant_id,user_id,title,status,version,generated_from) VALUES ($1,$2,$3,$4,'active',1,'{"source":"legacy_migration"}'::jsonb) ON CONFLICT (id) DO NOTHING`, [bundle.workout.id,bundle.actor.tenantId,bundle.actor.userId,bundle.workout.title]);
      for (const item of bundle.workout.items) await client.query(`INSERT INTO guto_v3.workout_plan_items (id,tenant_id,plan_id,exercise_id,name,purpose,muscle_group,position,sets,reps) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`, [item.id,bundle.actor.tenantId,bundle.workout.id,item.exerciseId,item.name,item.purpose,item.muscleGroup,item.position,item.sets || null,item.reps || null]);
    }
    if (bundle.diet) {
      await client.query(`INSERT INTO guto_v3.diet_plans (id,tenant_id,user_id,status,total_calories,protein_grams,carbs_grams,fat_grams,generated_from) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,'{"source":"legacy_migration"}'::jsonb) ON CONFLICT (id) DO NOTHING`, [bundle.diet.id,bundle.actor.tenantId,bundle.actor.userId,bundle.diet.totalCalories,bundle.diet.proteinGrams,bundle.diet.carbsGrams,bundle.diet.fatGrams]);
      for (const meal of bundle.diet.meals) {
        await client.query(`INSERT INTO guto_v3.diet_meals (id,tenant_id,plan_id,name,position,calories) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`, [meal.id,bundle.actor.tenantId,bundle.diet.id,meal.name,meal.position,meal.calories]);
        for (const item of meal.items) await client.query(`INSERT INTO guto_v3.diet_items (id,tenant_id,meal_id,food_id,name,quantity_grams,calories,protein_grams,carbs_grams,fat_grams,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`, [item.id,bundle.actor.tenantId,meal.id,item.foodId,item.name,item.quantityGrams,item.calories,item.proteinGrams,item.carbsGrams,item.fatGrams,item.position]);
      }
    }
    await client.query(`INSERT INTO guto_v3.active_plan_versions (tenant_id,user_id,workout_plan_id,workout_plan_version,diet_plan_id,diet_plan_version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO NOTHING`, [bundle.actor.tenantId,bundle.actor.userId,bundle.workout?.id || null,bundle.workout?.version || null,bundle.diet?.id || null,bundle.diet?.version || null]);
    if (bundle.totalXp > 0) await client.query(`INSERT INTO guto_v3.xp_ledger (tenant_id,user_id,request_id,amount,reason_code,source_key) VALUES ($1,$2,$3,$4,'legacy_balance_migration','lifetime') ON CONFLICT DO NOTHING`, [bundle.actor.tenantId,bundle.actor.userId,requestId,bundle.totalXp]);
    await client.query(`INSERT INTO guto_v3.guto_events (tenant_id,user_id,request_id,event_type,payload) VALUES ($1,$2,$3,'legacy.migrated',$4::jsonb) ON CONFLICT DO NOTHING`, [bundle.actor.tenantId,bundle.actor.userId,requestId,JSON.stringify({ workout: Boolean(bundle.workout), diet: Boolean(bundle.diet), xp: bundle.totalXp, activeContext: Boolean(bundle.activeContext) })]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

const legacyStore = await readMemoryStoreAsync();
const bundles: MigrationBundle[] = [];
for (const [userId, value] of Object.entries(legacyStore)) bundles.push(await transform(userId, value));
const ready = bundles.filter((bundle) => bundle.errors.length === 0);
const rejected = bundles.filter((bundle) => bundle.errors.length > 0);

for (const bundle of bundles) {
  process.stdout.write(`${JSON.stringify({ subjectHash: bundle.subjectHash, status: bundle.errors.length ? "rejected" : "ready", checks: { profile: !bundle.errors.some((e) => /LANGUAGE|SEX|AGE|WEIGHT|HEIGHT|CITY|COUNTRY|TRAINING|GOAL/.test(e)), workout: Boolean(bundle.workout), diet: Boolean(bundle.diet), xp: true, activeContext: Boolean(bundle.activeContext) }, errors: bundle.errors, warnings: bundle.warnings })}\n`);
}
process.stdout.write(`${JSON.stringify({ mode: APPLY ? "apply" : "dry-run", total: bundles.length, ready: ready.length, rejected: rejected.length })}\n`);

if (APPLY) {
  const { Pool } = pg;
  const pool = new Pool({ connectionString, ssl: process.env.GUTO_V3_PG_SSL === "disable" ? false : { rejectUnauthorized: false }, max: 2 });
  const operational = RedisV3OperationalState.fromEnvironment();
  try {
    for (const bundle of ready) {
      const client = await pool.connect();
      try { await insertBundle(client, bundle); } finally { client.release(); }
      // Active context is rebuilt only when it maps unambiguously to the migrated official plan.
      if (bundle.activeContext) {
        const type = text(bundle.activeContext.type);
        const currentItem = record(bundle.activeContext.currentItem);
        const sourceItemId = text(currentItem.id);
        const workoutItem = bundle.workout?.items.find((item) => item.exerciseId === sourceItemId || item.id === sourceItemId);
        const dietItem = bundle.diet?.meals.flatMap((meal) => meal.items).find((item) => item.foodId === sourceItemId || item.id === sourceItemId);
        const mapped = type === "workout" && bundle.workout && workoutItem
          ? { kind: "workout" as const, planId: bundle.workout.id, planVersion: bundle.workout.version, itemId: workoutItem.id, itemLabel: workoutItem.name }
          : type === "diet" && bundle.diet && dietItem
            ? { kind: "diet" as const, planId: bundle.diet.id, planVersion: bundle.diet.version, itemId: dietItem.id, itemLabel: dietItem.name }
            : null;
        if (mapped) await operational.compareAndSetActiveContext(bundle.actor, null, { id: deterministicUuid(`v3-context:${bundle.sourceUserId}`), version: 1, ...mapped, rejectedCandidateIds: [], updatedAt: new Date().toISOString() });
      }
    }
  } finally { await pool.end(); }
}

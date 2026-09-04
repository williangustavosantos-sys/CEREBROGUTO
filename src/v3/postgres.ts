import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import type { CalibrationMutation } from "./contracts.js";
import { emptyConversationDecisionState, type ConversationDecisionState, type ConversationKnownFact } from "./conversation-state.js";
import { V3Error } from "./errors.js";
import { materializeFirstContact } from "./first-contact.js";
import { assertFactChange, impactsFor, type FactChange, type RecordedFact } from "./facts.js";
import { assertRelationshipLifecycleState, evaluateOfficialRelationshipReturn, evaluateRelationshipLifecycleState, shouldSuppressProactivity, type RelationshipLifecycleRecord } from "./relationship-lifecycle.js";
import { decideWorkoutEvolution } from "./workout-evolution.js";
import { assertValidAdaptedExecution, resolveSessionEffectiveLocation } from "./session-execution-policy.js";
import type { ConversationStateRepository, DietPlanDraft, FoodReplacement, OfficialStateRepository, WorkoutPlanDraft } from "./repository.js";
import type {
  ActorContext,
  CalibrationResult,
  CandidateOption,
  ConfirmedUserContext,
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

export class PostgresOfficialStateRepository implements OfficialStateRepository, ConversationStateRepository {
  constructor(private readonly pool: pg.Pool, private readonly clock: () => Date = () => new Date()) {}

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

  private mapConfirmedContext(row: QueryResultRow): ConfirmedUserContext {
    return {
      id: String(row.id),
      version: asNumber(row.version),
      confirmedAt: new Date(row.confirmed_at).toISOString(),
      foodDeclaration: String(row.food_declaration),
      limitationDeclaration: String(row.limitation_declaration),
      profileVersion: asNumber(row.profile_version),
      goalVersion: asNumber(row.goal_version),
      weeklyFrequencyDaysPerWeek: asNumber(row.weekly_frequency),
      trainingLocation: "gym",
      factIds: Array.isArray(jsonObject(row.context_snapshot).factIds) ? jsonObject(row.context_snapshot).factIds as string[] : undefined,
    };
  }

  private async lockOfficialContextAuthority(client: PoolClient, actor: ActorContext): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2 || ':official-context-authority', 0))`,
      [actor.tenantId, actor.userId],
    );
  }

  private async assertContextCurrent(client: PoolClient, actor: ActorContext, context: ConfirmedUserContext): Promise<{ language: string }> {
    await this.lockOfficialContextAuthority(client, actor);
    const result = await client.query<QueryResultRow>(
      `SELECT c.id,c.version,c.profile_version,c.goal_version,
              f.status AS first_contact_status,
              f.confirmed_context_id,f.confirmed_context_version,
              p.version AS current_profile_version,p.language,
              g.version AS current_goal_version
         FROM guto_v3.first_contact_state f
         JOIN guto_v3.confirmed_user_contexts c
           ON c.tenant_id=f.tenant_id AND c.user_id=f.user_id
          AND c.id=f.confirmed_context_id AND c.version=f.confirmed_context_version
         JOIN guto_v3.user_profile p ON p.tenant_id=f.tenant_id AND p.user_id=f.user_id
         JOIN guto_v3.user_goals g ON g.tenant_id=f.tenant_id AND g.user_id=f.user_id
        WHERE f.tenant_id=$1 AND f.user_id=$2
        FOR UPDATE OF f,p,g`,
      [actor.tenantId, actor.userId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.first_contact_status !== "COMPLETED" ||
      String(row.id) !== context.id ||
      asNumber(row.version) !== context.version ||
      String(row.confirmed_context_id) !== context.id ||
      asNumber(row.confirmed_context_version) !== context.version ||
      asNumber(row.profile_version) !== context.profileVersion ||
      asNumber(row.current_profile_version) !== context.profileVersion ||
      asNumber(row.goal_version) !== context.goalVersion ||
      asNumber(row.current_goal_version) !== context.goalVersion
    ) {
      throw new V3Error("V3_STALE_GENERATION_CONTEXT", "O contexto oficial mudou durante a geração do plano.", 409);
    }
    return { language: String(row.language) };
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; sessionUser: string; activeRole: string }> {
    const started = performance.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const identity = await client.query<{ session_user: string }>("SELECT session_user AS session_user");
      const sessionUser = identity.rows[0]?.session_user || "unknown";
      if (process.env.GUTO_V3_ONLY === "true") {
        const expectedRole = process.env.GUTO_V3_RUNTIME_DB_ROLE || "guto_v3_runtime";
        if (sessionUser !== expectedRole) {
          throw new V3Error(
            "V3_DATABASE_RUNTIME_ROLE_REQUIRED",
            "A conexão runtime do Cérebro V3 não usa o papel restrito esperado.",
            503,
          );
        }
      }

      const sentinelId = "00000000-0000-0000-0000-000000000000";
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $1, true)",
        [sentinelId],
      );
      await client.query("SET LOCAL ROLE guto_v3_app");
      for (const table of [
        "users",
        "user_journey_state",
        "user_profile",
        "workout_plans",
        "diet_plans",
        "conversation_threads",
        "first_contact_state",
        "confirmed_user_contexts",
      ]) {
        await client.query(`SELECT 1 FROM guto_v3.${table} LIMIT 0`);
      }
      const role = await client.query<{ active_role: string }>("SELECT current_user AS active_role");
      const activeRole = role.rows[0]?.active_role || "unknown";
      if (activeRole !== "guto_v3_app") {
        throw new V3Error("V3_DATABASE_APP_ROLE_REQUIRED", "O papel de aplicação V3 não está ativo.", 503);
      }
      await client.query("COMMIT");
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - started),
        sessionUser,
        activeRole,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
    const confirmedSource = await this.withActorTransaction(actor, async (client) => {
      const result = await client.query(
        `SELECT c.*,p.version AS current_profile_version,g.version AS current_goal_version
           FROM guto_v3.confirmed_user_contexts c
           JOIN guto_v3.user_profile p ON p.tenant_id=c.tenant_id AND p.user_id=c.user_id
           JOIN guto_v3.user_goals g ON g.tenant_id=c.tenant_id AND g.user_id=c.user_id
          WHERE c.tenant_id=$1 AND c.user_id=$2 ORDER BY c.version DESC LIMIT 1`,
        [actor.tenantId, actor.userId],
      );
      const row = result.rows[0];
      return row ? {
        context: this.mapConfirmedContext(row),
        snapshot: jsonObject(row.context_snapshot),
        currentProfileVersion: asNumber(row.current_profile_version),
        currentGoalVersion: asNumber(row.current_goal_version),
      } : null;
    });
    const confirmedContext = confirmedSource?.context || null;
    if (confirmedContext && (confirmedSource!.currentProfileVersion !== confirmedContext.profileVersion || confirmedSource!.currentGoalVersion !== confirmedContext.goalVersion)) {
      throw new V3Error("V3_CONTEXT_RECONFIRMATION_REQUIRED", "O perfil mudou. Confirme novamente o contexto antes de continuar.", 409);
    }
    const storedProfile = jsonObject(confirmedSource?.snapshot.profile);
    const storedGoal = jsonObject(confirmedSource?.snapshot.goal);
    const profile = confirmedContext ? {
      ...state.profile,
      ...storedProfile,
      version: confirmedContext.profileVersion,
      weeklyFrequencyDaysPerWeek: confirmedContext.weeklyFrequencyDaysPerWeek,
      trainingLocation: "gym",
    } as OfficialProfile : state.profile;
    const goal = confirmedContext ? { ...state.goal, ...storedGoal, version: confirmedContext.goalVersion } as OfficialGoal : state.goal;
    return {
      actor,
      memoryVersion: state.memoryVersion,
      profile,
      goal,
      preferences: state.preferences,
      healthConstraints: state.healthConstraints,
      currentFacts: state.currentFacts,
      firstContact: state.firstContact,
      confirmedContext,
      workout: state.workout,
      diet: state.diet,
      relationshipLifecycle: state.relationshipLifecycle,
      nextSessionIndex: await this.countCompletedWorkoutSessions(actor),
    };
  }

  /**
   * P0 (pool max=1 safety): variant of loadOfficialSnapshot that runs on the
   * CURRENT transaction client instead of acquiring a second pool connection.
   * recordWorkoutExerciseEvent holds a transaction while validating adapted
   * executions; loading the snapshot through the same client guarantees the
   * operation never deadlocks waiting for a second connection when the pool
   * is exhausted (e.g. GUTO_V3_PG_POOL_MAX=1).
   *
   * Loads only what the session-execution policy needs: profile, confirmed
   * context and current physical-constraint facts.
   */
  private async loadOfficialSnapshotWithinTransaction(client: PoolClient, actor: ActorContext): Promise<OfficialSnapshot> {
    // PoolClient is a single transactional connection. Sequence these reads so
    // the runtime never multiplexes concurrent queries on one socket.
    const profileResult = await client.query(`SELECT * FROM guto_v3.user_profile WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]);
    const goalResult = await client.query(`SELECT * FROM guto_v3.user_goals WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]);
    const factResult = await client.query(`SELECT user_fact_id, fact_type, value_json, source, confirmation_status, valid_from, valid_to, recorded_at, superseded_at, superseded_by
                      FROM guto_v3.user_facts
                     WHERE tenant_id = $1 AND user_id = $2 AND superseded_at IS NULL
                       AND fact_type IN ('physical_constraint','food_restriction','PHYSICAL_CONSTRAINT','FOOD_CONSTRAINT','FOOD_EXCLUSION')
                     ORDER BY recorded_at`, [actor.tenantId, actor.userId]);
    const contextResult = await client.query(
      `SELECT c.*,p.version AS current_profile_version,g.version AS current_goal_version
           FROM guto_v3.confirmed_user_contexts c
           JOIN guto_v3.user_profile p ON p.tenant_id=c.tenant_id AND p.user_id=c.user_id
           JOIN guto_v3.user_goals g ON g.tenant_id=c.tenant_id AND g.user_id=c.user_id
          WHERE c.tenant_id=$1 AND c.user_id=$2 ORDER BY c.version DESC LIMIT 1`,
      [actor.tenantId, actor.userId],
    );
    const row = contextResult.rows[0];
    const confirmedContext = row ? this.mapConfirmedContext(row) : null;
    const storedSnapshot = row?.context_snapshot ? jsonObject(row.context_snapshot) : {};
    const storedProfile = jsonObject(storedSnapshot.profile);
    const storedGoal = jsonObject(storedSnapshot.goal);
    const profileRow = profileResult.rows[0];
    const baseProfile: OfficialProfile | null = profileRow ? {
      version: asNumber(profileRow.version),
      language: profileRow.language,
      biologicalSex: profileRow.biological_sex,
      age: asNumber(profileRow.age),
      weightKg: asNumber(profileRow.weight_kg),
      heightCm: asNumber(profileRow.height_cm),
      trainingStatus: profileRow.training_status,
      trainingLocation: profileRow.training_location,
      weeklyFrequencyDaysPerWeek: profileRow.weekly_frequency == null ? null : asNumber(profileRow.weekly_frequency),
    } : null;
    const profile = confirmedContext && baseProfile ? {
      ...baseProfile,
      ...storedProfile,
      version: confirmedContext.profileVersion,
      weeklyFrequencyDaysPerWeek: confirmedContext.weeklyFrequencyDaysPerWeek,
      trainingLocation: "gym",
    } as OfficialProfile : baseProfile;
    const goalRow = goalResult.rows[0];
    const baseGoal: OfficialGoal | null = goalRow ? { version: asNumber(goalRow.version), code: goalRow.goal_code } : null;
    const goal = confirmedContext && baseGoal ? { ...baseGoal, ...storedGoal, version: confirmedContext.goalVersion } as OfficialGoal : baseGoal;
    const currentFacts: RecordedFact[] = factResult.rows.map((row) => {
      const value = jsonObject(row.value_json);
      return {
        id: String(row.user_fact_id),
        factType: String(row.fact_type).toUpperCase() as RecordedFact["factType"],
        canonicalValue: typeof value.code === "string" ? value.code : typeof value.declaration === "string" ? value.declaration : JSON.stringify(value),
        value,
        source: row.source === "system" ? "system" : "user_declared",
        confirmationStatus: row.confirmation_status,
        validFrom: new Date(row.valid_from).toISOString(),
        validTo: row.valid_to ? new Date(row.valid_to).toISOString() : null,
        recordedAt: new Date(row.recorded_at).toISOString(),
        supersededAt: row.superseded_at ? new Date(row.superseded_at).toISOString() : null,
        supersededBy: row.superseded_by ? String(row.superseded_by) : null,
      };
    });
    return {
      actor,
      memoryVersion: 0,
      profile: profile as OfficialProfile,
      goal: goal as OfficialGoal,
      preferences: {} as OfficialPreferences,
      healthConstraints: [],
      currentFacts,
      firstContact: { status: "COMPLETED", step: "completed", foodDeclaration: "", limitationDeclaration: "", startedAt: null, completedAt: null, currentPrompt: null, summary: null, confirmedContextVersion: confirmedContext?.version ?? 0 },
      confirmedContext,
      workout: null,
      diet: null,
    };
  }

  async loadAppState(actor: ActorContext): Promise<V3AppState> {
    return this.withActorTransaction(actor, async (client) => {
      // A PoolClient transacional executa uma query por vez. Manter a leitura
      // sequencial evita concorrência não suportada no mesmo socket e preserva
      // um único snapshot/escopo RLS para todo o estado oficial.
      const userResult = await client.query(`SELECT version, display_name FROM guto_v3.users WHERE tenant_id = $1 AND id = $2`, [actor.tenantId, actor.userId]);
      const profileResult = await client.query(`SELECT * FROM guto_v3.user_profile WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]);
      const goalResult = await client.query(`SELECT * FROM guto_v3.user_goals WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]);
      const preferencesResult = await client.query(`SELECT * FROM guto_v3.user_preferences WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]);
      const healthResult = await client.query(`SELECT * FROM guto_v3.user_health_constraints WHERE tenant_id = $1 AND user_id = $2 AND confirmed = true ORDER BY created_at`, [actor.tenantId, actor.userId]);
      const factHealthResult = await client.query(`SELECT user_fact_id, fact_type, value_json, source, confirmation_status, valid_from, valid_to, recorded_at, superseded_at, superseded_by
                        FROM guto_v3.user_facts
                       WHERE tenant_id = $1 AND user_id = $2 AND superseded_at IS NULL
                         AND fact_type IN ('physical_constraint','food_restriction','PHYSICAL_CONSTRAINT','FOOD_CONSTRAINT','FOOD_EXCLUSION')
                       ORDER BY recorded_at`, [actor.tenantId, actor.userId]);
      const workoutResult = await client.query(`SELECT * FROM guto_v3.workout_plans WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [actor.tenantId, actor.userId]);
      const dietResult = await client.query(`SELECT * FROM guto_v3.diet_plans WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [actor.tenantId, actor.userId]);
      const journeyResult = await client.query(`SELECT * FROM guto_v3.user_journey_state WHERE tenant_id = $1 AND user_id = $2`, [actor.tenantId, actor.userId]);
      const xpResult = await client.query(`SELECT id, reason_code, amount, source_key, created_at FROM guto_v3.xp_ledger WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at, id`, [actor.tenantId, actor.userId]);
      const firstContactResult = await client.query(`SELECT * FROM guto_v3.first_contact_state WHERE tenant_id=$1 AND user_id=$2`, [actor.tenantId, actor.userId]);
      const contextResult = await client.query(`SELECT * FROM guto_v3.confirmed_user_contexts WHERE tenant_id=$1 AND user_id=$2 ORDER BY version DESC LIMIT 1`, [actor.tenantId, actor.userId]);

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
        city: profileRow.city || undefined,
        country: profileRow.country || undefined,
        biologicalSex: profileRow.biological_sex,
        age: asNumber(profileRow.age),
        weightKg: asNumber(profileRow.weight_kg),
        heightCm: asNumber(profileRow.height_cm),
        trainingStatus: profileRow.training_status,
        trainingLocation: profileRow.training_location,
        weeklyFrequencyDaysPerWeek: profileRow.weekly_frequency == null ? null : asNumber(profileRow.weekly_frequency),
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
      const knownConstraintValues = new Set(healthConstraints.map((constraint) => `${constraint.kind}:${constraint.bodyRegion || ""}:${constraint.description}`));
      const currentFacts: RecordedFact[] = factHealthResult.rows.map((row) => {
        const value = jsonObject(row.value_json);
        return {
          id: String(row.user_fact_id),
          factType: String(row.fact_type).toUpperCase() as RecordedFact["factType"],
          canonicalValue: typeof value.code === "string" ? value.code : typeof value.declaration === "string" ? value.declaration : JSON.stringify(value),
          value,
          source: row.source === "system" ? "system" : "user_declared",
          confirmationStatus: row.confirmation_status,
          validFrom: new Date(row.valid_from).toISOString(),
          validTo: row.valid_to ? new Date(row.valid_to).toISOString() : null,
          recordedAt: new Date(row.recorded_at).toISOString(),
          supersededAt: row.superseded_at ? new Date(row.superseded_at).toISOString() : null,
          supersededBy: row.superseded_by ? String(row.superseded_by) : null,
        };
      });
      for (const row of factHealthResult.rows) {
        const value = jsonObject(row.value_json);
        const bodyRegion = typeof value.bodyRegion === "string" ? value.bodyRegion : typeof value.area === "string" ? value.area : undefined;
        const description = typeof value.description === "string"
          ? value.description
          : typeof value.declaration === "string" ? value.declaration
          : bodyRegion ? `Limitação declarada: ${bodyRegion}` : String(row.fact_type);
        const kind: HealthConstraint["kind"] = row.fact_type === "food_restriction" ? "food_restriction" : "limitation";
        const identity = `${kind}:${bodyRegion || ""}:${description}`;
        if (!knownConstraintValues.has(identity)) {
          healthConstraints.push({
            id: row.user_fact_id,
            kind,
            bodyRegion,
            description,
            severity: "unknown",
            confirmed: row.confirmation_status === "FACT_CONFIRMED",
          });
          knownConstraintValues.add(identity);
        }
      }

      const lifecycleResult = await client.query<QueryResultRow>(
        `SELECT state, entered_state_at, last_evaluated_at, last_presence_day, consecutive_absence_days, version
           FROM guto_v3.relationship_lifecycle
          WHERE tenant_id=$1 AND user_id=$2`,
        [actor.tenantId, actor.userId],
      );
      const relationshipLifecycle = lifecycleResult.rows[0] ? this.mapLifecycleRow(lifecycleResult.rows[0], actor) : null;
      const journeyRow = journeyResult.rows[0];
      const firstContactRow = firstContactResult.rows[0];
      const fullContext = contextResult.rows[0] ? this.mapConfirmedContext(contextResult.rows[0]) : null;
      const firstContact = materializeFirstContact({
        status: firstContactRow?.status,
        step: firstContactRow?.step,
        foodDeclaration: firstContactRow?.food_declaration || null,
        limitationDeclaration: firstContactRow?.limitation_declaration || null,
        startedAt: firstContactRow?.started_at ? new Date(firstContactRow.started_at).toISOString() : null,
        completedAt: firstContactRow?.completed_at ? new Date(firstContactRow.completed_at).toISOString() : null,
        confirmedContextVersion: firstContactRow?.confirmed_context_version == null ? null : asNumber(firstContactRow.confirmed_context_version),
        displayName: user.display_name || "",
        profile,
        goal,
      });
      const confirmedWorkout = fullContext && workout?.confirmedContextVersion === fullContext.version ? workout : null;
      const confirmedDiet = fullContext && diet?.confirmedContextVersion === fullContext.version ? diet : null;
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
        firstContact,
        confirmedContext: fullContext
          ? {
              id: fullContext.id,
              version: fullContext.version,
              confirmedAt: fullContext.confirmedAt,
              profileVersion: fullContext.profileVersion,
              goalVersion: fullContext.goalVersion,
              foodDeclaration: fullContext.foodDeclaration,
              limitationDeclaration: fullContext.limitationDeclaration,
            }
          : null,
        currentFacts,
        workout: confirmedWorkout,
        diet: confirmedDiet,
        relationshipLifecycle,
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
    }).format(this.clock());
  }

  private async loadWorkout(client: PoolClient, row: QueryResultRow): Promise<WorkoutPlan> {
    const items = await client.query(`SELECT * FROM guto_v3.workout_plan_items WHERE plan_id = $1 ORDER BY position`, [row.id]);
    return {
      id: row.id,
      version: asNumber(row.version),
      title: row.title,
      status: row.status,
      confirmedContextVersion: row.confirmed_context_version == null ? null : asNumber(row.confirmed_context_version),
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
      confirmedContextVersion: row.confirmed_context_version == null ? null : asNumber(row.confirmed_context_version),
      totalCalories: asNumber(row.total_calories),
      proteinGrams: asNumber(row.protein_grams),
      carbsGrams: asNumber(row.carbs_grams),
      fatGrams: asNumber(row.fat_grams),
      meals,
    };
  }

  async persistCalibration(actor: ActorContext, input: CalibrationMutation): Promise<CalibrationResult> {
    return this.withActorTransaction(actor, async (client) => {
      await this.lockOfficialContextAuthority(client, actor);
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
           training_location, language, city, country, weekly_frequency
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'gym',
           COALESCE((SELECT preferred_language FROM guto_v3.user_journey_state WHERE tenant_id=$1 AND user_id=$2),'pt-BR'),
           NULL,NULL,$8)
         ON CONFLICT (user_id) DO UPDATE SET
           biological_sex = EXCLUDED.biological_sex,
           age = EXCLUDED.age,
           weight_kg = EXCLUDED.weight_kg,
           height_cm = EXCLUDED.height_cm,
           training_status = EXCLUDED.training_status,
           training_location = 'gym',
           language = EXCLUDED.language,
           city = NULL,
           country = NULL,
           weekly_frequency = EXCLUDED.weekly_frequency,
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
          input.profile.weeklyFrequencyDaysPerWeek,
        ],
      );
      await client.query(
        `INSERT INTO guto_v3.user_preferences (tenant_id, user_id, diet_style)
         VALUES ($1,$2,NULL)
         ON CONFLICT (user_id) DO NOTHING`,
        [actor.tenantId, actor.userId],
      );
      await client.query(
        `INSERT INTO guto_v3.user_goals (tenant_id, user_id, goal_code)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET goal_code = EXCLUDED.goal_code,
           version = guto_v3.user_goals.version + 1`,
        [actor.tenantId, actor.userId, input.goal.code],
      );
      await client.query(`DELETE FROM guto_v3.user_health_constraints WHERE tenant_id = $1 AND user_id = $2 AND source = 'calibration'`, [actor.tenantId, actor.userId]);
      await this.persistFact(client, actor, {
        factType: "GOAL",
        value: { code: input.goal.code },
        canonicalValue: input.goal.code,
        source: "system",
        confirmationStatus: "FACT_CONFIRMED",
        supersedeCurrent: true,
      });
      await this.persistFact(client, actor, { factType: "BODY_WEIGHT", value: { weightKg: input.profile.weightKg }, canonicalValue: String(input.profile.weightKg), source: "system", confirmationStatus: "FACT_CONFIRMED", supersedeCurrent: true });
      await this.persistFact(client, actor, { factType: "TRAINING_FREQUENCY", value: { daysPerWeek: input.profile.weeklyFrequencyDaysPerWeek }, canonicalValue: String(input.profile.weeklyFrequencyDaysPerWeek), source: "system", confirmationStatus: "FACT_CONFIRMED", supersedeCurrent: true });
      await this.persistFact(client, actor, { factType: "EXPERIENCE_LEVEL", value: { code: input.profile.trainingStatus }, canonicalValue: input.profile.trainingStatus, source: "system", confirmationStatus: "FACT_CONFIRMED", supersedeCurrent: true });
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

  async persistProfileLocation(actor: ActorContext, input: { requestId: string; country?: string; city?: string }): Promise<void> {
    await this.withActorTransaction(actor, async (client) => {
      await this.lockOfficialContextAuthority(client, actor);
      const prior = await client.query(
        `SELECT 1 FROM guto_v3.guto_events WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3 AND event_type='profile.location_updated'`,
        [actor.tenantId, actor.userId, input.requestId],
      );
      if (prior.rows[0]) return;
      const updated = await client.query(
        `UPDATE guto_v3.user_profile SET
           city = COALESCE($1, city),
           country = COALESCE($2, country),
           version = version + 1
         WHERE tenant_id=$3 AND user_id=$4
         RETURNING version`,
        [input.city?.trim() || null, input.country?.trim() || null, actor.tenantId, actor.userId],
      );
      if (!updated.rows[0]) return; // sem perfil ainda (pré-calibragem) — nada a persistir
      await this.appendMutationEvent(client, actor, input.requestId, "profile.location_updated", {
        country: input.country?.trim() || null,
        city: input.city?.trim() || null,
      });
    });
  }

  async startFirstContact(input: { actor: ActorContext; requestId: string }): Promise<void> {
    await this.withActorTransaction(input.actor, async (client) => {
      const prior = await client.query(`SELECT 1 FROM guto_v3.guto_events WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3 AND event_type='first_contact.started'`, [input.actor.tenantId, input.actor.userId, input.requestId]);
      if (prior.rows[0]) return;
      const source = await client.query<{ weekly_frequency: string | null }>(
        `SELECT p.weekly_frequency FROM guto_v3.user_profile p
          JOIN guto_v3.user_goals g ON g.tenant_id=p.tenant_id AND g.user_id=p.user_id
         WHERE p.tenant_id=$1 AND p.user_id=$2 FOR UPDATE OF p,g`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (!source.rows[0] || source.rows[0].weekly_frequency == null) {
        throw new V3Error("V3_CALIBRATION_REQUIRED", "Calibragem objetiva completa necessária antes do First Contact.", 409);
      }
      const current = await client.query<{ status: string }>(
        `SELECT status FROM guto_v3.first_contact_state WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (current.rows[0]?.status === "COMPLETED" || current.rows[0]?.status === "IN_PROGRESS") return;
      await client.query(
        `INSERT INTO guto_v3.first_contact_state (tenant_id,user_id,status,step,started_at)
         VALUES ($1,$2,'IN_PROGRESS','food_restrictions',now())
         ON CONFLICT (user_id) DO UPDATE SET status='IN_PROGRESS',step='food_restrictions',started_at=COALESCE(guto_v3.first_contact_state.started_at,now()),version=guto_v3.first_contact_state.version+1
         WHERE guto_v3.first_contact_state.status='NOT_STARTED'`,
        [input.actor.tenantId, input.actor.userId],
      );
      await this.appendMutationEvent(client, input.actor, input.requestId, "first_contact.started", { step: "food_restrictions" });
    });
  }

  async respondFirstContact(input: { actor: ActorContext; requestId: string; expectedStep: "food_restrictions" | "training_limitations"; answer: string }): Promise<void> {
    await this.withActorTransaction(input.actor, async (client) => {
      const prior = await client.query(`SELECT 1 FROM guto_v3.guto_events WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3 AND event_type='first_contact.responded'`, [input.actor.tenantId, input.actor.userId, input.requestId]);
      if (prior.rows[0]) return;
      const current = await client.query<{ status: string; step: string }>(
        `SELECT status,step FROM guto_v3.first_contact_state WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (!current.rows[0] || current.rows[0].status !== "IN_PROGRESS") {
        throw new V3Error("V3_FIRST_CONTACT_NOT_STARTED", "First Contact ainda não iniciado.", 409);
      }
      if (current.rows[0].step !== input.expectedStep) {
        throw new V3Error("V3_FIRST_CONTACT_STEP_CONFLICT", "A etapa do First Contact mudou. Recarregue o estado oficial.", 409);
      }
      const nextStep = input.expectedStep === "food_restrictions" ? "training_limitations" : "confirmation";
      await client.query(
        input.expectedStep === "food_restrictions"
          ? `UPDATE guto_v3.first_contact_state SET food_declaration=$1,step=$2,version=version+1 WHERE tenant_id=$3 AND user_id=$4`
          : `UPDATE guto_v3.first_contact_state SET limitation_declaration=$1,step=$2,version=version+1 WHERE tenant_id=$3 AND user_id=$4`,
        [input.answer.trim(), nextStep, input.actor.tenantId, input.actor.userId],
      );
      await this.appendMutationEvent(client, input.actor, input.requestId, "first_contact.responded", { expectedStep: input.expectedStep, nextStep });
    });
  }

  async updateFirstContactDeclarations(input: {
    actor: ActorContext;
    requestId: string;
    foodDeclaration?: string | null;
    limitationDeclaration?: string | null;
  }): Promise<void> {
    await this.withActorTransaction(input.actor, async (client) => {
      const prior = await client.query(`SELECT 1 FROM guto_v3.guto_events WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3 AND event_type='first_contact.corrected'`, [input.actor.tenantId, input.actor.userId, input.requestId]);
      if (prior.rows[0]) return;
      const current = await client.query<{ status: string; step: string }>(
        `SELECT status,step FROM guto_v3.first_contact_state WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (!current.rows[0] || current.rows[0].status !== "IN_PROGRESS") {
        throw new V3Error("V3_FIRST_CONTACT_NOT_STARTED", "First Contact ainda não iniciado.", 409);
      }
      const parts: string[] = [];
      const values: unknown[] = [];
      if (input.foodDeclaration !== undefined) {
        values.push(input.foodDeclaration);
        parts.push(`food_declaration = $${values.length}`);
      }
      if (input.limitationDeclaration !== undefined) {
        values.push(input.limitationDeclaration);
        parts.push(`limitation_declaration = $${values.length}`);
      }
      if (parts.length) {
        values.push(input.actor.tenantId, input.actor.userId);
        await client.query(`UPDATE guto_v3.first_contact_state SET ${parts.join(",")}, version=version+1 WHERE tenant_id=$${values.length - 1} AND user_id=$${values.length}`, values);
      }
      await this.appendMutationEvent(client, input.actor, input.requestId, "first_contact.corrected", {
        foodDeclaration: input.foodDeclaration ?? null,
        limitationDeclaration: input.limitationDeclaration ?? null,
      });
    });
  }

  async confirmFirstContact(input: {
    actor: ActorContext;
    requestId: string;
    contextId: string;
    contextVersion: number;
    expectedProfileVersion: number;
    expectedGoalVersion: number;
    confirmedSnapshot: Record<string, unknown>;
    workoutDraft: WorkoutPlanDraft;
    dietDraft: DietPlanDraft;
  }): Promise<ConfirmedUserContext> {
    return this.withActorTransaction(input.actor, async (client) => {
      await this.lockOfficialContextAuthority(client, input.actor);
      const prior = await client.query(`SELECT c.* FROM guto_v3.guto_events e JOIN guto_v3.confirmed_user_contexts c ON c.tenant_id=e.tenant_id AND c.user_id=e.user_id AND c.id=(e.payload->>'contextId')::uuid WHERE e.tenant_id=$1 AND e.user_id=$2 AND e.request_id=$3 AND e.event_type='first_contact.completed'`, [input.actor.tenantId, input.actor.userId, input.requestId]);
      if (prior.rows[0]) return this.mapConfirmedContext(prior.rows[0]);

      const contact = await client.query<{ status: string; step: string; food_declaration: string | null; limitation_declaration: string | null; started_at: Date | null; confirmed_context_id: string | null }>(
        `SELECT status,step,food_declaration,limitation_declaration,started_at,confirmed_context_id FROM guto_v3.first_contact_state WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (contact.rows[0]?.status === "COMPLETED" && contact.rows[0].confirmed_context_id) {
        const existing = await client.query(`SELECT * FROM guto_v3.confirmed_user_contexts WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [input.actor.tenantId, input.actor.userId, contact.rows[0].confirmed_context_id]);
        if (existing.rows[0]) return this.mapConfirmedContext(existing.rows[0]);
      }
      if (contact.rows[0]?.status !== "IN_PROGRESS" || contact.rows[0].step !== "confirmation" || !contact.rows[0].food_declaration || !contact.rows[0].limitation_declaration) {
        throw new V3Error("V3_FIRST_CONTACT_INCOMPLETE", "Responda às duas perguntas antes de confirmar.", 409);
      }
      const sources = await client.query<{ profile_version: string; goal_version: string; weekly_frequency: string | null }>(
        `SELECT p.version AS profile_version,g.version AS goal_version,p.weekly_frequency
           FROM guto_v3.user_profile p JOIN guto_v3.user_goals g ON g.tenant_id=p.tenant_id AND g.user_id=p.user_id
          WHERE p.tenant_id=$1 AND p.user_id=$2 FOR UPDATE OF p,g`,
        [input.actor.tenantId, input.actor.userId],
      );
      const source = sources.rows[0];
      if (!source || source.weekly_frequency == null) throw new V3Error("V3_CALIBRATION_REQUIRED", "Calibragem objetiva completa necessária.", 409);
      if (asNumber(source.profile_version) !== input.expectedProfileVersion || asNumber(source.goal_version) !== input.expectedGoalVersion) {
        throw new V3Error("V3_CONTEXT_SOURCE_CHANGED", "O perfil mudou antes da confirmação. Revise o resumo novamente.", 409);
      }
      const versionResult = await client.query<{ next_version: string }>(`SELECT COALESCE(max(version),0)+1 AS next_version FROM guto_v3.confirmed_user_contexts WHERE tenant_id=$1 AND user_id=$2`, [input.actor.tenantId, input.actor.userId]);
      const nextVersion = asNumber(versionResult.rows[0]?.next_version);
      if (nextVersion !== input.contextVersion) throw new V3Error("V3_CONTEXT_VERSION_CONFLICT", "A versão do contexto mudou.", 409);
      const contextResult = await client.query(
        `INSERT INTO guto_v3.confirmed_user_contexts
          (id,tenant_id,user_id,version,profile_version,goal_version,food_declaration,limitation_declaration,training_location,weekly_frequency,context_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'gym',$9,$10::jsonb) RETURNING *`,
        [input.contextId, input.actor.tenantId, input.actor.userId, nextVersion, input.expectedProfileVersion, input.expectedGoalVersion, contact.rows[0].food_declaration, contact.rows[0].limitation_declaration, source.weekly_frequency, JSON.stringify(input.confirmedSnapshot)],
      );
      const context = this.mapConfirmedContext(contextResult.rows[0]!);
      await this.persistFact(client, input.actor, { factType: "food_restriction", value: { declaration: context.foodDeclaration }, source: "user_declared", confirmationStatus: "FACT_CONFIRMED", supersedeCurrent: true });
      await this.persistFact(client, input.actor, { factType: "physical_constraint", value: { declaration: context.limitationDeclaration }, source: "user_declared", confirmationStatus: "FACT_CONFIRMED", supersedeCurrent: true });

      await client.query(`UPDATE guto_v3.workout_plans SET status='superseded' WHERE tenant_id=$1 AND user_id=$2 AND status='active'`, [input.actor.tenantId, input.actor.userId]);
      await client.query(`UPDATE guto_v3.diet_plans SET status='superseded' WHERE tenant_id=$1 AND user_id=$2 AND status='active'`, [input.actor.tenantId, input.actor.userId]);

      const workout = await client.query<{ id: string; version: string }>(
        `INSERT INTO guto_v3.workout_plans (tenant_id,user_id,title,status,generated_from,confirmed_context_id,confirmed_context_version)
         VALUES ($1,$2,$3,'active',$4::jsonb,$5,$6) RETURNING id,version`,
        [input.actor.tenantId, input.actor.userId, input.workoutDraft.title, JSON.stringify(input.workoutDraft.generatedFrom), context.id, context.version],
      );
      for (const item of input.workoutDraft.items) {
        await client.query(`INSERT INTO guto_v3.workout_plan_items (tenant_id,plan_id,exercise_id,name,purpose,muscle_group,position,sets,reps,canonical_name_pt,rest_text,cue,note,video_url,source_file_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [input.actor.tenantId, workout.rows[0]!.id, item.exerciseId, item.name, item.purpose, item.muscleGroup, item.position, item.sets || null, item.reps || null, item.canonicalNamePt || null, item.rest || null, item.cue || null, item.note || null, item.videoUrl || null, item.sourceFileName || null]);
      }
      const diet = await client.query<{ id: string; version: string }>(
        `INSERT INTO guto_v3.diet_plans (tenant_id,user_id,status,total_calories,protein_grams,carbs_grams,fat_grams,calculation_method,generated_from,confirmed_context_id,confirmed_context_version)
         VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id,version`,
        [input.actor.tenantId, input.actor.userId, input.dietDraft.totalCalories, input.dietDraft.proteinGrams, input.dietDraft.carbsGrams, input.dietDraft.fatGrams, input.dietDraft.calculationMethod, JSON.stringify(input.dietDraft.generatedFrom), context.id, context.version],
      );
      for (const meal of input.dietDraft.meals) {
        const insertedMeal = await client.query<{ id: string }>(`INSERT INTO guto_v3.diet_meals (tenant_id,plan_id,name,position,calories) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [input.actor.tenantId, diet.rows[0]!.id, meal.name, meal.position, meal.calories]);
        for (const item of meal.items) {
          await client.query(`INSERT INTO guto_v3.diet_items (tenant_id,meal_id,food_id,name,quantity_grams,calories,protein_grams,carbs_grams,fat_grams,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.actor.tenantId, insertedMeal.rows[0]!.id, item.foodId, item.name, item.quantityGrams, item.calories, item.proteinGrams, item.carbsGrams, item.fatGrams, item.position]);
        }
      }
      await client.query(
        `INSERT INTO guto_v3.active_plan_versions (tenant_id,user_id,workout_plan_id,workout_plan_version,diet_plan_id,diet_plan_version,confirmed_context_id,confirmed_context_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id) DO UPDATE SET workout_plan_id=EXCLUDED.workout_plan_id,workout_plan_version=EXCLUDED.workout_plan_version,diet_plan_id=EXCLUDED.diet_plan_id,diet_plan_version=EXCLUDED.diet_plan_version,confirmed_context_id=EXCLUDED.confirmed_context_id,confirmed_context_version=EXCLUDED.confirmed_context_version,version=guto_v3.active_plan_versions.version+1`,
        [input.actor.tenantId, input.actor.userId, workout.rows[0]!.id, workout.rows[0]!.version, diet.rows[0]!.id, diet.rows[0]!.version, context.id, context.version],
      );
      await client.query(`UPDATE guto_v3.first_contact_state SET status='COMPLETED',step='completed',completed_at=now(),confirmed_context_id=$1,confirmed_context_version=$2,version=version+1 WHERE tenant_id=$3 AND user_id=$4`, [context.id, context.version, input.actor.tenantId, input.actor.userId]);
      await this.appendMutationEvent(client, input.actor, input.requestId, "first_contact.completed", { contextId: context.id, contextVersion: context.version, workoutPlanId: workout.rows[0]!.id, dietPlanId: diet.rows[0]!.id });
      return context;
    });
  }

  async reconfirmContext(input: {
    actor: ActorContext;
    requestId: string;
    contextId: string;
    contextVersion: number;
    expectedProfileVersion: number;
    expectedGoalVersion: number;
    workoutDraft: WorkoutPlanDraft;
    dietDraft: DietPlanDraft;
  }): Promise<ConfirmedUserContext> {
    return this.withActorTransaction(input.actor, async (client) => {
      await this.lockOfficialContextAuthority(client, input.actor);
      const prior = await client.query(`SELECT c.* FROM guto_v3.guto_events e JOIN guto_v3.confirmed_user_contexts c ON c.tenant_id=e.tenant_id AND c.user_id=e.user_id AND c.id=(e.payload->>'contextId')::uuid WHERE e.tenant_id=$1 AND e.user_id=$2 AND e.request_id=$3 AND e.event_type='context.reconfirmed'`, [input.actor.tenantId, input.actor.userId, input.requestId]);
      if (prior.rows[0]) return this.mapConfirmedContext(prior.rows[0]);

      const contact = await client.query<{ status: string }>(
        `SELECT status FROM guto_v3.first_contact_state WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (!contact.rows[0] || contact.rows[0].status !== "COMPLETED") {
        throw new V3Error("V3_FIRST_CONTACT_NOT_COMPLETED", "Conclua e confirme o First Contact antes de re-confirmar o contexto.", 409);
      }
      const previous = await client.query(`SELECT * FROM guto_v3.confirmed_user_contexts WHERE tenant_id=$1 AND user_id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE`, [input.actor.tenantId, input.actor.userId]);
      const previousRow = previous.rows[0];
      if (!previousRow) {
        throw new V3Error("V3_CONFIRMED_CONTEXT_REQUIRED", "Nenhum contexto confirmado para re-confirmar.", 409);
      }
      const previousContext = this.mapConfirmedContext(previousRow);
      const sources = await client.query<QueryResultRow>(
        `SELECT p.version AS profile_version,p.weekly_frequency,g.version AS goal_version,
                jsonb_build_object('version',p.version,'language',p.language,'biologicalSex',p.biological_sex,'age',p.age,'weightKg',p.weight_kg,'heightCm',p.height_cm,'trainingStatus',p.training_status,'weeklyFrequencyDaysPerWeek',p.weekly_frequency,'trainingLocation','gym') AS profile_snapshot,
                jsonb_build_object('version',g.version,'code',g.goal_code) AS goal_snapshot
           FROM guto_v3.user_profile p JOIN guto_v3.user_goals g ON g.tenant_id=p.tenant_id AND g.user_id=p.user_id
          WHERE p.tenant_id=$1 AND p.user_id=$2 FOR UPDATE OF p,g`,
        [input.actor.tenantId, input.actor.userId],
      );
      const source = sources.rows[0];
      if (!source || source.weekly_frequency == null) throw new V3Error("V3_CALIBRATION_REQUIRED", "Calibragem objetiva completa necessária.", 409);
      const currentProfileVersion = asNumber(source.profile_version);
      const currentGoalVersion = asNumber(source.goal_version);
      if (currentProfileVersion === previousContext.profileVersion && currentGoalVersion === previousContext.goalVersion) {
        throw new V3Error("V3_CONTEXT_ALREADY_CURRENT", "O contexto já está na versão oficial atual. Nada a re-confirmar.", 409);
      }
      if (currentProfileVersion !== input.expectedProfileVersion || currentGoalVersion !== input.expectedGoalVersion) {
        throw new V3Error("V3_CONTEXT_SOURCE_CHANGED", "O perfil mudou antes da re-confirmação. Revise o resumo novamente.", 409);
      }
      const versionResult = await client.query<{ next_version: string }>(`SELECT COALESCE(max(version),0)+1 AS next_version FROM guto_v3.confirmed_user_contexts WHERE tenant_id=$1 AND user_id=$2`, [input.actor.tenantId, input.actor.userId]);
      const nextVersion = asNumber(versionResult.rows[0]?.next_version);
      if (nextVersion !== input.contextVersion) throw new V3Error("V3_CONTEXT_VERSION_CONFLICT", "A versão do contexto mudou.", 409);
      const contextFacts = await client.query<{ user_fact_id: string }>(
        `SELECT user_fact_id FROM guto_v3.user_facts WHERE tenant_id=$1 AND user_id=$2 AND superseded_at IS NULL ORDER BY recorded_at,user_fact_id`,
        [input.actor.tenantId, input.actor.userId],
      );
      const contextSnapshot = {
        profile: source.profile_snapshot,
        goal: source.goal_snapshot,
        foodDeclaration: previousContext.foodDeclaration,
        limitationDeclaration: previousContext.limitationDeclaration,
        trainingLocation: "gym" as const,
        weeklyFrequencyDaysPerWeek: asNumber(source.weekly_frequency),
        factIds: contextFacts.rows.map((row) => row.user_fact_id),
        previousContextId: previousContext.id,
        previousContextVersion: previousContext.version,
        reconfirmationRequestId: input.requestId,
      };
      const contextResult = await client.query(
        `INSERT INTO guto_v3.confirmed_user_contexts
          (id,tenant_id,user_id,version,profile_version,goal_version,food_declaration,limitation_declaration,training_location,weekly_frequency,context_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'gym',$9,$10::jsonb) RETURNING *`,
        [input.contextId, input.actor.tenantId, input.actor.userId, nextVersion, currentProfileVersion, currentGoalVersion, previousContext.foodDeclaration, previousContext.limitationDeclaration, source.weekly_frequency, JSON.stringify(contextSnapshot)],
      );
      const context = this.mapConfirmedContext(contextResult.rows[0]!);
      // Declarações são carregadas do contexto anterior — nenhum fato novo é
      // registrado: re-confirmar o perfil NÃO inventa restrição nova.
      await client.query(`UPDATE guto_v3.workout_plans SET status='superseded' WHERE tenant_id=$1 AND user_id=$2 AND status='active'`, [input.actor.tenantId, input.actor.userId]);
      await client.query(`UPDATE guto_v3.diet_plans SET status='superseded' WHERE tenant_id=$1 AND user_id=$2 AND status='active'`, [input.actor.tenantId, input.actor.userId]);

      const workout = await client.query<{ id: string; version: string }>(
        `INSERT INTO guto_v3.workout_plans (tenant_id,user_id,title,status,generated_from,confirmed_context_id,confirmed_context_version)
         VALUES ($1,$2,$3,'active',$4::jsonb,$5,$6) RETURNING id,version`,
        [input.actor.tenantId, input.actor.userId, input.workoutDraft.title, JSON.stringify(input.workoutDraft.generatedFrom), context.id, context.version],
      );
      for (const item of input.workoutDraft.items) {
        await client.query(`INSERT INTO guto_v3.workout_plan_items (tenant_id,plan_id,exercise_id,name,purpose,muscle_group,position,sets,reps,canonical_name_pt,rest_text,cue,note,video_url,source_file_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [input.actor.tenantId, workout.rows[0]!.id, item.exerciseId, item.name, item.purpose, item.muscleGroup, item.position, item.sets || null, item.reps || null, item.canonicalNamePt || null, item.rest || null, item.cue || null, item.note || null, item.videoUrl || null, item.sourceFileName || null]);
      }
      const diet = await client.query<{ id: string; version: string }>(
        `INSERT INTO guto_v3.diet_plans (tenant_id,user_id,status,total_calories,protein_grams,carbs_grams,fat_grams,calculation_method,generated_from,confirmed_context_id,confirmed_context_version)
         VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id,version`,
        [input.actor.tenantId, input.actor.userId, input.dietDraft.totalCalories, input.dietDraft.proteinGrams, input.dietDraft.carbsGrams, input.dietDraft.fatGrams, input.dietDraft.calculationMethod, JSON.stringify(input.dietDraft.generatedFrom), context.id, context.version],
      );
      for (const meal of input.dietDraft.meals) {
        const insertedMeal = await client.query<{ id: string }>(`INSERT INTO guto_v3.diet_meals (tenant_id,plan_id,name,position,calories) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [input.actor.tenantId, diet.rows[0]!.id, meal.name, meal.position, meal.calories]);
        for (const item of meal.items) {
          await client.query(`INSERT INTO guto_v3.diet_items (tenant_id,meal_id,food_id,name,quantity_grams,calories,protein_grams,carbs_grams,fat_grams,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.actor.tenantId, insertedMeal.rows[0]!.id, item.foodId, item.name, item.quantityGrams, item.calories, item.proteinGrams, item.carbsGrams, item.fatGrams, item.position]);
        }
      }
      await client.query(
        `INSERT INTO guto_v3.active_plan_versions (tenant_id,user_id,workout_plan_id,workout_plan_version,diet_plan_id,diet_plan_version,confirmed_context_id,confirmed_context_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id) DO UPDATE SET workout_plan_id=EXCLUDED.workout_plan_id,workout_plan_version=EXCLUDED.workout_plan_version,diet_plan_id=EXCLUDED.diet_plan_id,diet_plan_version=EXCLUDED.diet_plan_version,confirmed_context_id=EXCLUDED.confirmed_context_id,confirmed_context_version=EXCLUDED.confirmed_context_version,version=guto_v3.active_plan_versions.version+1`,
        [input.actor.tenantId, input.actor.userId, workout.rows[0]!.id, workout.rows[0]!.version, diet.rows[0]!.id, diet.rows[0]!.version, context.id, context.version],
      );
      await client.query(`UPDATE guto_v3.first_contact_state SET confirmed_context_id=$1,confirmed_context_version=$2,version=version+1 WHERE tenant_id=$3 AND user_id=$4 AND status='COMPLETED'`, [context.id, context.version, input.actor.tenantId, input.actor.userId]);
      await this.appendMutationEvent(client, input.actor, input.requestId, "context.reconfirmed", { contextId: context.id, contextVersion: context.version, previousContextId: previousContext.id, previousContextVersion: previousContext.version, workoutPlanId: workout.rows[0]!.id, dietPlanId: diet.rows[0]!.id });
      return context;
    });
  }

  async completePact(input: {
    actor: ActorContext;
    requestId: string;
    displayName: string;
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
        workoutReady: false,
        dietReady: false,
        firstContactRequired: true,
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
      // Relationship lifecycle gate: a TERMINAL relationship must never keep
      // accumulating miss penalties (no infinite charges). The daily miss
      // penalty is the deterministic "charge"; TERMINAL suppresses it.
      if (input.reasonCode === "apply_daily_miss_penalty") {
        const lifecycle = await client.query<QueryResultRow>(
          `SELECT state FROM guto_v3.relationship_lifecycle WHERE tenant_id=$1 AND user_id=$2`,
          [input.actor.tenantId, input.actor.userId],
        );
        if (lifecycle.rows[0] && shouldSuppressProactivity(assertRelationshipLifecycleState(String(lifecycle.rows[0].state)))) {
          throw new V3Error("V3_RELATIONSHIP_TERMINAL", "A relação está encerrada; penalidades de ausência não são mais aplicadas.", 409);
        }
      }
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
      // P0 (session completion authority): XP events (complete_daily_mission,
      // accept_adapted_mission) NO LONGER create workout_sessions rows. XP is
      // now cleanly separated from session-completion authority — only
      // completeWorkoutSession() can flip a session to 'completed'. This was
      // a second authority that inflated countCompletedWorkoutSessions and
      // diverged Postgres from in-memory.
      await client.query(`UPDATE guto_v3.users SET version=version+1 WHERE tenant_id=$1 AND id=$2`, [input.actor.tenantId, input.actor.userId]);
      await this.appendMutationEvent(client, input.actor, input.requestId, "xp.recorded", {
        reasonCode: input.reasonCode,
        sourceKey: input.sourceKey,
        amount,
      });
    });
  }

  async replaceWorkoutPlan(input: { actor: ActorContext; requestId: string; context: ConfirmedUserContext; draft: WorkoutPlanDraft }): Promise<WorkoutPlan> {
    return this.withActorTransaction(input.actor, async (client) => {
      await this.assertContextCurrent(client, input.actor, input.context);
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
        `INSERT INTO guto_v3.workout_plans (tenant_id,user_id,title,status,generated_from,confirmed_context_id,confirmed_context_version)
         VALUES ($1,$2,$3,'active',$4::jsonb,$5,$6) RETURNING *`,
        [input.actor.tenantId, input.actor.userId, input.draft.title, JSON.stringify(input.draft.generatedFrom), input.context.id, input.context.version],
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
        `INSERT INTO guto_v3.active_plan_versions (tenant_id,user_id,workout_plan_id,workout_plan_version,confirmed_context_id,confirmed_context_version)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO UPDATE SET workout_plan_id=EXCLUDED.workout_plan_id,
           workout_plan_version=EXCLUDED.workout_plan_version,confirmed_context_id=EXCLUDED.confirmed_context_id,confirmed_context_version=EXCLUDED.confirmed_context_version,version=guto_v3.active_plan_versions.version+1`,
        [input.actor.tenantId, input.actor.userId, planRow.id, planRow.version, input.context.id, input.context.version],
      );
      await this.appendMutationEvent(client, input.actor, input.requestId, "workout.generated", { planId: planRow.id, planVersion: asNumber(planRow.version) });
      return this.loadWorkout(client, planRow);
    });
  }

  async replaceDietPlan(input: { actor: ActorContext; requestId: string; context: ConfirmedUserContext; draft: DietPlanDraft }): Promise<DietPlan> {
    return this.withActorTransaction(input.actor, async (client) => {
      const authority = await this.assertContextCurrent(client, input.actor, input.context);
      if (
        String(input.draft.generatedFrom.confirmedContextId || "") !== input.context.id ||
        Number(input.draft.generatedFrom.confirmedContextVersion) !== input.context.version ||
        String(input.draft.generatedFrom.language || "") !== authority.language
      ) {
        throw new V3Error("V3_STALE_GENERATION_CONTEXT", "A autoridade da geração da dieta não corresponde ao contexto oficial.", 409);
      }
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
           (tenant_id,user_id,status,total_calories,protein_grams,carbs_grams,fat_grams,calculation_method,generated_from,confirmed_context_id,confirmed_context_version)
         VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
        [input.actor.tenantId, input.actor.userId, input.draft.totalCalories, input.draft.proteinGrams, input.draft.carbsGrams, input.draft.fatGrams, input.draft.calculationMethod, JSON.stringify(input.draft.generatedFrom), input.context.id, input.context.version],
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
        `INSERT INTO guto_v3.active_plan_versions (tenant_id,user_id,diet_plan_id,diet_plan_version,confirmed_context_id,confirmed_context_version)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO UPDATE SET diet_plan_id=EXCLUDED.diet_plan_id,
           diet_plan_version=EXCLUDED.diet_plan_version,confirmed_context_id=EXCLUDED.confirmed_context_id,confirmed_context_version=EXCLUDED.confirmed_context_version,version=guto_v3.active_plan_versions.version+1`,
        [input.actor.tenantId, input.actor.userId, planRow.id, planRow.version, input.context.id, input.context.version],
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
    mutation: import("./repository.js").FullDietPlanMutation;
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
      if (input.mutation.planId !== input.plan.id || input.mutation.expectedPlanVersion !== input.plan.version) throw new V3Error("V3_STALE_DIET_VERSION", "A dieta mudou; recarregue o estado oficial.", 409);
      const currentItems = await client.query<{ id: string; meal_id: string }>(`SELECT i.id, i.meal_id FROM guto_v3.diet_items i JOIN guto_v3.diet_meals m ON m.id = i.meal_id WHERE i.tenant_id=$1 AND m.plan_id=$2 FOR UPDATE OF i`, [input.actor.tenantId, input.plan.id]);
      const currentIds = new Set(currentItems.rows.map((row) => row.id));
      const mutationIds = new Set(input.mutation.items.map((item) => item.id));
      const mealId = currentItems.rows[0]?.meal_id;
      if (!mealId) throw new V3Error("V3_DIET_ITEM_NOT_FOUND", "Alimento oficial não encontrado.", 409);
      // Move every retained item to a guaranteed collision-free temporary range
      // (above any realistic plan position) BEFORE writing final positions, so
      // the (meal_id, position) unique key can never be violated mid-transaction
      // when a later row still occupies a destination position.
      const positionOffset = 1000000;
      let positionCursor = 0;
      for (const row of currentItems.rows) {
        if (!mutationIds.has(row.id)) continue;
        await client.query(`UPDATE guto_v3.diet_items SET position=$1 WHERE tenant_id=$2 AND id=$3`, [positionCursor + positionOffset, input.actor.tenantId, row.id]);
        positionCursor += 1;
      }
      for (const id of currentIds) if (!mutationIds.has(id)) await client.query(`DELETE FROM guto_v3.diet_items WHERE tenant_id=$1 AND id=$2`, [input.actor.tenantId, id]);
      for (const item of input.mutation.items) {
        if (!Number.isFinite(item.quantityGrams) || item.quantityGrams <= 0 || [item.calories, item.proteinGrams, item.carbsGrams, item.fatGrams].some((value) => !Number.isFinite(value))) throw new V3Error("NUTRITION_VALIDATION_FAILED", "Mutação de dieta inválida.", 409);
        if (currentIds.has(item.id)) await client.query(`UPDATE guto_v3.diet_items SET food_id=$1,name=$2,quantity_grams=$3,calories=$4,protein_grams=$5,carbs_grams=$6,fat_grams=$7,position=$8,version=version+1 WHERE tenant_id=$9 AND id=$10`, [item.foodId,item.name,item.quantityGrams,item.calories,item.proteinGrams,item.carbsGrams,item.fatGrams,item.position,input.actor.tenantId,item.id]);
        else await client.query(`INSERT INTO guto_v3.diet_items (id,tenant_id,meal_id,food_id,name,quantity_grams,calories,protein_grams,carbs_grams,fat_grams,position,version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)`, [item.id,input.actor.tenantId,item.mealId || mealId,item.foodId,item.name,item.quantityGrams,item.calories,item.proteinGrams,item.carbsGrams,item.fatGrams,item.position]);
      }
      await client.query(`UPDATE guto_v3.diet_meals SET calories=$1, version=version+1 WHERE id=$2 AND tenant_id=$3`, [input.mutation.totals.calories, mealId, input.actor.tenantId]);
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
        [input.mutation.totals.calories, input.mutation.totals.proteinGrams, input.mutation.totals.carbsGrams, input.mutation.totals.fatGrams, input.actor.tenantId, input.plan.id],
      );
      const planVersion = asNumber(versionResult.rows[0]?.version);
      await client.query(
        `UPDATE guto_v3.active_plan_versions SET diet_plan_version=$1, version=version+1
          WHERE tenant_id=$2 AND user_id=$3`,
        [planVersion, input.actor.tenantId, input.actor.userId],
      );
      await this.appendMutationEvent(client, input.actor, input.requestId, "diet.food_swapped", {
        planId: input.plan.id,
        itemId: input.mutation.items.find((item) => item.foodId === input.mutation.replacement.candidateId)?.id,
        candidateId: input.mutation.replacement.candidateId,
        planVersion,
      });
      return { planVersion };
    });
  }

  async recordWorkoutExerciseEvent(input: { actor: ActorContext; requestId: string; event: import("./types.js").WorkoutExerciseSessionEvent }): Promise<import("./types.js").WorkoutEvolutionDecision> {
    return this.withActorTransaction(input.actor, async (client) => {
      // P0 (concurrent idempotency): serialize concurrent requests with the
      // SAME requestId across serverless instances BEFORE the dedup read.
      // Without this, two transactions can both SELECT-nothing, both insert a
      // session, and duplicate history into a false progression signal. The
      // transaction-scoped advisory lock releases automatically at COMMIT/
      // ROLLBACK and works across instances (it is a database barrier, not an
      // in-process mutex).
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended($1 || ':' || $2 || ':' || $3, 0))`,
        [input.actor.tenantId, input.actor.userId, input.requestId],
      );
      // requestId is the public event identity for this endpoint. Deduplicate
      // before creating a workout session so network retries cannot become a
      // second historical execution or a false progression signal.
      const prior = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM guto_v3.guto_events
          WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3 AND event_type='workout.evolution_decided'
          LIMIT 1`,
        [input.actor.tenantId, input.actor.userId, input.requestId],
      );
      const priorPayload = prior.rows[0]?.payload;
      if (priorPayload && typeof priorPayload === "object") {
        const cached = priorPayload as Partial<import("./types.js").WorkoutEvolutionDecision>;
        if (typeof cached.exerciseId === "string" && typeof cached.decision === "string" && typeof cached.reasonCode === "string") {
          return {
            exerciseId: cached.exerciseId,
            decision: cached.decision as import("./types.js").WorkoutEvolutionDecisionCode,
            reasonCode: cached.reasonCode,
            nextPrescription: cached.nextPrescription as import("./types.js").WorkoutNextPrescription | undefined,
          };
        }
      }
      // P0 (adapted execution): SELECT * — loadWorkout needs version, title,
      // status and confirmed_context_version, not just the id (a bare
      // `SELECT id` made every adapted-event validation crash with
      // V3_INVALID_DATABASE_NUMBER before the policy could even run).
      const plan = await client.query<QueryResultRow>(
        `SELECT * FROM guto_v3.workout_plans WHERE tenant_id=$1 AND user_id=$2 AND status='active' FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (!plan.rows[0]) throw new V3Error("V3_WORKOUT_NOT_FOUND", "Treino oficial ativo não encontrado.", 409);
      if (input.event.substitutedFromExerciseId) {
        // P0 (adapted execution): SessionWorkout derives temporary adapted
        // exercises WITHOUT mutating the base plan, so the adapted exerciseId
        // is intentionally absent from workout_plan_items. Validate the
        // adaptation deterministically (base membership of the source,
        // catalog + video + safety + location of the adapted exercise)
        // instead of rejecting every adapted execution. The base plan is
        // never mutated by this path.
        // P0 (session location authority): the session's effectiveLocation
        // takes precedence over the profile default — resolve it from the
        // event context (canonical values only) via the policy helper.
        // P0 (pool max=1 safety): the snapshot is loaded from the CURRENT
        // transaction client (loadOfficialSnapshotWithinTransaction), never
        // from a second pool connection, so holding this transaction cannot
        // deadlock waiting for another connection of the same pool.
        const basePlan = await this.loadWorkout(client, plan.rows[0]);
        const snapshot = await this.loadOfficialSnapshotWithinTransaction(client, input.actor);
        const profileLocation = snapshot.confirmedContext?.trainingLocation || snapshot.profile.trainingLocation;
        const effectiveLocation = resolveSessionEffectiveLocation(input.event, undefined, profileLocation);
        assertValidAdaptedExecution({ event: input.event, basePlan, snapshot, effectiveLocation });
      } else {
        const exercise = await client.query(
          `SELECT 1 FROM guto_v3.workout_plan_items WHERE tenant_id=$1 AND plan_id=$2 AND exercise_id=$3`,
          [input.actor.tenantId, plan.rows[0].id, input.event.exerciseId],
        );
        if (!exercise.rows[0]) throw new V3Error("V3_WORKOUT_EXERCISE_NOT_ACTIVE", "Exercício não pertence ao treino oficial ativo.", 409);
      }
      // P0#4: decide from the current event plus the recent history of the SAME
      // exercise, so PROGRESS requires 2+ consecutive easy completed sessions.
      const recent = await client.query<{
        load_value: string | null;
        repetitions: string | null;
        sets_completed: string | null;
        completed: boolean;
        perceived_difficulty: string | null;
        substituted_from_exercise_id: string | null;
        substitution_reason: string | null;
      }>(
        `SELECT load_value,repetitions,sets_completed,completed,perceived_difficulty,substituted_from_exercise_id,substitution_reason
           FROM guto_v3.workout_session_exercises
          WHERE tenant_id=$1 AND user_id=$2 AND exercise_id=$3
          ORDER BY created_at DESC, id DESC LIMIT 4`,
        [input.actor.tenantId, input.actor.userId, input.event.exerciseId],
      );
      const history = recent.rows.reverse().map((row) => ({
        exerciseId: input.event.exerciseId,
        loadValue: row.load_value == null ? undefined : Number(row.load_value),
        repetitions: row.repetitions == null ? undefined : Number(row.repetitions),
        setsCompleted: row.sets_completed == null ? undefined : Number(row.sets_completed),
        completed: row.completed,
        perceivedDifficulty: row.perceived_difficulty == null ? undefined : Number(row.perceived_difficulty),
        substitutedFromExerciseId: row.substituted_from_exercise_id || undefined,
        substitutionReason: row.substitution_reason || undefined,
      }));
      // P0 (session completion): one workout_sessions row per LOGICAL session,
      // not per exercise. MODELO B: the client/runtime-generated workoutSessionId
      // is used LITERALLY as the PK (id) of the workout_sessions row. This lets
      // all exercise events of the same session group under one row, and lets
      // completeWorkoutSession find the row by the same id. The INSERT uses
      // ON CONFLICT (id) DO NOTHING so concurrent exercise events with the same
      // workoutSessionId never create duplicate rows.
      //
      // P0 (cross-tenant ownership): the ON CONFLICT (id) DO NOTHING can be a
      // LITERAL no-op when the session id already belongs to ANOTHER actor.
      // workout_session_exercises is only guaranteed isolated by its OWN
      // tenant_id/user_id + session_id FK to workout_sessions(id) — it does NOT
      // couple exercise rows to the session's tenant/user. So AFTER the
      // upsert we must assert that session X -- whether it was just created by
      // THIS actor or already existed -- is actually owned by THIS actor. The
      // rule: session X exists for THIS actor OR was created atomically for
      // THIS actor; a globally-existing session id must never be reusable by a
      // foreign actor.
      let sessionId: string;
      if (input.event.workoutSessionId) {
        // ON CONFLICT: if a concurrent event already created the row, reuse it.
        await client.query(
          `INSERT INTO guto_v3.workout_sessions (id,tenant_id,user_id,plan_id,status,started_at,completed_at)
           VALUES ($1::uuid,$2,$3,$4,'started',now(),null)
           ON CONFLICT (id) DO NOTHING`,
          [input.event.workoutSessionId, input.actor.tenantId, input.actor.userId, plan.rows[0].id],
        );
        sessionId = input.event.workoutSessionId;
        // P0 (cross-tenant ownership): the upsert above may have been a no-op
        // because the id already existed. Verify it belongs to THIS actor
        // before recording any exercise against it. If it belongs to a foreign
        // tenant/user (possibly on a different tenant entirely), this request
        // must be rejected WITHOUT leaving any side effect on the foreign
        // session.
        const owner = await client.query<{ tenant_id: string; user_id: string }>(
          `SELECT tenant_id, user_id FROM guto_v3.workout_sessions
            WHERE id=$1::uuid LIMIT 1`,
          [input.event.workoutSessionId],
        );
        if (!owner.rows[0]) {
          throw new V3Error("V3_WORKOUT_SESSION_NOT_FOUND", "Sessão de treino não encontrada dentro desta transação.", 404);
        }
        if (String(owner.rows[0]!.tenant_id) !== input.actor.tenantId || String(owner.rows[0]!.user_id) !== input.actor.userId) {
          throw new V3Error("V3_FOREIGN_WORKOUT_SESSION", "Não é possível usar uma sessão de treino de outro usuário.", 409);
        }
      } else {
        // Legacy fallback (no workoutSessionId): server-generated id.
        const created = await client.query<{ id: string }>(
          `INSERT INTO guto_v3.workout_sessions (tenant_id,user_id,plan_id,status,started_at,completed_at)
           VALUES ($1,$2,$3,'started',now(),null) RETURNING id::text AS id`,
          [input.actor.tenantId, input.actor.userId, plan.rows[0].id],
        );
        sessionId = created.rows[0]!.id;
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO guto_v3.workout_session_exercises
          (tenant_id,user_id,session_id,exercise_id,load_value,repetitions,sets_completed,completed,perceived_difficulty,substituted_from_exercise_id,substitution_reason,context_snapshot)
         VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`,
        [input.actor.tenantId, input.actor.userId, sessionId, input.event.exerciseId,
          input.event.loadValue ?? null, input.event.repetitions ?? null, input.event.setsCompleted ?? null, input.event.completed,
          input.event.perceivedDifficulty ?? null, input.event.substitutedFromExerciseId ?? null, input.event.substitutionReason ?? null,
          JSON.stringify(input.event.context || {})],
      );
      const decision = decideWorkoutEvolution(input.event, history);
      await client.query(
        `INSERT INTO guto_v3.workout_evolution_decisions
          (tenant_id,user_id,exercise_id,decision,reason_code,source_session_exercise_id,context_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [input.actor.tenantId, input.actor.userId, decision.exerciseId, decision.decision, decision.reasonCode, inserted.rows[0]!.id,
          JSON.stringify({ ...(input.event.context || {}), nextPrescription: decision.nextPrescription || null })],
      );
      await this.appendMutationEvent(client, input.actor, input.requestId, "workout.evolution_decided", { ...decision });
      return decision;
    });
  }

  /**
   * P0 (session completion): the SOLE authority that flips a logical workout
   * session from 'started' to 'completed'. Exercise events only add history
   * under a session; this call is what the rotation counter observes, so the
   * index advances exactly once per real session, regardless of how many
   * exercises it contained. Idempotent on requestId (a replay is a no-op).
   */
  async completeWorkoutSession(input: { actor: ActorContext; requestId: string; workoutSessionId: string }): Promise<void> {
    await this.withActorTransaction(input.actor, async (client) => {
      // P0 (session completion): lock on the SESSION identity (not just
      // requestId) so two different requestIds trying to complete the SAME
      // session serialize. The conditional UPDATE (status IN
      // 'started','planned') is the durable second barrier: only the first
      // transaction to reach it flips started→completed; the second finds
      // status='completed' and returns idempotently.
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended($1 || ':' || $2 || ':' || $3, 0))`,
        [input.actor.tenantId, input.actor.userId, input.workoutSessionId],
      );
      const result = await client.query<{ id: string; status: string }>(
        `UPDATE guto_v3.workout_sessions
            SET status='completed', completed_at=now(), updated_at=now()
          WHERE tenant_id=$1 AND user_id=$2 AND id=$3::uuid AND status IN ('started','planned')
          RETURNING id, status`,
        [input.actor.tenantId, input.actor.userId, input.workoutSessionId],
      );
      if (!result.rows[0]) {
        const existing = await client.query<{ status: string }>(
          `SELECT status FROM guto_v3.workout_sessions
            WHERE tenant_id=$1 AND user_id=$2 AND id=$3::uuid LIMIT 1`,
          [input.actor.tenantId, input.actor.userId, input.workoutSessionId],
        );
        if (!existing.rows[0]) throw new V3Error("V3_WORKOUT_SESSION_NOT_FOUND", "Sessão de treino não encontrada.", 404);
        return; // already completed — idempotent (different requestId is fine)
      }
      await this.appendMutationEvent(client, input.actor, input.requestId, "workout.session_completed", { workoutSessionId: input.workoutSessionId });
    });
  }

  /**
   * P0 (session rotation): durable session counter. The next session index is
   * derived from the number of COMPLETED sessions already recorded in
   * workout_sessions — the official "this session really happened" event —
   * so it survives reload, logout/login, fresh serverless instances and empty
   * Redis. Idempotent replays never advance it (a duplicate requestId reuses
   * the cached decision instead of inserting a second session row).
   */
  async countCompletedWorkoutSessions(actor: ActorContext): Promise<number> {
    return this.withActorTransaction(actor, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM guto_v3.workout_sessions
          WHERE tenant_id=$1 AND user_id=$2 AND status='completed'`,
        [actor.tenantId, actor.userId],
      );
      return asNumber(result.rows[0]?.count) || 0;
    });
  }

  async recordTurn(input: { actor: ActorContext; requestId: string; action: string; resultCode: string }): Promise<void> {
    await this.withActorTransaction(input.actor, async (client) => {
      const presenceDay = this.todayKey();
      const inserted = await client.query<{ event_id: string }>(
        `INSERT INTO guto_v3.guto_events (tenant_id,user_id,request_id,event_type,payload)
         VALUES ($1,$2,$3,'turn.completed',$4::jsonb)
         ON CONFLICT (tenant_id,user_id,request_id,event_type) DO NOTHING
         RETURNING event_id`,
        [input.actor.tenantId, input.actor.userId, input.requestId, JSON.stringify({ action: input.action, resultCode: input.resultCode, presenceDay })],
      );
      if (!inserted.rows[0]) return;
      const lifecycle = await client.query<QueryResultRow>(
        `SELECT state,entered_state_at,last_evaluated_at,last_presence_day,consecutive_absence_days,version
           FROM guto_v3.relationship_lifecycle
          WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (!lifecycle.rows[0]) return;
      const current = assertRelationshipLifecycleState(String(lifecycle.rows[0].state));
      const transition = evaluateOfficialRelationshipReturn(current);
      await client.query(
        `UPDATE guto_v3.relationship_lifecycle
            SET state=$3,
                entered_state_at=CASE WHEN state<>$3 THEN now() ELSE entered_state_at END,
                last_evaluated_at=now(),last_presence_day=$4::date,consecutive_absence_days=0,
                version=version+CASE WHEN state<>$3 THEN 1 ELSE 0 END
          WHERE tenant_id=$1 AND user_id=$2`,
        [input.actor.tenantId, input.actor.userId, transition.state, presenceDay],
      );
      if (transition.transitioned) {
        await client.query(
          `INSERT INTO guto_v3.relationship_lifecycle_events
             (tenant_id,user_id,request_id,from_state,to_state,reason)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id,user_id,request_id,from_state,to_state) DO NOTHING`,
          [input.actor.tenantId, input.actor.userId, input.requestId, current, transition.state, transition.reason],
        );
      }
    });
  }

  private async deriveLastPresenceDay(client: PoolClient, actor: ActorContext): Promise<string | null> {
    const result = await client.query<{ day: string | null }>(
      `SELECT MAX(day)::text AS day FROM (
         SELECT source_key::date AS day FROM guto_v3.xp_ledger
          WHERE tenant_id=$1 AND user_id=$2
            AND reason_code IN ('complete_daily_mission','accept_adapted_mission')
            AND source_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         UNION ALL
         SELECT last_interaction_at::date AS day FROM guto_v3.conversation_threads
          WHERE tenant_id=$1 AND user_id=$2 AND last_interaction_at IS NOT NULL
         UNION ALL
         SELECT (payload->>'presenceDay')::date AS day FROM guto_v3.guto_events
          WHERE tenant_id=$1 AND user_id=$2 AND event_type='turn.completed'
            AND payload->>'presenceDay' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       ) official_presence`,
      [actor.tenantId, actor.userId],
    );
    return result.rows[0]?.day || null;
  }

  private mapLifecycleRow(row: QueryResultRow, actor: ActorContext): RelationshipLifecycleRecord {
    return {
      tenantId: actor.tenantId,
      userId: actor.userId,
      state: assertRelationshipLifecycleState(String(row.state)),
      enteredStateAt: row.entered_state_at ? new Date(row.entered_state_at).toISOString() : null,
      lastEvaluatedAt: new Date(row.last_evaluated_at).toISOString(),
      lastPresenceDay: row.last_presence_day ? String(row.last_presence_day) : null,
      consecutiveAbsenceDays: asNumber(row.consecutive_absence_days),
      version: asNumber(row.version),
    };
  }

  async getRelationshipLifecycle(actor: ActorContext): Promise<RelationshipLifecycleRecord | null> {
    return this.withActorTransaction(actor, async (client) => {
      const result = await client.query<QueryResultRow>(
        `SELECT state, entered_state_at, last_evaluated_at, last_presence_day, consecutive_absence_days, version
           FROM guto_v3.relationship_lifecycle
          WHERE tenant_id=$1 AND user_id=$2`,
        [actor.tenantId, actor.userId],
      );
      return result.rows[0] ? this.mapLifecycleRow(result.rows[0], actor) : null;
    });
  }

  async evaluateRelationshipLifecycle(input: {
    actor: ActorContext;
    requestId: string;
  }): Promise<RelationshipLifecycleRecord> {
    return this.withActorTransaction(input.actor, async (client) => {
      // Serialize concurrent evaluations of the same actor on the lifecycle row.
      let existing = await client.query<QueryResultRow>(
        `SELECT state, entered_state_at, last_evaluated_at, last_presence_day, consecutive_absence_days, version
           FROM guto_v3.relationship_lifecycle
          WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.actor.tenantId, input.actor.userId],
      );
      if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO guto_v3.relationship_lifecycle (tenant_id,user_id,state,last_evaluated_at,last_presence_day,consecutive_absence_days)
           VALUES ($1,$2,'ACTIVE',now(),NULL,0)
           ON CONFLICT (tenant_id,user_id) DO NOTHING`,
          [input.actor.tenantId, input.actor.userId],
        );
        existing = await client.query<QueryResultRow>(
          `SELECT state, entered_state_at, last_evaluated_at, last_presence_day, consecutive_absence_days, version
             FROM guto_v3.relationship_lifecycle
            WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE`,
          [input.actor.tenantId, input.actor.userId],
        );
      }
      const row = existing.rows[0]!;
      const current = assertRelationshipLifecycleState(String(row.state));
      const currentAbsence = asNumber(row.consecutive_absence_days);
      const currentPresenceDay = row.last_presence_day ? String(row.last_presence_day) : null;
      const presenceDay = await this.deriveLastPresenceDay(client, input.actor);
      const asOf = this.todayKey();
      const absenceDays = presenceDay
        ? Math.max(0, Math.floor((new Date(`${asOf}T00:00:00.000Z`).getTime() - new Date(`${presenceDay}T00:00:00.000Z`).getTime()) / 86_400_000))
        : 0;
      const transition = evaluateRelationshipLifecycleState(current, absenceDays);
      if (transition.transitioned) {
        await client.query(
          `UPDATE guto_v3.relationship_lifecycle
              SET state=$3, entered_state_at=now(), last_evaluated_at=now(),
                  last_presence_day=$4, consecutive_absence_days=$5, version=version+1
            WHERE tenant_id=$1 AND user_id=$2`,
          [input.actor.tenantId, input.actor.userId, transition.state, presenceDay, absenceDays],
        );
        await client.query(
          `INSERT INTO guto_v3.relationship_lifecycle_events
             (tenant_id,user_id,request_id,from_state,to_state,reason)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id,user_id,request_id,from_state,to_state) DO NOTHING`,
          [input.actor.tenantId, input.actor.userId, input.requestId, current, transition.state, transition.reason || "transition"],
        );
      } else if (presenceDay !== currentPresenceDay || absenceDays !== currentAbsence) {
        await client.query(
          `UPDATE guto_v3.relationship_lifecycle
              SET last_evaluated_at=now(), last_presence_day=$3, consecutive_absence_days=$4
            WHERE tenant_id=$1 AND user_id=$2`,
          [input.actor.tenantId, input.actor.userId, presenceDay, absenceDays],
        );
      } else {
        await client.query(
          `UPDATE guto_v3.relationship_lifecycle SET last_evaluated_at=now()
            WHERE tenant_id=$1 AND user_id=$2`,
          [input.actor.tenantId, input.actor.userId],
        );
      }
      const final = await client.query<QueryResultRow>(
        `SELECT state, entered_state_at, last_evaluated_at, last_presence_day, consecutive_absence_days, version
           FROM guto_v3.relationship_lifecycle
          WHERE tenant_id=$1 AND user_id=$2`,
        [input.actor.tenantId, input.actor.userId],
      );
      return this.mapLifecycleRow(final.rows[0]!, input.actor);
    });
  }

  async listFactHistory(actor: ActorContext): Promise<RecordedFact[]> {
    return this.withActorTransaction(actor, async (client) => {
      const result = await client.query<QueryResultRow>(
        `SELECT user_fact_id,fact_type,value_json,source,confirmation_status,valid_from,valid_to,recorded_at,superseded_at,superseded_by
           FROM guto_v3.user_facts
          WHERE tenant_id=$1 AND user_id=$2
          ORDER BY recorded_at,user_fact_id`,
        [actor.tenantId, actor.userId],
      );
      return result.rows.map((row): RecordedFact => {
        const value = jsonObject(row.value_json);
        return {
          id: String(row.user_fact_id),
          factType: String(row.fact_type).toUpperCase() as RecordedFact["factType"],
          canonicalValue: typeof value.code === "string" ? value.code : typeof value.declaration === "string" ? value.declaration : JSON.stringify(value),
          value,
          source: row.source === "system" ? "system" : "user_declared",
          confirmationStatus: row.confirmation_status,
          validFrom: new Date(row.valid_from).toISOString(),
          validTo: row.valid_to ? new Date(row.valid_to).toISOString() : null,
          recordedAt: new Date(row.recorded_at).toISOString(),
          supersededAt: row.superseded_at ? new Date(row.superseded_at).toISOString() : null,
          supersededBy: row.superseded_by ? String(row.superseded_by) : null,
        };
      });
    });
  }

  async applyFactChanges(input: {
    actor: ActorContext;
    requestId: string;
    changes: FactChange[];
    expectedContextVersion: number;
  }): Promise<{ context: ConfirmedUserContext; facts: RecordedFact[]; affectedDomains: string[] }> {
    return this.withActorTransaction(input.actor, async (client) => {
      await this.lockOfficialContextAuthority(client, input.actor);
      if (!input.changes.length) throw new V3Error("V3_FACT_CHANGE_REQUIRED", "Nenhum fato operacional foi informado.", 400);
      for (const change of input.changes) assertFactChange(change);
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      const currentResult = await client.query<QueryResultRow>(
        `SELECT * FROM guto_v3.confirmed_user_contexts WHERE tenant_id=$1 AND user_id=$2 ORDER BY version DESC LIMIT 1`,
        [input.actor.tenantId, input.actor.userId],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow || asNumber(currentRow.version) !== input.expectedContextVersion) {
        throw new V3Error("V3_CONTEXT_VERSION_CONFLICT", "O contexto mudou; recarregue antes de registrar o fato.", 409, {
          expectedContextVersion: input.expectedContextVersion,
          officialContextVersion: currentRow ? asNumber(currentRow.version) : null,
        });
      }
      const current = this.mapConfirmedContext(currentRow);
      const recorded: RecordedFact[] = [];
      let foodDeclaration = current.foodDeclaration;
      let limitationDeclaration = current.limitationDeclaration;
      for (const change of input.changes) {
        const fact = await this.persistFact(client, input.actor, {
          factType: change.factType,
          value: { canonicalValue: change.canonicalValue, ...change.value, scope: change.scope || "profile" },
          canonicalValue: change.canonicalValue,
          scope: change.scope,
          source: change.source,
          confirmationStatus: change.confirmationStatus,
          supersedeCurrent: true,
        });
        if (fact) recorded.push(fact);
        if (change.factType === "GOAL") {
          await client.query(`UPDATE guto_v3.user_goals SET goal_code=$1,version=version+1 WHERE tenant_id=$2 AND user_id=$3`, [change.canonicalValue, input.actor.tenantId, input.actor.userId]);
        } else if (change.factType === "BODY_WEIGHT") {
          await client.query(`UPDATE guto_v3.user_profile SET weight_kg=$1,version=version+1 WHERE tenant_id=$2 AND user_id=$3`, [Number(change.value.weightKg), input.actor.tenantId, input.actor.userId]);
        } else if (change.factType === "TRAINING_FREQUENCY") {
          await client.query(`UPDATE guto_v3.user_profile SET weekly_frequency=$1,version=version+1 WHERE tenant_id=$2 AND user_id=$3`, [Number(change.value.daysPerWeek), input.actor.tenantId, input.actor.userId]);
        } else if (change.factType === "EXPERIENCE_LEVEL") {
          await client.query(`UPDATE guto_v3.user_profile SET training_status=$1,version=version+1 WHERE tenant_id=$2 AND user_id=$3`, [change.canonicalValue, input.actor.tenantId, input.actor.userId]);
        } else if (change.factType === "FOOD_CONSTRAINT" || change.factType === "FOOD_EXCLUSION") {
          // Exclusions are ADDITIVE, never a silent replacement: a later
          // declaration must not erase an earlier, still-valid one. Each
          // declared exclusion is appended to the running declaration so the
          // confirmed context (forbidden set) is the union of ALL of them.
          const declared = String(change.value.declaration || change.canonicalValue || "");
          if (declared && !foodDeclaration.includes(declared)) {
            foodDeclaration = foodDeclaration ? `${foodDeclaration} ${declared}` : declared;
          }
        } else if (change.factType === "PHYSICAL_CONSTRAINT") {
          limitationDeclaration = String(change.value.declaration || limitationDeclaration);
        }
      }
      const sources = await client.query<QueryResultRow>(
        `SELECT p.version AS profile_version,p.weekly_frequency,g.version AS goal_version,
                jsonb_build_object('version',p.version,'language',p.language,'biologicalSex',p.biological_sex,'age',p.age,'weightKg',p.weight_kg,'heightCm',p.height_cm,'trainingStatus',p.training_status,'weeklyFrequencyDaysPerWeek',p.weekly_frequency,'trainingLocation','gym') AS profile_snapshot,
                jsonb_build_object('version',g.version,'code',g.goal_code) AS goal_snapshot
           FROM guto_v3.user_profile p JOIN guto_v3.user_goals g ON g.tenant_id=p.tenant_id AND g.user_id=p.user_id
          WHERE p.tenant_id=$1 AND p.user_id=$2 FOR UPDATE OF p,g`,
        [input.actor.tenantId, input.actor.userId],
      );
      const source = sources.rows[0];
      if (!source || source.weekly_frequency == null) throw new V3Error("V3_CALIBRATION_REQUIRED", "Calibragem objetiva completa necessária.", 409);
      const nextVersion = asNumber(currentRow.version) + 1;
      const contextId = randomUUID();
      const currentFacts = await client.query<{ user_fact_id: string }>(
        `SELECT user_fact_id FROM guto_v3.user_facts WHERE tenant_id=$1 AND user_id=$2 AND superseded_at IS NULL ORDER BY recorded_at,user_fact_id`,
        [input.actor.tenantId, input.actor.userId],
      );
      const contextSnapshot = {
        profile: source.profile_snapshot,
        goal: source.goal_snapshot,
        factIds: currentFacts.rows.map((row) => row.user_fact_id),
        factChangeRequestId: input.requestId,
      };
      const contextResult = await client.query<QueryResultRow>(
        `INSERT INTO guto_v3.confirmed_user_contexts
          (id,tenant_id,user_id,version,profile_version,goal_version,food_declaration,limitation_declaration,training_location,weekly_frequency,context_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'gym',$9,$10::jsonb) RETURNING *`,
        [contextId, input.actor.tenantId, input.actor.userId, nextVersion, source.profile_version, source.goal_version, foodDeclaration, limitationDeclaration, source.weekly_frequency, JSON.stringify(contextSnapshot)],
      );
      const context = this.mapConfirmedContext(contextResult.rows[0]!);
      await client.query(
        `UPDATE guto_v3.first_contact_state SET confirmed_context_id=$1,confirmed_context_version=$2,version=version+1
          WHERE tenant_id=$3 AND user_id=$4 AND status='COMPLETED'`,
        [context.id, context.version, input.actor.tenantId, input.actor.userId],
      );
      const impactedSet = impactsFor(input.changes);
      const impacted = [...impactedSet];
      // Content from an unaffected engine remains authoritative, but its
      // context binding must advance atomically. An affected engine stays on
      // the previous context until its replacement commits, so a failed
      // regeneration can never masquerade as a valid new-context plan.
      if (!impactedSet.has("WORKOUT")) {
        await client.query(
          `UPDATE guto_v3.workout_plans
              SET confirmed_context_id=$1,confirmed_context_version=$2
            WHERE tenant_id=$3 AND user_id=$4 AND status='active'`,
          [context.id, context.version, input.actor.tenantId, input.actor.userId],
        );
      }
      if (!impactedSet.has("NUTRITION")) {
        await client.query(
          `UPDATE guto_v3.diet_plans
              SET confirmed_context_id=$1,confirmed_context_version=$2
            WHERE tenant_id=$3 AND user_id=$4 AND status='active'`,
          [context.id, context.version, input.actor.tenantId, input.actor.userId],
        );
      }
      if (!impactedSet.has("WORKOUT") && !impactedSet.has("NUTRITION")) {
        await client.query(
          `UPDATE guto_v3.active_plan_versions
              SET confirmed_context_id=$1,confirmed_context_version=$2,version=version+1
            WHERE tenant_id=$3 AND user_id=$4`,
          [context.id, context.version, input.actor.tenantId, input.actor.userId],
        );
      }
      await this.appendMutationEvent(client, input.actor, input.requestId, "facts.confirmed", {
        contextId: context.id,
        contextVersion: context.version,
        factIds: recorded.map((fact) => fact.id),
        affectedDomains: impacted,
      });
      return { context, facts: recorded, affectedDomains: impacted };
    });
  }

  async loadConversationDecisionState(actor: ActorContext, threadKey = "companion"): Promise<ConversationDecisionState> {
    return this.withActorTransaction(actor, async (client) => {
      const result = await client.query<QueryResultRow>(
        `SELECT t.thread_key, t.last_interaction_id, s.*
           FROM guto_v3.conversation_threads t
           LEFT JOIN guto_v3.conversation_decision_states s ON s.thread_id = t.id
          WHERE t.tenant_id = $1 AND t.user_id = $2 AND t.thread_key = $3`,
        [actor.tenantId, actor.userId, threadKey],
      );
      const row = result.rows[0];
      if (!row) return emptyConversationDecisionState(threadKey);
      const fallback = emptyConversationDecisionState(threadKey);
      return {
        threadKey: String(row.thread_key),
        version: row.version == null ? 0 : asNumber(row.version),
        activeTopic: row.active_topic || null,
        activeGoal: row.active_goal || null,
        knownFacts: Array.isArray(row.known_facts) ? row.known_facts as ConversationKnownFact[] : [],
        resolvedSlots: Array.isArray(row.resolved_slots) ? row.resolved_slots.map(String) : [],
        missingInformation: Array.isArray(row.missing_information) ? row.missing_information as ConversationDecisionState["missingInformation"] : [],
        uncertaintyType: row.uncertainty_type || fallback.uncertaintyType,
        decisionSufficiency: row.decision_sufficiency || fallback.decisionSufficiency,
        pendingAction: row.pending_action || null,
        nextAllowedAction: row.next_allowed_action || null,
        previousInteractionId: row.previous_interaction_id || row.last_interaction_id || null,
        status: row.status || fallback.status,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : fallback.updatedAt,
      };
    });
  }

  async recordConversationDecision(input: {
    actor: ActorContext;
    requestId: string;
    state: ConversationDecisionState;
    interactionId?: string;
    decisionId: string;
    resolvedFacts: ConversationKnownFact[];
  }): Promise<void> {
    await this.withActorTransaction(input.actor, async (client) => {
      const threadResult = await client.query<{ id: string; last_interaction_id: string | null }>(
        `INSERT INTO guto_v3.conversation_threads (tenant_id,user_id,thread_key,last_interaction_id,last_interaction_at)
         VALUES ($1,$2,$3,$4::text,CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (tenant_id,user_id,thread_key) DO UPDATE SET
           last_interaction_id=COALESCE(EXCLUDED.last_interaction_id,guto_v3.conversation_threads.last_interaction_id),
           last_interaction_at=CASE WHEN EXCLUDED.last_interaction_id IS NULL THEN guto_v3.conversation_threads.last_interaction_at ELSE now() END,
           version=guto_v3.conversation_threads.version+1
         RETURNING id,last_interaction_id`,
        [input.actor.tenantId, input.actor.userId, input.state.threadKey, input.interactionId || null],
      );
      const thread = threadResult.rows[0]!;
      const current = await client.query<{ version: string }>(
        `SELECT version FROM guto_v3.conversation_decision_states WHERE thread_id=$1 FOR UPDATE`,
        [thread.id],
      );
      const previousVersion = current.rows[0] ? asNumber(current.rows[0].version) : 0;
      const state = { ...input.state, version: Math.max(input.state.version, previousVersion + 1), previousInteractionId: input.interactionId || input.state.previousInteractionId };
      await client.query(
        `INSERT INTO guto_v3.conversation_decision_states
          (thread_id,tenant_id,user_id,active_topic,active_goal,known_facts,resolved_slots,missing_information,
           uncertainty_type,decision_sufficiency,pending_action,next_allowed_action,previous_interaction_id,status,version)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (thread_id) DO UPDATE SET
           active_topic=EXCLUDED.active_topic,active_goal=EXCLUDED.active_goal,known_facts=EXCLUDED.known_facts,
           resolved_slots=EXCLUDED.resolved_slots,missing_information=EXCLUDED.missing_information,
           uncertainty_type=EXCLUDED.uncertainty_type,decision_sufficiency=EXCLUDED.decision_sufficiency,
           pending_action=EXCLUDED.pending_action,next_allowed_action=EXCLUDED.next_allowed_action,
           previous_interaction_id=EXCLUDED.previous_interaction_id,status=EXCLUDED.status,version=EXCLUDED.version`,
        [
          thread.id, input.actor.tenantId, input.actor.userId, state.activeTopic, state.activeGoal,
          JSON.stringify(state.knownFacts), JSON.stringify(state.resolvedSlots), JSON.stringify(state.missingInformation),
          state.uncertaintyType, state.decisionSufficiency, state.pendingAction, state.nextAllowedAction,
          state.previousInteractionId, state.status, state.version,
        ],
      );
      for (const fact of input.resolvedFacts) {
        await this.persistFact(client, input.actor, {
          factType: fact.key,
          value: fact.value,
          source: fact.source || "derived",
          confirmationStatus: fact.certainty,
          supersedeCurrent: true,
        });
      }
      await client.query(
        `INSERT INTO guto_v3.conversation_state_events (tenant_id,user_id,thread_id,request_id,previous_version,next_version,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (tenant_id,user_id,request_id,next_version) DO NOTHING`,
        [input.actor.tenantId, input.actor.userId, thread.id, input.requestId, previousVersion, state.version, JSON.stringify({
          activeTopic: state.activeTopic,
          decisionSufficiency: state.decisionSufficiency,
          pendingAction: state.pendingAction,
          result: "persisted",
        })],
      );
      if (input.interactionId) {
        const retentionDays = Math.max(1, Math.min(55, Number(process.env.GUTO_V3_GEMINI_INTERACTION_RETENTION_DAYS || 7)));
        await client.query(
          `INSERT INTO guto_v3.gemini_interactions
            (tenant_id,user_id,thread_id,interaction_id,previous_interaction_id,decision_id,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,now() + ($7::text || ' days')::interval)
           ON CONFLICT (tenant_id,user_id,interaction_id) DO NOTHING`,
          [input.actor.tenantId, input.actor.userId, thread.id, input.interactionId, input.state.previousInteractionId, input.decisionId, String(retentionDays)],
        );
      }
      await client.query(
        `INSERT INTO guto_v3.outbox_events (tenant_id,aggregate_type,aggregate_id,event_type,payload)
         VALUES ($1,'user',$2,'conversation.decision.persisted',$3::jsonb)`,
        [input.actor.tenantId, input.actor.userId, JSON.stringify({
          requestId: input.requestId,
          correlationId: input.requestId,
          threadId: thread.id,
          interactionId: input.interactionId || null,
        })],
      );
    });
  }

  private async persistFact(
    client: PoolClient,
    actor: ActorContext,
    input: {
      factType: string;
      value: unknown;
      canonicalValue?: string;
      scope?: "profile" | "session";
      source: "user_declared" | "derived" | "system";
      confirmationStatus: "FACT_CONFIRMED" | "FACT_UNKNOWN";
      supersedeCurrent: boolean;
    },
  ): Promise<RecordedFact | null> {
    const valueJson = JSON.stringify(input.value);
    const existing = await client.query<{ user_fact_id: string; value_json: unknown }>(
      `SELECT user_fact_id,value_json FROM guto_v3.user_facts
        WHERE tenant_id=$1 AND user_id=$2 AND fact_type=$3 AND superseded_at IS NULL
        ORDER BY recorded_at DESC FOR UPDATE`,
      [actor.tenantId, actor.userId, input.factType],
    );
    const duplicate = existing.rows.find((row) => JSON.stringify(row.value_json) === valueJson);
    if (duplicate) {
      const existingRow = await client.query<QueryResultRow>(
        `SELECT user_fact_id,fact_type,value_json,source,confirmation_status,valid_from,valid_to,recorded_at,superseded_at,superseded_by FROM guto_v3.user_facts WHERE user_fact_id=$1`,
        [duplicate.user_fact_id],
      );
      const row = existingRow.rows[0];
      if (!row) return null;
      const value = jsonObject(row.value_json);
      return {
        id: String(row.user_fact_id), factType: String(row.fact_type).toUpperCase() as RecordedFact["factType"],
        canonicalValue: typeof value.canonicalValue === "string" ? value.canonicalValue : JSON.stringify(value), value,
        source: row.source === "system" ? "system" : "user_declared", confirmationStatus: row.confirmation_status,
        validFrom: new Date(row.valid_from).toISOString(), validTo: row.valid_to ? new Date(row.valid_to).toISOString() : null,
        recordedAt: new Date(row.recorded_at).toISOString(), supersededAt: row.superseded_at ? new Date(row.superseded_at).toISOString() : null,
        supersededBy: row.superseded_by ? String(row.superseded_by) : null,
      };
    }
    const inserted = await client.query<QueryResultRow>(
      `INSERT INTO guto_v3.user_facts
        (tenant_id,user_id,fact_type,canonical_value,fact_scope,value_json,source,confirmation_status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'guto-v3.3')
       RETURNING user_fact_id,fact_type,value_json,source,confirmation_status,valid_from,valid_to,recorded_at,superseded_at,superseded_by`,
      [actor.tenantId, actor.userId, input.factType, input.canonicalValue || JSON.stringify(input.value), input.scope || "profile", valueJson, input.source, input.confirmationStatus],
    );
    if (input.supersedeCurrent && existing.rows.length) {
      await client.query(
        `UPDATE guto_v3.user_facts SET valid_to=now(),superseded_at=now(),superseded_by=$1
          WHERE tenant_id=$2 AND user_id=$3 AND fact_type=$4 AND superseded_at IS NULL AND user_fact_id <> $1`,
        [inserted.rows[0]!.user_fact_id, actor.tenantId, actor.userId, input.factType],
      );
    }
    const row = inserted.rows[0]!;
    const value = jsonObject(row.value_json);
    return {
      id: String(row.user_fact_id), factType: String(row.fact_type).toUpperCase() as RecordedFact["factType"],
      canonicalValue: typeof value.canonicalValue === "string" ? value.canonicalValue : JSON.stringify(value), value,
      source: row.source === "system" ? "system" : "user_declared", confirmationStatus: row.confirmation_status,
      validFrom: new Date(row.valid_from).toISOString(), validTo: null,
      recordedAt: new Date(row.recorded_at).toISOString(), supersededAt: null, supersededBy: null,
    };
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

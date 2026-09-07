import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { CalibrationMutationSchema, FirstContactConfirmationSchema, FirstContactCorrectionSchema, FirstContactResponseSchema, V3MemoryMutationSchema, V3TurnRequestSchema } from "./contracts.js";
import { V3CutoverService } from "./cutover-service.js";
import { asV3Error, userFacingV3Message, V3Error } from "./errors.js";
import { parseWorkoutValidationEvidence } from "./workout-validation-evidence.js";
import { ProfileServiceV3 } from "./executors.js";
import { isLangfuseConfigured } from "./observability/instrumentation.js";
import { currentTraceId, withV3Span, withV3Trace } from "./observability/tracing.js";
import { getV3AuthService, getV3Runtime } from "./runtime.js";
import type { ActorContext } from "./types.js";

const ActiveContextMutationSchema = z.discriminatedUnion("clear", [
  z.object({ requestId: z.string().uuid(), clear: z.literal(true), expectedVersion: z.number().int().positive().nullable() }),
  z.object({
    requestId: z.string().uuid(),
    clear: z.literal(false),
    expectedVersion: z.number().int().positive().nullable(),
    kind: z.enum(["workout", "diet"]),
    planId: z.string().uuid(),
    itemId: z.string().uuid(),
  }),
]);

const RequestIdSchema = z.object({ requestId: z.string().uuid() });

// ─── BETA1 contracts (memory curation + execution logging + self-report) ────
const Beta1SetSchema = z.object({
  setNumber: z.number().int().min(1).max(20),
  loadKg: z.number().min(0).max(1000).optional(),
  reps: z.number().int().min(0).max(200).optional(),
  techniqueType: z.enum(["STRAIGHT_SET", "SUPERSET", "DROP_SET", "REST_PAUSE"]).default("STRAIGHT_SET"),
  techniqueGroup: z.string().max(64).optional(),
}).strict();

const Beta1ExecutionFeedbackSchema = z.object({
  requestId: z.string().uuid(),
  workoutSessionId: z.string().uuid(),
  exerciseId: z.string().min(1).max(160),
  difficultyLabel: z.enum(["FACIL", "BOA", "PESADA", "DOR"]),
  pain: z.boolean().optional(),
  sets: z.array(Beta1SetSchema).min(1).max(40),
  substitutedFromExerciseId: z.string().max(160).optional(),
  substitutionReason: z.string().max(300).optional(),
  techniqueGroup: z.string().max(64).optional(),
}).strict();

const Beta1CompleteSchema = z.object({
  requestId: z.string().uuid(),
  workoutSessionId: z.string().uuid(),
  completionMode: z.literal("self_report"),
}).strict();

const Beta1CurateMemorySchema = z.object({
  requestId: z.string().uuid(),
  message: z.string().min(1).max(4000),
  sourceType: z.enum(["conversation", "first_contact", "food_swap", "explicit_profile_edit"]).optional(),
}).strict();
const RelationshipLifecycleEvaluateSchema = RequestIdSchema.strict();
export function parseRelationshipLifecycleEvaluationBody(value: unknown): { requestId: string } {
  return RelationshipLifecycleEvaluateSchema.parse(value);
}
export function rejectPublicRelationshipReactivationBody(value: unknown): never {
  RequestIdSchema.parse(value);
  throw new V3Error("V3_RELATIONSHIP_REACTIVATION_FORBIDDEN", "A relação só pode ser retomada por um retorno real do usuário.", 403);
}
/** P0 (public session-completion bypass CLOSED): this public route can no
 * longer complete a session without the official /workout/validate authority
 * (selfie evidence + session + XP + rotation atomic). completeWorkoutSession()
 * stays an INTERNAL repository primitive for tests/internal logic, but the
 * public HTTP path is closed. Called after the contract parse + actor
 * resolution inside the route handler. */
export function rejectPublicSessionCompletion(value: unknown): never {
  WorkoutSessionCompletionSchema.parse(value);
  throw new V3Error("V3_WORKOUT_VALIDATION_REQUIRED", "Conclusão de sessão só existe pela validação oficial /workout/validate com prova (selfie).", 409);
}
const NameValidationRequestSchema = z.object({ name: z.string().trim().min(1).max(80) });
const V3LoginRequestSchema = z.object({
  emailOrId: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(512),
});
const WorkoutExerciseEventSchema = z.object({
  requestId: z.string().uuid(),
  exerciseId: z.string().trim().min(1).max(160),
  workoutSessionId: z.string().uuid().optional(),
  loadValue: z.number().nonnegative().max(2_000).optional(),
  repetitions: z.number().int().positive().max(200).optional(),
  setsCompleted: z.number().int().nonnegative().max(30).optional(),
  completed: z.boolean(),
  perceivedDifficulty: z.number().int().min(1).max(10).optional(),
  substitutedFromExerciseId: z.string().trim().min(1).max(160).optional(),
  substitutionReason: z.string().trim().min(1).max(500).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
}).strict();
const WorkoutSessionCompletionSchema = z.object({
  requestId: z.string().uuid(),
  workoutSessionId: z.string().uuid(),
}).strict();
const WorkoutValidationSchema = z.object({
  requestId: z.string().uuid(),
  workoutSessionId: z.string().uuid(),
  /* P0 (selfie authority): camera-produced evidence as a data URL. The backend
   * verifies format/magic bytes/size and persists ONLY a sha256 + metadata
   * (never the raw image, never base64). */
  evidence: z.string().min(1).max(12_000_000),
  language: z.string().trim().min(2).max(10).optional(),
}).strict();

function v3Enabled(): boolean { return process.env.GUTO_V3_ENABLED === "true"; }
export function v3OnlyEnabled(): boolean { return process.env.GUTO_V3_ONLY === "true"; }

export function isV3OnlyAllowedPath(pathname: string): boolean {
  return pathname === "/health/v3" ||
    pathname === "/guto/v3" || pathname.startsWith("/guto/v3/") ||
    pathname === "/api/inngest" || pathname.startsWith("/api/inngest/");
}

/** Administrative panel remains an explicit bounded surface during the V3
 * cutover. It is never a Companion authority and still has its own legacy
 * admin middleware. */
export function isV3AdministrativePanelPath(pathname: string): boolean {
  if (process.env.GUTO_V3_PANEL_ENABLED !== "true") return false;
  return pathname === "/auth/admin/login" || pathname === "/auth/coach/login" ||
    pathname.startsWith("/admin/") || pathname === "/admin";
}

const legacyAuthorityPrefixes = [
  "/guto/memory",
  "/guto/consent/accept",
  "/guto/consent/revoke",
  "/guto/validate-workout",
  "/guto/diet",
  "/guto/active-context",
  "/guto/active-exercise",
  "/guto/events",
  "/guto/validate-name",
  "/guto/arena",
  "/guto/proactive",
  "/guto/proactivity",
  "/guto/online/exception",
  "/guto-audio",
] as const;

export function isLegacyAuthorityPath(pathname: string): boolean {
  if (pathname === "/guto") return true;
  if (pathname.startsWith("/guto/v3")) return false;
  return legacyAuthorityPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function resolveActor(req: Request): Promise<ActorContext> {
  const actor = req.gutoV3Auth?.principal.actor;
  if (!actor) throw new V3Error("V3_AUTH_REQUIRED", "Autenticação necessária para o Cérebro V3.", 401);
  return actor;
}

function guardEnabled(_req: Request, _res: Response, next: NextFunction): void {
  if (!v3Enabled()) return next(new V3Error("V3_NOT_ENABLED", "Cérebro V3 ainda não habilitado neste ambiente.", 503));
  next();
}

async function requireV3Session(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    req.gutoV3Auth = await getV3AuthService().authenticateHeader(req.headers.authorization);
    next();
  } catch (error) {
    next(error);
  }
}

function validateV3Name(value: string): { status: "invalid" | "confirm" | "valid"; normalized: string; message: string } {
  const normalized = value.replace(/\s+/g, " ").trim();
  const lower = normalized.toLocaleLowerCase("pt-BR");
  const suspiciousNames = new Set(["banana", "teste", "asdf", "qwerty", "nome", "usuario", "usuário", "nada", "ovo"]);
  if (normalized.length < 2) return { status: "invalid", normalized, message: "Nome curto demais. Me dá um nome real." };
  if (normalized.length > 20) return { status: "invalid", normalized, message: "Nome longo demais. Usa até 20 caracteres." };
  if (!/^[\p{L} ]+$/u.test(normalized)) return { status: "invalid", normalized, message: "Nome não precisa de número nem símbolo. Só letras." };
  if (suspiciousNames.has(lower)) return { status: "confirm", normalized, message: `Esse é o nome que você quer que eu use com você: ${normalized}?` };
  return { status: "valid", normalized, message: "Nome aceito." };
}

export function createV3Router(options: { authenticatedRateLimit?: RequestHandler } = {}): express.Router {
  const router = express.Router();

  router.get("/health/v3", async (_req, res) => {
    const configured = {
      v3Only: v3OnlyEnabled(),
      postgres: Boolean(process.env.DATABASE_URL),
      redis: Boolean(
        (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
        (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
      ),
      geminiInteractions: Boolean(process.env.GEMINI_API_KEY) && process.env.GUTO_V3_GEMINI_INTERACTIONS_STORE !== "false",
      mem0: Boolean(process.env.MEM0_API_KEY),
      langfuse: isLangfuseConfigured(),
      inngest: Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY),
      auth: Boolean(process.env.GUTO_V3_JWT_SECRET && process.env.GUTO_V3_JWT_SECRET.length >= 32),
    };
    let postgres: unknown = { ok: false, configured: configured.postgres };
    let redis: unknown = { ok: false, configured: configured.redis };
    let auth: unknown = { ok: false, configured: configured.auth };
    if (configured.postgres && configured.auth) {
      auth = await getV3AuthService().health().catch((error) => ({
        ok: false,
        error: error instanceof V3Error ? error.code : error instanceof Error ? error.name : "unknown",
      }));
    }
    if (configured.postgres && configured.redis) {
      try {
        const runtime = getV3Runtime();
        [postgres, redis] = await Promise.all([
          runtime.repository.health().catch((error) => ({ ok: false, error: error instanceof Error ? error.name : "unknown" })),
          runtime.operational.health().catch((error) => ({ ok: false, error: error instanceof Error ? error.name : "unknown" })),
        ]);
      } catch (error) {
        postgres = { ok: false, error: error instanceof Error ? error.name : "unknown" };
        redis = { ok: false, error: error instanceof Error ? error.name : "unknown" };
      }
    }
    const ready = v3Enabled() && Object.values(configured).every(Boolean) &&
      Boolean((postgres as { ok?: boolean }).ok) && Boolean((redis as { ok?: boolean }).ok) &&
      Boolean((auth as { ok?: boolean }).ok);
    res.status(ready ? 200 : 503).json({
      service: "guto-cerebro-v3",
      brainVersion: "guto-cerebro-v3",
      enabled: v3Enabled(),
      v3Only: configured.v3Only,
      ready,
      configured,
      postgres,
      redis,
      auth,
    });
  });

  router.post("/guto/v3/auth/login", guardEnabled, async (req, res, next) => {
    try {
      const input = V3LoginRequestSchema.parse(req.body);
      const result = await getV3AuthService().login(input.emailOrId, input.password);
      const principal = result.principal;
      res.json({
        token: result.token,
        role: principal.actor.role,
        userId: principal.actor.userId,
        name: principal.displayName,
        ...(principal.loginIdentifier.includes("@") ? { email: principal.loginIdentifier } : {}),
        brainVersion: "guto-cerebro-v3",
      });
    } catch (error) { next(error); }
  });

  // Every route below /guto/v3 is authorized exclusively by a live PostgreSQL
  // session. Legacy req.gutoUser/JWT state is deliberately ignored.
  router.use("/guto/v3", guardEnabled, requireV3Session);
  if (options.authenticatedRateLimit) router.use("/guto/v3", options.authenticatedRateLimit);

  router.get("/guto/v3/auth/me", async (req, res, next) => {
    try {
      const principal = req.gutoV3Auth!.principal;
      res.json({
        role: principal.actor.role,
        userId: principal.actor.userId,
        name: principal.displayName,
        ...(principal.loginIdentifier.includes("@") ? { email: principal.loginIdentifier } : {}),
        brainVersion: "guto-cerebro-v3",
      });
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/auth/logout", async (req, res, next) => {
    try {
      await getV3AuthService().logout(req.gutoV3Auth!);
      res.json({ ok: true, brainVersion: "guto-cerebro-v3" });
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/name/validate", (req, res, next) => {
    try {
      res.json(validateV3Name(NameValidationRequestSchema.parse(req.body).name));
    } catch (error) { next(error); }
  });

  router.post("/guto/v3", async (req, res, next) => {
    try {
      const input = V3TurnRequestSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await getV3Runtime().gutoTurnFlow({
        actor,
        ...input,
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.get("/guto/v3/state", async (req, res, next) => {
    const requestId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : randomUUID();
    try {
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "state_read" } }, async () => {
        const [state, activeContext] = await Promise.all([
          withV3Span("POSTGRES_TRANSACTION", { "guto.operation": "state_read" }, () => getV3Runtime().repository.loadAppState(actor)),
          withV3Span("ACTIVE_CONTEXT_LOAD", {}, () => getV3Runtime().operational.getActiveContext(actor)),
        ]);
        return { brainVersion: "guto-cerebro-v3", requestId, traceId: currentTraceId(), state, activeContext };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.get("/guto/v3/facts/history", async (req, res, next) => {
    const requestId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : randomUUID();
    try {
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "facts_history" } }, async () => {
        const facts = await withV3Span("FACT_HISTORY_LOAD", {}, () => getV3Runtime().repository.listFactHistory(actor));
        return { brainVersion: "guto-cerebro-v3", requestId, traceId: currentTraceId(), facts };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/workout/session-exercises", async (req, res, next) => {
    try {
      const input = WorkoutExerciseEventSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "workout_evolution" } }, async () => {
        const decision = await withV3Span("WORKOUT_EVOLUTION", {}, () => getV3Runtime().repository.recordWorkoutExerciseEvent({ actor, requestId: input.requestId, event: input }));
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), decision };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  // P0 (public session-completion bypass CLOSED): /workout/validate is the
  // ONLY public authority that may complete a workout session. Sessions are
  // completed inside its single atomic transaction (selfie evidence + session
  // flip + XP + rotation). completeWorkoutSession() remains an INTERNAL
  // repository primitive used by internal logic/tests, but this public route
  // can no longer flip a session to 'completed' without the official
  // validation — otherwise session-exercises + sessions/complete would bypass
  // selfie/XP/rotation entirely (SEM SELFIE: XP=NÃO, COMPLETED=NÃO,
  // ROTATION=NÃO).
  router.post("/guto/v3/workout/sessions/complete", async (req, res, next) => {
    try {
      WorkoutSessionCompletionSchema.parse(req.body);
      await resolveActor(req);
      rejectPublicSessionCompletion(req.body);
    } catch (error) { next(error); }
  });

  // P0 (workout validation authority / founder gate): the SINGLE endpoint the
  // frontend uses to close a real workout. Requires selfie evidence, then
  // completes the session and records its XP atomically (exactly once).
  // ─── BETA1 Golden Path: execution logging + self-report completion ────────
  // The memory gate moved selfie OUT of the Beta 1 critical path. This is the
  // ONE official public authority to close a session in Beta 1 (selfie route
  // below stays untouched for BETA_2). Preconditions and exactly-once live in
  // completeBeta1WorkoutSession (ownership, context currency, execution
  // present, XP still daily-exactly-once via the shared ledger authority).
  router.post("/guto/v3/workout/start", async (req, res, next) => {
    try {
      const input = RequestIdSchema.strict().parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "beta1_workout_start" } }, async () => {
        const session = await withV3Span("BETA1_WORKOUT_START", { "guto.operation": "beta1_session_start" }, () =>
          getV3Runtime().beta1Workout.startOrResumeSession({ actor, requestId: input.requestId }));
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), ...session };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/workout/complete", async (req, res, next) => {
    try {
      const input = Beta1CompleteSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "beta1_workout_complete" } }, async () => {
        const outcome = await withV3Span("BETA1_WORKOUT_COMPLETE", { "guto.operation": "beta1_completion" }, () =>
          getV3Runtime().beta1Workout.completeWorkout({ actor, requestId: input.requestId, workoutSessionId: input.workoutSessionId }));
        return {
          brainVersion: "guto-cerebro-v3",
          requestId: input.requestId,
          traceId: currentTraceId(),
          status: outcome.status,
          xpGranted: outcome.xpGranted,
          xpAmount: outcome.xpAmount,
          nextSessionIndex: outcome.nextSessionIndex,
          painMemoriesPersisted: outcome.painMemoriesPersisted,
          progressSnapshots: outcome.progressSnapshots,
          presence: outcome.presence,
        };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/workout/execution-feedback", async (req, res, next) => {
    try {
      const input = Beta1ExecutionFeedbackSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "beta1_execution_feedback" } }, async () => {
        const outcome = await withV3Span("BETA1_EXECUTION_FEEDBACK", { "guto.operation": "beta1_execution" }, () =>
          getV3Runtime().beta1Workout.recordExecution({
            actor,
            requestId: input.requestId,
            workoutSessionId: input.workoutSessionId,
            exerciseId: input.exerciseId,
            difficultyLabel: input.difficultyLabel,
            pain: input.pain,
            sets: input.sets.map((set) => ({ setNumber: set.setNumber, loadKg: set.loadKg, reps: set.reps, techniqueType: set.techniqueType, techniqueGroup: set.techniqueGroup })),
            substitutedFromExerciseId: input.substitutedFromExerciseId,
            substitutionReason: input.substitutionReason,
            techniqueGroup: input.techniqueGroup,
          }));
        return {
          brainVersion: "guto-cerebro-v3",
          requestId: input.requestId,
          traceId: currentTraceId(),
          decision: outcome.decision,
          setCount: outcome.setCount,
        };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  // B2/B5/B7/B8: session-level subjective feedback (what GUTO cannot sense).
  // Persists idempotently, then returns the deterministic outcome + trend so
  // the UI can close the INVESTIGATE loop conversationally.
  router.post("/guto/v3/workout/session-feedback", async (req, res, next) => {
    try {
      const BodySchema = z.object({
        requestId: z.string().uuid(),
        workoutSessionId: z.string().uuid(),
        overallDifficulty: z.enum(["FACIL", "BOA", "PESADA", "DOR"]),
        pain: z.boolean().default(false),
        causeExplanation: z.string().trim().min(1).max(500).optional(),
        causeCategory: z.enum(["user_state", "training"]).optional(),
      }).strict();
      const input = BodySchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "beta1_session_feedback" } }, async () => {
        const presence = await withV3Span("BETA1_SESSION_FEEDBACK", {}, () =>
          getV3Runtime().beta1Workout.recordSessionFeedback({
            actor,
            requestId: input.requestId,
            workoutSessionId: input.workoutSessionId,
            overallDifficulty: input.overallDifficulty,
            pain: input.pain,
            causeExplanation: input.causeExplanation,
            causeCategory: input.causeCategory,
          }));
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), presence };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/memory/curate", async (req, res, next) => {
    try {
      const input = Beta1CurateMemorySchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "beta1_memory_curate" } }, async () => {
        const persisted = await withV3Span("BETA1_MEMORY_CURATE", { "guto.operation": "memory_curation" }, () =>
          getV3Runtime().beta1Curation.curateFromTurn(actor, input.requestId, input.message, input.sourceType ?? "conversation"));
        return {
          brainVersion: "guto-cerebro-v3",
          requestId: input.requestId,
          traceId: currentTraceId(),
          persisted: persisted.map((memory) => ({ id: memory.id, category: memory.category, key: memory.key, status: memory.status, version: memory.version, supersedesId: memory.supersedesId })),
        };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/memory/snapshot", async (req, res, next) => {
    try {
      const BodySchema = z.object({ queryKind: z.enum(["workout", "diet", "chat"]).default("chat") }).strict();
      const input = BodySchema.parse(req.body ?? {});
      const actor = await resolveActor(req);
      const requestId = randomUUID();
      const result = await withV3Trace({ requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "beta1_memory_snapshot" } }, async () => {
        const snapshot = await withV3Span("BETA1_MEMORY_SNAPSHOT", {}, () =>
          getV3Runtime().beta1Curation.buildRelevantMemorySnapshot(actor, input.queryKind));
        return { brainVersion: "guto-cerebro-v3", requestId, traceId: currentTraceId(), snapshot };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/workout/validate", async (req, res, next) => {
    try {
      const input = WorkoutValidationSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "workout_validation" } }, async () => {
        const evidence = parseWorkoutValidationEvidence(input.evidence);
        const outcome = await withV3Span("WORKOUT_VALIDATE", { "guto.operation": "workout_validation" }, () =>
          getV3Runtime().repository.validateAndCompleteWorkoutSession({ actor, requestId: input.requestId, workoutSessionId: input.workoutSessionId, evidence }));
        return {
          brainVersion: "guto-cerebro-v3",
          requestId: input.requestId,
          traceId: currentTraceId(),
          status: outcome.status,
          xpGranted: outcome.xpGranted,
          xpAmount: outcome.xpAmount,
          nextSessionIndex: outcome.nextSessionIndex,
          evidence: { sha256: evidence.sha256, mime: evidence.mime, byteLength: evidence.byteLength },
        };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/consent/accept", async (req, res, next) => {
    try {
      const input = RequestIdSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({
        requestId: input.requestId,
        externalSubject: actor.externalSubject,
        attributes: { "guto.input_category": "consent_accept" },
      }, async () => {
        const runtime = getV3Runtime();
        const state = await withV3Span("CONSENT_SAVE", {}, () =>
          runtime.operational.withLock(actor, "consent", () =>
            new V3CutoverService(runtime.repository).acceptConsent(actor, input.requestId)));
        const activeContext = await withV3Span("ACTIVE_CONTEXT_LOAD", {}, () =>
          runtime.operational.getActiveContext(actor));
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/memory", async (req, res, next) => {
    try {
      const input = V3MemoryMutationSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({
        requestId: input.requestId,
        externalSubject: actor.externalSubject,
        attributes: { "guto.input_category": "memory_save" },
      }, async () => {
        const runtime = getV3Runtime();
        const state = await withV3Span("MEMORY_SAVE", {}, () =>
          runtime.operational.withLock(actor, "memory", () =>
            new V3CutoverService(runtime.repository).saveMemory(actor, input)));
        const activeContext = await withV3Span("ACTIVE_CONTEXT_LOAD", {}, () =>
          runtime.operational.getActiveContext(actor));
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/first-contact/start", async (req, res, next) => {
    try {
      const input = RequestIdSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "first_contact_start" } }, async () => {
        const runtime = getV3Runtime();
        const state = await runtime.operational.withLock(actor, "first-contact", () => new V3CutoverService(runtime.repository).startFirstContact(actor, input.requestId));
        const activeContext = await runtime.operational.getActiveContext(actor);
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/first-contact/respond", async (req, res, next) => {
    try {
      const input = FirstContactResponseSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "first_contact_respond" } }, async () => {
        const runtime = getV3Runtime();
        const state = await runtime.operational.withLock(actor, "first-contact", () => new V3CutoverService(runtime.repository).respondFirstContact(actor, input));
        const activeContext = await runtime.operational.getActiveContext(actor);
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/first-contact/correct", async (req, res, next) => {
    try {
      const input = FirstContactCorrectionSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "first_contact_correct" } }, async () => {
        const runtime = getV3Runtime();
        const state = await runtime.operational.withLock(actor, "first-contact", () => new V3CutoverService(runtime.repository).correctFirstContact(actor, input));
        const activeContext = await runtime.operational.getActiveContext(actor);
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/first-contact/confirm", async (req, res, next) => {
    try {
      const input = FirstContactConfirmationSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "first_contact_confirm" } }, async () => {
        const runtime = getV3Runtime();
        const state = await runtime.operational.withLock(actor, "first-contact", () => new V3CutoverService(runtime.repository).confirmFirstContact(actor, input));
        const activeContext = await runtime.operational.getActiveContext(actor);
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/context/reconfirm", async (req, res, next) => {
    try {
      const input = RequestIdSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "context_reconfirm" } }, async () => {
        const runtime = getV3Runtime();
        const state = await runtime.operational.withLock(actor, "first-contact", () => new V3CutoverService(runtime.repository).reconfirmContext(actor, input.requestId));
        const activeContext = await runtime.operational.getActiveContext(actor);
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/workout/generate", async (req, res, next) => {
    try {
      const input = RequestIdSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({
        requestId: input.requestId,
        externalSubject: actor.externalSubject,
        attributes: { "guto.input_category": "workout_generate" },
      }, async () => {
        const runtime = getV3Runtime();
        const state = await withV3Span("WORKOUT_GENERATE", {}, () =>
          runtime.operational.withLock(actor, "workout-generate", () =>
            new V3CutoverService(runtime.repository).generateWorkout(actor, input.requestId)));
        const activeContext = await withV3Span("ACTIVE_CONTEXT_LOAD", {}, () =>
          runtime.operational.getActiveContext(actor));
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/diet/generate", async (req, res, next) => {
    try {
      const input = RequestIdSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({
        requestId: input.requestId,
        externalSubject: actor.externalSubject,
        attributes: { "guto.input_category": "diet_generate" },
      }, async () => {
        const runtime = getV3Runtime();
        const state = await withV3Span("DIET_GENERATE", {}, () =>
          runtime.operational.withLock(actor, "diet-generate", () =>
            new V3CutoverService(runtime.repository).generateDiet(actor, input.requestId)));
        const activeContext = await withV3Span("ACTIVE_CONTEXT_LOAD", {}, () =>
          runtime.operational.getActiveContext(actor));
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/calibration", async (req, res, next) => {
    try {
      const input = CalibrationMutationSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "calibration" } }, async () => {
        const calibration = await getV3Runtime().operational.withLock(actor, "calibration", () =>
          withV3Span("CALIBRATION_SAVE", {}, () => new ProfileServiceV3(getV3Runtime().repository).persistCalibration(actor, input)));
        return { ...calibration, brainVersion: "guto-cerebro-v3", traceId: currentTraceId() };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/active-context", async (req, res, next) => {
    try {
      const input = ActiveContextMutationSchema.parse(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "active_context" } }, async () => {
        if (input.clear) {
          await getV3Runtime().operational.clearActiveContext(actor, input.expectedVersion);
          return { requestId: input.requestId, traceId: currentTraceId(), brainVersion: "guto-cerebro-v3", activeContext: null };
        }
        const snapshot = await withV3Span("POSTGRES_TRANSACTION", { "guto.operation": "active_context_validate" }, () =>
          getV3Runtime().repository.loadOfficialSnapshot(actor));
        const plan = input.kind === "workout" ? snapshot.workout : snapshot.diet;
        if (!plan || plan.id !== input.planId) throw new V3Error("V3_OFFICIAL_PLAN_NOT_FOUND", "Plano oficial não encontrado.", 409);
        const item = input.kind === "workout"
          ? snapshot.workout?.items.find((candidate) => candidate.id === input.itemId)
          : snapshot.diet?.meals.flatMap((meal) => meal.items).find((candidate) => candidate.id === input.itemId);
        if (!item) throw new V3Error("V3_OFFICIAL_ITEM_NOT_FOUND", "Item oficial não encontrado.", 409);
        const current = await getV3Runtime().operational.getActiveContext(actor);
        if ((current?.version ?? null) !== input.expectedVersion) throw new V3Error("V3_ACTIVE_CONTEXT_CONFLICT", "O contexto ativo mudou.", 409);
        const nextContext = {
          id: current?.id || randomUUID(),
          version: (current?.version || 0) + 1,
          kind: input.kind,
          planId: plan.id,
          planVersion: plan.version,
          itemId: input.itemId,
          itemLabel: "name" in item ? item.name : String(input.itemId),
          rejectedCandidateIds: [] as string[],
          updatedAt: new Date().toISOString(),
        };
        await withV3Span("REDIS_UPDATE", { "guto.operation": "active_context_set" }, () =>
          getV3Runtime().operational.compareAndSetActiveContext(actor, input.expectedVersion, nextContext));
        return { requestId: input.requestId, traceId: currentTraceId(), brainVersion: "guto-cerebro-v3", activeContext: nextContext };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/relationship/lifecycle/evaluate", async (req, res, next) => {
    try {
      const input = parseRelationshipLifecycleEvaluationBody(req.body);
      const actor = await resolveActor(req);
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: actor.externalSubject, attributes: { "guto.input_category": "relationship_lifecycle_evaluate" } }, async () => {
        const lifecycle = await getV3Runtime().operational.withLock(actor, "relationship-lifecycle", () =>
          new V3CutoverService(getV3Runtime().repository).evaluateRelationshipLifecycle(actor, input));
        return { brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), lifecycle };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/relationship/lifecycle/reactivate", async (req, res, next) => {
    try {
      await resolveActor(req);
      rejectPublicRelationshipReactivationBody(req.body);
    } catch (error) { next(error); }
  });

  // Em ambiente de cutover, uma rota legada não pode virar uma segunda fonte
  // de verdade por chamada direta, cliente antigo ou retry fora de versão.
  router.use((req, res, next) => {
    if (!v3Enabled() || !isLegacyAuthorityPath(req.path)) return next();
    res.status(409).json({
      error: "V3_LEGACY_AUTHORITY_DISABLED",
      message: "Este fluxo pertence exclusivamente ao Cérebro V3 neste ambiente.",
      brainVersion: "guto-cerebro-v3",
    });
  });

  router.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const parsed = error instanceof z.ZodError
      ? new V3Error("V3_INVALID_REQUEST", "Contrato de requisição V3 inválido.", 400, {
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
        })
      : asV3Error(error);
    // B12: engineering layer keeps the true error (code/trace/status), the
    // user layer gets a short human line — never a raw technical message.
    const requestId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : "";
    console.error(`[v3-error] code=${parsed.code} status=${parsed.status} path=${req.path}`, error);
    res.status(parsed.status).json({
      error: parsed.code,
      message: userFacingV3Message(parsed, requestId || parsed.code),
      brainVersion: "guto-cerebro-v3",
      traceId: currentTraceId(),
      ...(parsed.details ? { details: parsed.details } : {}),
    });
  });

  return router;
}

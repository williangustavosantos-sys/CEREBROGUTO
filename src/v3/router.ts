import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { CalibrationMutationSchema, V3MemoryMutationSchema, V3TurnRequestSchema } from "./contracts.js";
import { V3CutoverService } from "./cutover-service.js";
import { asV3Error, V3Error } from "./errors.js";
import { ProfileServiceV3 } from "./executors.js";
import { isLangfuseConfigured } from "./observability/instrumentation.js";
import { currentTraceId, withV3Span, withV3Trace } from "./observability/tracing.js";
import { getV3Runtime } from "./runtime.js";
import type { ActorContext } from "./types.js";
import { getEffectiveUserAccessAsync } from "../user-access-store.js";
import { GUTO_CORE_TEAM_ID } from "../team-store.js";

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

function v3Enabled(): boolean { return process.env.GUTO_V3_ENABLED === "true"; }

const legacyAuthorityPrefixes = [
  "/guto/memory",
  "/guto/consent/accept",
  "/guto/consent/revoke",
  "/guto/validate-workout",
  "/guto/diet",
  "/guto/active-context",
  "/guto/active-exercise",
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

async function resolveActor(req: Request, options?: { provision?: boolean }): Promise<ActorContext> {
  if (!req.gutoUser) throw new V3Error("V3_AUTH_REQUIRED", "Autenticação necessária.", 401);
  const runtime = getV3Runtime();
  const actor = await runtime.repository.resolveActor(req.gutoUser.userId, req.gutoUser.role);
  if (!actor && options?.provision) {
    const access = await getEffectiveUserAccessAsync(req.gutoUser.userId);
    if (!access) throw new V3Error("V3_ACCESS_NOT_FOUND", "Acesso oficial não encontrado.", 409);
    const tenantKey = access.teamId || GUTO_CORE_TEAM_ID;
    return runtime.repository.provisionActor({
      externalSubject: req.gutoUser.userId,
      role: req.gutoUser.role,
      tenantKey,
      tenantName: tenantKey,
      displayName: access.name || [access.firstName, access.lastName].filter(Boolean).join(" ") || undefined,
    });
  }
  if (!actor) throw new V3Error("V3_IDENTITY_NOT_MIGRATED", "Identidade ainda não migrada para o Cérebro V3.", 409);
  return actor;
}

function guardEnabled(_req: Request, _res: Response, next: NextFunction): void {
  if (!v3Enabled()) return next(new V3Error("V3_NOT_ENABLED", "Cérebro V3 ainda não habilitado neste ambiente.", 503));
  next();
}

export function createV3Router(requireActiveUser: RequestHandler): express.Router {
  const router = express.Router();

  router.get("/health/v3", async (_req, res) => {
    const configured = {
      postgres: Boolean(process.env.DATABASE_URL),
      redis: Boolean(
        (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
        (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
      ),
      gemini: Boolean(process.env.GEMINI_API_KEY),
      mem0: Boolean(process.env.MEM0_API_KEY),
      langfuse: isLangfuseConfigured(),
    };
    let postgres: unknown = { ok: false, configured: configured.postgres };
    let redis: unknown = { ok: false, configured: configured.redis };
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
      Boolean((postgres as { ok?: boolean }).ok) && Boolean((redis as { ok?: boolean }).ok);
    res.status(ready ? 200 : 503).json({
      service: "guto-cerebro-v3",
      brainVersion: "guto-cerebro-v3",
      enabled: v3Enabled(),
      ready,
      configured,
      postgres,
      redis,
    });
  });

  router.post("/guto/v3", requireActiveUser, guardEnabled, async (req, res, next) => {
    try {
      const input = V3TurnRequestSchema.parse(req.body);
      const user = req.gutoUser!;
      const result = await getV3Runtime().gutoTurnFlow({
        externalSubject: user.userId,
        role: user.role,
        ...input,
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.get("/guto/v3/state", requireActiveUser, guardEnabled, async (req, res, next) => {
    const requestId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : randomUUID();
    try {
      const user = req.gutoUser!;
      const result = await withV3Trace({ requestId, externalSubject: user.userId, attributes: { "guto.input_category": "state_read" } }, async () => {
        const actor = await resolveActor(req, { provision: true });
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

  router.post("/guto/v3/consent/accept", requireActiveUser, guardEnabled, async (req, res, next) => {
    try {
      const input = RequestIdSchema.parse(req.body);
      const actor = await resolveActor(req, { provision: true });
      const state = await getV3Runtime().operational.withLock(actor, "consent", () =>
        new V3CutoverService(getV3Runtime().repository).acceptConsent(actor, input.requestId));
      const activeContext = await getV3Runtime().operational.getActiveContext(actor);
      res.json({ brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext });
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/memory", requireActiveUser, guardEnabled, async (req, res, next) => {
    try {
      const input = V3MemoryMutationSchema.parse(req.body);
      const actor = await resolveActor(req, { provision: true });
      const state = await getV3Runtime().operational.withLock(actor, "memory", () =>
        new V3CutoverService(getV3Runtime().repository).saveMemory(actor, input));
      const activeContext = await getV3Runtime().operational.getActiveContext(actor);
      res.json({ brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext });
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/workout/generate", requireActiveUser, guardEnabled, async (req, res, next) => {
    try {
      const input = RequestIdSchema.parse(req.body);
      const actor = await resolveActor(req);
      const state = await getV3Runtime().operational.withLock(actor, "workout-generate", () =>
        new V3CutoverService(getV3Runtime().repository).generateWorkout(actor, input.requestId));
      const activeContext = await getV3Runtime().operational.getActiveContext(actor);
      res.json({ brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext });
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/diet/generate", requireActiveUser, guardEnabled, async (req, res, next) => {
    try {
      const input = RequestIdSchema.parse(req.body);
      const actor = await resolveActor(req);
      const state = await getV3Runtime().operational.withLock(actor, "diet-generate", () =>
        new V3CutoverService(getV3Runtime().repository).generateDiet(actor, input.requestId));
      const activeContext = await getV3Runtime().operational.getActiveContext(actor);
      res.json({ brainVersion: "guto-cerebro-v3", requestId: input.requestId, traceId: currentTraceId(), state, activeContext });
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/calibration", requireActiveUser, guardEnabled, async (req, res, next) => {
    try {
      const input = CalibrationMutationSchema.parse(req.body);
      const user = req.gutoUser!;
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: user.userId, attributes: { "guto.input_category": "calibration" } }, async () => {
        const actor = await withV3Span("AUTH", {}, () => resolveActor(req, { provision: true }));
        const calibration = await getV3Runtime().operational.withLock(actor, "calibration", () =>
          withV3Span("CALIBRATION_SAVE", {}, () => new ProfileServiceV3(getV3Runtime().repository).persistCalibration(actor, input)));
        return { ...calibration, brainVersion: "guto-cerebro-v3", traceId: currentTraceId() };
      });
      res.setHeader("x-guto-trace-id", result.traceId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/guto/v3/active-context", requireActiveUser, guardEnabled, async (req, res, next) => {
    try {
      const input = ActiveContextMutationSchema.parse(req.body);
      const user = req.gutoUser!;
      const result = await withV3Trace({ requestId: input.requestId, externalSubject: user.userId, attributes: { "guto.input_category": "active_context" } }, async () => {
        const actor = await withV3Span("AUTH", {}, () => resolveActor(req));
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

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const parsed = error instanceof z.ZodError
      ? new V3Error("V3_INVALID_REQUEST", "Contrato de requisição V3 inválido.", 400, {
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
        })
      : asV3Error(error);
    res.status(parsed.status).json({
      error: parsed.code,
      message: parsed.message,
      brainVersion: "guto-cerebro-v3",
      traceId: currentTraceId(),
      ...(parsed.details ? { details: parsed.details } : {}),
    });
  });

  return router;
}

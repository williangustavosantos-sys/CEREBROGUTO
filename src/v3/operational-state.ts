import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { V3Error } from "./errors.js";
import type { ActiveContext, ActorContext, V3TurnResponse } from "./types.js";

export interface OperationalStateStore {
  health(): Promise<{ ok: boolean; latencyMs: number }>;
  getActiveContext(actor: ActorContext): Promise<ActiveContext | null>;
  compareAndSetActiveContext(actor: ActorContext, expectedVersion: number | null, next: ActiveContext): Promise<void>;
  beginRequest(actor: ActorContext, requestId: string): Promise<{ state: "started" | "pending" | "completed"; response?: V3TurnResponse; requestToken?: string }>;
  completeRequest(actor: ActorContext, requestId: string, requestToken: string, response: V3TurnResponse): Promise<void>;
  abortRequest(actor: ActorContext, requestId: string, requestToken: string): Promise<void>;
  withLock<T>(actor: ActorContext, operation: string, fn: () => Promise<T>): Promise<T>;
}

type RedisLike = Pick<Redis, "get" | "set" | "del" | "eval" | "ping">;

function scope(actor: ActorContext): string {
  return `{${actor.tenantId}:${actor.userId}}`;
}

function activeContextKey(actor: ActorContext): string {
  return `guto:v3:${scope(actor)}:active-context`;
}

function idempotencyKey(actor: ActorContext, requestId: string): string {
  return `guto:v3:${scope(actor)}:idem:${requestId}`;
}

function lockKey(actor: ActorContext, operation: string): string {
  const safeOperation = operation.replace(/[^a-zA-Z0-9:_-]/g, "_");
  return `guto:v3:${scope(actor)}:lock:${safeOperation}`;
}

export class RedisV3OperationalState implements OperationalStateStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlSeconds = Number(process.env.GUTO_V3_OPERATIONAL_TTL_SECONDS || 86_400),
    private readonly lockTtlMs = Number(process.env.GUTO_V3_LOCK_TTL_MS || 60_000),
  ) {}

  static fromEnvironment(): RedisV3OperationalState {
    const url = process.env.UPSTASH_REDIS_REST_URL || "";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
    if (!url || !token) {
      throw new V3Error("V3_REDIS_NOT_CONFIGURED", "Redis V3 não configurado.", 503);
    }
    return new RedisV3OperationalState(new Redis({ url, token }));
  }

  async health(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = performance.now();
    const pong = await this.redis.ping();
    return { ok: pong === "PONG", latencyMs: Math.round(performance.now() - started) };
  }

  async getActiveContext(actor: ActorContext): Promise<ActiveContext | null> {
    const value = await this.redis.get<ActiveContext>(activeContextKey(actor));
    return value && typeof value === "object" ? value : null;
  }

  async compareAndSetActiveContext(actor: ActorContext, expectedVersion: number | null, next: ActiveContext): Promise<void> {
    const script = `
      local current = redis.call('GET', KEYS[1])
      if ARGV[1] == '-1' then
        if current then return 0 end
      else
        if not current then return 0 end
        local decoded = cjson.decode(current)
        if tostring(decoded.version) ~= ARGV[1] then return 0 end
      end
      redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
      return 1
    `;
    const result = await this.redis.eval(
      script,
      [activeContextKey(actor)],
      [String(expectedVersion ?? -1), JSON.stringify(next), String(this.ttlSeconds)],
    );
    if (Number(result) !== 1) {
      throw new V3Error("V3_ACTIVE_CONTEXT_CONFLICT", "O contexto ativo mudou durante a operação.", 409);
    }
  }

  async beginRequest(actor: ActorContext, requestId: string): Promise<{ state: "started" | "pending" | "completed"; response?: V3TurnResponse; requestToken?: string }> {
    const key = idempotencyKey(actor, requestId);
    const requestToken = randomUUID();
    const started = await this.redis.set(key, JSON.stringify({ state: "pending", requestToken, createdAt: new Date().toISOString() }), {
      nx: true,
      ex: this.ttlSeconds,
    });
    if (started === "OK") return { state: "started", requestToken };
    const current = await this.redis.get<{ state?: string; response?: V3TurnResponse }>(key);
    if (current?.state === "completed" && current.response) return { state: "completed", response: current.response };
    return { state: "pending" };
  }

  async completeRequest(actor: ActorContext, requestId: string, requestToken: string, response: V3TurnResponse): Promise<void> {
    const result = await this.redis.eval(
      `local current = redis.call('GET', KEYS[1])
       if not current then return 0 end
       local decoded = cjson.decode(current)
       if decoded.state ~= 'pending' or decoded.requestToken ~= ARGV[1] then return 0 end
       redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
       return 1`,
      [idempotencyKey(actor, requestId)],
      [requestToken, JSON.stringify({ state: "completed", response, completedAt: new Date().toISOString() }), String(this.ttlSeconds)],
    );
    if (Number(result) !== 1) throw new V3Error("V3_IDEMPOTENCY_WRITE_FAILED", "Falha ao confirmar idempotência.", 503);
  }

  async abortRequest(actor: ActorContext, requestId: string, requestToken: string): Promise<void> {
    await this.redis.eval(
      `local current = redis.call('GET', KEYS[1])
       if not current then return 0 end
       local decoded = cjson.decode(current)
       if decoded.state == 'pending' and decoded.requestToken == ARGV[1] then return redis.call('DEL', KEYS[1]) end
       return 0`,
      [idempotencyKey(actor, requestId)],
      [requestToken],
    );
  }

  async withLock<T>(actor: ActorContext, operation: string, fn: () => Promise<T>): Promise<T> {
    const key = lockKey(actor, operation);
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, { nx: true, px: this.lockTtlMs });
    if (acquired !== "OK") throw new V3Error("V3_OPERATION_IN_PROGRESS", "Esta operação já está em andamento.", 409);
    try {
      return await fn();
    } finally {
      await this.redis.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
        [key],
        [token],
      ).catch(() => undefined);
    }
  }
}

export class InMemoryOperationalState implements OperationalStateStore {
  private readonly contexts = new Map<string, ActiveContext>();
  private readonly requests = new Map<string, { state: "pending" | "completed"; response?: V3TurnResponse; requestToken?: string }>();
  private readonly locks = new Set<string>();

  async health(): Promise<{ ok: boolean; latencyMs: number }> { return { ok: true, latencyMs: 0 }; }
  async getActiveContext(actor: ActorContext): Promise<ActiveContext | null> { return this.contexts.get(scope(actor)) || null; }
  async compareAndSetActiveContext(actor: ActorContext, expectedVersion: number | null, next: ActiveContext): Promise<void> {
    const current = this.contexts.get(scope(actor));
    if ((current?.version ?? null) !== expectedVersion) throw new V3Error("V3_ACTIVE_CONTEXT_CONFLICT", "O contexto ativo mudou durante a operação.", 409);
    this.contexts.set(scope(actor), structuredClone(next));
  }
  async beginRequest(actor: ActorContext, requestId: string): Promise<{ state: "started" | "pending" | "completed"; response?: V3TurnResponse; requestToken?: string }> {
    const key = `${scope(actor)}:${requestId}`;
    const current = this.requests.get(key);
    if (!current) { const requestToken = randomUUID(); this.requests.set(key, { state: "pending", requestToken }); return { state: "started", requestToken }; }
    return current.state === "completed" ? { state: "completed", response: current.response } : { state: "pending" };
  }
  async completeRequest(actor: ActorContext, requestId: string, requestToken: string, response: V3TurnResponse): Promise<void> {
    const key = `${scope(actor)}:${requestId}`;
    const current = this.requests.get(key) as { state: "pending" | "completed"; requestToken?: string } | undefined;
    if (current?.state !== "pending" || current.requestToken !== requestToken) throw new V3Error("V3_IDEMPOTENCY_WRITE_FAILED", "Falha ao confirmar idempotência.", 503);
    this.requests.set(`${scope(actor)}:${requestId}`, { state: "completed", response: structuredClone(response) });
  }
  async abortRequest(actor: ActorContext, requestId: string, requestToken: string): Promise<void> {
    const key = `${scope(actor)}:${requestId}`;
    const current = this.requests.get(key) as { state: "pending" | "completed"; requestToken?: string } | undefined;
    if (current?.state === "pending" && current.requestToken === requestToken) this.requests.delete(key);
  }
  async withLock<T>(actor: ActorContext, operation: string, fn: () => Promise<T>): Promise<T> {
    const key = `${scope(actor)}:${operation}`;
    if (this.locks.has(key)) throw new V3Error("V3_OPERATION_IN_PROGRESS", "Esta operação já está em andamento.", 409);
    this.locks.add(key);
    try { return await fn(); } finally { this.locks.delete(key); }
  }
}

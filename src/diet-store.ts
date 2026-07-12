/**
 * GUTO Diet Store
 *
 * Armazena e recupera o plano de dieta semanal por userId.
 * Usa o mesmo mecanismo de persistência do memory-store (Redis → filesystem → in-memory).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { DietPlan } from "./nutrition.js";

const DIET_FILE = process.env.GUTO_DIET_FILE || join(process.cwd(), "data", "guto-diet.json");
const REDIS_KEY = "guto:diet";
const REDIS_WRITE_LOCK_KEY = "guto:diet:write-lock:v1";
const REDIS_WRITE_LOCK_TTL_MS = 15_000;
const REDIS_WRITE_LOCK_WAIT_MS = 20_000;

// ─── In-memory cache ──────────────────────────────────────────────────────────

const inMemoryStore: Record<string, DietPlan> = {};

// ─── Redis client (lazy, same pattern as memory-store) ───────────────────────

type RedisClient = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options?: { nx: true; px: number }) => Promise<unknown>;
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
};
let redisClient: RedisClient | null = null;

function getRedisClient() {
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    redisClient = new Redis({ url, token }) as unknown as RedisClient;
    return redisClient;
  } catch {
    return null;
  }
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireRedisWriteLock(redis: RedisClient): Promise<() => Promise<void>> {
  const token = randomUUID();
  const deadline = Date.now() + REDIS_WRITE_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const acquired = await redis.set(REDIS_WRITE_LOCK_KEY, token, {
      nx: true,
      px: REDIS_WRITE_LOCK_TTL_MS,
    });
    if (acquired === "OK") {
      return async () => {
        try {
          await redis.eval(
            'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
            [REDIS_WRITE_LOCK_KEY],
            [token]
          );
        } catch (error) {
          console.warn("[GUTO] Failed to release Redis diet write lock:", error);
        }
      };
    }
    await waitFor(50);
  }
  throw new Error("Timed out waiting for the Redis diet write lock.");
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

function readFromFile(): Record<string, DietPlan> {
  try {
    if (!existsSync(DIET_FILE)) return {};
    return JSON.parse(readFileSync(DIET_FILE, "utf8")) as Record<string, DietPlan>;
  } catch {
    return {};
  }
}

function writeToFile(store: Record<string, DietPlan>): boolean {
  try {
    mkdirSync(dirname(DIET_FILE), { recursive: true });
    writeFileSync(DIET_FILE, JSON.stringify(store, null, 2));
    return true;
  } catch {
    // Filesystem write failure is non-fatal — in-memory cache is the fallback.
    return false;
  }
}

// ─── Anti-clobber: ler o store COMPLETO do Redis antes de gravar + serializar ─
// Bug crítico (a dieta de outros usuários sumia no deploy): saveDietPlan lia o
// store do ARQUIVO (efêmero no Render → vazio após deploy) e gravava { só esse
// usuário } por cima de todos no Redis. Mesma classe do memory/arena/user-access.
// Correção: lê o Redis (fonte de verdade) antes; se a leitura falha, NÃO grava no
// Redis (evita clobber); e as escritas são serializadas (sem corrida concorrente).
let dietWriteChain: Promise<void> = Promise.resolve();
function runDietSerialized(fn: () => Promise<void>): Promise<void> {
  const next = dietWriteChain.then(fn, fn);
  dietWriteChain = next.then(() => undefined, () => undefined);
  return next;
}

async function withRedisWriteLock(fn: () => Promise<void>): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return fn();
  const release = await acquireRedisWriteLock(redis);
  try {
    await fn();
  } finally {
    await release();
  }
}

async function readFullStoreForWrite(): Promise<{
  store: Record<string, DietPlan>;
  redisReadOk: boolean;
  localReadOk: boolean;
}> {
  const redis = getRedisClient();
  if (!redis) {
    if (!existsSync(DIET_FILE)) return { store: {}, redisReadOk: false, localReadOk: true };
    try {
      return {
        store: JSON.parse(readFileSync(DIET_FILE, "utf8")) as Record<string, DietPlan>,
        redisReadOk: false,
        localReadOk: true,
      };
    } catch {
      return { store: {}, redisReadOk: false, localReadOk: false };
    }
  }
  try {
    const raw = await redis.get(REDIS_KEY);
    const store = (raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {}) as Record<string, DietPlan>;
    Object.assign(inMemoryStore, store);
    return { store, redisReadOk: true, localReadOk: true };
  } catch {
    return { store: readFromFile(), redisReadOk: false, localReadOk: true };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getDietPlan(userId: string): Promise<DietPlan | null> {
  // 1. In-memory (fastest)
  if (inMemoryStore[userId]) return inMemoryStore[userId];

  // 2. Redis
  const redis = getRedisClient();
  if (redis) {
    try {
      const raw = await redis.get(REDIS_KEY);
      if (raw) {
        const store = typeof raw === "string" ? JSON.parse(raw) : raw;
        Object.assign(inMemoryStore, store);
        return (store as Record<string, DietPlan>)[userId] || null;
      }
    } catch {
      // fall through
    }
  }

  // 3. Filesystem
  const store = readFromFile();
  Object.assign(inMemoryStore, store);
  return store[userId] || null;
}

/**
 * Read the persisted plan without consulting the process-local cache first.
 * Long-running generation guards and student-facing reads use this so a coach
 * lock, edit, or deletion made by another instance is immediately visible.
 */
export async function readPersistedDietPlan(userId: string): Promise<DietPlan | null> {
  const redis = getRedisClient();
  if (redis) {
    const raw = await redis.get(REDIS_KEY);
    const store = (raw
      ? (typeof raw === "string" ? JSON.parse(raw) : raw)
      : {}) as Record<string, DietPlan>;
    if (store[userId]) inMemoryStore[userId] = store[userId];
    else delete inMemoryStore[userId];
    return store[userId] || null;
  }

  if (existsSync(DIET_FILE)) {
    const store = JSON.parse(readFileSync(DIET_FILE, "utf8")) as Record<string, DietPlan>;
    if (store[userId]) inMemoryStore[userId] = store[userId];
    else delete inMemoryStore[userId];
    return store[userId] || null;
  }

  delete inMemoryStore[userId];
  return null;
}

export async function saveDietPlan(plan: DietPlan): Promise<void> {
  plan.revision = randomUUID();
  return runDietSerialized(() => withRedisWriteLock(async () => {
    // Lê o store COMPLETO do Redis (não o arquivo efêmero) p/ não apagar outros.
    const { store, redisReadOk, localReadOk } = await readFullStoreForWrite();
    store[plan.userId] = plan;
    const redis = getRedisClient();
    if (redis) {
      if (!redisReadOk) {
        throw new Error("Redis diet store could not be read before save.");
      }
      await redis.set(REDIS_KEY, store);
      writeToFile(store);
      Object.assign(inMemoryStore, store);
      return;
    }
    if (!localReadOk) {
      throw new Error("Local diet store could not be read before save.");
    }
    if (!writeToFile(store)) {
      throw new Error("Diet plan could not be persisted to disk.");
    }
    Object.assign(inMemoryStore, store);
  }));
}

export function getDietPlanConcurrencyToken(plan: DietPlan | null | undefined): string {
  if (!plan) return "none";
  return JSON.stringify({
    revision: plan.revision || null,
    generatedAt: plan.generatedAt || null,
    updatedAt: plan.updatedAt || null,
    editedAt: plan.editedAt || null,
    lockedByCoach: Boolean(plan.lockedByCoach),
    manualOverride: Boolean(plan.manualOverride),
    source: plan.source || null,
    planSource: plan.planSource || null,
  });
}

export class DietPlanWriteConflictError extends Error {
  readonly code = "DIET_PLAN_CHANGED_DURING_GENERATION";

  constructor(message = "Diet plan changed while generation was in progress.") {
    super(message);
    this.name = "DietPlanWriteConflictError";
  }
}

export async function saveDietPlanIfUnchanged(
  plan: DietPlan,
  expectedToken: string,
  options: { allowLockedCurrent?: boolean } = {}
): Promise<void> {
  plan.revision = randomUUID();
  return runDietSerialized(() => withRedisWriteLock(async () => {
    const { store, redisReadOk, localReadOk } = await readFullStoreForWrite();
    // The freshly read persisted store is authoritative, including absence.
    // Falling back to a stale process cache here could resurrect a plan that
    // another instance or an admin deliberately removed.
    const current = Object.prototype.hasOwnProperty.call(store, plan.userId)
      ? store[plan.userId]
      : null;
    if (
      (current?.lockedByCoach && !options.allowLockedCurrent) ||
      getDietPlanConcurrencyToken(current) !== expectedToken
    ) {
      throw new DietPlanWriteConflictError();
    }

    store[plan.userId] = plan;
    const redis = getRedisClient();
    if (redis) {
      if (!redisReadOk) {
        throw new Error("Redis diet store could not be read before conditional commit.");
      }
      await redis.set(REDIS_KEY, store);
      inMemoryStore[plan.userId] = plan;
      writeToFile(store);
      return;
    }
    if (!localReadOk) {
      throw new Error("Local diet store could not be read before conditional commit.");
    }
    if (!writeToFile(store)) {
      throw new Error("Diet plan could not be persisted to disk.");
    }
    inMemoryStore[plan.userId] = plan;
  }));
}

export async function deleteDietPlanIfUnchanged(userId: string, expectedToken: string): Promise<void> {
  return runDietSerialized(() => withRedisWriteLock(async () => {
    const { store, redisReadOk, localReadOk } = await readFullStoreForWrite();
    const current = Object.prototype.hasOwnProperty.call(store, userId)
      ? store[userId]
      : null;
    if (getDietPlanConcurrencyToken(current) !== expectedToken) {
      throw new DietPlanWriteConflictError();
    }
    delete store[userId];
    const redis = getRedisClient();
    if (redis) {
      if (!redisReadOk) throw new Error("Redis diet store could not be read before conditional delete.");
      await redis.set(REDIS_KEY, store);
      writeToFile(store);
      delete inMemoryStore[userId];
      return;
    }
    if (!localReadOk) throw new Error("Local diet store could not be read before conditional delete.");
    if (!writeToFile(store)) throw new Error("Diet plan deletion could not be persisted to disk.");
    delete inMemoryStore[userId];
  }));
}

export async function deleteDietPlan(userId: string): Promise<void> {
  return runDietSerialized(() => withRedisWriteLock(async () => {
    const { store, redisReadOk, localReadOk } = await readFullStoreForWrite();
    delete store[userId];
    const redis = getRedisClient();
    if (redis) {
      if (!redisReadOk) {
        throw new Error("Redis diet store could not be read before delete.");
      }
      await redis.set(REDIS_KEY, store);
      writeToFile(store);
      delete inMemoryStore[userId];
      return;
    }
    if (!localReadOk) {
      throw new Error("Local diet store could not be read before delete.");
    }
    if (!writeToFile(store)) {
      throw new Error("Diet plan deletion could not be persisted to disk.");
    }
    delete inMemoryStore[userId];
  }));
}

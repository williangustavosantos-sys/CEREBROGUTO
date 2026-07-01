/**
 * GUTO Diet Store
 *
 * Armazena e recupera o plano de dieta semanal por userId.
 * Usa o mesmo mecanismo de persistência do memory-store (Redis → filesystem → in-memory).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { Redis } from "@upstash/redis";
import type { DietPlan } from "./nutrition.js";

const DIET_FILE = process.env.GUTO_DIET_FILE || join(process.cwd(), "data", "guto-diet.json");
const REDIS_KEY = "guto:diet";

// ─── In-memory cache ──────────────────────────────────────────────────────────

const inMemoryStore: Record<string, DietPlan> = {};

// ─── Redis client (lazy, same pattern as memory-store) ───────────────────────

type RedisClient = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<unknown>;
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

// ─── Filesystem helpers ───────────────────────────────────────────────────────

function readFromFile(): Record<string, DietPlan> {
  try {
    if (!existsSync(DIET_FILE)) return {};
    return JSON.parse(readFileSync(DIET_FILE, "utf8")) as Record<string, DietPlan>;
  } catch {
    return {};
  }
}

function writeToFile(store: Record<string, DietPlan>): void {
  try {
    mkdirSync(dirname(DIET_FILE), { recursive: true });
    writeFileSync(DIET_FILE, JSON.stringify(store, null, 2));
  } catch {
    // Filesystem write failure is non-fatal — in-memory cache is the fallback.
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

async function readFullStoreForWrite(): Promise<{ store: Record<string, DietPlan>; redisReadOk: boolean }> {
  const redis = getRedisClient();
  if (!redis) return { store: readFromFile(), redisReadOk: false };
  try {
    const raw = await redis.get(REDIS_KEY);
    const store = (raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {}) as Record<string, DietPlan>;
    Object.assign(inMemoryStore, store);
    return { store, redisReadOk: true };
  } catch {
    return { store: readFromFile(), redisReadOk: false };
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

export async function saveDietPlan(plan: DietPlan): Promise<void> {
  inMemoryStore[plan.userId] = plan; // cache imediato
  return runDietSerialized(async () => {
    // Lê o store COMPLETO do Redis (não o arquivo efêmero) p/ não apagar outros.
    const { store, redisReadOk } = await readFullStoreForWrite();
    store[plan.userId] = plan;
    Object.assign(inMemoryStore, store);
    const redis = getRedisClient();
    if (redis && redisReadOk) {
      try { await redis.set(REDIS_KEY, store); } catch { /* fs fallback */ }
    }
    writeToFile(store);
  });
}

export async function deleteDietPlan(userId: string): Promise<void> {
  delete inMemoryStore[userId];
  return runDietSerialized(async () => {
    const { store, redisReadOk } = await readFullStoreForWrite();
    delete store[userId];
    delete inMemoryStore[userId];
    const redis = getRedisClient();
    if (redis && redisReadOk) {
      try { await redis.set(REDIS_KEY, store); } catch { /* fs fallback */ }
    }
    writeToFile(store);
  });
}

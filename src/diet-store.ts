/**
 * GUTO Diet Store
 *
 * Armazena e recupera o plano de dieta semanal por userId.
 * Usa o mesmo mecanismo de persistência do memory-store (Redis → filesystem → in-memory).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import type { DietPlan } from "./nutrition.js";

const DIET_FILE = process.env.GUTO_DIET_FILE || join(process.cwd(), "data", "guto-diet.json");
const REDIS_KEY = "guto:diet";

// ─── In-memory cache ──────────────────────────────────────────────────────────

const inMemoryStore: Record<string, DietPlan> = {};

// ─── Redis client (lazy, same pattern as memory-store) ───────────────────────

let redisClient: {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<unknown>;
} | null = null;

function getRedisClient() {
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = require("@upstash/redis");
    redisClient = new Redis({ url, token }) as typeof redisClient;
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
    // Write atômico: escreve em temp, depois renomeia
    const tmpFile = DIET_FILE + ".tmp." + Date.now();
    writeFileSync(tmpFile, JSON.stringify(store, null, 2));
    renameSync(tmpFile, DIET_FILE);
  } catch {
    // Filesystem write failure is non-fatal — in-memory cache is the fallback.
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
  // Update in-memory
  inMemoryStore[plan.userId] = plan;

  // Read full store first (to avoid overwriting other users)
  const store = readFromFile();
  store[plan.userId] = plan;

  // Persist to Redis + filesystem
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(REDIS_KEY, store);
    } catch {
      // fall through to filesystem
    }
  }

  writeToFile(store);
}

export async function deleteDietPlan(userId: string): Promise<void> {
  delete inMemoryStore[userId];
  const store = readFromFile();
  delete store[userId];

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(REDIS_KEY, store);
    } catch {
      // fall through to filesystem
    }
  }

  writeToFile(store);
}

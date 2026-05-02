/**
 * GUTO Memory Store
 *
 * Production: Upstash Redis (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
 * Development / fallback: local JSON file (data/guto-memory.json)
 *
 * The layer is fully transparent — server.ts calls readMemoryStore / writeMemoryStore
 * exactly as before. Zero breaking change.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { config } from "./config";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MemoryStore = Record<string, unknown>;

// ─── Redis client (lazy) ──────────────────────────────────────────────────────

let redisClient: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<unknown> } | null = null;
const REDIS_KEY = "guto:memory";

function getRedisClient() {
  if (redisClient) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) return null;

  try {
    // Dynamic import so the module doesn't crash if not installed
    const { Redis } = require("@upstash/redis");
    redisClient = new Redis({ url, token }) as typeof redisClient;
    return redisClient;
  } catch {
    return null;
  }
}

// ─── In-memory fallback (when filesystem fails in prod without Redis) ─────────

const globalMemoryStore: MemoryStore = {};
let globalMemoryLoaded = false;

// ─── Filesystem helpers ───────────────────────────────────────────────────────

function readFromFile(): MemoryStore {
  try {
    if (!existsSync(config.memoryFile)) return {};
    return JSON.parse(readFileSync(config.memoryFile, "utf8")) as MemoryStore;
  } catch {
    return {};
  }
}

function writeToFile(store: MemoryStore): boolean {
  try {
    mkdirSync(dirname(config.memoryFile), { recursive: true });
    writeFileSync(config.memoryFile, JSON.stringify(store, null, 2));
    return true;
  } catch {
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read the full memory store.
 * Priority: Redis → filesystem → in-memory cache
 */
export async function readMemoryStoreAsync(): Promise<MemoryStore> {
  const redis = getRedisClient();

  if (redis) {
    try {
      const raw = await redis.get(REDIS_KEY);
      if (raw && typeof raw === "object") return raw as MemoryStore;
      if (typeof raw === "string") return JSON.parse(raw) as MemoryStore;
    } catch (err) {
      console.warn("[GUTO] Redis read failed, falling back to filesystem:", err);
    }
  }

  // Filesystem
  const fromFile = readFromFile();
  if (Object.keys(fromFile).length > 0) return fromFile;

  // In-memory (last resort)
  if (!globalMemoryLoaded) {
    globalMemoryLoaded = true;
  }
  return { ...globalMemoryStore };
}

/**
 * Write the full memory store.
 * Priority: Redis → filesystem → in-memory cache
 */
export async function writeMemoryStoreAsync(store: MemoryStore): Promise<void> {
  const redis = getRedisClient();

  if (redis) {
    try {
      await redis.set(REDIS_KEY, store);
      // Also try filesystem (nice to have, not required)
      writeToFile(store);
      return;
    } catch (err) {
      console.warn("[GUTO] Redis write failed, falling back to filesystem:", err);
    }
  }

  // Filesystem
  const wroteFile = writeToFile(store);
  if (wroteFile) return;

  // In-memory fallback (Vercel without Redis)
  console.warn("[GUTO] Filesystem unavailable — using in-memory store (data lost on restart)");
  Object.assign(globalMemoryStore, store);
}

/**
 * Synchronous read — uses in-memory cache or filesystem only.
 * Kept for backward compat with sync code paths. Prefer async version.
 */
export function readMemoryStoreSync(): MemoryStore {
  // In-memory first (already populated by a previous async read)
  if (Object.keys(globalMemoryStore).length > 0) return { ...globalMemoryStore };
  return readFromFile();
}

/**
 * Synchronous write — filesystem or in-memory only.
 */
export function writeMemoryStoreSync(store: MemoryStore): void {
  const wroteFile = writeToFile(store);
  if (!wroteFile) {
    Object.assign(globalMemoryStore, store);
  }
}

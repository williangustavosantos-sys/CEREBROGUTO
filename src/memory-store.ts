/**
 * GUTO Memory Store
 *
 * Production: Upstash Redis (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
 * Development / fallback: local JSON file (data/guto-memory.json)
 *
 * The layer is fully transparent — server.ts calls readMemoryStore / writeMemoryStore
 * exactly as before. Zero breaking change.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { dirname, join } from "path";
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
    // Write atômico: escreve em temp, depois renomeia
    // Isso evita corrupção se 2 processos escreverem simultaneamente
    const tmpFile = config.memoryFile + ".tmp." + Date.now();
    writeFileSync(tmpFile, JSON.stringify(store, null, 2));
    renameSync(tmpFile, config.memoryFile);
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
      if (raw) {
        const store = typeof raw === "string" ? JSON.parse(raw) : raw;
        Object.assign(globalMemoryStore, store);
        return store as MemoryStore;
      }
    } catch (err) {
      console.warn("[GUTO] Redis read failed, falling back to filesystem:", err);
    }
  }

  // Filesystem
  const fromFile = readFromFile();
  if (Object.keys(fromFile).length > 0) {
    Object.assign(globalMemoryStore, fromFile);
    return fromFile;
  }

  // In-memory (last resort)
  return { ...globalMemoryStore };
}

/**
 * Write the full memory store.
 */
export async function writeMemoryStoreAsync(store: MemoryStore): Promise<void> {
  // Clear the in-memory cache to ensure a full replacement (especially for nuke/reset)
  for (const key in globalMemoryStore) {
    delete globalMemoryStore[key];
  }
  Object.assign(globalMemoryStore, store);

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(REDIS_KEY, store);
      writeToFile(store);
      return;
    } catch (err) {
      console.warn("[GUTO] Redis write failed, falling back to filesystem:", err);
    }
  }

  writeToFile(store);
}

/**
 * Synchronous read — uses in-memory cache or filesystem only.
 */
export function readMemoryStoreSync(): MemoryStore {
  const fromFile = readFromFile();
  if (Object.keys(fromFile).length > 0) {
    Object.assign(globalMemoryStore, fromFile);
    return fromFile;
  }
  return { ...globalMemoryStore };
}

/**
 * Synchronous write — filesystem or in-memory only.
 */
export function writeMemoryStoreSync(store: MemoryStore): void {
  // Clear the in-memory cache to ensure a full replacement
  for (const key in globalMemoryStore) {
    delete globalMemoryStore[key];
  }
  Object.assign(globalMemoryStore, store);
  writeToFile(store);
}

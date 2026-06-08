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
  // Hard guard: tests must NEVER touch production Redis.
  // Checked on every call (not cached) so the flag is honored even when env vars
  // are set later via dotenv after the module is imported.
  if (
    process.env.NODE_ENV === "test" ||
    process.env.GUTO_DISABLE_REDIS_FOR_TESTS === "1"
  ) {
    return null;
  }

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

// ─── Anti-clobber: hidratação no boot + escrita por-usuário serializada ───────
// Bug crítico (a memória/calibragem do usuário sumia a cada deploy/cold-start):
// saveMemory lia o store SYNC (vazio no boot do Render, pois readMemoryStoreSync
// só lê o arquivo efêmero) e gravava um store PARCIAL por cima de todos no Redis,
// apagando a memória dos outros usuários. (README: "Memória no GUTO é confiança.")
// Correção: (1) bootstrap hidrata o cache do Redis no init; (2) persistUserMemory
// grava de forma SERIALIZADA e só DEPOIS da hidratação, re-aplicando a memória do
// usuário sobre o store já hidratado — nunca apaga a dos outros.
let memHydrated = false;
let memHydrationPromise: Promise<void> | null = null;

export function ensureMemoryHydrated(): Promise<void> {
  if (memHydrated || !getRedisClient()) return Promise.resolve();
  if (!memHydrationPromise) {
    memHydrationPromise = readMemoryStoreAsync()
      .then(() => { memHydrated = true; })
      .catch(() => { memHydrationPromise = null; });
  }
  return memHydrationPromise;
}

let memWriteChain: Promise<void> = Promise.resolve();

export function persistUserMemory(userId: string, memory: unknown): void {
  globalMemoryStore[userId] = memory;       // cache imediato p/ leituras sync
  writeToFile(globalMemoryStore);
  const redis = getRedisClient();
  if (!redis) return;
  memWriteChain = memWriteChain
    .then(async () => {
      await ensureMemoryHydrated();           // cache passa a refletir o Redis (full)
      if (!memHydrated) return;               // Redis indisponível: não arrisca clobber
      globalMemoryStore[userId] = memory;     // re-aplica sobre o store hidratado
      await redis.set(REDIS_KEY, globalMemoryStore);
      writeToFile(globalMemoryStore);
    })
    .catch((err) => {
      // Antes era silenciado: uma falha de escrita no Redis sumia sem rastro,
      // contradizendo "memória é confiança". Alinha com o console.warn já usado
      // nos caminhos de leitura/escrita acima.
      console.warn("[GUTO] Redis memory write failed (async write chain):", err);
    });
}

// Bootstrap: hidrata o cache no init do módulo (encolhe a janela de clobber p/ TODOS
// os caminhos, pois readMemoryStoreSync passa a devolver o cache cheio).
void ensureMemoryHydrated();

/**
 * Clear the in-memory cache. Use in tests to prevent state leaking between test cases.
 */
export function clearMemoryStoreCache(): void {
  for (const key in globalMemoryStore) {
    delete globalMemoryStore[key];
  }
}

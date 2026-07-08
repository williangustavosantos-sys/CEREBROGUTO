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
import { Redis } from "@upstash/redis";
import { config } from "./config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MemoryStore = Record<string, unknown>;

// ─── Redis client (lazy) ──────────────────────────────────────────────────────

type RedisClient = { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<unknown> };
let redisClient: RedisClient | null = null;
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
    redisClient = new Redis({ url, token }) as unknown as RedisClient;
    return redisClient;
  } catch {
    return null;
  }
}

// ─── In-memory fallback (when filesystem fails in prod without Redis) ─────────

const globalMemoryStore: MemoryStore = {};
let globalMemoryLoaded = false;

function cloneStoreValue<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function mergeStringList(existing: unknown, incoming: unknown): unknown {
  const values = [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return Array.from(new Set(values)).sort();
}

function eventKey(event: unknown): string {
  if (!isRecord(event)) return JSON.stringify(event);
  const id = typeof event.id === "string" ? event.id : "";
  if (id) return id;
  return JSON.stringify({
    type: event.type,
    date: event.date,
    amount: event.amount,
    createdAt: event.createdAt,
  });
}

function mergeXpEvents(existing: unknown, incoming: unknown): unknown[] {
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const event of [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ]) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged;
}

function eventAmount(event: unknown): number {
  if (!isRecord(event)) return 0;
  const amount = event.amount;
  return typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
}

function hasAllEventKeys(source: unknown, target: unknown): boolean {
  if (!Array.isArray(target) || target.length === 0) return true;
  if (!Array.isArray(source)) return false;
  const sourceKeys = new Set(source.map(eventKey));
  return target.every((event) => sourceKeys.has(eventKey(event)));
}

function hasNewNegativeEvent(source: unknown, target: unknown): boolean {
  if (!Array.isArray(source)) return false;
  const targetKeys = new Set(Array.isArray(target) ? target.map(eventKey) : []);
  return source.some((event) => !targetKeys.has(eventKey(event)) && eventAmount(event) < 0);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mergeProtectedUserMemorySnapshot(existing: unknown, incoming: unknown): unknown {
  if (!isRecord(existing) || !isRecord(incoming)) return incoming;

  const merged: Record<string, unknown> = { ...existing, ...incoming };

  const existingRevokedAt = toTime(existing.consentRevokedAt);
  const incomingAcceptedAt = toTime(incoming.consentAcceptedAt);
  const incomingConsented = incoming.consentHealthFitness === true && incoming.acceptedTerms === true;
  if (incomingConsented) {
    merged.consentHealthFitness = true;
    merged.acceptedTerms = true;
    delete merged.consentRevokedAt;
  } else if (existingRevokedAt !== null && (incomingAcceptedAt === null || existingRevokedAt > incomingAcceptedAt)) {
    merged.consentHealthFitness = false;
    merged.acceptedTerms = false;
    merged.consentRevokedAt = existing.consentRevokedAt;
  } else {
    if (existing.consentHealthFitness === true || incoming.consentHealthFitness === true) {
      merged.consentHealthFitness = true;
    }
    if (existing.acceptedTerms === true || incoming.acceptedTerms === true) {
      merged.acceptedTerms = true;
    }
    if (typeof existing.consentAcceptedAt === "string" && typeof incoming.consentAcceptedAt !== "string") {
      merged.consentAcceptedAt = existing.consentAcceptedAt;
    }
  }

  if (existing.initialXpGranted === true || incoming.initialXpGranted === true) {
    merged.initialXpGranted = true;
  }
  if (existing.initialXpRewardSeen === true || incoming.initialXpRewardSeen === true) {
    merged.initialXpRewardSeen = true;
  }

  const xpEvents = mergeXpEvents(existing.xpEvents, incoming.xpEvents);
  if (xpEvents.length > 0) {
    merged.xpEvents = xpEvents;
  }

  const existingTotal = numberValue(existing.totalXp);
  const incomingTotal = numberValue(incoming.totalXp);
  const eventTotal: number | null = xpEvents.length > 0
    ? xpEvents.reduce<number>((sum, event) => sum + eventAmount(event), 0)
    : null;
  const incomingContainsExistingEvents = hasAllEventKeys(incoming.xpEvents, existing.xpEvents);
  if (incomingContainsExistingEvents && hasNewNegativeEvent(incoming.xpEvents, existing.xpEvents) && incomingTotal !== null) {
    merged.totalXp = incomingTotal;
  } else {
    merged.totalXp = Math.max(existingTotal ?? 0, incomingTotal ?? 0, eventTotal ?? 0);
  }

  for (const field of ["lastWorkoutPlan", "weeklyWorkoutPlan", "weeklyDietPlan"]) {
    if ((incoming[field] === null || incoming[field] === undefined) && existing[field] !== null && existing[field] !== undefined) {
      merged[field] = existing[field];
    }
  }

  const existingDietStatus = typeof existing.dietGenerationStatus === "string" ? existing.dietGenerationStatus : "";
  const incomingDietStatus = typeof incoming.dietGenerationStatus === "string" ? incoming.dietGenerationStatus : "";
  if (existingDietStatus === "generated" && (!incomingDietStatus || ["idle", "ready_to_generate", "generating"].includes(incomingDietStatus))) {
    merged.dietGenerationStatus = "generated";
  }

  for (const field of ["completedWorkoutDates", "adaptedMissionDates", "missedMissionDates"]) {
    const list = mergeStringList(existing[field], incoming[field]);
    if (Array.isArray(list) && list.length > 0) merged[field] = list;
  }

  return merged;
}

function replaceGlobalMemoryStore(store: MemoryStore): void {
  for (const key in globalMemoryStore) {
    delete globalMemoryStore[key];
  }
  Object.assign(globalMemoryStore, store);
}

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
        replaceGlobalMemoryStore(store as MemoryStore);
        return store as MemoryStore;
      }
    } catch (err) {
      console.warn("[GUTO] Redis read failed, falling back to filesystem:", err);
    }
  }

  // Filesystem
  const fromFile = readFromFile();
  if (Object.keys(fromFile).length > 0) {
    replaceGlobalMemoryStore(fromFile);
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
  // In serverless production, data/guto-memory.json is a build artifact. When
  // Redis is configured, sync reads must use the already-hydrated cache instead
  // of that packaged file, or newly calibrated users appear to lose their
  // profile on the next request.
  if (getRedisClient()) {
    return { ...globalMemoryStore };
  }

  const fromFile = readFromFile();
  if (Object.keys(fromFile).length > 0) {
    replaceGlobalMemoryStore(fromFile);
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

export function persistUserMemory(userId: string, memory: unknown): Promise<void> {
  const snapshot = cloneStoreValue(memory);
  globalMemoryStore[userId] = mergeProtectedUserMemorySnapshot(globalMemoryStore[userId], snapshot); // cache imediato p/ leituras sync
  writeToFile(globalMemoryStore);
  const redis = getRedisClient();
  if (!redis) return Promise.resolve();
  memWriteChain = memWriteChain
    .then(async () => {
      await readMemoryStoreAsync();           // cache passa a refletir o Redis atual (full)
      memHydrated = true;
      if (!memHydrated) return;               // Redis indisponível: não arrisca clobber
      globalMemoryStore[userId] = mergeProtectedUserMemorySnapshot(globalMemoryStore[userId], snapshot); // re-aplica sobre o store hidratado
      await redis.set(REDIS_KEY, cloneStoreValue(globalMemoryStore));
      writeToFile(globalMemoryStore);
    })
    .catch((err) => {
      // Antes era silenciado: uma falha de escrita no Redis sumia sem rastro,
      // contradizendo "memória é confiança". Alinha com o console.warn já usado
      // nos caminhos de leitura/escrita acima.
      console.warn("[GUTO] Redis memory write failed (async write chain):", err);
    });
  return memWriteChain;
}

export function flushMemoryStoreWrites(): Promise<void> {
  return memWriteChain;
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

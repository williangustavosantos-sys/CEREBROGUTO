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
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { config } from "./config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MemoryStore = Record<string, unknown>;

// ─── Redis client (lazy) ──────────────────────────────────────────────────────

type RedisClient = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options?: { nx: true; px: number }) => Promise<unknown>;
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
};
let redisClient: RedisClient | null = null;
let redisClientOverrideForTests: RedisClient | null | undefined;
const REDIS_KEY = "guto:memory";
const REDIS_WRITE_LOCK_KEY = "guto:memory:write-lock:v1";
const REDIS_WRITE_LOCK_TTL_MS = 15_000;
const REDIS_WRITE_LOCK_WAIT_MS = 20_000;
const REDIS_WRITE_MAX_ATTEMPTS = 3;

class RedisMemoryWriteLeaseLostError extends Error {
  constructor() {
    super("Redis memory write lease expired before commit.");
    this.name = "RedisMemoryWriteLeaseLostError";
  }
}

function getRedisClient() {
  if (redisClientOverrideForTests !== undefined) return redisClientOverrideForTests;
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

export function setMemoryStoreRedisClientForTests(client: RedisClient | null | undefined): void {
  if (process.env.NODE_ENV !== "test" && process.env.GUTO_DISABLE_REDIS_FOR_TESTS !== "1") {
    throw new Error("Redis test override is only available when NODE_ENV=test.");
  }
  redisClientOverrideForTests = client;
  memHydrated = false;
  memHydrationPromise = null;
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireRedisWriteLock(redis: RedisClient): Promise<{
  token: string;
  release: () => Promise<void>;
}> {
  const token = randomUUID();
  const deadline = Date.now() + REDIS_WRITE_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const acquired = await redis.set(REDIS_WRITE_LOCK_KEY, token, {
      nx: true,
      px: REDIS_WRITE_LOCK_TTL_MS,
    });
    if (acquired === "OK") {
      return {
        token,
        release: async () => {
          try {
            await redis.eval(
              'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
              [REDIS_WRITE_LOCK_KEY],
              [token]
            );
          } catch (error) {
            console.warn("[GUTO] Failed to release Redis memory write lock:", error);
          }
        },
      };
    }
    await waitFor(50);
  }
  throw new Error("Timed out waiting for the Redis memory write lock.");
}

export async function acquireDistributedUserLease(
  scope: string,
  userId: string,
  options: { ttlMs?: number; waitMs?: number } = {}
): Promise<{ waited: boolean; release: () => Promise<void> }> {
  const redis = getRedisClient();
  if (!redis) return { waited: false, release: async () => {} };

  const token = randomUUID();
  const leaseKey = `guto:lease:${encodeURIComponent(scope)}:${encodeURIComponent(userId)}`;
  const ttlMs = Math.max(5_000, options.ttlMs || 90_000);
  const deadline = Date.now() + Math.max(1_000, options.waitMs || ttlMs + 5_000);
  let waited = false;
  while (Date.now() < deadline) {
    const acquired = await redis.set(leaseKey, token, { nx: true, px: ttlMs });
    if (acquired === "OK") {
      return {
        waited,
        release: async () => {
          try {
            await redis.eval(
              'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
              [leaseKey],
              [token]
            );
          } catch (error) {
            console.warn(`[GUTO] Failed to release distributed user lease (${scope}):`, error);
          }
        },
      };
    }
    waited = true;
    await waitFor(75);
  }
  throw new Error(`Timed out waiting for distributed user lease (${scope}).`);
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

function hasMeaningfulMemoryValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function hasProtectedMemoryValue(field: string, value: unknown): boolean {
  if (field === "biologicalSex") return value === "female" || value === "male";
  return hasMeaningfulMemoryValue(value);
}

function hasOwnField(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function isCoachLockedWorkoutSnapshot(value: unknown): boolean {
  return isRecord(value) && value.lockedByCoach === true;
}

function mergeProtectedUserMemorySnapshot(existing: unknown, incoming: unknown): unknown {
  if (!isRecord(existing) || !isRecord(incoming)) return incoming;

  const merged: Record<string, unknown> = { ...existing, ...incoming };
  delete merged.phone;
  const countryChanged =
    hasMeaningfulMemoryValue(incoming.country) &&
    hasMeaningfulMemoryValue(existing.country) &&
    incoming.country !== existing.country;
  const workoutProfileChanged = [
    "userAge",
    "biologicalSex",
    "heightCm",
    "weightKg",
    "trainingLevel",
    "trainingStatus",
    "trainingGoal",
    "trainingSchedule",
    "trainingLocation",
    "preferredTrainingLocation",
    "trainingPathology",
    "trainingLimitations",
  ].some((field) =>
    hasOwnField(incoming, field) &&
    hasProtectedMemoryValue(field, incoming[field]) &&
    incoming[field] !== existing[field]
  );

  for (const field of [
    "userAge",
    "biologicalSex",
    "trainingLevel",
    "trainingStatus",
    "trainingGoal",
    "preferredTrainingLocation",
    "trainingPathology",
    "trainingLimitations",
    "country",
    "countryCode",
    "city",
    "heightCm",
    "weightKg",
    "foodRestrictions",
    "resolvedFields",
  ]) {
    if (field === "countryCode" && countryChanged && !hasProtectedMemoryValue(field, incoming[field])) {
      delete merged[field];
      continue;
    }
    if (!hasProtectedMemoryValue(field, incoming[field]) && hasProtectedMemoryValue(field, existing[field])) {
      merged[field] = existing[field];
    } else if (!hasProtectedMemoryValue(field, incoming[field]) && !hasProtectedMemoryValue(field, existing[field])) {
      delete merged[field];
    }
  }

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
    if (
      field === "lastWorkoutPlan" &&
      incoming[field] === null &&
      workoutProfileChanged &&
      !isCoachLockedWorkoutSnapshot(existing[field])
    ) {
      merged[field] = null;
      continue;
    }
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

export function mergeFetchedMemoryStoreWithCache(fetched: MemoryStore, cache: MemoryStore): MemoryStore {
  const merged: MemoryStore = { ...fetched };
  for (const [userId, cachedSnapshot] of Object.entries(cache)) {
    if (!isRecord(fetched[userId])) continue;
    merged[userId] = mergeProtectedUserMemorySnapshot(fetched[userId], cachedSnapshot);
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
  // Let locally queued writes settle before hydrating. Once settled, Redis is
  // authoritative; overlaying an arbitrary historical cache here could undo a
  // profile/mission change made by another instance.
  await memWriteChain;
  const redis = getRedisClient();

  if (redis) {
    try {
      const raw = await redis.get(REDIS_KEY);
      const store = (raw
        ? (typeof raw === "string" ? JSON.parse(raw) : raw)
        : {}) as MemoryStore;
      replaceGlobalMemoryStore(store);
      return store;
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
 * Read one user's persisted snapshot without merging the process-local cache.
 *
 * Conditional/long-running workflows (for example diet generation) use this
 * to detect a profile update made by another request or instance. The normal
 * read path deliberately protects cached fields while hydrating; that is the
 * right default for continuity, but it would hide a concurrent persisted
 * change from an optimistic-concurrency guard.
 */
export async function readPersistedUserMemorySnapshot(userId: string): Promise<unknown> {
  const redis = getRedisClient();
  if (redis) {
    // A Redis read failure must remain observable. Falling back to a packaged
    // or partial local file here could falsely authorize a stale commit.
    const raw = await redis.get(REDIS_KEY);
    const store = (raw
      ? (typeof raw === "string" ? JSON.parse(raw) : raw)
      : {}) as MemoryStore;
    return cloneStoreValue(store[userId]);
  }

  if (existsSync(config.memoryFile)) {
    const store = JSON.parse(readFileSync(config.memoryFile, "utf8")) as MemoryStore;
    return cloneStoreValue(store[userId]);
  }

  return cloneStoreValue(globalMemoryStore[userId]);
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
      await mutateRedisMemoryStore(redis, (current) => {
        for (const key in current) delete current[key];
        Object.assign(current, cloneStoreValue(store));
      });
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

async function withRedisWriteLock(redis: RedisClient, fn: (token: string) => Promise<void>): Promise<void> {
  const lease = await acquireRedisWriteLock(redis);
  try {
    await fn(lease.token);
  } finally {
    await lease.release();
  }
}

async function commitMemoryStoreWhileLeaseOwned(
  redis: RedisClient,
  token: string,
  store: MemoryStore
): Promise<void> {
  const committed = await redis.eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("set", KEYS[2], ARGV[2]); return 1 else return 0 end',
    [REDIS_WRITE_LOCK_KEY, REDIS_KEY],
    [token, JSON.stringify(cloneStoreValue(store))]
  );
  if (Number(committed) !== 1) throw new RedisMemoryWriteLeaseLostError();
}

async function mutateRedisMemoryStore(
  redis: RedisClient,
  mutate: (store: MemoryStore) => Promise<void> | void
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= REDIS_WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await withRedisWriteLock(redis, async (token) => {
        await hydrateMemoryStoreFromRedisForWrite(redis);
        await mutate(globalMemoryStore);
        await commitMemoryStoreWhileLeaseOwned(redis, token, globalMemoryStore);
        writeToFile(globalMemoryStore);
      });
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof RedisMemoryWriteLeaseLostError) || attempt === REDIS_WRITE_MAX_ATTEMPTS) {
        throw error;
      }
      await waitFor(25 * attempt);
    }
  }
  throw lastError;
}

async function hydrateMemoryStoreFromRedisForWrite(redis: RedisClient): Promise<void> {
  // Escrita do store inteiro só é segura depois de uma leitura Redis bem-sucedida.
  // `readMemoryStoreAsync` possui fallback local por design; usá-lo aqui fazia
  // GET Redis falhar + SET Redis funcionar apagar usuários ausentes no fallback.
  const raw = await redis.get(REDIS_KEY);
  const remoteStore = (raw
    ? (typeof raw === "string" ? JSON.parse(raw) : raw)
    : {}) as MemoryStore;
  // The persisted store is authoritative while holding the distributed write
  // lock. Only the caller's snapshot/patch is re-applied afterwards; merging
  // every cached user here could resurrect stale data from another instance.
  replaceGlobalMemoryStore(remoteStore);
  memHydrated = true;
}

export function persistUserMemory(userId: string, memory: unknown): Promise<void> {
  const snapshot = cloneStoreValue(memory);
  globalMemoryStore[userId] = mergeProtectedUserMemorySnapshot(globalMemoryStore[userId], snapshot); // cache imediato p/ leituras sync
  const wroteLocalSnapshot = writeToFile(globalMemoryStore);
  const redis = getRedisClient();
  if (!redis) {
    const localWrite = wroteLocalSnapshot
      ? Promise.resolve()
      : Promise.reject(new Error("GUTO memory snapshot could not be persisted to disk."));
    void localWrite.catch((err) => {
      console.warn("[GUTO] Local memory write failed:", err);
    });
    return localWrite;
  }

  // `writeOperation` mantém a falha observável para os poucos caminhos que
  // precisam confirmar um commit antes de responder (ex.: primeira missão).
  // `memWriteChain` continua resiliente para que uma falha não envenene todas
  // as gravações seguintes. Assim, callers legados podem ignorar a Promise sem
  // gerar unhandled rejection, enquanto callers atômicos podem usar `await`.
  const writeOperation = memWriteChain.then(() => mutateRedisMemoryStore(redis, async () => {
    globalMemoryStore[userId] = mergeProtectedUserMemorySnapshot(globalMemoryStore[userId], snapshot); // re-aplica sobre o store hidratado
  }));
  memWriteChain = writeOperation.catch((err) => {
    // Antes era silenciado: uma falha de escrita no Redis sumia sem rastro,
    // contradizendo "memória é confiança". Alinha com o console.warn já usado
    // nos caminhos de leitura/escrita acima.
    console.warn("[GUTO] Redis memory write failed (async write chain):", err);
  });
  return writeOperation;
}

export type UserMemoryListAppend = {
  field: string;
  value: unknown;
  maxItems?: number;
};

/**
 * Persist only selected fields on top of the latest stored user snapshot.
 * Used by long-running workflows so a terminal status write cannot roll back
 * profile data that changed while the workflow was running.
 */
export function persistUserMemoryPatch(
  userId: string,
  patch: Record<string, unknown>,
  listAppends: UserMemoryListAppend[] = [],
  options: { requireExisting?: boolean } = {}
): Promise<void> {
  const patchSnapshot = cloneStoreValue(patch);
  const appendSnapshots = cloneStoreValue(listAppends);

  const applyPatch = (store: MemoryStore) => {
    if (options.requireExisting && !isRecord(store[userId])) {
      throw new Error(`Cannot patch missing GUTO memory (${userId}).`);
    }
    const current = isRecord(store[userId]) ? cloneStoreValue(store[userId]) : {};
    const next: Record<string, unknown> = { ...current, ...patchSnapshot };
    for (const append of appendSnapshots) {
      const existing = Array.isArray(next[append.field]) ? next[append.field] as unknown[] : [];
      const values = [...existing, cloneStoreValue(append.value)];
      next[append.field] = typeof append.maxItems === "number" && append.maxItems > 0
        ? values.slice(-append.maxItems)
        : values;
    }
    store[userId] = next;
    globalMemoryStore[userId] = cloneStoreValue(next);
  };

  const redis = getRedisClient();
  const writeOperation = memWriteChain.then(async () => {
    if (redis) {
      await mutateRedisMemoryStore(redis, async () => {
        applyPatch(globalMemoryStore);
      });
      return;
    }

    const store = existsSync(config.memoryFile)
      ? JSON.parse(readFileSync(config.memoryFile, "utf8")) as MemoryStore
      : cloneStoreValue(globalMemoryStore);
    applyPatch(store);
    if (!writeToFile(store)) {
      throw new Error("GUTO memory patch could not be persisted to disk.");
    }
  });
  memWriteChain = writeOperation.catch((error) => {
    console.warn("[GUTO] Memory patch write failed:", error);
  });
  return writeOperation;
}

/**
 * Run a per-user read/modify/write while holding both the local queue and the
 * Redis-wide store lock. This is the safe replacement for callers that used to
 * read the whole map and later write that stale snapshot back.
 */
export async function updateUserMemoryAtomically<T>(
  userId: string,
  updater: (current: unknown) => T | null | Promise<T | null>
): Promise<T | null> {
  let result: T | null = null;
  const redis = getRedisClient();
  const writeOperation = memWriteChain.then(async () => {
    const updateStore = async (store: MemoryStore) => {
      const current = cloneStoreValue(store[userId]);
      result = await updater(current);
      if (result === null) delete store[userId];
      else store[userId] = cloneStoreValue(result);
      if (result === null) delete globalMemoryStore[userId];
      else globalMemoryStore[userId] = cloneStoreValue(result);
    };

    if (redis) {
      await mutateRedisMemoryStore(redis, async () => {
        await updateStore(globalMemoryStore);
      });
      return;
    }

    const store = existsSync(config.memoryFile)
      ? JSON.parse(readFileSync(config.memoryFile, "utf8")) as MemoryStore
      : cloneStoreValue(globalMemoryStore);
    await updateStore(store);
    if (!writeToFile(store)) {
      throw new Error("Atomic GUTO user memory update could not be persisted to disk.");
    }
  });
  memWriteChain = writeOperation.catch((error) => {
    console.warn("[GUTO] Atomic user memory update failed:", error);
  });
  await writeOperation;
  return result;
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

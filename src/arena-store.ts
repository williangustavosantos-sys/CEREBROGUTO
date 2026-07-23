import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { config } from "./config.js";
import type { GutoEvolutionStage } from "./guto-evolution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARENA_STORE_PATH = path.join(__dirname, "../tmp/arena-store.json");

export type AvatarStage = GutoEvolutionStage;

export interface ArenaProfile {
  userId: string;
  displayName: string;
  pairName: string;
  arenaGroupId: string;
  avatarStage: AvatarStage;
  totalXp: number;
  weeklyXp: number;
  monthlyXp: number;
  validatedWorkoutsTotal: number;
  validatedWorkoutsWeek: number;
  validatedWorkoutsMonth: number;
  currentStreak: number;
  lastWorkoutValidatedAt: string | null;
  // Âncora genérica da última atividade registrada (pacto/bônus, treino,
  // missão adaptada, penalidade). Dirige o reset preguiçoso de weekly/monthly
  // mesmo quando a atividade não altera o período, como o buffer do Pacto.
  // Opcional para compat com perfis antigos (fallback p/ lastWorkoutValidatedAt).
  lastXpAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArenaXpEvent {
  id: string;
  userId: string;
  arenaGroupId: string;
  type: "workout_validated" | "reduced_mission_validated" | "workout_completion_delta" | "bonus" | "miss_penalty";
  xp: number;
  workoutFocus?: string;
  sourceValidationId?: string;
  createdAt: string;
}

export interface ArenaStore {
  profiles: Record<string, ArenaProfile>;
  events: ArenaXpEvent[];
  schemaVersion?: number;
}

const ARENA_STORE_SCHEMA_VERSION = 4;

function sameWeek(dateA: Date, dateB: Date): boolean {
  const monday = (date: Date) => {
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(date.getFullYear(), date.getMonth(), diff).getTime();
  };
  return monday(dateA) === monday(dateB);
}

function sameMonth(dateA: Date, dateB: Date): boolean {
  return dateA.getFullYear() === dateB.getFullYear() && dateA.getMonth() === dateB.getMonth();
}

/** v4 mantém o bônus do Pacto apenas no saldo geral, sem inflar semana/mês. */
export function migrateArenaStoreToCurrentSchema(store: ArenaStore, now: Date = new Date()): ArenaStore {
  if ((store.schemaVersion ?? 1) >= ARENA_STORE_SCHEMA_VERSION) return store;

  // v2 já excluía o bônus dos períodos. v1 e v3 o contavam; removemos somente
  // nesses schemas para não subtrair duas vezes. A migração é idempotente.
  if (store.schemaVersion !== 2) {
    for (const profile of Object.values(store.profiles)) {
      const bonusEvents = store.events.filter((event) => event.userId === profile.userId && event.type === "bonus");
      const weeklyBonus = bonusEvents.reduce((sum, event) => {
        const createdAt = new Date(event.createdAt);
        return !Number.isNaN(createdAt.getTime()) && sameWeek(createdAt, now) ? sum + event.xp : sum;
      }, 0);
      const monthlyBonus = bonusEvents.reduce((sum, event) => {
        const createdAt = new Date(event.createdAt);
        return !Number.isNaN(createdAt.getTime()) && sameMonth(createdAt, now) ? sum + event.xp : sum;
      }, 0);

      profile.weeklyXp = Math.max(0, profile.weeklyXp - weeklyBonus);
      profile.monthlyXp = Math.max(0, profile.monthlyXp - monthlyBonus);
    }
  }

  store.schemaVersion = ARENA_STORE_SCHEMA_VERSION;
  return store;
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
let memCache: ArenaStore = { profiles: {}, events: [], schemaVersion: ARENA_STORE_SCHEMA_VERSION };

// ─── Redis helpers ────────────────────────────────────────────────────────────
const REDIS_KEY = "guto:arena";
const REDIS_WRITE_LOCK_KEY = "guto:arena:write-lock:v1";
const REDIS_WRITE_LOCK_TTL_MS = 15_000;
const REDIS_WRITE_LOCK_WAIT_MS = 20_000;

type ArenaRedisClient = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options?: { nx: true; px: number }) => Promise<unknown>;
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
};

let redisClient: ArenaRedisClient | null = null;
let redisClientOverrideForTests: ArenaRedisClient | null | undefined;

function getRedisClient(): ArenaRedisClient | null {
  if (redisClientOverrideForTests !== undefined) return redisClientOverrideForTests;
  // Tests must never touch the production database, even when dotenv loaded it.
  if (process.env.NODE_ENV === "test" || process.env.GUTO_DISABLE_REDIS_FOR_TESTS === "1") return null;
  if (redisClient) return redisClient;
  if (!config.upstashRedisUrl || !config.upstashRedisToken) return null;
  redisClient = new Redis({
    url: config.upstashRedisUrl,
    token: config.upstashRedisToken,
  }) as unknown as ArenaRedisClient;
  return redisClient;
}

export function setArenaStoreRedisClientForTests(client: ArenaRedisClient | null | undefined): void {
  if (process.env.NODE_ENV !== "test" && process.env.GUTO_DISABLE_REDIS_FOR_TESTS !== "1") {
    throw new Error("Arena Redis test override is only available in tests.");
  }
  redisClientOverrideForTests = client;
}

function useRedis(): boolean {
  return getRedisClient() !== null;
}

function cloneStore(store: ArenaStore): ArenaStore {
  return JSON.parse(JSON.stringify(store)) as ArenaStore;
}

function parseRedisStore(raw: unknown): ArenaStore | null {
  if (!raw) return null;
  let parsed: unknown = raw;
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  if (!parsed || typeof parsed !== "object" || !("profiles" in parsed)) return null;
  return migrateArenaStoreToCurrentSchema(parsed as ArenaStore);
}

function writeLocalSnapshot(store: ArenaStore): void {
  memCache = store;
  try {
    fs.mkdirSync(path.dirname(ARENA_STORE_PATH), { recursive: true });
    fs.writeFileSync(ARENA_STORE_PATH, JSON.stringify(store, null, 2));
  } catch {
    // Redis/memCache remain authoritative in serverless production.
  }
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireRedisWriteLock(redis: ArenaRedisClient): Promise<() => Promise<void>> {
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
          console.warn("[GUTO] Failed to release Redis arena write lock:", error);
        }
      };
    }
    await waitFor(50);
  }
  throw new Error("Timed out waiting for the Redis arena write lock.");
}

// ─── Async store (Redis → file) ───────────────────────────────────────────────

/**
 * Read from Redis first, falling back to the local file.
 * Warms up memCache so subsequent sync reads work correctly after a cold start.
 */
export async function readArenaStoreAsync(): Promise<ArenaStore> {
  await arenaWriteChain;
  const redis = getRedisClient();
  if (redis) {
    try {
      const store = parseRedisStore(await redis.get(REDIS_KEY));
      if (store) {
        writeLocalSnapshot(store);
        return memCache;
      }
    } catch (error) {
      console.warn("[GUTO] Redis arena read failed, falling back to local snapshot:", error);
      // fall through to file
    }
  }
  try {
    if (fs.existsSync(ARENA_STORE_PATH)) {
      const fromFile = JSON.parse(fs.readFileSync(ARENA_STORE_PATH, "utf-8")) as ArenaStore;
      writeLocalSnapshot(migrateArenaStoreToCurrentSchema(fromFile));
    }
  } catch {
    // ignore — return whatever is in memCache
  }
  return memCache;
}

// ─── Sync store (memCache → file fallback) ────────────────────────────────────

function ensureStoreFile(): void {
  if (!fs.existsSync(ARENA_STORE_PATH)) {
    try {
      fs.mkdirSync(path.dirname(ARENA_STORE_PATH), { recursive: true });
      fs.writeFileSync(ARENA_STORE_PATH, JSON.stringify({ profiles: {}, events: [] }, null, 2));
    } catch {
      // ignore — will work from memCache
    }
  }
}

export function readArenaStore(): ArenaStore {
  // If Redis is configured and memCache has been warmed up, use it directly.
  // This avoids hitting the file system (which is ephemeral on Render) on every request.
  if (useRedis() && (Object.keys(memCache.profiles).length > 0 || memCache.events.length > 0)) {
    return memCache;
  }
  // Cold-start fallback: read from file and warm the cache
  ensureStoreFile();
  try {
    const store = JSON.parse(fs.readFileSync(ARENA_STORE_PATH, "utf-8")) as ArenaStore;
    memCache = migrateArenaStoreToCurrentSchema(store);
    return memCache;
  } catch {
    return memCache; // empty — better than crashing
  }
}

export function writeArenaStore(store: ArenaStore): void {
  const next = migrateArenaStoreToCurrentSchema(store);
  writeLocalSnapshot(next);
  // Compatibility path for synchronous unit tests and local tooling. Production
  // request handlers use writeArenaStoreDurably/mutateArenaStoreAsync and await.
  if (useRedis()) {
    void writeArenaStoreDurably(next).catch((error) =>
      console.warn("[GUTO] Redis arena compatibility write failed:", error)
    );
  }
}

// ─── Cross-instance durable mutations ───────────────────────────────────────
// Every production mutation acquires a Redis lease, re-reads the latest whole
// store while holding it, applies exactly one mutation, and awaits SET before
// the HTTP request may complete. This prevents both serverless freeze loss and
// last-writer-wins clobber between warm instances.
let arenaWriteChain: Promise<void> = Promise.resolve();
let arenaHydrationPromise: Promise<ArenaStore> | null = null;
export function mutateArenaStoreAsync<T>(mutate: (store: ArenaStore) => T): Promise<T> {
  const operation = arenaWriteChain.then(async () => {
    // A boot read may still be in flight on a cold instance. Waiting prevents
    // its older snapshot from overwriting memCache after this durable commit.
    if (arenaHydrationPromise) {
      await arenaHydrationPromise;
      arenaHydrationPromise = null;
    }
    const redis = getRedisClient();
    if (!redis) {
      const next = cloneStore(readArenaStore());
      const result = mutate(next);
      next.schemaVersion = ARENA_STORE_SCHEMA_VERSION;
      writeLocalSnapshot(next);
      return result;
    }

    const release = await acquireRedisWriteLock(redis);
    try {
      const latest = parseRedisStore(await redis.get(REDIS_KEY)) ?? {
        profiles: {},
        events: [],
        schemaVersion: ARENA_STORE_SCHEMA_VERSION,
      };
      const next = cloneStore(latest);
      const result = mutate(next);
      next.schemaVersion = ARENA_STORE_SCHEMA_VERSION;
      const wrote = await redis.set(REDIS_KEY, JSON.stringify(next));
      if (wrote !== "OK") throw new Error("Redis arena SET did not return OK.");
      writeLocalSnapshot(next);
      return result;
    } finally {
      await release();
    }
  });

  arenaWriteChain = operation.then(
    () => undefined,
    (error) => {
      console.warn("[GUTO] Redis arena durable mutation failed:", error);
    }
  );
  return operation;
}

export function writeArenaStoreDurably(store: ArenaStore): Promise<void> {
  const snapshot = cloneStore(store);
  return mutateArenaStoreAsync((current) => {
    current.profiles = snapshot.profiles;
    current.events = snapshot.events;
    current.schemaVersion = ARENA_STORE_SCHEMA_VERSION;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getArenaProfile(userId: string): ArenaProfile | undefined {
  const store = readArenaStore();
  return store.profiles[userId];
}

export function saveArenaProfile(profile: ArenaProfile): void {
  const store = readArenaStore();
  store.profiles[profile.userId] = profile;
  writeArenaStore(store);
}

export function appendArenaEvent(event: ArenaXpEvent): void {
  const store = readArenaStore();
  if (!store.events.some((e) => e.id === event.id)) store.events.push(event);
  if (store.events.length > 5000) store.events = store.events.slice(-4000);
  writeArenaStore(store);
}

export function getProfilesByGroup(arenaGroupId: string): ArenaProfile[] {
  const store = readArenaStore();
  return Object.values(store.profiles).filter((p) => p.arenaGroupId === arenaGroupId);
}

export function getAllArenaProfiles(): ArenaProfile[] {
  const store = readArenaStore();
  return Object.values(store.profiles);
}

// Warm reads for legacy synchronous consumers. Durable request paths still await
// a fresh Redis read or mutation, so this optimization is never a correctness gate.
arenaHydrationPromise = readArenaStoreAsync();

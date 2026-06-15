import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
  // Âncora genérica de "última atividade de XP" (pacto/bônus, treino, missão
  // adaptada, penalidade). Dirige o reset preguiçoso de weekly/monthly para
  // QUALQUER XP — não só treino — para que o pacto também resete no fim do
  // ciclo. Opcional para compat com perfis já gravados (fallback p/ lastWorkoutValidatedAt).
  lastXpAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArenaXpEvent {
  id: string;
  userId: string;
  arenaGroupId: string;
  type: "workout_validated" | "reduced_mission_validated" | "bonus" | "miss_penalty";
  xp: number;
  workoutFocus?: string;
  sourceValidationId?: string;
  createdAt: string;
}

interface ArenaStore {
  profiles: Record<string, ArenaProfile>;
  events: ArenaXpEvent[];
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
let memCache: ArenaStore = { profiles: {}, events: [] };

// ─── Redis helpers ────────────────────────────────────────────────────────────
function useRedis(): boolean {
  return Boolean(config.upstashRedisUrl && config.upstashRedisToken);
}

async function redisGet(key: string): Promise<string | null> {
  const res = await fetch(`${config.upstashRedisUrl}/get/${key}`, {
    headers: { Authorization: `Bearer ${config.upstashRedisToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { result: string | null };
  return data.result;
}

async function redisSet(key: string, value: string): Promise<void> {
  await fetch(`${config.upstashRedisUrl}/set/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.upstashRedisToken}` },
    body: value,
  });
}

const REDIS_KEY = "guto:arena";

// ─── Async store (Redis → file) ───────────────────────────────────────────────

/**
 * Read from Redis first, falling back to the local file.
 * Warms up memCache so subsequent sync reads work correctly after a cold start.
 */
export async function readArenaStoreAsync(): Promise<ArenaStore> {
  if (useRedis()) {
    try {
      const raw = await redisGet(REDIS_KEY);
      if (raw) {
        let parsed = JSON.parse(raw);
        if (typeof parsed === "string") parsed = JSON.parse(parsed);
        if (parsed && typeof parsed === "object" && "profiles" in parsed) {
          memCache = parsed as ArenaStore;
          return memCache;
        }
      }
    } catch {
      // fall through to file
    }
  }
  try {
    if (fs.existsSync(ARENA_STORE_PATH)) {
      const fromFile = JSON.parse(fs.readFileSync(ARENA_STORE_PATH, "utf-8")) as ArenaStore;
      memCache = fromFile;
    }
  } catch {
    // ignore — return whatever is in memCache
  }
  return memCache;
}

async function writeArenaStoreAsync(store: ArenaStore): Promise<void> {
  if (useRedis()) {
    try {
      await redisSet(REDIS_KEY, JSON.stringify(store));
    } catch {
      // fall through to file
    }
  }
  try {
    fs.mkdirSync(path.dirname(ARENA_STORE_PATH), { recursive: true });
    fs.writeFileSync(ARENA_STORE_PATH, JSON.stringify(store, null, 2));
  } catch {
    // ignore — at minimum data lives in memCache
  }
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
    memCache = store;
    return store;
  } catch {
    return memCache; // empty — better than crashing
  }
}

export function writeArenaStore(store: ArenaStore): void {
  memCache = store;
  // Write file synchronously so any in-process sync reads see the update instantly
  ensureStoreFile();
  try {
    fs.writeFileSync(ARENA_STORE_PATH, JSON.stringify(store, null, 2));
  } catch {
    // ignore — memCache is the source of truth while Redis is configured
  }
  // Fire-and-forget async write to Redis (same pattern as user-access-store)
  void writeArenaStoreAsync(store).catch((err) =>
    console.warn("[GUTO] Redis arena write failed:", err)
  );
}

// ─── Anti-clobber: hidratação no boot + escrita por-mutação serializada ───────
// Bug crítico (o arena foi de 61 perfis p/ 1 num cold-start): saveArenaProfile
// lia o store vazio na janela do bootstrap e gravava 1 perfil por cima de TODOS
// no Redis (writeArenaStore fire-and-forget). Mesma classe do user-access/memory.
// Correção: grava SERIALIZADO e só DEPOIS da hidratação, RE-APLICANDO a mutação
// (idempotente) sobre o store hidratado. Nunca apaga os outros perfis.
let arenaHydrated = false;
let arenaHydrationPromise: Promise<void> | null = null;
function ensureArenaHydrated(): Promise<void> {
  if (arenaHydrated || !useRedis()) return Promise.resolve();
  if (!arenaHydrationPromise) {
    arenaHydrationPromise = readArenaStoreAsync()
      .then(() => { arenaHydrated = true; })
      .catch(() => { arenaHydrationPromise = null; });
  }
  return arenaHydrationPromise;
}

let arenaWriteChain: Promise<void> = Promise.resolve();
function persistArenaMutation(mutate: (store: ArenaStore) => void): void {
  mutate(memCache);
  ensureStoreFile();
  try { fs.writeFileSync(ARENA_STORE_PATH, JSON.stringify(memCache, null, 2)); } catch { /* memCache é a fonte */ }
  if (!useRedis()) return;
  arenaWriteChain = arenaWriteChain
    .then(async () => {
      await ensureArenaHydrated();
      if (!arenaHydrated) return; // Redis indisponível: não arrisca clobber
      mutate(memCache);
      await redisSet(REDIS_KEY, JSON.stringify(memCache));
      try { fs.writeFileSync(ARENA_STORE_PATH, JSON.stringify(memCache, null, 2)); } catch { /* ok */ }
    })
    .catch((err) => {
      console.warn("[GUTO] Redis arena write failed (async mutation chain):", err);
    });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getArenaProfile(userId: string): ArenaProfile | undefined {
  const store = readArenaStore();
  return store.profiles[userId];
}

export function saveArenaProfile(profile: ArenaProfile): void {
  persistArenaMutation((store) => {
    store.profiles[profile.userId] = profile;
  });
}

export function appendArenaEvent(event: ArenaXpEvent): void {
  persistArenaMutation((store) => {
    // idempotente (a re-aplicação pós-hidratação roda 2x): só empurra 1 vez por id
    if (!store.events.some((e) => e.id === event.id)) {
      store.events.push(event);
      if (store.events.length > 5000) {
        store.events = store.events.slice(-4000);
      }
    }
  });
}

export function getProfilesByGroup(arenaGroupId: string): ArenaProfile[] {
  const store = readArenaStore();
  return Object.values(store.profiles).filter((p) => p.arenaGroupId === arenaGroupId);
}

export function getAllArenaProfiles(): ArenaProfile[] {
  const store = readArenaStore();
  return Object.values(store.profiles);
}

// ─── Bootstrap: hidrata do Redis no init (e trava writes até completar) ───────
// Sem isso, após um cold start do Render (file system zerado), readArenaStore()
// devolveria perfis vazios mesmo com o Redis cheio — e um write nessa janela
// apagava todos os perfis (clobber). ensureArenaHydrated também serve de gate.
void ensureArenaHydrated();

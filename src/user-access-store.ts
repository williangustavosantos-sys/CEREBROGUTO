import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_ACCESS_STORE_PATH = path.join(__dirname, "../tmp/user-access.json");

export type UserRole = "student" | "coach" | "admin" | "super_admin";
export type SubscriptionStatus = "pending_payment" | "active" | "expired" | "cancelled";
export type PaymentStatus = "pending_payment" | "active" | "expired" | "cancelled";
export type UserPlan = "beta_simple" | "supervised_beta" | "premium";

export interface UserAccess {
  userId: string;
  role: UserRole;
  coachId: string;
  active: boolean;
  visibleInArena: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  subscriptionStatus: SubscriptionStatus;
  subscriptionEndsAt: string | null;
  passwordHash?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  whatsapp?: string;
  instagram?: string;
  country?: string;
  language?: string;
  plan?: UserPlan;
  paymentStatus?: PaymentStatus;
  internalNotes?: string;
  accessDurationDays?: number;
  phone?: string;
  teamId?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripePriceId?: string;
}

interface UserAccessStore {
  users: Record<string, UserAccess>;
}

const DEV_COACH_ID = process.env.DEV_COACH_ID ?? "will-coach";

// ─── Storage layer (Redis → file → memory) ────────────────────────────────────

let memCache: UserAccessStore = { users: {} };

function useRedis(): boolean {
  return Boolean(config.upstashRedisUrl && config.upstashRedisToken);
}

async function redisGet(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${config.upstashRedisUrl}/get/${key}`, {
      headers: { Authorization: `Bearer ${config.upstashRedisToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result: string | null };
    return data.result;
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: string): Promise<void> {
  try {
    await fetch(`${config.upstashRedisUrl}/set/${key}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.upstashRedisToken}`,
      },
      body: value,
    });
  } catch {
    // ignore
  }
}

const REDIS_KEY = "guto:user-access";

function ensureStoreFile(): void {
  if (!fs.existsSync(USER_ACCESS_STORE_PATH)) {
    fs.mkdirSync(path.dirname(USER_ACCESS_STORE_PATH), { recursive: true });
    fs.writeFileSync(USER_ACCESS_STORE_PATH, JSON.stringify({ users: {} }, null, 2));
  }
}

function readStoreSync(): UserAccessStore {
  if (useRedis() && Object.keys(memCache.users).length > 0) {
    return memCache;
  }
  try {
    ensureStoreFile();
    const parsed = JSON.parse(fs.readFileSync(USER_ACCESS_STORE_PATH, "utf-8")) as UserAccessStore;
    if (Object.keys(parsed.users || {}).length === 0 && Object.keys(memCache.users).length > 0) {
      return memCache;
    }
    return parsed;
  } catch {
    return { users: {} };
  }
}

function writeStoreSync(store: UserAccessStore): void {
  memCache = store;
  try {
    ensureStoreFile();
    fs.writeFileSync(USER_ACCESS_STORE_PATH, JSON.stringify(store, null, 2));
  } catch {
    // in-memory only
  }
}

async function readStoreAsync(): Promise<UserAccessStore> {
  if (useRedis()) {
    try {
      const raw = await redisGet(REDIS_KEY);
      if (raw) {
        let parsed = JSON.parse(raw);
        if (typeof parsed === "string") {
          parsed = JSON.parse(parsed);
        }
        if (!parsed || typeof parsed !== "object" || !("users" in parsed)) {
          parsed = { users: {} };
        }
        memCache = parsed as UserAccessStore;
        return memCache;
      }
    } catch {
      // fall through
    }
  }
  const store = readStoreSync();
  memCache = store;
  return store;
}

// ─── Persistência anti-clobber (hidratação + escrita serializada) ────────────
// Bug crítico (achado no QA 31/05, confirmado no Redis de prod): após um
// restart/cold-start do Render, `readStoreSync` devolvia memória/arquivo VAZIO
// durante a janela do bootstrap async, e um write fire-and-forget gravava esse
// estado vazio por cima dos usuários reais no Redis — apagando coaches/alunos.
// (README: "Memória no GUTO é confiança. Se diz 'salvei', salvou de verdade.")
// Correção: todo write ao Redis é SERIALIZADO e só roda DEPOIS da hidratação,
// RE-APLICANDO a mutação sobre o memCache já hidratado. Se a hidratação falhar,
// NÃO grava no Redis (evita clobber); mantém memória/arquivo e tenta de novo.
let hydrated = false;
let hydrationPromise: Promise<void> | null = null;

function ensureHydration(): Promise<void> {
  if (hydrated || !useRedis()) return Promise.resolve();
  if (!hydrationPromise) {
    hydrationPromise = readStoreAsync()
      .then(() => { hydrated = true; })
      .catch(() => { hydrationPromise = null; }); // permite retry no próximo write
  }
  return hydrationPromise;
}

let writeChain: Promise<void> = Promise.resolve();

// Aplica `mutate` ao memCache (sync, para leituras imediatas) e persiste o
// estado já HIDRATADO no Redis de forma serializada. As versões async aguardam
// a promise retornada; as sync disparam em background.
function persistMutation(mutate: (store: UserAccessStore) => void): Promise<void> {
  mutate(memCache);          // best-effort imediato p/ readStoreSync
  writeStoreSync(memCache);  // arquivo + memCache (não toca Redis)
  if (!useRedis()) return Promise.resolve();
  writeChain = writeChain
    .then(async () => {
      await ensureHydration();   // memCache passa a refletir o Redis
      if (!hydrated) return;     // Redis indisponível: não arrisca clobber
      mutate(memCache);          // RE-aplica sobre o estado hidratado
      await redisSet(REDIS_KEY, JSON.stringify(memCache));
      writeStoreSync(memCache);
    })
    .catch(() => {});
  return writeChain;
}

function buildUpsertedUser(
  existing: UserAccess | undefined,
  userId: string,
  patch: Partial<Omit<UserAccess, "userId" | "createdAt">>,
  now: string
): UserAccess {
  const updated = Object.assign(
    {},
    { role: "student" as UserRole, coachId: DEV_COACH_ID, active: false, visibleInArena: true, archived: false, subscriptionStatus: "pending_payment" as SubscriptionStatus, subscriptionEndsAt: null as string | null, teamId: "GUTO_CORE" },
    existing ?? {},
    patch,
    { userId, createdAt: existing?.createdAt ?? now, updatedAt: now }
  ) as UserAccess;
  if (!updated.teamId) updated.teamId = "GUTO_CORE";
  return updated;
}

// ─── Sync API (used by coach-router and server.ts) ───────────────────────────

export function getUserAccess(userId: string): UserAccess | undefined {
  const existing = readStoreSync().users[userId];
  if (existing) {
    return { ...existing, teamId: existing.teamId || "GUTO_CORE" };
  }
  return undefined;
}

/**
 * In production, never grants access to unknown users.
 * In dev mode (GUTO_ALLOW_DEV_ACCESS=true), returns a synthetic active record.
 */
export function getEffectiveUserAccess(userId: string): UserAccess | null {
  const existing = getUserAccess(userId);
  if (existing) return existing;

  if (config.allowDevAccess) {
    const now = new Date().toISOString();
    return {
      userId,
      role: "student",
      coachId: DEV_COACH_ID,
      active: true,
      visibleInArena: true,
      archived: false,
      createdAt: now,
      updatedAt: now,
      subscriptionStatus: "active",
      subscriptionEndsAt: null,
      teamId: "GUTO_CORE",
    };
  }

  return null;
}

export function requireActiveUserAccess(userId: string): UserAccess | null {
  const access = getEffectiveUserAccess(userId);
  if (!access) return null;
  if (!access.active) return null;
  if (access.archived) return null;
  if (access.subscriptionStatus === "expired" || access.subscriptionStatus === "cancelled") return null;
  if (access.subscriptionEndsAt && new Date(access.subscriptionEndsAt) < new Date()) return null;
  return access;
}

export function upsertUserAccess(
  userId: string,
  patch: Partial<Omit<UserAccess, "userId" | "createdAt">>
): UserAccess {
  const now = new Date().toISOString();
  void persistMutation((store) => {
    store.users[userId] = buildUpsertedUser(store.users[userId], userId, patch, now);
  });
  return memCache.users[userId];
}

export function deleteUserAccessHard(userId: string): void {
  void persistMutation((store) => {
    delete store.users[userId];
  });
}

export function getAllUserAccess(): UserAccess[] {
  return Object.values(readStoreSync().users).map((u) => ({
    ...u,
    teamId: u.teamId || "GUTO_CORE",
  }));
}

export function writeUserAccessStoreRaw(store: { users: Record<string, UserAccess> }): void {
  // Sobrescrita deliberada do store inteiro (ex.: nuke administrativo). Mantém a
  // mesma intenção mesmo após hidratação (define o estado exato pedido).
  const snapshot = { ...store.users };
  void persistMutation((s) => {
    s.users = { ...snapshot };
  });
}

// Async versions for auth router
export async function getUserAccessAsync(userId: string): Promise<UserAccess | undefined> {
  const store = await readStoreAsync();
  const existing = store.users[userId];
  if (existing) {
    return { ...existing, teamId: existing.teamId || "GUTO_CORE" };
  }
  return undefined;
}

export async function getEffectiveUserAccessAsync(userId: string): Promise<UserAccess | null> {
  const existing = await getUserAccessAsync(userId);
  if (existing) return existing;

  if (config.allowDevAccess) {
    const now = new Date().toISOString();
    return {
      userId,
      role: "student",
      coachId: DEV_COACH_ID,
      active: true,
      visibleInArena: true,
      archived: false,
      createdAt: now,
      updatedAt: now,
      subscriptionStatus: "active",
      subscriptionEndsAt: null,
      teamId: "GUTO_CORE",
    };
  }

  return null;
}

export async function requireActiveUserAccessAsync(userId: string): Promise<UserAccess | null> {
  const access = await getEffectiveUserAccessAsync(userId);
  if (!access) return null;
  if (!access.active) return null;
  if (access.archived) return null;
  if (access.subscriptionStatus === "expired" || access.subscriptionStatus === "cancelled") return null;
  if (access.subscriptionEndsAt && new Date(access.subscriptionEndsAt) < new Date()) return null;
  return access;
}

export async function getAllUserAccessAsync(): Promise<UserAccess[]> {
  const store = await readStoreAsync();
  return Object.values(store.users).map((u) => ({
    ...u,
    teamId: u.teamId || "GUTO_CORE",
  }));
}

export async function deleteUserAccessHardAsync(userId: string): Promise<void> {
  await persistMutation((store) => {
    delete store.users[userId];
  });
}

export async function writeUserAccessStoreRawAsync(store: { users: Record<string, UserAccess> }): Promise<void> {
  const snapshot = { ...store.users };
  await persistMutation((s) => {
    s.users = { ...snapshot };
  });
}

export async function upsertUserAccessAsync(
  userId: string,
  patch: Partial<Omit<UserAccess, "userId" | "createdAt">>
): Promise<UserAccess> {
  const now = new Date().toISOString();
  let result: UserAccess | undefined;
  await persistMutation((store) => {
    result = buildUpsertedUser(store.users[userId], userId, patch, now);
    store.users[userId] = result;
  });
  return result ?? memCache.users[userId];
}

// ─── Bootstrap: hidrata o memCache do Redis no init do módulo ────────────────
// Sem isso, após um cold start do Render (file system zerado), readStoreSync
// leria um arquivo vazio e perderia todo usuário salvo no Redis. ensureHydration
// também trava os writes ao Redis até a hidratação completar (anti-clobber).
void ensureHydration();

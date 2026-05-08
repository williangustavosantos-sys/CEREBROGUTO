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

async function writeStoreAsync(store: UserAccessStore): Promise<void> {
  memCache = store;
  if (useRedis()) {
    await redisSet(REDIS_KEY, JSON.stringify(store));
  }
  writeStoreSync(store);
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
  const store = readStoreSync();
  const now = new Date().toISOString();
  const existing = store.users[userId];
  const updated = Object.assign(
    {},
    { role: "student" as UserRole, coachId: DEV_COACH_ID, active: false, visibleInArena: true, archived: false, subscriptionStatus: "pending_payment" as SubscriptionStatus, subscriptionEndsAt: null as string | null, teamId: "GUTO_CORE" },
    existing ?? {},
    patch,
    { userId, createdAt: existing?.createdAt ?? now, updatedAt: now }
  ) as UserAccess;
  if (!updated.teamId) updated.teamId = "GUTO_CORE";
  store.users[userId] = updated;
  writeStoreSync(store);
  // persist async to Redis in background
  void writeStoreAsync(store).catch(() => { });
  return updated;
}

export function deleteUserAccessHard(userId: string): void {
  const store = readStoreSync();
  delete store.users[userId];
  writeStoreSync(store);
  void writeStoreAsync(store).catch(() => { });
}

export function getAllUserAccess(): UserAccess[] {
  return Object.values(readStoreSync().users).map((u) => ({
    ...u,
    teamId: u.teamId || "GUTO_CORE",
  }));
}

export function writeUserAccessStoreRaw(store: { users: Record<string, UserAccess> }): void {
  writeStoreSync(store);
  void writeStoreAsync(store).catch(() => { });
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
  const store = await readStoreAsync();
  delete store.users[userId];
  await writeStoreAsync(store);
}

export async function writeUserAccessStoreRawAsync(store: { users: Record<string, UserAccess> }): Promise<void> {
  await writeStoreAsync(store);
}

export async function upsertUserAccessAsync(
  userId: string,
  patch: Partial<Omit<UserAccess, "userId" | "createdAt">>
): Promise<UserAccess> {
  const store = await readStoreAsync();
  const now = new Date().toISOString();
  const existing = store.users[userId];
  const updated = Object.assign(
    {},
    { role: "student" as UserRole, coachId: DEV_COACH_ID, active: false, visibleInArena: true, archived: false, subscriptionStatus: "pending_payment" as SubscriptionStatus, subscriptionEndsAt: null as string | null, teamId: "GUTO_CORE" },
    existing ?? {},
    patch,
    { userId, createdAt: existing?.createdAt ?? now, updatedAt: now }
  ) as UserAccess;
  if (!updated.teamId) updated.teamId = "GUTO_CORE";
  store.users[userId] = updated;
  await writeStoreAsync(store);
  return updated;
}

// ─── Bootstrap: load persisted users from Redis on module init ───────────────
// Without this, after a Render cold start (file system wiped), readStoreSync
// would read an empty file and miss every user that was saved to Redis.
readStoreAsync().catch(() => {});

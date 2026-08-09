import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUSH_STORE_PATH = process.env.PUSH_STORE_FILE
  ? process.env.PUSH_STORE_FILE
  : path.join(__dirname, "../tmp/push-subscriptions.json");
const REDIS_KEY = "guto:push-subscriptions:v1";
const REDIS_LOCK_KEY = "guto:push-subscriptions:write-lock:v1";
const REDIS_LOCK_TTL_MS = 15_000;
const REDIS_LOCK_WAIT_MS = 20_000;

export interface PushSubscriptionRecord {
  userId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  /** ISO date — last successful delivery */
  lastSentAt?: string;
  /** "12" | "18" | "21" — which approved window was used */
  lastSentSlot?: string;
  /** ISO date — last delivery attempt failed */
  lastFailedAt?: string;
  failureCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface PushStore {
  subscriptions: PushSubscriptionRecord[];
}

type RedisClient = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options?: { nx: true; px: number }) => Promise<unknown>;
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
};

let redisClient: RedisClient | null = null;
let localWriteChain: Promise<void> = Promise.resolve();

function getRedisClient(): RedisClient | null {
  if (process.env.GUTO_DISABLE_REDIS_FOR_TESTS === "1") return null;
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    redisClient = new Redis({ url, token }) as unknown as RedisClient;
    return redisClient;
  } catch {
    return null;
  }
}

function normalizeStore(raw: unknown): PushStore {
  let parsed = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { subscriptions: [] };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { subscriptions: [] };
  }
  const subscriptions = (parsed as { subscriptions?: unknown }).subscriptions;
  return {
    subscriptions: Array.isArray(subscriptions)
      ? subscriptions.filter((item): item is PushSubscriptionRecord =>
          Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as PushSubscriptionRecord).userId === "string" &&
            typeof (item as PushSubscriptionRecord).endpoint === "string"
          )
        )
      : [],
  };
}

function ensureStoreFile(): void {
  if (!fs.existsSync(PUSH_STORE_PATH)) {
    fs.mkdirSync(path.dirname(PUSH_STORE_PATH), { recursive: true });
    fs.writeFileSync(PUSH_STORE_PATH, JSON.stringify({ subscriptions: [] }, null, 2));
  }
}

function readLocalStore(): PushStore {
  ensureStoreFile();
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(PUSH_STORE_PATH, "utf-8")));
  } catch {
    return { subscriptions: [] };
  }
}

function writeLocalStore(store: PushStore): void {
  ensureStoreFile();
  fs.writeFileSync(PUSH_STORE_PATH, JSON.stringify(store, null, 2));
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireRedisLock(redis: RedisClient): Promise<() => Promise<void>> {
  const token = randomUUID();
  const deadline = Date.now() + REDIS_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const acquired = await redis.set(REDIS_LOCK_KEY, token, {
      nx: true,
      px: REDIS_LOCK_TTL_MS,
    });
    if (acquired === "OK") {
      return async () => {
        await redis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          [REDIS_LOCK_KEY],
          [token]
        ).catch(() => {});
      };
    }
    await waitFor(50);
  }
  throw new Error("Timed out waiting for push subscription store lock.");
}

async function readStore(): Promise<PushStore> {
  const redis = getRedisClient();
  if (!redis) return readLocalStore();
  const raw = await redis.get(REDIS_KEY);
  return normalizeStore(raw);
}

async function mutateStore<T>(mutate: (store: PushStore) => T): Promise<T> {
  const redis = getRedisClient();
  if (redis) {
    const release = await acquireRedisLock(redis);
    try {
      const store = normalizeStore(await redis.get(REDIS_KEY));
      const result = mutate(store);
      await redis.set(REDIS_KEY, store);
      return result;
    } finally {
      await release();
    }
  }

  let result!: T;
  const operation = localWriteChain.then(() => {
    const store = readLocalStore();
    result = mutate(store);
    writeLocalStore(store);
  });
  localWriteChain = operation.catch(() => {});
  await operation;
  return result;
}

/**
 * Endpoint é a chave única. Se o navegador trocar de usuário, a assinatura
 * passa a pertencer ao login mais recente sem duplicar o mesmo dispositivo.
 */
export async function upsertSubscription(
  record: Omit<PushSubscriptionRecord, "createdAt" | "updatedAt">
): Promise<PushSubscriptionRecord> {
  return mutateStore((store) => {
    const now = new Date().toISOString();
    const existing = store.subscriptions.find((item) => item.endpoint === record.endpoint);
    if (existing) {
      Object.assign(existing, record, { updatedAt: now });
      return { ...existing, keys: { ...existing.keys } };
    }
    const created: PushSubscriptionRecord = {
      ...record,
      keys: { ...record.keys },
      createdAt: now,
      updatedAt: now,
    };
    store.subscriptions.push(created);
    return { ...created, keys: { ...created.keys } };
  });
}

export async function getSubscriptionsByUser(userId: string): Promise<PushSubscriptionRecord[]> {
  return (await readStore()).subscriptions
    .filter((item) => item.userId === userId)
    .map((item) => ({ ...item, keys: { ...item.keys } }));
}

export async function getAllSubscriptions(): Promise<PushSubscriptionRecord[]> {
  return (await readStore()).subscriptions.map((item) => ({ ...item, keys: { ...item.keys } }));
}

export async function deleteSubscriptionByEndpoint(endpoint: string): Promise<boolean> {
  return mutateStore((store) => {
    const before = store.subscriptions.length;
    store.subscriptions = store.subscriptions.filter((item) => item.endpoint !== endpoint);
    return store.subscriptions.length !== before;
  });
}

/**
 * User-facing unsubscribe. An authenticated user may remove only an endpoint
 * that currently belongs to that same user. Delivery cleanup keeps using the
 * endpoint-only variant because it acts on a provider-confirmed invalid token.
 */
export async function deleteSubscriptionForUser(
  userId: string,
  endpoint: string,
): Promise<boolean> {
  return mutateStore((store) => {
    const before = store.subscriptions.length;
    store.subscriptions = store.subscriptions.filter(
      (item) => !(item.userId === userId && item.endpoint === endpoint),
    );
    return store.subscriptions.length !== before;
  });
}

export async function deleteSubscriptionsByUser(userId: string): Promise<number> {
  return mutateStore((store) => {
    const before = store.subscriptions.length;
    store.subscriptions = store.subscriptions.filter((item) => item.userId !== userId);
    return before - store.subscriptions.length;
  });
}

export async function recordSuccessfulDelivery(
  endpoint: string,
  slot: string,
  sentAt = new Date()
): Promise<void> {
  await mutateStore((store) => {
    const delivered = store.subscriptions.find((item) => item.endpoint === endpoint);
    if (!delivered) return;
    const timestamp = sentAt.toISOString();
    for (const sub of store.subscriptions) {
      if (sub.userId !== delivered.userId) continue;
      sub.lastSentAt = timestamp;
      sub.lastSentSlot = slot;
      sub.failureCount = 0;
      sub.lastFailedAt = undefined;
      sub.updatedAt = timestamp;
    }
  });
}

export async function recordFailedDelivery(endpoint: string, failedAt = new Date()): Promise<void> {
  await mutateStore((store) => {
    const sub = store.subscriptions.find((item) => item.endpoint === endpoint);
    if (!sub) return;
    sub.lastFailedAt = failedAt.toISOString();
    sub.failureCount = (sub.failureCount ?? 0) + 1;
    sub.updatedAt = sub.lastFailedAt;
  });
}

export async function writePushStoreRaw(store: PushStore): Promise<void> {
  await mutateStore((current) => {
    current.subscriptions = store.subscriptions.map((item) => ({
      ...item,
      keys: { ...item.keys },
    }));
  });
}

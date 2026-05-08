import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUSH_STORE_PATH = process.env.PUSH_STORE_FILE
  ? process.env.PUSH_STORE_FILE
  : path.join(__dirname, "../tmp/push-subscriptions.json");

export interface PushSubscriptionRecord {
  userId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  /** ISO date — last successful delivery */
  lastSentAt?: string;
  /** "morning" | "evening" | "critical" — which slot was used today */
  lastSentSlot?: string;
  /** ISO date — last delivery attempt failed (for cleanup of expired subs) */
  lastFailedAt?: string;
  failureCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface PushStore {
  subscriptions: PushSubscriptionRecord[];
}

function ensureStoreFile(): void {
  if (!fs.existsSync(PUSH_STORE_PATH)) {
    fs.mkdirSync(path.dirname(PUSH_STORE_PATH), { recursive: true });
    fs.writeFileSync(PUSH_STORE_PATH, JSON.stringify({ subscriptions: [] }, null, 2));
  }
}

function readStore(): PushStore {
  ensureStoreFile();
  try {
    return JSON.parse(fs.readFileSync(PUSH_STORE_PATH, "utf-8")) as PushStore;
  } catch {
    return { subscriptions: [] };
  }
}

function writeStore(store: PushStore): void {
  ensureStoreFile();
  fs.writeFileSync(PUSH_STORE_PATH, JSON.stringify(store, null, 2));
}

/**
 * Insere ou atualiza uma subscription. Endpoint é a chave única —
 * mesmo dispositivo pode aparecer com user diferente se o app trocou de
 * usuário; a subscription mais recente sobrescreve.
 */
export function upsertSubscription(record: Omit<PushSubscriptionRecord, "createdAt" | "updatedAt">): PushSubscriptionRecord {
  const store = readStore();
  const now = new Date().toISOString();
  const existing = store.subscriptions.find((s) => s.endpoint === record.endpoint);

  if (existing) {
    Object.assign(existing, record, { updatedAt: now });
    writeStore(store);
    return existing;
  }

  const created: PushSubscriptionRecord = {
    ...record,
    createdAt: now,
    updatedAt: now,
  };
  store.subscriptions.push(created);
  writeStore(store);
  return created;
}

export function getSubscriptionsByUser(userId: string): PushSubscriptionRecord[] {
  return readStore().subscriptions.filter((s) => s.userId === userId);
}

export function getAllSubscriptions(): PushSubscriptionRecord[] {
  return readStore().subscriptions;
}

export function deleteSubscriptionByEndpoint(endpoint: string): boolean {
  const store = readStore();
  const before = store.subscriptions.length;
  store.subscriptions = store.subscriptions.filter((s) => s.endpoint !== endpoint);
  if (store.subscriptions.length === before) return false;
  writeStore(store);
  return true;
}

export function deleteSubscriptionsByUser(userId: string): number {
  const store = readStore();
  const before = store.subscriptions.length;
  store.subscriptions = store.subscriptions.filter((s) => s.userId !== userId);
  const removed = before - store.subscriptions.length;
  if (removed > 0) writeStore(store);
  return removed;
}

export function recordSuccessfulDelivery(endpoint: string, slot: string): void {
  const store = readStore();
  const sub = store.subscriptions.find((s) => s.endpoint === endpoint);
  if (!sub) return;
  sub.lastSentAt = new Date().toISOString();
  sub.lastSentSlot = slot;
  sub.failureCount = 0;
  sub.lastFailedAt = undefined;
  sub.updatedAt = sub.lastSentAt;
  writeStore(store);
}

export function recordFailedDelivery(endpoint: string): void {
  const store = readStore();
  const sub = store.subscriptions.find((s) => s.endpoint === endpoint);
  if (!sub) return;
  sub.lastFailedAt = new Date().toISOString();
  sub.failureCount = (sub.failureCount ?? 0) + 1;
  sub.updatedAt = sub.lastFailedAt;
  writeStore(store);
}

export function writePushStoreRaw(store: PushStore): void {
  writeStore(store);
}

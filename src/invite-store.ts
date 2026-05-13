import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVITE_FILE = path.join(__dirname, "../tmp/invites.json");

export type InviteStatus = "pending_claim" | "active" | "expired" | "revoked";
export type SubscriptionStatus = "pending_payment" | "active" | "expired" | "cancelled";

export interface Invite {
  id: string;
  tokenHash: string;
  rawToken?: string;
  userId: string;
  name: string;
  role: "student";
  coachId: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  subscriptionStatus: SubscriptionStatus;
  subscriptionEndsAt: string | null;
}

interface InviteStore {
  invites: Record<string, Invite>;
}

// ─── Token helpers ────────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// ─── Storage layer (Redis → file → memory) ────────────────────────────────────

let memCache: InviteStore = { invites: {} };

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
    headers: {
      Authorization: `Bearer ${config.upstashRedisToken}`,
    },
    body: value,
  });
}

const REDIS_INVITE_KEY = "guto:invites";

async function readStore(): Promise<InviteStore> {
  if (useRedis()) {
    try {
      const raw = await redisGet(REDIS_INVITE_KEY);
      if (raw) {
        let parsed = JSON.parse(raw);
        if (typeof parsed === "string") {
          parsed = JSON.parse(parsed);
        }
        if (!parsed || typeof parsed !== "object" || !("invites" in parsed)) {
          parsed = { invites: {} };
        }
        memCache = parsed as InviteStore;
        return memCache;
      }
    } catch {
      // fall through to file
    }
  }
  try {
    if (fs.existsSync(INVITE_FILE)) {
      memCache = JSON.parse(fs.readFileSync(INVITE_FILE, "utf-8")) as InviteStore;
    }
  } catch {
    // ignore
  }
  return memCache;
}

async function writeStore(store: InviteStore): Promise<void> {
  memCache = store;
  if (useRedis()) {
    try {
      await redisSet(REDIS_INVITE_KEY, JSON.stringify(store));
      return;
    } catch {
      // fall through to file
    }
  }
  try {
    fs.mkdirSync(path.dirname(INVITE_FILE), { recursive: true });
    fs.writeFileSync(INVITE_FILE, JSON.stringify(store, null, 2));
  } catch {
    // in-memory only
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createInvite(params: {
  userId: string;
  name: string;
  coachId: string;
  expiresInDays?: number;
}): Promise<{ invite: Invite; rawToken: string }> {
  const store = await readStore();
  const rawToken = generateInviteToken();
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + (params.expiresInDays ?? 7));

  const invite: Invite = {
    id: crypto.randomUUID(),
    tokenHash,
    rawToken,
    userId: params.userId,
    name: params.name,
    role: "student",
    coachId: params.coachId,
    status: "pending_claim",
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    usedAt: null,
    subscriptionStatus: "pending_payment",
    subscriptionEndsAt: null,
  };

  store.invites[tokenHash] = invite;
  await writeStore(store);
  return { invite, rawToken };
}

export async function findInviteByToken(rawToken: string): Promise<Invite | null> {
  const store = await readStore();
  const tokenHash = hashToken(rawToken);
  return store.invites[tokenHash] ?? null;
}

export async function findInviteByUserId(userId: string): Promise<Invite | null> {
  const store = await readStore();
  return Object.values(store.invites).find((inv) => inv.userId === userId) ?? null;
}

export async function claimInvite(rawToken: string): Promise<Invite | null> {
  const store = await readStore();
  const tokenHash = hashToken(rawToken);
  const invite = store.invites[tokenHash];
  if (!invite) return null;
  if (invite.status !== "pending_claim") return null;
  if (new Date(invite.expiresAt) < new Date()) {
    invite.status = "expired";
    await writeStore(store);
    return null;
  }
  invite.status = "active";
  invite.usedAt = new Date().toISOString();
  invite.subscriptionStatus = "active";
  const endsAt = new Date();
  endsAt.setDate(endsAt.getDate() + 30);
  invite.subscriptionEndsAt = endsAt.toISOString();
  store.invites[tokenHash] = invite;
  await writeStore(store);
  return invite;
}

export async function updateInviteByUserId(
  userId: string,
  patch: Partial<Pick<Invite, "status" | "subscriptionStatus" | "subscriptionEndsAt">>
): Promise<void> {
  const store = await readStore();
  const invite = Object.values(store.invites).find((inv) => inv.userId === userId);
  if (!invite) return;
  Object.assign(invite, patch);
  await writeStore(store);
}

export async function revokeInviteByUserId(userId: string): Promise<void> {
  await updateInviteByUserId(userId, { status: "revoked" });
}

export async function getAllInvites(): Promise<Invite[]> {
  const store = await readStore();
  return Object.values(store.invites);
}

export async function regenerateInviteByUserId(params: {
  userId: string;
  name: string;
  coachId: string;
  expiresInDays?: number;
}): Promise<{ invite: Invite; rawToken: string }> {
  await revokeInviteByUserId(params.userId);
  return createInvite(params);
}

// ─── Bootstrap: load persisted invites from Redis on module init ─────────────
// Without this, after a Render cold start (file system wiped), in-flight
// invite lookups fail until the first async read populates memCache.
readStore().catch(() => {});

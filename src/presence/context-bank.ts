// CRUD do Context Bank — persiste via memory-store, zero RAM isolada

import {
  readMemoryStoreAsync,
  writeMemoryStoreAsync,
} from "../memory-store";

import type { ContextItem, ContextState, ContextType } from "./types";

const MAX_HYPOTHESES_PER_USER = 20;

// ─── Helper para strict: true ─────────────────────────────────────────────────
// memory[userId] retorna unknown. Esse cast seguro evita quebrar typecheck.

function asUserMemory(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function normalizeContextBank(
  bank: ContextItem[],
  nowISO: string
): { bank: ContextItem[]; changed: boolean } {
  let changed = false;

  const normalized = bank
    .filter((item) => {
      if (item.expiresAt && item.expiresAt <= nowISO) {
        changed = true;
        return false;
      }

      return true;
    })
    .map((item) => {
      if (
        item.state === "cooldown" &&
        item.cooldownUntil &&
        item.cooldownUntil <= nowISO
      ) {
        changed = true;
        return {
          ...item,
          state: "active" as const,
          cooldownUntil: null,
          updatedAt: nowISO,
        };
      }

      return item;
    });

  return { bank: normalized, changed };
}

// ─── Leitura com lazy GC de itens expirados e cooldown vencido ────────────────

export async function getUserContextBank(
  userId: string
): Promise<ContextItem[]> {
  const memory = await readMemoryStoreAsync();
  const userMemory = asUserMemory(memory[userId]);

  const rawBank = Array.isArray(userMemory.contextBank)
    ? (userMemory.contextBank as ContextItem[])
    : [];

  const nowISO = new Date().toISOString();
  const { bank, changed } = normalizeContextBank(rawBank, nowISO);

  if (changed) {
    userMemory.contextBank = bank;
    memory[userId] = userMemory;
    await writeMemoryStoreAsync(memory);
  }

  return bank;
}

// ─── Escrita preservando o resto da memória do usuário ───────────────────────

async function saveUserContextBank(
  userId: string,
  bank: ContextItem[]
): Promise<void> {
  const memory = await readMemoryStoreAsync();
  const userMemory = asUserMemory(memory[userId]);

  userMemory.contextBank = bank;
  memory[userId] = userMemory;

  await writeMemoryStoreAsync(memory);
}

// ─── ID único por usuário ─────────────────────────────────────────────────────

function generateId(userId: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `ctx_${userId.slice(0, 6)}_${ts}_${rand}`;
}

// ─── Poda de hipóteses ────────────────────────────────────────────────────────

function pruneHypotheses(bank: ContextItem[]): ContextItem[] {
  const hypotheses = bank.filter((item) => item.state === "hypothesis");
  if (hypotheses.length <= MAX_HYPOTHESES_PER_USER) return bank;

  // Ordena por confiança ascendente e remove as piores.
  hypotheses.sort((a, b) => a.confidence - b.confidence);

  const toRemove = new Set(
    hypotheses
      .slice(0, hypotheses.length - MAX_HYPOTHESES_PER_USER)
      .map((item) => item.id)
  );

  return bank.filter((item) => !toRemove.has(item.id));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function addContextItem(
  userId: string,
  item: Omit<ContextItem, "id" | "userId" | "createdAt" | "updatedAt">
): Promise<ContextItem> {
  const now = new Date().toISOString();

  const fullItem: ContextItem = {
    ...item,
    userId,
    id: generateId(userId),
    createdAt: now,
    updatedAt: now,
  };

  let bank = await getUserContextBank(userId);
  bank.push(fullItem);
  bank = pruneHypotheses(bank);

  await saveUserContextBank(userId, bank);
  return fullItem;
}

export async function updateContextItem(
  userId: string,
  itemId: string,
  updates: Partial<
    Pick<
      ContextItem,
      | "state"
      | "confidence"
      | "value"
      | "lastUsedAt"
      | "cooldownUntil"
      | "expiresAt"
      | "meta"
    >
  >
): Promise<ContextItem | null> {
  const bank = await getUserContextBank(userId);
  const index = bank.findIndex((item) => item.id === itemId);

  if (index === -1) return null;

  const current = bank[index];
  if (!current) return null;

  bank[index] = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await saveUserContextBank(userId, bank);
  return bank[index] ?? null;
}

export async function getContextItems(
  userId: string,
  filters?: { type?: ContextType; state?: ContextState }
): Promise<ContextItem[]> {
  const bank = await getUserContextBank(userId);

  return bank
    .filter((item) => {
      if (filters?.type && item.type !== filters.type) return false;
      if (filters?.state && item.state !== filters.state) return false;
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence);
}

export async function getUsableContextItems(
  userId: string,
  now?: string
): Promise<ContextItem[]> {
  const bank = await getUserContextBank(userId);
  const currentISO = now || new Date().toISOString();

  return bank
    .filter((item) => {
      if (item.state === "archived") return false;
      if (item.expiresAt && item.expiresAt <= currentISO) return false;

      // cooldown ainda ativo: não usa.
      if (
        item.state === "cooldown" &&
        item.cooldownUntil &&
        item.cooldownUntil > currentISO
      ) {
        return false;
      }

      return item.state === "active" || item.state === "validated";
    })
    .sort((a, b) => b.confidence - a.confidence);
}

export async function isDuplicate(
  userId: string,
  type: ContextType,
  value: string,
  rawPhrase?: string
): Promise<boolean> {
  const bank = await getUserContextBank(userId);
  const today = new Date().toISOString().slice(0, 10);
  const normalizedValue = value.trim().toLowerCase();
  const normalizedRaw = rawPhrase?.trim().toLowerCase();

  return bank.some((item) => {
    const sameType = item.type === type;
    const sameValue = item.value.trim().toLowerCase() === normalizedValue;
    const sameDay = item.createdAt.slice(0, 10) === today;
    const sameRaw = normalizedRaw
      ? item.rawPhrase.trim().toLowerCase() === normalizedRaw
      : true;

    return sameType && sameValue && sameDay && sameRaw;
  });
}

export async function archiveContextItem(
  userId: string,
  itemId: string
): Promise<boolean> {
  const result = await updateContextItem(userId, itemId, {
    state: "archived",
  });

  return result !== null;
}

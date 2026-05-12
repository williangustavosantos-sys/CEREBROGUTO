import {
  readMemoryStoreAsync,
  writeMemoryStoreAsync,
} from "../memory-store";
import type { DailyHook } from "./types";

function asUserMemory(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export async function addDailyHook(userId: string, hook: DailyHook): Promise<void> {
  const memory = await readMemoryStoreAsync();
  const userMemory = asUserMemory(memory[userId]);
  const hooks: DailyHook[] = Array.isArray(userMemory.dailyHooks)
    ? (userMemory.dailyHooks as DailyHook[])
    : [];
  hooks.push(hook);
  userMemory.dailyHooks = hooks;
  memory[userId] = userMemory;
  await writeMemoryStoreAsync(memory);
}

export async function getDailyHooks(userId: string): Promise<DailyHook[]> {
  const memory = await readMemoryStoreAsync();
  const userMemory = asUserMemory(memory[userId]);
  return Array.isArray(userMemory.dailyHooks) ? (userMemory.dailyHooks as DailyHook[]) : [];
}

export async function getActiveDailyHooks(
  userId: string,
  now: string = new Date().toISOString()
): Promise<DailyHook[]> {
  const all = await getDailyHooks(userId);
  return all.filter(
    (h) =>
      !h.staleAfter || h.staleAfter > now
  );
}

export async function markHookUsed(
  userId: string,
  hookId: string
): Promise<void> {
  const now = new Date().toISOString();
  const memory = await readMemoryStoreAsync();
  const userMemory = asUserMemory(memory[userId]);
  const hooks: DailyHook[] = Array.isArray(userMemory.dailyHooks)
    ? (userMemory.dailyHooks as DailyHook[])
    : [];
  const updated = hooks.map((h) =>
    h.id === hookId ? { ...h, usedAt: now } : h
  );
  userMemory.dailyHooks = updated;
  memory[userId] = userMemory;
  await writeMemoryStoreAsync(memory);
}

export async function clearExpiredDailyHooks(
  userId: string,
  now: string = new Date().toISOString()
): Promise<number> {
  const memory = await readMemoryStoreAsync();
  const userMemory = asUserMemory(memory[userId]);
  const hooks: DailyHook[] = Array.isArray(userMemory.dailyHooks)
    ? (userMemory.dailyHooks as DailyHook[])
    : [];
  const before = hooks.length;
  const filtered = hooks.filter((h) => !h.staleAfter || h.staleAfter > now);
  userMemory.dailyHooks = filtered;
  memory[userId] = userMemory;
  await writeMemoryStoreAsync(memory);
  return before - filtered.length;
}

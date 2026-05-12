// Validation Engine — transforma contexto incerto em pergunta segura.
// Regra central: dado confuso não vira ação. Entra na fila, GUTO pergunta, usuário valida.

import {
  readMemoryStoreAsync,
  writeMemoryStoreAsync,
} from "../memory-store";
import { getUserContextBank, updateContextItem } from "./context-bank";
import type {
  ContextItem,
  ContextState,
  DetectedLanguage,
  ValidationBrief,
  ValidationObjective,
  ValidationQueueItem,
  ValidationReason,
  ValidationResolution,
} from "./types";

const MAX_ATTEMPTS = 2;

function asUserMemory(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function nowISO(): string {
  return new Date().toISOString();
}

function addMinutes(dateISO: string, minutes: number): string {
  return new Date(new Date(dateISO).getTime() + minutes * 60_000).toISOString();
}

function generateValidationId(userId: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `val_${userId.slice(0, 6)}_${ts}_${rand}`;
}

function normalizeLanguage(value: unknown): DetectedLanguage {
  return value === "pt" || value === "en" || value === "it" || value === "es" || value === "mixed"
    ? value
    : "mixed";
}

async function getValidationQueue(userId: string): Promise<ValidationQueueItem[]> {
  const memory = await readMemoryStoreAsync();
  const userMemory = asUserMemory(memory[userId]);
  if (!Array.isArray(userMemory.validationQueue)) return [];

  const current = nowISO();
  const queue = userMemory.validationQueue as ValidationQueueItem[];
  const live = queue.map((item) => {
    if (item.status === "pending" && item.expiresAt && item.expiresAt <= current) {
      return { ...item, status: "expired" as const, updatedAt: current };
    }
    return item;
  });

  if (JSON.stringify(queue) !== JSON.stringify(live)) {
    userMemory.validationQueue = live;
    memory[userId] = userMemory;
    await writeMemoryStoreAsync(memory);
  }

  return live;
}

async function saveValidationQueue(
  userId: string,
  queue: ValidationQueueItem[]
): Promise<void> {
  const memory = await readMemoryStoreAsync();
  const userMemory = asUserMemory(memory[userId]);
  userMemory.validationQueue = queue;
  memory[userId] = userMemory;
  await writeMemoryStoreAsync(memory);
}

function getValidationReason(item: ContextItem): ValidationReason | null {
  if (item.state === "blocked_unknown") return "blocked_unknown";
  if (item.type === "health_signal" && item.state !== "validated" && item.state !== "active") {
    return "health_safety_check";
  }
  if (item.type === "future_event" && item.state === "needs_validation") {
    return "future_event_check";
  }
  if (item.state === "needs_validation") return "needs_validation";
  return null;
}

function getPriority(reason: ValidationReason): number {
  switch (reason) {
    case "health_safety_check":
      return 100;
    case "blocked_unknown":
      return 90;
    case "future_event_check":
      return 70;
    case "needs_validation":
      return 50;
  }
}

function getObjective(reason: ValidationReason): ValidationObjective {
  switch (reason) {
    case "blocked_unknown":
      return "clarify_unknown_term";
    case "health_safety_check":
      return "confirm_health_signal";
    case "future_event_check":
      return "confirm_future_event";
    case "needs_validation":
      return "confirm_user_context";
  }
}

function shouldQueueContextItem(item: ContextItem): boolean {
  return getValidationReason(item) !== null;
}

function buildQueueItem(userId: string, item: ContextItem): ValidationQueueItem | null {
  const reason = getValidationReason(item);
  if (!reason) return null;

  const current = nowISO();
  const language = normalizeLanguage(item.meta?.language);

  return {
    id: generateValidationId(userId),
    userId,
    contextItemId: item.id,
    contextType: item.type,
    contextValue: item.value,
    rawPhrase: item.rawPhrase,
    reason,
    status: "pending",
    priority: getPriority(reason),
    language,
    attempts: 0,
    askAfter: current,
    createdAt: current,
    updatedAt: current,
    askedAt: null,
    resolvedAt: null,
    expiresAt: addMinutes(current, reason === "health_safety_check" ? 60 * 24 * 14 : 60 * 24 * 7),
    meta: {
      bodyPart: item.meta?.bodyPart ?? null,
      originalType: item.meta?.originalType ?? null,
    },
  };
}

export async function syncValidationQueue(userId: string): Promise<{
  created: number;
  pending: number;
}> {
  const bank = await getUserContextBank(userId);
  const queue = await getValidationQueue(userId);
  const activeContextIds = new Set(
    queue
      .filter((item) => item.status === "pending" || item.status === "asked")
      .map((item) => item.contextItemId)
  );

  const newItems: ValidationQueueItem[] = [];
  for (const contextItem of bank) {
    if (!shouldQueueContextItem(contextItem)) continue;
    if (activeContextIds.has(contextItem.id)) continue;

    const queueItem = buildQueueItem(userId, contextItem);
    if (queueItem) newItems.push(queueItem);
  }

  if (newItems.length > 0) {
    await saveValidationQueue(userId, [...queue, ...newItems]);
  }

  const updatedQueue = newItems.length > 0 ? [...queue, ...newItems] : queue;
  return {
    created: newItems.length,
    pending: updatedQueue.filter((item) => item.status === "pending").length,
  };
}

export async function getPendingValidations(
  userId: string,
  currentISO = nowISO()
): Promise<ValidationQueueItem[]> {
  await syncValidationQueue(userId);
  const queue = await getValidationQueue(userId);

  return queue
    .filter((item) => item.status === "pending")
    .filter((item) => item.askAfter <= currentISO)
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

export function buildValidationBrief(item: ValidationQueueItem): ValidationBrief {
  const bodyPart = typeof item.meta?.bodyPart === "string" ? item.meta.bodyPart : null;
  const objective = getObjective(item.reason);

  return {
    objective,
    reason: item.reason,
    target: {
      contextItemId: item.contextItemId,
      contextType: item.contextType,
      contextValue: item.contextValue,
      rawPhrase: item.rawPhrase,
      bodyPart,
    },
    user: {
      language: item.language,
    },
    facts: {
      mustConfirm: [item.contextValue],
      mustAvoid: [
        "cadastro",
        "sistema",
        "erro",
        "adicionar patologia",
        "diagnóstico médico",
      ],
    },
    style: {
      mode: item.reason === "health_safety_check" ? "care" : item.reason === "blocked_unknown" ? "clarify" : "confirm",
      maxSentences: 2,
      allowMedicalAdvice: false,
    },
  };
}

export async function markValidationAsked(
  userId: string,
  validationId: string
): Promise<ValidationQueueItem | null> {
  const queue = await getValidationQueue(userId);
  const index = queue.findIndex((item) => item.id === validationId);
  if (index === -1) return null;

  const current = nowISO();
  const attempts = queue[index].attempts + 1;

  queue[index] = {
    ...queue[index],
    status: attempts >= MAX_ATTEMPTS ? "dismissed" : "asked",
    attempts,
    askedAt: current,
    updatedAt: current,
    askAfter: addMinutes(current, 60 * 12),
  };

  await saveValidationQueue(userId, queue);
  return queue[index];
}

function stateForResolution(resolution: ValidationResolution): ContextState {
  switch (resolution) {
    case "confirmed":
    case "clarified":
      return "active";
    case "rejected":
    case "ignored":
      return "archived";
  }
}

export async function resolveValidation(
  userId: string,
  validationId: string,
  resolution: ValidationResolution,
  clarifiedValue?: string
): Promise<ValidationQueueItem | null> {
  const queue = await getValidationQueue(userId);
  const index = queue.findIndex((item) => item.id === validationId);
  if (index === -1) return null;

  const current = nowISO();
  const item = queue[index];

  const patch: Partial<Pick<ContextItem, "state" | "confidence" | "value" | "meta">> = {
    state: stateForResolution(resolution),
    confidence: resolution === "confirmed" || resolution === "clarified" ? 1 : item.reason === "blocked_unknown" ? 0 : undefined,
  };

  if (resolution === "clarified" && clarifiedValue?.trim()) {
    patch.value = clarifiedValue.trim().slice(0, 240);
    // Preserve existing meta and merge with validation fields
    patch.meta = {
      ...(item.meta ?? {}),
      validationResolution: resolution,
      originalUnclearValue: item.contextValue,
      clarifiedAt: current,
    } as unknown as ContextItem["meta"]; // safe because meta has index signature
  }

  await updateContextItem(userId, item.contextItemId, patch);

  queue[index] = {
    ...item,
    status: resolution === "ignored" ? "dismissed" : "resolved",
    resolvedAt: current,
    updatedAt: current,
    meta: {
      ...item.meta,
      resolution,
      clarifiedValue: clarifiedValue ?? null,
    },
  };

  await saveValidationQueue(userId, queue);
  return queue[index];
}

export async function getValidationQueueForDebug(userId: string): Promise<ValidationQueueItem[]> {
  return getValidationQueue(userId);
}

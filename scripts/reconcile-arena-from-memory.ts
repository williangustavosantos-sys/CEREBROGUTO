import "dotenv/config";
import { Redis } from "@upstash/redis";
import { config } from "../src/config.js";
import {
  mutateArenaStoreAsync,
  readArenaStoreAsync,
  type ArenaProfile,
  type ArenaStore,
  type ArenaXpEvent,
} from "../src/arena-store.js";
import { getGutoEvolutionStage } from "../src/guto-evolution.js";

type RecordValue = Record<string, unknown>;
type MemoryXpEvent = { id?: string; type?: string; amount?: number; date?: string; createdAt?: string };

const apply = process.argv.includes("--apply");
if (!config.upstashRedisUrl || !config.upstashRedisToken) {
  throw new Error("UPSTASH_REDIS_REST_URL/TOKEN are required.");
}

const redis = new Redis({ url: config.upstashRedisUrl, token: config.upstashRedisToken });

function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function parseStore(value: unknown): RecordValue {
  let parsed = value;
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  return asRecord(parsed);
}

function dateKey(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function mondayKey(day: string): string {
  const noon = new Date(`${day}T12:00:00.000Z`);
  const weekday = noon.getUTCDay();
  noon.setUTCDate(noon.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  return noon.toISOString().slice(0, 10);
}

function arenaTypesForMemoryEvent(event: MemoryXpEvent): ArenaXpEvent["type"][] {
  if (event.type === "grant_initial_xp") return ["bonus"];
  if (event.type === "complete_daily_mission") return ["workout_validated", "workout_completion_delta", "bonus"];
  if (event.type === "accept_adapted_mission") return ["reduced_mission_validated"];
  if (event.type === "apply_daily_miss_penalty") return ["miss_penalty"];
  return [];
}

function eventRepresented(events: ArenaXpEvent[], memoryEvent: MemoryXpEvent): boolean {
  const types = arenaTypesForMemoryEvent(memoryEvent);
  return events.some((event) =>
    types.includes(event.type) &&
    event.xp === memoryEvent.amount &&
    event.createdAt.slice(0, 10) === memoryEvent.date
  );
}

function syntheticArenaEvent(
  userId: string,
  arenaGroupId: string,
  memoryEvent: MemoryXpEvent,
  adaptedDates: Set<string>
): ArenaXpEvent | null {
  const type = memoryEvent.type === "grant_initial_xp" ? "bonus"
    : memoryEvent.type === "accept_adapted_mission" ? "reduced_mission_validated"
    : memoryEvent.type === "apply_daily_miss_penalty" ? "miss_penalty"
    : memoryEvent.type === "complete_daily_mission"
      ? (adaptedDates.has(memoryEvent.date || "") ? "workout_completion_delta" : "workout_validated")
      : null;
  if (!type || typeof memoryEvent.amount !== "number" || !memoryEvent.date) return null;
  const sourceId = memoryEvent.id || `${memoryEvent.date}:${memoryEvent.type}`;
  return {
    id: `memory:${userId}:${sourceId}`,
    userId,
    arenaGroupId,
    type,
    xp: memoryEvent.amount,
    sourceValidationId: sourceId,
    createdAt: memoryEvent.createdAt || `${memoryEvent.date}T12:00:00.000Z`,
  };
}

function reconcileProfile(
  store: ArenaStore,
  userId: string,
  memory: RecordValue,
  access: RecordValue,
  now: Date
): void {
  const xpEvents = Array.isArray(memory.xpEvents) ? memory.xpEvents.map((event) => asRecord(event) as MemoryXpEvent) : [];
  const totalXp = typeof memory.totalXp === "number" && Number.isFinite(memory.totalXp) ? Math.max(0, memory.totalXp) : 0;
  const arenaGroupId = typeof access.teamId === "string" && access.teamId.trim() ? access.teamId : "GUTO_CORE";
  const displayName = typeof memory.name === "string" && memory.name.trim() ? memory.name.trim() : userId;
  const today = dateKey(now);
  const currentWeek = mondayKey(today);
  const currentMonth = today.slice(0, 7);
  const periodEvents = xpEvents.filter((event) => event.type !== "grant_initial_xp");
  const weeklyXp = Math.max(0, periodEvents.filter((event) => event.date && mondayKey(event.date) === currentWeek).reduce((sum, event) => sum + (event.amount || 0), 0));
  const monthlyXp = Math.max(0, periodEvents.filter((event) => event.date?.slice(0, 7) === currentMonth).reduce((sum, event) => sum + (event.amount || 0), 0));
  const validatedDates = new Set(
    xpEvents
      .filter((event) => event.type === "complete_daily_mission" || event.type === "accept_adapted_mission")
      .map((event) => event.date)
      .filter((day): day is string => Boolean(day))
  );
  const lastWorkoutAt = xpEvents
    .filter((event) => event.type === "complete_daily_mission" || event.type === "accept_adapted_mission")
    .map((event) => event.createdAt || "")
    .sort()
    .at(-1) || null;
  const lastXpAt = xpEvents.map((event) => event.createdAt || "").sort().at(-1) || null;
  const existing = store.profiles[userId];
  const timestamp = now.toISOString();
  const profile: ArenaProfile = {
    userId,
    displayName,
    pairName: existing?.pairName || `GUTO & ${displayName.toUpperCase()}`,
    arenaGroupId,
    avatarStage: getGutoEvolutionStage(totalXp),
    totalXp,
    weeklyXp,
    monthlyXp,
    validatedWorkoutsTotal: validatedDates.size,
    validatedWorkoutsWeek: [...validatedDates].filter((day) => mondayKey(day) === currentWeek).length,
    validatedWorkoutsMonth: [...validatedDates].filter((day) => day.slice(0, 7) === currentMonth).length,
    currentStreak: typeof memory.streak === "number" && Number.isFinite(memory.streak) ? Math.max(0, memory.streak) : 0,
    lastWorkoutValidatedAt: lastWorkoutAt,
    lastXpAt,
    createdAt: existing?.createdAt || (typeof access.createdAt === "string" ? access.createdAt : timestamp),
    updatedAt: timestamp,
  };
  store.profiles[userId] = profile;

  const userArenaEvents = store.events.filter((event) => event.userId === userId);
  const adaptedDates = new Set(xpEvents.filter((event) => event.type === "accept_adapted_mission").map((event) => event.date || ""));
  for (const memoryEvent of xpEvents) {
    if (eventRepresented(userArenaEvents, memoryEvent)) continue;
    const synthetic = syntheticArenaEvent(userId, arenaGroupId, memoryEvent, adaptedDates);
    if (synthetic && !store.events.some((event) => event.id === synthetic.id)) store.events.push(synthetic);
  }
}

const [memoryRaw, accessRaw, currentArena] = await Promise.all([
  redis.get("guto:memory"),
  redis.get("guto:user-access"),
  readArenaStoreAsync(),
]);
const memories = parseStore(memoryRaw);
const accessUsers = asRecord(parseStore(accessRaw).users);

function selectRepairs(store: ArenaStore): string[] {
  const selected: string[] = [];
  for (const [userId, rawMemory] of Object.entries(memories)) {
    const memory = asRecord(rawMemory);
    const access = asRecord(accessUsers[userId]);
    if (access.role !== "student" || access.active !== true || access.archived === true) continue;
    const memoryTotal = typeof memory.totalXp === "number" ? memory.totalXp : 0;
    const arenaTotal = store.profiles[userId]?.totalXp ?? 0;
    if (memoryTotal === arenaTotal) continue;
    const memoryEvents = Array.isArray(memory.xpEvents) ? memory.xpEvents.map((event) => asRecord(event) as MemoryXpEvent) : [];
    const arenaEvents = store.events.filter((event) => event.userId === userId);
    const missingEvidence = memoryEvents.some((event) => !eventRepresented(arenaEvents, event));
    // Existing scoped admin resets intentionally leave memory and Arena totals
    // different. Preserve them when the complete memory ledger is represented.
    if (memoryTotal === 0 || missingEvidence) selected.push(userId);
  }
  return selected;
}

const candidates = selectRepairs(currentArena);
if (apply && candidates.length > 0) {
  await mutateArenaStoreAsync((store) => {
    for (const userId of candidates) {
      reconcileProfile(store, userId, asRecord(memories[userId]), asRecord(accessUsers[userId]), new Date());
    }
  });
}

const after = apply ? await readArenaStoreAsync() : currentArena;
console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  activeCandidates: candidates.length,
  repaired: apply ? candidates.filter((userId) => (after.profiles[userId]?.totalXp ?? 0) === (asRecord(memories[userId]).totalXp ?? 0)).length : 0,
  preservedPossibleAdminResets: Object.entries(memories).filter(([userId, rawMemory]) => {
    const access = asRecord(accessUsers[userId]);
    if (access.role !== "student" || access.active !== true || access.archived === true) return false;
    const memory = asRecord(rawMemory);
    return (memory.totalXp ?? 0) !== (after.profiles[userId]?.totalXp ?? 0) && !candidates.includes(userId);
  }).length,
}, null, 2));

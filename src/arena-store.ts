import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARENA_STORE_PATH = path.join(__dirname, "../tmp/arena-store.json");

export type AvatarStage = "baby" | "teen" | "adult" | "elite";

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
  createdAt: string;
  updatedAt: string;
}

export interface ArenaXpEvent {
  id: string;
  userId: string;
  arenaGroupId: string;
  type: "workout_validated" | "reduced_mission_validated" | "bonus";
  xp: number;
  workoutFocus?: string;
  sourceValidationId?: string;
  createdAt: string;
}

interface ArenaStore {
  profiles: Record<string, ArenaProfile>;
  events: ArenaXpEvent[];
}

function ensureStoreFile(): void {
  if (!fs.existsSync(ARENA_STORE_PATH)) {
    fs.mkdirSync(path.dirname(ARENA_STORE_PATH), { recursive: true });
    fs.writeFileSync(ARENA_STORE_PATH, JSON.stringify({ profiles: {}, events: [] }, null, 2));
  }
}

export function readArenaStore(): ArenaStore {
  ensureStoreFile();
  try {
    return JSON.parse(fs.readFileSync(ARENA_STORE_PATH, "utf-8")) as ArenaStore;
  } catch {
    return { profiles: {}, events: [] };
  }
}

export function writeArenaStore(store: ArenaStore): void {
  ensureStoreFile();
  fs.writeFileSync(ARENA_STORE_PATH, JSON.stringify(store, null, 2));
}

export function getArenaProfile(userId: string): ArenaProfile | undefined {
  const store = readArenaStore();
  return store.profiles[userId];
}

export function saveArenaProfile(profile: ArenaProfile): void {
  const store = readArenaStore();
  store.profiles[profile.userId] = profile;
  writeArenaStore(store);
}

export function appendArenaEvent(event: ArenaXpEvent): void {
  const store = readArenaStore();
  store.events.push(event);
  writeArenaStore(store);
}

export function getProfilesByGroup(arenaGroupId: string): ArenaProfile[] {
  const store = readArenaStore();
  return Object.values(store.profiles).filter((p) => p.arenaGroupId === arenaGroupId);
}

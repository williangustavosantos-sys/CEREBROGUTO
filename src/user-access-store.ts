import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_ACCESS_STORE_PATH = path.join(__dirname, "../tmp/user-access.json");

export type UserRole = "student" | "coach" | "admin";

export interface UserAccess {
  userId: string;
  role: UserRole;
  coachId: string;
  active: boolean;
  visibleInArena: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface UserAccessStore {
  users: Record<string, UserAccess>;
}

const DEV_COACH_ID = process.env.DEV_COACH_ID ?? "will-coach";

function ensureStoreFile(): void {
  if (!fs.existsSync(USER_ACCESS_STORE_PATH)) {
    fs.mkdirSync(path.dirname(USER_ACCESS_STORE_PATH), { recursive: true });
    fs.writeFileSync(
      USER_ACCESS_STORE_PATH,
      JSON.stringify({ users: {} }, null, 2)
    );
  }
}

function readStore(): UserAccessStore {
  ensureStoreFile();
  try {
    return JSON.parse(
      fs.readFileSync(USER_ACCESS_STORE_PATH, "utf-8")
    ) as UserAccessStore;
  } catch {
    return { users: {} };
  }
}

function writeStore(store: UserAccessStore): void {
  ensureStoreFile();
  fs.writeFileSync(USER_ACCESS_STORE_PATH, JSON.stringify(store, null, 2));
}

export function getUserAccess(userId: string): UserAccess | undefined {
  return readStore().users[userId];
}

export function getEffectiveUserAccess(userId: string): UserAccess {
  const now = new Date().toISOString();
  return (
    getUserAccess(userId) ?? {
      userId,
      role: "student",
      coachId: DEV_COACH_ID,
      active: true,
      visibleInArena: true,
      archived: false,
      createdAt: now,
      updatedAt: now,
    }
  );
}

export function upsertUserAccess(
  userId: string,
  patch: Partial<Omit<UserAccess, "userId" | "createdAt">>
): UserAccess {
  const store = readStore();
  const now = new Date().toISOString();
  const existing = store.users[userId];
  const updated: UserAccess = {
    userId,
    role: existing?.role ?? "student",
    coachId: existing?.coachId ?? DEV_COACH_ID,
    active: existing?.active ?? true,
    visibleInArena: existing?.visibleInArena ?? true,
    archived: existing?.archived ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...patch,
  };
  store.users[userId] = updated;
  writeStore(store);
  return updated;
}

export function deleteUserAccessHard(userId: string): void {
  const store = readStore();
  delete store.users[userId];
  writeStore(store);
}

export function getAllUserAccess(): UserAccess[] {
  return Object.values(readStore().users);
}

export function writeUserAccessStoreRaw(store: { users: Record<string, UserAccess> }): void {
  writeStore(store);
}

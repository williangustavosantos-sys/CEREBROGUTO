import express, { Request, Response, NextFunction } from "express";
import {
  getUserAccess,
  getEffectiveUserAccess,
  upsertUserAccess,
  deleteUserAccessHard,
  getAllUserAccess,
  type UserAccess,
} from "./user-access-store.js";
import {
  getArenaProfile,
  saveArenaProfile,
  readArenaStore,
  writeArenaStore,
} from "./arena-store.js";
import { getAvatarStage } from "./arena.js";
import {
  readMemoryStoreSync,
  writeMemoryStoreSync,
} from "./memory-store.js";

export const coachRouter = express.Router();

// ─── Auth middleware ───────────────────────────────────────────────────────

coachRouter.use((req: Request, res: Response, next: NextFunction) => {
  const incoming = (req.headers["x-coach-id"] as string) || (req.query.coachId as string);
  const DEV_COACH_ID = process.env.DEV_COACH_ID ?? "will-coach";
  if (incoming !== DEV_COACH_ID) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────

type StoredMemory = {
  userId?: string;
  name?: string;
  totalXp?: number;
  streak?: number;
  lastActiveAt?: string;
  validationHistory?: Array<{ createdAt?: string }>;
  xpEvents?: unknown[];
  completedWorkoutDates?: string[];
  adaptedMissionDates?: string[];
  missedMissionDates?: string[];
};

function buildStudentView(userId: string) {
  const store = readMemoryStoreSync() as Record<string, StoredMemory>;
  const memory: StoredMemory = store[userId] ?? {};
  const access = getEffectiveUserAccess(userId);
  const arena = getArenaProfile(userId);

  const lastValidation =
    arena?.lastWorkoutValidatedAt ??
    (memory.validationHistory?.length
      ? memory.validationHistory[memory.validationHistory.length - 1]?.createdAt ?? null
      : null);

  return {
    userId,
    name: memory.name || userId,
    role: access.role,
    coachId: access.coachId,
    active: access.active,
    visibleInArena: access.visibleInArena,
    archived: access.archived,
    weeklyXp: arena?.weeklyXp ?? 0,
    monthlyXp: arena?.monthlyXp ?? 0,
    totalXp: arena?.totalXp ?? memory.totalXp ?? 0,
    avatarStage: arena?.avatarStage ?? "baby",
    currentStreak: arena?.currentStreak ?? memory.streak ?? 0,
    validationsTotal: arena?.validatedWorkoutsTotal ?? (memory.validationHistory?.length ?? 0),
    lastValidationAt: lastValidation,
    lastActiveAt: memory.lastActiveAt ?? null,
    createdAt: access.createdAt,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────

// GET /guto/coach/students
coachRouter.get("/students", (req: Request, res: Response) => {
  const includeArchived = req.query.includeArchived === "true";
  const store = readMemoryStoreSync() as Record<string, unknown>;

  const memoryIds = new Set(Object.keys(store));
  const accessIds = new Set(getAllUserAccess().map((u) => u.userId));
  const allIds = [...new Set([...memoryIds, ...accessIds])];

  const students = allIds
    .map((userId) => buildStudentView(userId))
    .filter((s) => includeArchived || !s.archived);

  res.json({ students });
});

// GET /guto/coach/student/:userId
coachRouter.get("/student/:userId", (req: Request, res: Response) => {
  const userId = req.params["userId"] as string;
  const store = readMemoryStoreSync() as Record<string, unknown>;
  const access = getUserAccess(userId);

  if (!store[userId] && !access) {
    res.status(404).json({ error: "student_not_found" });
    return;
  }

  res.json(buildStudentView(userId));
});

// PATCH /guto/coach/student/:userId
coachRouter.patch("/student/:userId", express.json(), (req: Request, res: Response) => {
  const userId = req.params["userId"] as string;
  const { name, role, coachId, visibleInArena, active, archived } = req.body as Partial<UserAccess & { name: string }>;

  if (typeof name === "string" && name.trim()) {
    const store = readMemoryStoreSync() as Record<string, StoredMemory>;
    const memory: StoredMemory = store[userId] ?? { userId };
    memory.name = name.trim();
    const arena = getArenaProfile(userId);
    if (arena) {
      arena.displayName = name.trim();
      saveArenaProfile(arena);
    }
    store[userId] = memory;
    writeMemoryStoreSync(store);
  }

  const patch: Partial<Omit<UserAccess, "userId" | "createdAt">> = {};
  if (role !== undefined) patch.role = role;
  if (coachId !== undefined) patch.coachId = coachId;
  if (visibleInArena !== undefined) patch.visibleInArena = visibleInArena;
  if (active !== undefined) patch.active = active;
  if (archived !== undefined) patch.archived = archived;

  upsertUserAccess(userId, patch);
  res.json(buildStudentView(userId));
});

// PATCH /guto/coach/student/:userId/access
coachRouter.patch("/student/:userId/access", express.json(), (req: Request, res: Response) => {
  const userId = req.params["userId"] as string;
  const { active } = req.body as { active?: boolean };

  if (typeof active !== "boolean") {
    res.status(400).json({ error: "active must be a boolean" });
    return;
  }

  upsertUserAccess(userId, { active });
  res.json(buildStudentView(userId));
});

// POST /guto/coach/student/:userId/reset
coachRouter.post("/student/:userId/reset", express.json(), (req: Request, res: Response) => {
  const userId = req.params["userId"] as string;
  const { scope } = req.body as {
    scope?: "weekly" | "monthly" | "individual" | "validationHistory" | "all";
  };

  const validScopes = ["weekly", "monthly", "individual", "validationHistory", "all"];
  if (!scope || !validScopes.includes(scope)) {
    res.status(400).json({ error: `scope must be one of: ${validScopes.join(", ")}` });
    return;
  }

  const arena = getArenaProfile(userId);
  if (arena) {
    if (scope === "weekly" || scope === "all") {
      arena.weeklyXp = 0;
      arena.validatedWorkoutsWeek = 0;
    }
    if (scope === "monthly" || scope === "all") {
      arena.monthlyXp = 0;
      arena.validatedWorkoutsMonth = 0;
    }
    if (scope === "individual" || scope === "all") {
      arena.totalXp = 0;
      arena.validatedWorkoutsTotal = 0;
      arena.avatarStage = getAvatarStage(0);
    }
    if (scope === "all") {
      arena.currentStreak = 0;
      arena.lastWorkoutValidatedAt = null;
    }
    arena.updatedAt = new Date().toISOString();
    saveArenaProfile(arena);
  }

  if (scope === "validationHistory" || scope === "all") {
    const store = readMemoryStoreSync() as Record<string, StoredMemory>;
    const memory: StoredMemory = store[userId] ?? {};
    memory.validationHistory = [];
    if (scope === "all") {
      memory.streak = 0;
      memory.totalXp = 0;
      memory.xpEvents = [];
      memory.completedWorkoutDates = [];
      memory.adaptedMissionDates = [];
      memory.missedMissionDates = [];
    }
    store[userId] = memory;
    writeMemoryStoreSync(store);
  }

  res.json({ success: true, scope, userId });
});

// DELETE /guto/coach/student/:userId  — soft archive
coachRouter.delete("/student/:userId", (req: Request, res: Response) => {
  const userId = req.params["userId"] as string;
  upsertUserAccess(userId, {
    active: false,
    visibleInArena: false,
    archived: true,
  });
  res.json({ success: true, archived: true, userId });
});

// POST /guto/coach/student/:userId/hard-delete  — full removal (dev/admin only)
coachRouter.post("/student/:userId/hard-delete", (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = process.env.ADMIN_KEY;

  if (!expectedKey) {
    res.status(403).json({ error: "hard_delete_not_configured", message: "ADMIN_KEY not set on server." });
    return;
  }
  if (adminKey !== expectedKey) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const userId = req.params["userId"] as string;

  const store = readMemoryStoreSync() as Record<string, unknown>;
  delete store[userId];
  writeMemoryStoreSync(store);

  const arenaStore = readArenaStore();
  delete arenaStore.profiles[userId];
  arenaStore.events = arenaStore.events.filter((e) => e.userId !== userId);
  writeArenaStore(arenaStore);

  deleteUserAccessHard(userId);

  res.status(204).send();
});

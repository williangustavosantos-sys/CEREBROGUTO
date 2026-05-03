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
  readMemoryStoreAsync,
  writeMemoryStoreAsync,
  readMemoryStoreSync,
  writeMemoryStoreSync,
} from "./memory-store.js";
import { deleteDietPlan } from "./diet-store.js";

export const coachRouter = express.Router();

// ─── Auth middleware ───────────────────────────────────────────────────────────

coachRouter.use((req: Request, res: Response, next: NextFunction) => {
  const incoming = (req.headers["x-coach-id"] as string) || (req.query.coachId as string);
  const DEV_COACH_ID = process.env.DEV_COACH_ID ?? "will-coach";
  if (incoming !== DEV_COACH_ID) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Remove o userId de todos os stores. Após isso, o mesmo userId começa do zero
 * na próxima vez que abrir o app.
 *
 * Note: imagens em tmp/validation-images/ não são indexadas por userId.
 * Futuramente, nomear imagens como {userId}-{timestamp}.jpg para limpeza total.
 */
async function deleteUserEverywhere(userId: string): Promise<void> {
  // 1. Memory store — async para garantir limpeza no Redis em produção
  const memStore = await readMemoryStoreAsync();
  delete memStore[userId];
  await writeMemoryStoreAsync(memStore);

  // 2. Arena store (filesystem)
  const arenaStore = readArenaStore();
  delete arenaStore.profiles[userId];
  arenaStore.events = arenaStore.events.filter((e) => e.userId !== userId);
  writeArenaStore(arenaStore);

  // 3. User access record
  deleteUserAccessHard(userId);

  // 4. Diet plan (async — também limpa Redis)
  await deleteDietPlan(userId);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

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

// PATCH /guto/coach/student/:userId/archive — soft archive (preserva dados, apenas bloqueia)
coachRouter.patch("/student/:userId/archive", (req: Request, res: Response) => {
  const userId = req.params["userId"] as string;
  upsertUserAccess(userId, {
    active: false,
    visibleInArena: false,
    archived: true,
  });
  res.json({ success: true, archived: true, userId });
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

// POST /guto/coach/student/create
coachRouter.post("/student/create", express.json(), (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }

  const coachId = (req.headers["x-coach-id"] as string) || (req.query.coachId as string) || "will-coach";
  const userId = `student-${Date.now()}`;
  const cleanName = name.trim();

  upsertUserAccess(userId, {
    role: "student",
    coachId: coachId,
    active: true,
    visibleInArena: true,
    archived: false,
  });

  saveArenaProfile({
    userId,
    displayName: cleanName,
    pairName: "",
    arenaGroupId: "default",
    avatarStage: "baby",
    totalXp: 0,
    weeklyXp: 0,
    monthlyXp: 0,
    validatedWorkoutsTotal: 0,
    validatedWorkoutsWeek: 0,
    validatedWorkoutsMonth: 0,
    currentStreak: 0,
    lastWorkoutValidatedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const store = readMemoryStoreSync() as Record<string, StoredMemory>;
  store[userId] = {
    userId,
    name: cleanName,
    totalXp: 0,
    streak: 0,
    lastActiveAt: new Date().toISOString(),
    validationHistory: [],
  };
  writeMemoryStoreSync(store);

  // Generate conceptual link (could be relative depending on frontend domain)
  // But we send it as requested, or the frontend can build it locally.
  const inviteLink = `https://corpoguto.vercel.app/?inviteUserId=${userId}&presetName=${encodeURIComponent(cleanName)}&forceReset=1`;

  res.json({
    userId,
    name: cleanName,
    inviteLink,
    student: buildStudentView(userId)
  });
});

// DELETE /guto/coach/student/:userId — soft archive (arquivar aluno)
coachRouter.delete("/student/:userId", (req: Request, res: Response) => {
  const userId = req.params["userId"] as string;
  try {
    upsertUserAccess(userId, {
      active: false,
      visibleInArena: false,
      archived: true,
    });
    res.json({
      ok: true,
      archived: true,
      userId,
      message: "Aluno arquivado.",
    });
  } catch (err) {
    res.status(500).json({ error: "archive_failed", message: String(err) });
  }
});

// POST /guto/coach/student/:userId/hard-delete  — mantido para compatibilidade (dev/admin)
coachRouter.post("/student/:userId/hard-delete", async (req: Request, res: Response) => {
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
  try {
    await deleteUserEverywhere(userId);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "delete_failed", message: String(err) });
  }
});

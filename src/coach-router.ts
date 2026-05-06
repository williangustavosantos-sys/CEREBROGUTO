import express, { Request, Response, NextFunction } from "express";
import {
  getUserAccess,
  getEffectiveUserAccess,
  upsertUserAccess,
  deleteUserAccessHard,
  getAllUserAccess,
  writeUserAccessStoreRaw,
  type UserAccess,
} from "./user-access-store.js";
import {
  getArenaProfile,
  saveArenaProfile,
  readArenaStore,
  writeArenaStore,
} from "./arena-store.js";
import { getAvatarStage, getWeeklyRanking, getMonthlyRanking, getIndividualRanking, DEFAULT_ARENA_GROUP } from "./arena.js";
import {
  readMemoryStoreAsync,
  writeMemoryStoreAsync,
  readMemoryStoreSync,
  writeMemoryStoreSync,
} from "./memory-store.js";
import { deleteDietPlan } from "./diet-store.js";
import { createInvite } from "./invite-store.js";
import { config } from "./config.js";
import { requireCoachOrAdmin, requireSuperAdmin } from "./auth-middleware.js";

export const coachRouter = express.Router();
export const coachRankingsRouter = express.Router();

// ─── Auth middleware ───────────────────────────────────────────────────────────

coachRouter.use(requireCoachOrAdmin);

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

function buildStudentView(userId: string, preloadedStore?: Record<string, StoredMemory>) {
  const store = preloadedStore ?? (readMemoryStoreSync() as Record<string, StoredMemory>);
  const memory: StoredMemory = store[userId] ?? {};
  const access = getEffectiveUserAccess(userId);
  const arena = getArenaProfile(userId);

  const lastValidation =
    arena?.lastWorkoutValidatedAt ??
    (memory.validationHistory?.length
      ? memory.validationHistory[memory.validationHistory.length - 1]?.createdAt ?? null
      : null);
  const totalXp = arena?.totalXp ?? memory.totalXp ?? 0;

  return {
    userId,
    name: memory.name || userId,
    role: access?.role ?? "student",
    coachId: access?.coachId ?? "unknown",
    active: access?.active ?? false,
    visibleInArena: access?.visibleInArena ?? false,
    archived: access?.archived ?? false,
    subscriptionStatus: access?.subscriptionStatus ?? "pending_payment",
    subscriptionEndsAt: access?.subscriptionEndsAt ?? null,
    weeklyXp: arena?.weeklyXp ?? 0,
    monthlyXp: arena?.monthlyXp ?? 0,
    totalXp,
    avatarStage: getAvatarStage(totalXp),
    currentStreak: arena?.currentStreak ?? memory.streak ?? 0,
    validationsTotal: arena?.validatedWorkoutsTotal ?? (memory.validationHistory?.length ?? 0),
    lastValidationAt: lastValidation,
    lastActiveAt: memory.lastActiveAt ?? null,
    createdAt: access?.createdAt ?? new Date().toISOString(),
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

function sendRankings(_req: Request, res: Response): void {
  const arenaGroupId = DEFAULT_ARENA_GROUP;
  const weekly = getWeeklyRanking(arenaGroupId);
  const monthly = getMonthlyRanking(arenaGroupId);
  const individual = getIndividualRanking(arenaGroupId);

  res.json({ weekly, monthly, individual });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

coachRankingsRouter.use(requireCoachOrAdmin);
coachRankingsRouter.get("/rankings", sendRankings);

// GET /guto/coach/students
coachRouter.get("/students", (req: Request, res: Response) => {
  const includeArchived = req.query.includeArchived === "true";
  const caller = req.gutoUser!;
  
  const allAccess = getAllUserAccess();
  const studentsAccess = allAccess.filter(u => {
    const isStudent = u.role === "student";
    const matchesCoach = caller.role === "admin" || caller.role === "super_admin" || u.coachId === (caller.coachId || caller.userId);
    const matchesArchived = includeArchived || !u.archived;
    return isStudent && matchesCoach && matchesArchived;
  });

  const memoryStore = readMemoryStoreSync() as Record<string, StoredMemory>;
  const students = studentsAccess.map((s) => buildStudentView(s.userId, memoryStore));

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
coachRouter.post("/student/create", express.json(), async (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }

  const caller = req.gutoUser!;
  const coachId = caller.coachId || caller.userId;
  const userId = `student-${Date.now()}`;
  const cleanName = name.trim();

  // 1. Criar registro de acesso (pausado até claim)
  upsertUserAccess(userId, {
    role: "student",
    coachId: coachId,
    active: false, // Inativo até aceitar o convite
    visibleInArena: true,
    archived: false,
    subscriptionStatus: "pending_payment",
  });

  // 2. Criar convite
  const { invite, rawToken } = await createInvite({
    userId,
    name: cleanName,
    coachId,
  });

  const inviteLink = `${config.frontendPublicUrl}/convite/${rawToken}`;

  res.json({
    userId,
    name: cleanName,
    inviteLink,
    inviteToken: rawToken,
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

// POST /guto/coach/student/:userId/hard-delete
coachRouter.post("/student/:userId/hard-delete", requireSuperAdmin, async (req: Request, res: Response) => {
  const userId = req.params["userId"] as string;
  try {
    await deleteUserEverywhere(userId);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "delete_failed", message: String(err) });
  }
});

// GET /guto/coach/rankings
coachRouter.get("/rankings", sendRankings);

// POST /guto/coach/nuke-all — apaga TODOS os dados de TODOS os usuários
coachRouter.post("/nuke-all", requireSuperAdmin, async (_req: Request, res: Response) => {
  try {
    await writeMemoryStoreAsync({});
    writeArenaStore({ profiles: {}, events: [] });
    writeUserAccessStoreRaw({ users: {} });
    res.json({ ok: true, message: "Todos os dados foram apagados." });
  } catch (err) {
    res.status(500).json({ error: "nuke_failed", message: String(err) });
  }
});

import express, { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import {
  requireCoachOrAdmin,
  requireAdmin,
} from "./auth-middleware.js";
import {
  getUserAccess,
  getAllUserAccessAsync,
  upsertUserAccessAsync,
  deleteUserAccessHardAsync,
  type UserAccess,
  type UserRole,
  type SubscriptionStatus,
  type PaymentStatus,
} from "./user-access-store.js";
import {
  getArenaProfile,
  saveArenaProfile,
  readArenaStore,
  writeArenaStore,
} from "./arena-store.js";
import { getAvatarStage, DEFAULT_ARENA_GROUP } from "./arena.js";
import {
  readMemoryStoreAsync,
  writeMemoryStoreAsync,
} from "./memory-store.js";
import { getMemory, saveMemory, buildWorkoutPlanFromSemanticFocus } from "../server.js";
import { getDietPlan, saveDietPlan, deleteDietPlan } from "./diet-store.js";
import { addLog, getLogs } from "./log-store.js";
import { config } from "./config.js";
import { createInvite, revokeInviteByUserId, updateInviteByUserId } from "./invite-store.js";

export const adminRouter = express.Router();

adminRouter.use(requireCoachOrAdmin);

type PlanSource = "guto_generated" | "coach_manual" | "mixed";
type LooseRecord = Record<string, any>;
type ResetScope = "weekly" | "monthly" | "individual" | "validationHistory" | "all";

const PLAN_SOURCES: PlanSource[] = ["guto_generated", "coach_manual", "mixed"];
const ADMIN_ROLES: UserRole[] = ["admin", "super_admin"];

function isAdminRole(role?: string): boolean {
  return role === "admin" || role === "super_admin";
}

function isCoachRole(role?: string): boolean {
  return role === "coach";
}

function isPlanSource(value: unknown): value is PlanSource {
  return typeof value === "string" && PLAN_SOURCES.includes(value as PlanSource);
}

function asRecord(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseRecord) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function resolveActorId(req: Request): string {
  const caller = req.gutoUser!;
  return caller.role === "coach" ? caller.coachId || caller.userId : caller.userId;
}

function ownsStudent(caller: NonNullable<Request["gutoUser"]>, student: UserAccess): boolean {
  if (isAdminRole(caller.role)) return true;
  if (!isCoachRole(caller.role)) return false;
  return student.role === "student" && student.coachId === (caller.coachId || caller.userId);
}

function requireSuperAdminLike(req: Request, res: Response): boolean {
  const caller = req.gutoUser!;
  if (!isAdminRole(caller.role)) {
    res.status(403).json({ message: "Sem permissão administrativa para esta ação." });
    return false;
  }
  return true;
}

async function getManagedStudent(req: Request, res: Response, userId: string): Promise<UserAccess | null> {
  const student = getUserAccess(userId);
  if (!student || student.role !== "student") {
    res.status(404).json({ message: "Aluno não encontrado." });
    return null;
  }
  if (!ownsStudent(req.gutoUser!, student)) {
    res.status(403).json({ message: "Sem permissão para alterar este aluno." });
    return null;
  }
  return student;
}

function buildStudentView(access: UserAccess) {
  const memory = getMemory(access.userId);
  const arena = getArenaProfile(access.userId);
  const lastValidation =
    arena?.lastWorkoutValidatedAt ??
    (memory.validationHistory?.length
      ? memory.validationHistory[memory.validationHistory.length - 1]?.createdAt ?? null
      : null);

  return {
    ...access,
    name: access.name || memory.name || access.userId,
    weeklyXp: arena?.weeklyXp ?? 0,
    monthlyXp: arena?.monthlyXp ?? 0,
    totalXp: arena?.totalXp ?? memory.totalXp ?? 0,
    avatarStage: arena?.avatarStage ?? "baby",
    currentStreak: arena?.currentStreak ?? memory.streak ?? 0,
    validationsTotal: arena?.validatedWorkoutsTotal ?? (memory.validationHistory?.length ?? 0),
    lastValidationAt: lastValidation,
    lastActiveAt: memory.lastActiveAt ?? null,
  };
}

async function listManagedStudents(req: Request) {
  const caller = req.gutoUser!;
  const allUsers = await getAllUserAccessAsync();
  return allUsers
    .filter((user) => user.role === "student")
    .filter((student) => ownsStudent(caller, student))
    .map(buildStudentView);
}

function setDaysFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function extendSubscription(existing: UserAccess | null, days: number): string {
  const base = existing?.subscriptionEndsAt ? new Date(existing.subscriptionEndsAt) : new Date();
  const now = new Date();
  if (base < now) base.setTime(now.getTime());
  base.setDate(base.getDate() + days);
  return base.toISOString();
}

function buildInviteLink(rawToken: string): string {
  return `${config.frontendPublicUrl}/convite/${rawToken}`;
}

function publicUserPatch(body: Partial<UserAccess>): Partial<Omit<UserAccess, "userId" | "createdAt">> {
  const patch: Partial<Omit<UserAccess, "userId" | "createdAt">> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.email === "string") patch.email = body.email.trim();
  if (typeof body.whatsapp === "string") patch.whatsapp = body.whatsapp.trim();
  if (typeof body.instagram === "string") patch.instagram = body.instagram.trim();
  if (typeof body.country === "string") patch.country = body.country.trim();
  if (typeof body.language === "string") patch.language = body.language;
  if (typeof body.internalNotes === "string") patch.internalNotes = body.internalNotes;
  if (typeof body.coachId === "string") patch.coachId = body.coachId;
  if (typeof body.active === "boolean") patch.active = body.active;
  if (typeof body.visibleInArena === "boolean") patch.visibleInArena = body.visibleInArena;
  if (typeof body.archived === "boolean") patch.archived = body.archived;
  if (typeof body.subscriptionStatus === "string") patch.subscriptionStatus = body.subscriptionStatus as SubscriptionStatus;
  if (typeof body.subscriptionEndsAt === "string" || body.subscriptionEndsAt === null) patch.subscriptionEndsAt = body.subscriptionEndsAt;
  if (typeof body.paymentStatus === "string") patch.paymentStatus = body.paymentStatus as PaymentStatus;
  if (typeof body.plan === "string") patch.plan = body.plan;
  if (typeof body.accessDurationDays === "number") patch.accessDurationDays = body.accessDurationDays;
  return patch;
}

async function updateMemoryFromStudentPatch(userId: string, patch: Partial<UserAccess> & LooseRecord): Promise<void> {
  const memory = getMemory(userId);
  if (typeof patch.name === "string" && patch.name.trim()) memory.name = patch.name.trim();
  const calibration = asRecord(patch.calibration);
  const merged = { ...patch, ...calibration };
  if (typeof merged.userAge !== "undefined" && !Number.isNaN(Number(merged.userAge))) memory.userAge = Number(merged.userAge);
  if (typeof merged.biologicalSex === "string") memory.biologicalSex = merged.biologicalSex;
  if (typeof merged.trainingLevel === "string") memory.trainingLevel = merged.trainingLevel;
  if (typeof merged.trainingGoal === "string") memory.trainingGoal = merged.trainingGoal;
  if (typeof merged.preferredTrainingLocation === "string") memory.preferredTrainingLocation = merged.preferredTrainingLocation;
  if (typeof merged.trainingPathology === "string") memory.trainingPathology = merged.trainingPathology;
  if (typeof merged.country === "string") memory.country = merged.country;
  if (typeof merged.heightCm !== "undefined" && !Number.isNaN(Number(merged.heightCm)) && Number(merged.heightCm) > 0) memory.heightCm = Number(merged.heightCm);
  if (typeof merged.weightKg !== "undefined" && !Number.isNaN(Number(merged.weightKg)) && Number(merged.weightKg) > 0) memory.weightKg = Number(merged.weightKg);
  if (typeof merged.foodRestrictions === "string") memory.foodRestrictions = merged.foodRestrictions;
  saveMemory(memory);
}

async function deleteStudentEverywhere(userId: string): Promise<void> {
  const memStore = await readMemoryStoreAsync();
  delete (memStore as Record<string, unknown>)[userId];
  await writeMemoryStoreAsync(memStore);

  const arenaStore = readArenaStore();
  delete arenaStore.profiles[userId];
  arenaStore.events = arenaStore.events.filter((event) => event.userId !== userId);
  writeArenaStore(arenaStore);

  await deleteDietPlan(userId);
  await deleteUserAccessHardAsync(userId);
  await revokeInviteByUserId(userId);
}

function normalizeWorkoutExercise(rawValue: unknown, index: number): LooseRecord {
  const raw = asRecord(rawValue);
  const name = asString(raw.name, `Exercício ${index + 1}`).trim() || `Exercício ${index + 1}`;
  const restSeconds = raw.restSeconds !== undefined ? asNumber(raw.restSeconds, 0) : undefined;
  const videoUrl = asString(raw.videoUrl, "");
  const sourceFileName = asString(raw.sourceFileName, videoUrl.split("/").filter(Boolean).pop() || "");
  return {
    id: asString(raw.id, `${name.toLowerCase().replace(/[^a-z0-9]+/gi, "-")}-${index + 1}`),
    name,
    canonicalNamePt: asString(raw.canonicalNamePt, name),
    muscleGroup: asString(raw.muscleGroup || raw.group || raw.groupName, "manual"),
    sets: asNumber(raw.sets, 3),
    reps: asString(raw.reps, "10-12"),
    load: raw.load ?? null,
    rest: asString(raw.rest, restSeconds !== undefined ? `${restSeconds}s` : "60s"),
    restSeconds,
    cue: asString(raw.cue || raw.technique || raw.technicalObservation, ""),
    note: asString(raw.note || raw.notes, ""),
    alternatives: normalizeStringArray(raw.alternatives || raw.substitutions),
    order: asNumber(raw.order, index + 1),
    videoUrl,
    videoProvider: "local",
    sourceFileName,
  };
}

function normalizeWorkoutPlan(rawValue: unknown, existing: LooseRecord | null, req: Request, reason?: string): LooseRecord {
  const raw = asRecord(rawValue);
  const blocksInput = Array.isArray(raw.blocks) ? raw.blocks : [];
  const exercisesInput = Array.isArray(raw.exercises)
    ? raw.exercises
    : blocksInput.flatMap((block) => Array.isArray(asRecord(block).exercises) ? asRecord(block).exercises : []);
  const exercises = exercisesInput.map(normalizeWorkoutExercise);
  const existingWasGuto = existing?.source === "guto_generated" || existing?.planSource === "ai_generated";
  const source = isPlanSource(raw.source) ? raw.source : existingWasGuto ? "mixed" : "coach_manual";
  const caller = req.gutoUser!;
  const updatedAt = new Date().toISOString();
  const normalizedBlocks = blocksInput.length
    ? blocksInput.map((blockValue, blockIndex) => {
        const block = asRecord(blockValue);
        const blockExercises = Array.isArray(block.exercises) ? block.exercises : [];
        return {
          name: asString(block.name, blockIndex === 0 ? "Principal" : `Bloco ${blockIndex + 1}`),
          exercises: blockExercises.map(normalizeWorkoutExercise),
        };
      })
    : [{ name: "Principal", exercises }];

  return {
    ...existing,
    ...raw,
    studentId: asString(raw.studentId, asString(raw.userId, asString(existing?.studentId, ""))),
    title: asString(raw.title, asString(raw.focus, asString(existing?.title, "Treino oficial"))),
    focus: asString(raw.focus, asString(raw.title, asString(existing?.focus, "Treino oficial"))),
    focusKey: raw.focusKey ?? existing?.focusKey,
    weekDay: raw.weekDay ?? existing?.weekDay,
    goal: raw.goal ?? existing?.goal,
    location: raw.location ?? existing?.location,
    dateLabel: asString(raw.dateLabel, asString(existing?.dateLabel, "Hoje")),
    scheduledFor: asString(raw.scheduledFor, asString(existing?.scheduledFor, updatedAt)),
    summary: asString(raw.summary, asString(raw.coachNotes, asString(existing?.summary, ""))),
    exercises,
    blocks: normalizedBlocks,
    estimatedDurationMinutes: raw.estimatedDurationMinutes !== undefined ? asNumber(raw.estimatedDurationMinutes, 0) : existing?.estimatedDurationMinutes,
    difficulty: raw.difficulty ?? existing?.difficulty,
    coachNotes: asString(raw.coachNotes, asString(existing?.coachNotes, "")),
    source,
    lockedByCoach: asBoolean(raw.lockedByCoach, asBoolean(existing?.lockedByCoach, false)),
    manualOverride: source !== "guto_generated",
    editedBy: caller.userId,
    editedAt: updatedAt,
    editReason: reason || "Manual adjustment",
    planSource: caller.role === "coach" ? "coach_override" : source === "guto_generated" ? "ai_generated" : "admin_override",
    updatedBy: caller.userId,
    updatedAt,
  };
}

function normalizeDietFood(rawValue: unknown, index: number): LooseRecord {
  const raw = asRecord(rawValue);
  return {
    name: asString(raw.name || raw.food, `Alimento ${index + 1}`),
    quantity: asString(raw.quantity || raw.amount, ""),
    kcal: asNumber(raw.kcal, 0),
    proteinG: raw.proteinG !== undefined ? asNumber(raw.proteinG, 0) : undefined,
    carbsG: raw.carbsG !== undefined ? asNumber(raw.carbsG, 0) : undefined,
    fatG: raw.fatG !== undefined ? asNumber(raw.fatG, 0) : undefined,
    notes: asString(raw.notes, ""),
  };
}

function normalizeDietMeal(rawValue: unknown, index: number): LooseRecord {
  const raw = asRecord(rawValue);
  const foodsInput = Array.isArray(raw.foods) ? raw.foods : Array.isArray(raw.items) ? raw.items : [];
  const foods = foodsInput.map(normalizeDietFood);
  const totalKcal = raw.totalKcal !== undefined
    ? asNumber(raw.totalKcal, 0)
    : raw.kcal !== undefined
      ? asNumber(raw.kcal, 0)
      : foods.reduce((sum, food) => sum + asNumber(food.kcal, 0), 0);
  return {
    id: asString(raw.id, `meal-${index + 1}`),
    name: asString(raw.name, `Refeição ${index + 1}`),
    time: asString(raw.time, ""),
    foods,
    totalKcal,
    kcal: totalKcal,
    gutoNote: asString(raw.gutoNote || raw.notes, ""),
    alternatives: normalizeStringArray(raw.alternatives || raw.substitutions),
  };
}

function normalizeDietPlan(rawValue: unknown, existing: LooseRecord | null, req: Request, userId: string, reason?: string): LooseRecord {
  const raw = asRecord(rawValue);
  const rawMacros = asRecord(raw.macros);
  const caller = req.gutoUser!;
  const updatedAt = new Date().toISOString();
  const existingWasGuto = existing?.source === "guto_generated" || existing?.planSource === "ai_generated";
  const source = isPlanSource(raw.source) ? raw.source : existingWasGuto ? "mixed" : "coach_manual";
  const mealsInput = Array.isArray(raw.meals) ? raw.meals : [];
  const meals = mealsInput.map(normalizeDietMeal);
  const targetKcal = raw.targetKcal !== undefined ? asNumber(raw.targetKcal, 0) : asNumber(rawMacros.targetKcal, asNumber(existing?.macros?.targetKcal, 0));

  return {
    ...existing,
    ...raw,
    userId,
    title: asString(raw.title, asString(existing?.title, "Dieta oficial")),
    generatedAt: asString(raw.generatedAt, asString(existing?.generatedAt, updatedAt)),
    country: asString(raw.country, asString(existing?.country, "")),
    goal: asString(raw.goal, asString(rawMacros.goal, asString(existing?.goal, ""))),
    source,
    lockedByCoach: asBoolean(raw.lockedByCoach, asBoolean(existing?.lockedByCoach, false)),
    macros: {
      bmr: asNumber(rawMacros.bmr, asNumber(existing?.macros?.bmr, 0)),
      tdee: asNumber(rawMacros.tdee, asNumber(existing?.macros?.tdee, targetKcal)),
      targetKcal,
      proteinG: asNumber(rawMacros.proteinG, asNumber(existing?.macros?.proteinG, 0)),
      carbsG: asNumber(rawMacros.carbsG, asNumber(existing?.macros?.carbsG, 0)),
      fatG: asNumber(rawMacros.fatG, asNumber(existing?.macros?.fatG, 0)),
      goal: asString(rawMacros.goal, asString(raw.goal, asString(existing?.macros?.goal, "consistency"))),
    },
    meals,
    foodRestrictions: asString(raw.foodRestrictions || raw.restrictions, asString(existing?.foodRestrictions, "")),
    restrictions: asString(raw.restrictions || raw.foodRestrictions, asString(existing?.restrictions, "")),
    coachNotes: asString(raw.coachNotes, asString(existing?.coachNotes, "")),
    manualOverride: source !== "guto_generated",
    editedBy: caller.userId,
    editedAt: updatedAt,
    editReason: reason || "Manual adjustment",
    planSource: caller.role === "coach" ? "coach_override" : source === "guto_generated" ? "ai_generated" : "admin_override",
    updatedBy: caller.userId,
    updatedAt,
  };
}

function workoutHistory(userId: string) {
  return getLogs({ targetUserId: userId }).filter((log) => log.action.startsWith("workout_"));
}

function dietHistory(userId: string) {
  return getLogs({ targetUserId: userId }).filter((log) => log.action.startsWith("diet_"));
}

function resetArenaAndMemory(userId: string, scope: ResetScope): void {
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
    const memory = getMemory(userId);
    memory.validationHistory = [];
    if (scope === "all") {
      memory.streak = 0;
      memory.totalXp = 0;
      memory.xpEvents = [];
      memory.completedWorkoutDates = [];
      memory.adaptedMissionDates = [];
      memory.missedMissionDates = [];
    }
    saveMemory(memory);
  }
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((error) => {
      console.error("[GUTO_ADMIN] route error:", error);
      res.status(500).json({ message: "Backend recusou a ação: erro interno.", detail: error instanceof Error ? error.message : String(error) });
    });
  };
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] || "" : String(value || "");
}

// ─── Students ────────────────────────────────────────────────────────────────

adminRouter.get(["/students", "/users"], asyncHandler(async (req, res) => {
  const students = await listManagedStudents(req);
  const users = isAdminRole(req.gutoUser?.role)
    ? await getAllUserAccessAsync()
    : students;
  res.json({ students, users });
}));

adminRouter.post(["/students", "/users"], asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const body = req.body as Partial<UserAccess> & { password?: string };
  if (!body.name?.trim()) {
    res.status(400).json({ message: "Nome do aluno é obrigatório." });
    return;
  }
  if (body.role && body.role !== "student") {
    if (!requireSuperAdminLike(req, res)) return;
  }

  const userId = body.userId || `u-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const coachId = isCoachRole(caller.role)
    ? caller.coachId || caller.userId
    : body.coachId || "admin";
  const passwordHash = body.password ? await bcrypt.hash(body.password, 10) : undefined;
  const active = body.active ?? Boolean(passwordHash);
  const durationDays = body.accessDurationDays || 30;
  const subscriptionEndsAt = active ? (body.subscriptionEndsAt || setDaysFromNow(durationDays)) : (body.subscriptionEndsAt || null);

  const user = await upsertUserAccessAsync(userId, {
    ...publicUserPatch(body),
    role: "student",
    coachId,
    active,
    archived: false,
    visibleInArena: body.visibleInArena ?? true,
    subscriptionStatus: active ? "active" : (body.subscriptionStatus ?? "pending_payment"),
    paymentStatus: active ? "active" : (body.paymentStatus ?? "pending_payment"),
    subscriptionEndsAt,
    ...(passwordHash ? { passwordHash } : {}),
  });

  await updateMemoryFromStudentPatch(userId, body);

  let inviteLink = "";
  if (!passwordHash) {
    const { rawToken } = await createInvite({ userId, name: body.name.trim(), coachId });
    inviteLink = buildInviteLink(rawToken);
  }

  addLog({
    action: "user_created",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: userId,
    metadata: { role: "student", coachId, active },
  });

  res.status(201).json({ user, student: buildStudentView(user), inviteLink });
}));

adminRouter.get(["/students/:userId", "/users/:userId"], asyncHandler(async (req, res) => {
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  res.json({ student: buildStudentView(student), user: student, memory });
}));

adminRouter.patch(["/students/:userId", "/users/:userId"], asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const body = req.body as Partial<UserAccess> & LooseRecord;

  if (isCoachRole(caller.role)) {
    delete body.role;
    delete body.passwordHash;
    if (body.coachId && body.coachId !== student.coachId) {
      res.status(403).json({ message: "Coach não pode transferir aluno para outro coach." });
      return;
    }
  }

  const updated = await upsertUserAccessAsync(student.userId, publicUserPatch(body));
  await updateMemoryFromStudentPatch(student.userId, body);

  addLog({
    action: "user_updated",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: student.userId,
    metadata: { updatedFields: Object.keys(body) },
  });

  res.json({ student: buildStudentView(updated), user: updated });
}));

adminRouter.delete(["/students/:userId", "/users/:userId"], requireAdmin, asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = getUserAccess(routeParam(req, "userId"));
  if (!student || student.role !== "student") {
    res.status(404).json({ message: "Aluno não encontrado." });
    return;
  }

  await deleteStudentEverywhere(student.userId);
  addLog({
    action: "user_deleted",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: student.userId,
  });
  res.status(204).send();
}));

adminRouter.post("/students/:userId/reactivate", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const patch: Partial<Omit<UserAccess, "userId" | "createdAt">> = {
    active: true,
    archived: false,
    subscriptionStatus: "active",
    paymentStatus: "active",
    subscriptionEndsAt: student.subscriptionEndsAt && new Date(student.subscriptionEndsAt) > new Date()
      ? student.subscriptionEndsAt
      : setDaysFromNow(student.accessDurationDays || 30),
  };
  const updated = await upsertUserAccessAsync(student.userId, patch);
  await updateInviteByUserId(student.userId, { subscriptionStatus: "active", subscriptionEndsAt: updated.subscriptionEndsAt });
  addLog({ action: "access_reactivated", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId });
  res.json({ student: buildStudentView(updated), user: updated });
}));

adminRouter.post("/students/:userId/pause", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const updated = await upsertUserAccessAsync(student.userId, { active: false });
  addLog({ action: "access_paused", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId });
  res.json({ student: buildStudentView(updated), user: updated });
}));

adminRouter.post("/students/:userId/renew", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const days = Math.max(1, Math.min(365, asNumber((req.body as { days?: unknown }).days, 30)));
  const subscriptionEndsAt = extendSubscription(student, days);
  const updated = await upsertUserAccessAsync(student.userId, {
    active: true,
    archived: false,
    subscriptionStatus: "active",
    paymentStatus: "active",
    subscriptionEndsAt,
  });
  await updateInviteByUserId(student.userId, { subscriptionStatus: "active", subscriptionEndsAt });
  addLog({ action: "access_renewed", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { days, subscriptionEndsAt } });
  res.json({ student: buildStudentView(updated), user: updated });
}));

adminRouter.post("/students/:userId/reset-password", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const body = req.body as { password?: string };
  const temporaryPassword = body.password?.trim() || `GUTO-${crypto.randomBytes(4).toString("hex")}`;
  if (temporaryPassword.length < 6) {
    res.status(400).json({ message: "Senha precisa ter pelo menos 6 caracteres." });
    return;
  }
  const passwordHash = await bcrypt.hash(temporaryPassword, 10);
  const updated = await upsertUserAccessAsync(student.userId, { passwordHash });
  addLog({ action: "password_reset", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId });
  res.json({ user: updated, temporaryPassword: body.password ? undefined : temporaryPassword });
}));

adminRouter.post("/students/:userId/reset", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const scope = (req.body as { scope?: ResetScope }).scope;
  const validScopes: ResetScope[] = ["weekly", "monthly", "individual", "validationHistory", "all"];
  if (!scope || !validScopes.includes(scope)) {
    res.status(400).json({ message: `scope deve ser um destes: ${validScopes.join(", ")}` });
    return;
  }
  resetArenaAndMemory(student.userId, scope);
  addLog({ action: "arena_reset", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { scope } });
  const updated = getUserAccess(student.userId)!;
  res.json({ student: buildStudentView(updated), scope });
}));

// ─── Coaches ─────────────────────────────────────────────────────────────────

adminRouter.get("/coaches", asyncHandler(async (req, res) => {
  if (!requireSuperAdminLike(req, res)) return;
  const users = await getAllUserAccessAsync();
  const coaches = users.filter((user) => user.role === "coach");
  res.json({ coaches });
}));

adminRouter.post("/coaches", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  if (!requireSuperAdminLike(req, res)) return;
  const body = req.body as Partial<UserAccess> & { password?: string };
  if (!body.name?.trim() || !body.email?.trim()) {
    res.status(400).json({ message: "Nome e email do coach são obrigatórios." });
    return;
  }
  const userId = body.userId || `coach-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const temporaryPassword = body.password?.trim() || `GUTO-${crypto.randomBytes(4).toString("hex")}`;
  const passwordHash = await bcrypt.hash(temporaryPassword, 10);
  const coach = await upsertUserAccessAsync(userId, {
    ...publicUserPatch(body),
    role: "coach",
    coachId: userId,
    active: body.active ?? true,
    archived: false,
    visibleInArena: false,
    subscriptionStatus: "active",
    paymentStatus: "active",
    subscriptionEndsAt: null,
    passwordHash,
  });
  addLog({ action: "coach_created", actorUserId: caller.userId, actorRole: caller.role, targetUserId: userId });
  res.status(201).json({ coach, temporaryPassword: body.password ? undefined : temporaryPassword });
}));

adminRouter.patch("/coaches/:coachId", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  if (!requireSuperAdminLike(req, res)) return;
  const coach = getUserAccess(routeParam(req, "coachId"));
  if (!coach || coach.role !== "coach") {
    res.status(404).json({ message: "Coach não encontrado." });
    return;
  }
  const updated = await upsertUserAccessAsync(coach.userId, publicUserPatch(req.body as Partial<UserAccess>));
  addLog({ action: "coach_updated", actorUserId: caller.userId, actorRole: caller.role, targetUserId: coach.userId });
  res.json({ coach: updated });
}));

adminRouter.delete("/coaches/:coachId", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  if (!requireSuperAdminLike(req, res)) return;
  const coach = getUserAccess(routeParam(req, "coachId"));
  if (!coach || coach.role !== "coach") {
    res.status(404).json({ message: "Coach não encontrado." });
    return;
  }
  const users = await getAllUserAccessAsync();
  const assigned = users.filter((user) => user.role === "student" && user.coachId === coach.userId);
  if (assigned.length) {
    res.status(409).json({ message: "Coach ainda possui alunos atribuídos. Reatribua antes de excluir.", assignedStudents: assigned.length });
    return;
  }
  await deleteUserAccessHardAsync(coach.userId);
  addLog({ action: "coach_deleted", actorUserId: caller.userId, actorRole: caller.role, targetUserId: coach.userId });
  res.status(204).send();
}));

adminRouter.post("/coaches/:coachId/students/:studentId", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  if (!requireSuperAdminLike(req, res)) return;
  const coach = getUserAccess(routeParam(req, "coachId"));
  const student = getUserAccess(routeParam(req, "studentId"));
  if (!coach || coach.role !== "coach") {
    res.status(404).json({ message: "Coach não encontrado." });
    return;
  }
  if (!student || student.role !== "student") {
    res.status(404).json({ message: "Aluno não encontrado." });
    return;
  }
  const updated = await upsertUserAccessAsync(student.userId, { coachId: coach.userId });
  addLog({ action: "coach_assigned", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { coachId: coach.userId } });
  res.json({ student: buildStudentView(updated) });
}));

adminRouter.delete("/coaches/:coachId/students/:studentId", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  if (!requireSuperAdminLike(req, res)) return;
  const student = getUserAccess(routeParam(req, "studentId"));
  if (!student || student.role !== "student") {
    res.status(404).json({ message: "Aluno não encontrado." });
    return;
  }
  if (student.coachId !== routeParam(req, "coachId")) {
    res.status(404).json({ message: "Aluno não está atribuído a este coach." });
    return;
  }
  const updated = await upsertUserAccessAsync(student.userId, { coachId: "admin" });
  addLog({ action: "coach_unassigned", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { previousCoachId: routeParam(req, "coachId") } });
  res.json({ student: buildStudentView(updated) });
}));

// ─── Workout ─────────────────────────────────────────────────────────────────

adminRouter.get(["/students/:userId/workout", "/users/:userId/workout"], asyncHandler(async (req, res) => {
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  res.json({ workout: memory.lastWorkoutPlan || null });
}));

adminRouter.put(["/students/:userId/workout", "/users/:userId/workout"], asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  const body = req.body as { workout?: unknown; reason?: string };
  const previous = memory.lastWorkoutPlan ? { ...memory.lastWorkoutPlan } : null;
  const workout = normalizeWorkoutPlan(body.workout ?? req.body, previous, req, body.reason);
  workout.studentId = student.userId;
  memory.lastWorkoutPlan = workout as any;
  saveMemory(memory);
  addLog({
    action: "workout_edited",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: student.userId,
    metadata: { sourceBefore: previous?.source, sourceAfter: workout.source, lockedByCoach: workout.lockedByCoach, snapshotBefore: previous },
  });
  res.json({ workout });
}));

adminRouter.patch(["/students/:userId/workout", "/users/:userId/workout"], asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  const body = req.body as { workout?: unknown; reason?: string };
  const previous = memory.lastWorkoutPlan ? { ...memory.lastWorkoutPlan } : null;
  const workout = normalizeWorkoutPlan({ ...(previous || {}), ...asRecord(body.workout ?? req.body) }, previous, req, body.reason);
  workout.studentId = student.userId;
  memory.lastWorkoutPlan = workout as any;
  saveMemory(memory);
  addLog({
    action: "workout_edited",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: student.userId,
    metadata: { sourceBefore: previous?.source, sourceAfter: workout.source, lockedByCoach: workout.lockedByCoach, snapshotBefore: previous },
  });
  res.json({ workout });
}));

adminRouter.post("/students/:userId/workout/generate", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  if (memory.lastWorkoutPlan?.lockedByCoach) {
    res.status(409).json({ message: "Plano bloqueado pelo coach.", code: "COACH_LOCKED_PLAN" });
    return;
  }
  const generated = buildWorkoutPlanFromSemanticFocus({
    language: memory.language,
    location: memory.preferredTrainingLocation || memory.trainingLocation || "casa",
    status: memory.trainingStatus || memory.trainingLevel || "iniciante",
    limitation: memory.trainingLimitations || memory.trainingPathology || "sem dor",
    age: memory.userAge ?? memory.trainingAge,
    scheduleIntent: memory.trainingSchedule,
    focus: memory.nextWorkoutFocus,
    trainingGoal: memory.trainingGoal,
  });
  const workout = normalizeWorkoutPlan({ ...generated, source: "guto_generated", lockedByCoach: false }, null, req, "Generated by GUTO through admin panel");
  workout.studentId = student.userId;
  memory.lastWorkoutPlan = workout as any;
  saveMemory(memory);
  addLog({ action: "workout_generated", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { sourceAfter: workout.source } });
  res.json({ workout });
}));

adminRouter.post("/students/:userId/workout/lock", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  if (!memory.lastWorkoutPlan) {
    res.status(404).json({ message: "Treino não encontrado." });
    return;
  }
  memory.lastWorkoutPlan.lockedByCoach = true;
  memory.lastWorkoutPlan.updatedBy = caller.userId;
  memory.lastWorkoutPlan.updatedAt = new Date().toISOString();
  saveMemory(memory);
  addLog({ action: "workout_locked", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { lockedByCoach: true } });
  res.json({ workout: memory.lastWorkoutPlan });
}));

adminRouter.post("/students/:userId/workout/unlock", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  if (!memory.lastWorkoutPlan) {
    res.status(404).json({ message: "Treino não encontrado." });
    return;
  }
  memory.lastWorkoutPlan.lockedByCoach = false;
  memory.lastWorkoutPlan.updatedBy = caller.userId;
  memory.lastWorkoutPlan.updatedAt = new Date().toISOString();
  saveMemory(memory);
  addLog({ action: "workout_unlocked", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { lockedByCoach: false } });
  res.json({ workout: memory.lastWorkoutPlan });
}));

adminRouter.post("/students/:userId/workout/reset", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  const previous = memory.lastWorkoutPlan ? { ...memory.lastWorkoutPlan } : null;
  memory.lastWorkoutPlan = null;
  saveMemory(memory);
  addLog({ action: "workout_reset", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { snapshotBefore: previous } });
  res.json({ workout: null });
}));

adminRouter.get("/students/:userId/workout/history", asyncHandler(async (req, res) => {
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  res.json({ history: workoutHistory(student.userId) });
}));

// ─── Diet ────────────────────────────────────────────────────────────────────

adminRouter.get(["/students/:userId/diet", "/users/:userId/diet"], asyncHandler(async (req, res) => {
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const diet = await getDietPlan(student.userId);
  res.json({ diet });
}));

adminRouter.put(["/students/:userId/diet", "/users/:userId/diet"], asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const body = req.body as { diet?: unknown; reason?: string };
  const previous = await getDietPlan(student.userId);
  const diet = normalizeDietPlan(body.diet ?? req.body, previous as LooseRecord | null, req, student.userId, body.reason);
  await saveDietPlan(diet as any);
  addLog({
    action: "diet_edited",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: student.userId,
    metadata: { sourceBefore: previous?.source, sourceAfter: diet.source, lockedByCoach: diet.lockedByCoach, snapshotBefore: previous },
  });
  res.json({ diet });
}));

adminRouter.patch(["/students/:userId/diet", "/users/:userId/diet"], asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const body = req.body as { diet?: unknown; reason?: string };
  const previous = await getDietPlan(student.userId);
  const diet = normalizeDietPlan({ ...(previous || {}), ...asRecord(body.diet ?? req.body) }, previous as LooseRecord | null, req, student.userId, body.reason);
  await saveDietPlan(diet as any);
  addLog({
    action: "diet_edited",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: student.userId,
    metadata: { sourceBefore: previous?.source, sourceAfter: diet.source, lockedByCoach: diet.lockedByCoach, snapshotBefore: previous },
  });
  res.json({ diet });
}));

adminRouter.post("/students/:userId/diet/generate", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const existing = await getDietPlan(student.userId);
  if (existing?.lockedByCoach) {
    res.status(409).json({ message: "Plano bloqueado pelo coach.", code: "COACH_LOCKED_PLAN" });
    return;
  }
  if (!existing) {
    res.status(404).json({ message: "Nenhuma dieta gerada pelo GUTO existe ainda. Crie manualmente ou peça ao aluno para concluir a calibragem." });
    return;
  }
  const diet = normalizeDietPlan({ ...existing, source: "guto_generated", lockedByCoach: false }, existing as LooseRecord, req, student.userId, "Marked as GUTO generated");
  await saveDietPlan(diet as any);
  addLog({ action: "diet_generated", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { sourceAfter: diet.source } });
  res.json({ diet });
}));

adminRouter.post("/students/:userId/diet/lock", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const existing = await getDietPlan(student.userId);
  if (!existing) {
    res.status(404).json({ message: "Dieta não encontrada." });
    return;
  }
  const diet = { ...existing, lockedByCoach: true, updatedBy: caller.userId, updatedAt: new Date().toISOString() };
  await saveDietPlan(diet);
  addLog({ action: "diet_locked", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { lockedByCoach: true } });
  res.json({ diet });
}));

adminRouter.post("/students/:userId/diet/unlock", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const existing = await getDietPlan(student.userId);
  if (!existing) {
    res.status(404).json({ message: "Dieta não encontrada." });
    return;
  }
  const diet = { ...existing, lockedByCoach: false, updatedBy: caller.userId, updatedAt: new Date().toISOString() };
  await saveDietPlan(diet);
  addLog({ action: "diet_unlocked", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { lockedByCoach: false } });
  res.json({ diet });
}));

adminRouter.post("/students/:userId/diet/reset", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const previous = await getDietPlan(student.userId);
  await deleteDietPlan(student.userId);
  addLog({ action: "diet_reset", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { snapshotBefore: previous } });
  res.json({ diet: null });
}));

adminRouter.get("/students/:userId/diet/history", asyncHandler(async (req, res) => {
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  res.json({ history: dietHistory(student.userId) });
}));

// ─── Logs ────────────────────────────────────────────────────────────────────

adminRouter.get("/logs", asyncHandler(async (req, res) => {
  const targetUserId = req.query.targetUserId ? String(req.query.targetUserId) : undefined;
  if (targetUserId) {
    const target = getUserAccess(targetUserId);
    if (!target || (target.role === "student" && !ownsStudent(req.gutoUser!, target))) {
      res.status(403).json({ message: "Sem permissão para ver histórico deste aluno." });
      return;
    }
    res.json({ logs: getLogs({ targetUserId }) });
    return;
  }

  if (!isAdminRole(req.gutoUser?.role)) {
    res.status(403).json({ message: "Apenas admin pode ver logs globais." });
    return;
  }

  res.json({ logs: getLogs() });
}));

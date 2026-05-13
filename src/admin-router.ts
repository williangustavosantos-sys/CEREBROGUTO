import express, { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { getAggregatedExerciseCatalog, getCatalogById, type CatalogMuscleGroup } from "../exercise-catalog";
import {
  requireCoachOrAdmin,
  requireAdmin,
  requireSuperAdmin,
  assertCanAccessUserAccess,
  canAccessUserAccess,
  getRequestActorAccess,
  getScopedUserAccessList,
  normalizeAccessTeamId,
  TeamAccessError,
  type GutoAccessActor,
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
  assertTeamPlanCapacity,
  createTeam,
  getAllTeams,
  getTeam,
  getTeamPlanUsage,
  GUTO_CORE_TEAM_ID,
  GutoTeamNotFoundError,
  GutoTeamPlanLimitError,
  normalizeTeamId,
  updateTeam,
  type GutoTeam,
  type TeamCapacitySubject,
} from "./team-store.js";
import type { GutoTeamPlan } from "./team-plans.js";
import {
  getArenaProfile,
  saveArenaProfile,
  readArenaStore,
  writeArenaStore,
  getAllArenaProfiles,
} from "./arena-store.js";
import { getAvatarStage, DEFAULT_ARENA_GROUP } from "./arena.js";
import {
  readMemoryStoreAsync,
  writeMemoryStoreAsync,
} from "./memory-store.js";
import { getMemory, saveMemory, buildWorkoutPlanFromSemanticFocus, type WeekDayKey, type WeeklyWorkoutPlan, type WeeklyDietDay, type WeeklyDietPlan } from "../server.js";
import { getDietPlan, saveDietPlan, deleteDietPlan } from "./diet-store.js";
import { addLog, getLogs } from "./log-store.js";
import { config } from "./config.js";
import {
  createInvite,
  findInviteByUserId,
  regenerateInviteByUserId,
  revokeInviteByUserId,
  updateInviteByUserId,
} from "./invite-store.js";
import {
  isWorkoutCatalogValidationError,
  normalizeWorkoutPlanAgainstCatalog,
} from "./workout-catalog-validation.js";
import {
  assertValidExerciseVideoMetadata,
  isExerciseVideoValidationError,
  suggestSafeExerciseVideoFileName,
} from "./exercise-video-validation.js";
import {
  buildAliasMap,
  buildLanguageMap,
  getCustomExerciseRequest,
  readCustomExerciseRequests,
  saveCustomExerciseRequest,
  type CustomExerciseRequest,
} from "./custom-exercise-store.js";

export const adminRouter = express.Router();

adminRouter.use(requireCoachOrAdmin);

type PlanSource = "guto_generated" | "coach_manual" | "mixed";
type LooseRecord = Record<string, any>;
type ResetScope = "weekly" | "monthly" | "individual" | "validationHistory" | "all";

const PLAN_SOURCES: PlanSource[] = ["guto_generated", "coach_manual", "mixed"];
const ADMIN_ROLES: UserRole[] = ["admin", "super_admin"];
const VALID_TEAM_PLANS: GutoTeamPlan[] = ["start", "pro", "elite", "custom"];
const CATALOG_MUSCLE_GROUPS: CatalogMuscleGroup[] = ["aquecimento", "peito", "costas", "ombro", "bracos", "pernas", "abdomen"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const COACH_FORBIDDEN_STUDENT_PATCH_FIELDS = [
  "active",
  "archived",
  "visibleInArena",
  "subscriptionStatus",
  "subscriptionEndsAt",
  "paymentStatus",
  "plan",
  "accessDurationDays",
  "teamId",
] as const;

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

function normalizeExerciseId(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function customExerciseFromBody(req: Request): CustomExerciseRequest {
  const body = asRecord(req.body);
  const video = assertValidExerciseVideoMetadata(
    {
      ...asRecord(body.video),
      ...asRecord(body.videoMetadata),
      sourceFileName: body.sourceFileName ?? asRecord(body.video).sourceFileName ?? asRecord(body.videoMetadata).sourceFileName,
      fileName: body.fileName ?? asRecord(body.video).fileName ?? asRecord(body.videoMetadata).fileName,
      videoUrl: body.videoUrl ?? asRecord(body.video).videoUrl ?? asRecord(body.videoMetadata).videoUrl,
      fileSizeBytes: body.fileSizeBytes ?? asRecord(body.video).fileSizeBytes ?? asRecord(body.videoMetadata).fileSizeBytes,
      durationSeconds: body.durationSeconds ?? asRecord(body.video).durationSeconds ?? asRecord(body.videoMetadata).durationSeconds,
      width: body.width ?? asRecord(body.video).width ?? asRecord(body.videoMetadata).width,
      height: body.height ?? asRecord(body.video).height ?? asRecord(body.videoMetadata).height,
      fps: body.fps ?? asRecord(body.video).fps ?? asRecord(body.videoMetadata).fps,
      mimeType: body.mimeType ?? asRecord(body.video).mimeType ?? asRecord(body.videoMetadata).mimeType,
      hasAudio: body.hasAudio ?? asRecord(body.video).hasAudio ?? asRecord(body.videoMetadata).hasAudio,
    },
    { customOnly: true }
  );
  const canonicalNamePt = asString(body.canonicalNamePt || body.name, "").trim();
  if (!canonicalNamePt) {
    throw new Error("Nome do exercício é obrigatório.");
  }
  const requestedId = normalizeExerciseId(asString(body.id, ""));
  const id = requestedId || normalizeExerciseId(video.sourceFileName.replace(/\.mp4$/i, ""));
  const muscleGroup = asString(body.muscleGroup, "peito") as CatalogMuscleGroup;
  if (!CATALOG_MUSCLE_GROUPS.includes(muscleGroup)) {
    throw new Error(`Grupo muscular inválido: ${muscleGroup}`);
  }
  const caller = req.gutoUser!;
  const now = new Date().toISOString();
  return {
    id,
    canonicalNamePt,
    namesByLanguage: buildLanguageMap(canonicalNamePt, body.namesByLanguage),
    aliasesByLanguage: buildAliasMap(body.aliasesByLanguage),
    muscleGroup,
    videoUrl: video.videoUrl,
    sourceFileName: video.sourceFileName,
    videoProvider: "local",
    movementPattern: asString(body.movementPattern, "") || undefined,
    equipment: asString(body.equipment, "") || undefined,
    tags: normalizeStringArray(body.tags),
    status: "pending",
    requestedBy: caller.userId,
    requestedByRole: caller.role,
    requestedAt: now,
    videoValidated: true,
    videoMetadata: {
      fileSizeBytes: video.fileSizeBytes,
      durationSeconds: video.durationSeconds,
      width: video.width,
      height: video.height,
      fps: video.fps,
      mimeType: video.mimeType,
      ...(video.hasAudio !== undefined ? { hasAudio: video.hasAudio } : {}),
    },
    custom: true,
  };
}

function customExerciseView(exercise: CustomExerciseRequest) {
  return {
    ...exercise,
    suggestedFileName: suggestSafeExerciseVideoFileName(exercise.sourceFileName),
  };
}

function requireSuperAdminLike(req: Request, res: Response): boolean {
  const actor = getRequestActorAccess(req);
  if (!actor || !isAdminRole(actor.role)) {
    res.status(403).json({ message: "Sem permissão administrativa para esta ação." });
    return false;
  }
  return true;
}

function sendTeamAccessError(res: Response, error: unknown): boolean {
  if (!(error instanceof TeamAccessError)) return false;
  res.status(error.status).json({ message: error.message, code: error.code });
  return true;
}

function sendTeamPlanError(res: Response, error: unknown): boolean {
  if (error instanceof GutoTeamPlanLimitError || error instanceof GutoTeamNotFoundError) {
    res.status(error.status).json({
      message: error.message,
      code: error.code,
      ...(error instanceof GutoTeamPlanLimitError
        ? { subject: error.subject, usage: error.usage }
        : { teamId: error.teamId }),
    });
    return true;
  }
  return false;
}

function requireActor(req: Request, res: Response): GutoAccessActor | null {
  const actor = getRequestActorAccess(req);
  if (!actor) {
    res.status(401).json({ message: "Autenticação necessária." });
    return null;
  }
  return actor;
}

async function getManagedStudent(req: Request, res: Response, userId: string): Promise<UserAccess | null> {
  const actor = requireActor(req, res);
  if (!actor) return null;
  const student = getUserAccess(userId);
  if (!student || student.role !== "student") {
    res.status(404).json({ message: "Aluno não encontrado." });
    return null;
  }
  try {
    assertCanAccessUserAccess(actor, student);
  } catch (error) {
    if (sendTeamAccessError(res, error)) return null;
    throw error;
  }
  return student;
}

async function ensureTeamPlanCapacity(
  res: Response,
  teamId: string,
  subject: TeamCapacitySubject,
  excludeUserId?: string
): Promise<boolean> {
  try {
    assertTeamPlanCapacity(teamId, subject, await getAllUserAccessAsync(), { excludeUserId });
    return true;
  } catch (error) {
    if (sendTeamPlanError(res, error)) return false;
    throw error;
  }
}

function getManagedCoach(req: Request, res: Response, coachId: string): UserAccess | null {
  const actor = requireActor(req, res);
  if (!actor) return null;
  const coach = getUserAccess(coachId);
  if (!coach || coach.role !== "coach") {
    res.status(404).json({ message: "Coach não encontrado." });
    return null;
  }
  if (actor.role !== "super_admin" && normalizeAccessTeamId(actor.teamId) !== normalizeAccessTeamId(coach.teamId)) {
    res.status(403).json({ message: "Time sem permissão para acessar este coach.", code: "TEAM_ACCESS_FORBIDDEN" });
    return null;
  }
  return coach;
}

function buildStudentView(access: UserAccess) {
  const memory = getMemory(access.userId);
  const arena = getArenaProfile(access.userId);
  const coach = access.coachId ? getUserAccess(access.coachId) : undefined;
  const team = access.teamId ? getTeam(normalizeTeamId(access.teamId)) : undefined;
  const totalXp = arena?.totalXp ?? memory.totalXp ?? 0;
  const lastValidation =
    arena?.lastWorkoutValidatedAt ??
    (memory.validationHistory?.length
      ? memory.validationHistory[memory.validationHistory.length - 1]?.createdAt ?? null
      : null);

  return {
    ...access,
    name: access.name || memory.name || access.userId,
    firstName: access.firstName ?? null,
    lastName: access.lastName ?? null,
    coachName: coach?.name || coach?.email || access.coachId || null,
    teamName: team?.name ?? null,
    age: memory.userAge ?? null,
    gender: memory.biologicalSex ?? null,
    biologicalSex: memory.biologicalSex ?? null,
    weeklyXp: arena?.weeklyXp ?? 0,
    monthlyXp: arena?.monthlyXp ?? 0,
    totalXp,
    avatarStage: getAvatarStage(totalXp),
    currentStreak: arena?.currentStreak ?? memory.streak ?? 0,
    validationsTotal: arena?.validatedWorkoutsTotal ?? (memory.validationHistory?.length ?? 0),
    lastValidationAt: lastValidation,
    lastActiveAt: memory.lastActiveAt ?? null,
  };
}

function queryText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function queryNumber(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesStudentFilters(student: ReturnType<typeof buildStudentView>, req: Request): boolean {
  const search = queryText(req.query.search).toLowerCase();
  const coachId = queryText(req.query.coachId);
  const gender = queryText(req.query.gender).toLowerCase();
  const status = queryText(req.query.status);
  const subscriptionStatus = queryText(req.query.subscriptionStatus);
  const minAge = queryNumber(req.query.minAge);
  const maxAge = queryNumber(req.query.maxAge);
  const studentAge = typeof student.age === "number" ? student.age : null;

  if (search) {
    const haystack = [
      student.name,
      student.email,
      student.phone,
      student.userId,
      student.coachName,
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  if (coachId && student.coachId !== coachId) return false;
  if (gender && String(student.gender || student.biologicalSex || "").toLowerCase() !== gender) return false;
  if (minAge !== null && (studentAge === null || studentAge < minAge)) return false;
  if (maxAge !== null && (studentAge === null || studentAge > maxAge)) return false;
  if (subscriptionStatus && student.subscriptionStatus !== subscriptionStatus) return false;
  if (status === "active" && (!student.active || student.archived)) return false;
  if ((status === "paused" || status === "inactive") && (student.active || student.archived)) return false;
  if (status === "archived" && !student.archived) return false;
  return true;
}

async function listManagedStudents(req: Request) {
  const actor = getRequestActorAccess(req)!;
  const allUsers = await getAllUserAccessAsync();
  return getScopedUserAccessList(actor, allUsers)
    .filter((user) => user.role === "student")
    .map(buildStudentView)
    .filter((student) => matchesStudentFilters(student, req));
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

function normalizePersonName(value: unknown): string {
  return asString(value, "")
    .trim()
    .replace(/\s+/g, " ");
}

function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

function normalizePhone(value: unknown): string {
  return asString(value, "")
    .trim()
    .replace(/[^\d+]/g, "");
}

function phoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function isValidPhone(value: string): boolean {
  const digits = phoneDigits(value);
  return digits.length >= 8 && digits.length <= 15 && !/^(\d)\1+$/.test(digits);
}

function userIdPart(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase()
    .slice(0, 24);
}

function buildStudentUserId(body: Partial<UserAccess>): string {
  const first = userIdPart(normalizePersonName(body.firstName || body.name || "ALUNO"));
  const last = userIdPart(normalizePersonName(body.lastName || ""));
  const base = ["G", first, last].filter(Boolean).join("-") || `G-ALUNO-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  let candidate = base;
  let suffix = 2;
  while (getUserAccess(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function publicUserPatch(body: Partial<UserAccess>): Partial<Omit<UserAccess, "userId" | "createdAt">> {
  const patch: Partial<Omit<UserAccess, "userId" | "createdAt">> = {};
  if (typeof body.firstName === "string") patch.firstName = normalizePersonName(body.firstName);
  if (typeof body.lastName === "string") patch.lastName = normalizePersonName(body.lastName);
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.email === "string") patch.email = body.email.trim().toLowerCase();
  if (typeof body.phone === "string") patch.phone = normalizePhone(body.phone);
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

function hasBodyField(body: LooseRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined;
}

async function updateMemoryFromStudentPatch(userId: string, patch: Partial<UserAccess> & LooseRecord): Promise<void> {
  const memory = getMemory(userId);
  if (typeof patch.firstName === "string" && patch.firstName.trim()) memory.name = patch.firstName.trim();
  else if (typeof patch.name === "string" && patch.name.trim()) memory.name = patch.name.trim();
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

export async function deleteStudentEverywhere(userId: string): Promise<void> {
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
  const hasVideoUrl = Object.prototype.hasOwnProperty.call(raw, "videoUrl");
  const videoUrl = asString(raw.videoUrl, "");
  const hasVideoProvider = Object.prototype.hasOwnProperty.call(raw, "videoProvider");
  const hasSourceFileName = Object.prototype.hasOwnProperty.call(raw, "sourceFileName");
  const sourceFileName = asString(raw.sourceFileName, videoUrl.split("/").filter(Boolean).pop() || "");
  return {
    id: asString(raw.id, ""),
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
    ...(hasVideoUrl ? { videoUrl } : {}),
    ...(hasVideoProvider ? { videoProvider: asString(raw.videoProvider, "") } : {}),
    ...(hasSourceFileName ? { sourceFileName } : {}),
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

  const workout = {
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
  return normalizeWorkoutPlanAgainstCatalog(workout);
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
  const totalKcal = Math.round(foods.reduce((sum, food) => sum + asNumber(food.kcal, 0), 0));
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

function dietFoodKcalTotal(diet: LooseRecord): number {
  const meals = Array.isArray(diet.meals) ? diet.meals : [];
  return Math.round(meals.reduce((sum, mealValue) => {
    const meal = asRecord(mealValue);
    const foods = Array.isArray(meal.foods) ? meal.foods : [];
    return sum + foods.reduce((foodSum, foodValue) => foodSum + asNumber(asRecord(foodValue).kcal, 0), 0);
  }, 0));
}

function dietCalorieValidationMessage(diet: LooseRecord): string | null {
  const macros = asRecord(diet.macros);
  const targetKcal = Math.round(asNumber(macros.targetKcal, asNumber(diet.targetKcal, 0)));
  if (targetKcal <= 0) return null;
  const totalKcal = dietFoodKcalTotal(diet);
  if (totalKcal === targetKcal) return null;
  const delta = targetKcal - totalKcal;
  return `Total dos alimentos (${totalKcal} kcal) precisa bater com a meta da dieta (${targetKcal} kcal). ${delta > 0 ? "Faltam" : "Excedeu"} ${Math.abs(delta)} kcal.`;
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
      if (isWorkoutCatalogValidationError(error)) {
        res.status(error.status).json({
          message: error.code === "WORKOUT_EXERCISE_CATALOG_SELECTION_REQUIRED"
            ? "Escolha um exercício do catálogo oficial antes de salvar."
            : "Treino recusado: exercício sem vídeo local validado no catálogo oficial.",
          code: error.code,
          issues: error.issues,
        });
        return;
      }
      if (isExerciseVideoValidationError(error)) {
        res.status(error.status).json({
          message: "Esse vídeo está pesado demais para o app. Use MP4 até 30 segundos, máximo 12MB e 720p.",
          code: error.code,
          issues: error.issues,
        });
        return;
      }
      res.status(500).json({ message: "Backend recusou a ação: erro interno.", detail: error instanceof Error ? error.message : String(error) });
    });
  };
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] || "" : String(value || "");
}

adminRouter.get("/exercises/catalog", asyncHandler(async (_req, res) => {
  const exercises = getAggregatedExerciseCatalog()
    .map((entry) => ({
      id: entry.id,
      canonicalNamePt: entry.canonicalNamePt,
      namesByLanguage: entry.namesByLanguage,
      aliasesByLanguage: entry.aliasesByLanguage,
      muscleGroup: entry.muscleGroup,
      videoUrl: entry.videoUrl,
      videoProvider: entry.videoProvider,
      sourceFileName: entry.sourceFileName,
      equipment: entry.equipment,
      movementPattern: entry.movementPattern,
      tags: entry.tags ?? [],
    }))
    .sort((a, b) => {
      const group = a.muscleGroup.localeCompare(b.muscleGroup, "pt-BR");
      return group || a.canonicalNamePt.localeCompare(b.canonicalNamePt, "pt-BR");
    });

  res.json({ exercises });
}));

adminRouter.get("/exercises/custom", asyncHandler(async (_req, res) => {
  res.json({ exercises: readCustomExerciseRequests().map(customExerciseView) });
}));

adminRouter.post("/exercises/custom", asyncHandler(async (req, res) => {
  const exercise = customExerciseFromBody(req);
  if (getCatalogById(exercise.id) || getCustomExerciseRequest(exercise.id)) {
    res.status(409).json({ message: "Exercício já existe no catálogo ou na fila customizada.", code: "EXERCISE_ALREADY_EXISTS" });
    return;
  }
  const saved = saveCustomExerciseRequest(exercise);
  addLog({
    action: "custom_exercise_requested",
    actorUserId: req.gutoUser!.userId,
    actorRole: req.gutoUser!.role,
    metadata: { exerciseId: saved.id, videoUrl: saved.videoUrl },
  });
  res.status(201).json({ exercise: customExerciseView(saved) });
}));

adminRouter.post("/exercises/custom/:exerciseId/approve", requireAdmin, asyncHandler(async (req, res) => {
  const existing = getCustomExerciseRequest(routeParam(req, "exerciseId"));
  if (!existing) {
    res.status(404).json({ message: "Exercício customizado não encontrado." });
    return;
  }
  const video = assertValidExerciseVideoMetadata({
    sourceFileName: existing.sourceFileName,
    videoUrl: existing.videoUrl,
    ...existing.videoMetadata,
  }, { customOnly: true });
  const updated: CustomExerciseRequest = {
    ...existing,
    status: "approved",
    videoValidated: true,
    videoUrl: video.videoUrl,
    sourceFileName: video.sourceFileName,
    videoMetadata: {
      fileSizeBytes: video.fileSizeBytes,
      durationSeconds: video.durationSeconds,
      width: video.width,
      height: video.height,
      fps: video.fps,
      mimeType: video.mimeType,
      ...(video.hasAudio !== undefined ? { hasAudio: video.hasAudio } : {}),
    },
    approvedBy: req.gutoUser!.userId,
    approvedAt: new Date().toISOString(),
    rejectionReason: undefined,
  };
  saveCustomExerciseRequest(updated);
  addLog({
    action: "custom_exercise_approved",
    actorUserId: req.gutoUser!.userId,
    actorRole: req.gutoUser!.role,
    metadata: { exerciseId: updated.id, videoUrl: updated.videoUrl },
  });
  res.json({ exercise: customExerciseView(updated) });
}));

adminRouter.post("/exercises/custom/:exerciseId/reject", requireAdmin, asyncHandler(async (req, res) => {
  const existing = getCustomExerciseRequest(routeParam(req, "exerciseId"));
  if (!existing) {
    res.status(404).json({ message: "Exercício customizado não encontrado." });
    return;
  }
  const updated: CustomExerciseRequest = {
    ...existing,
    status: "rejected",
    rejectedBy: req.gutoUser!.userId,
    rejectedAt: new Date().toISOString(),
    rejectionReason: asString(asRecord(req.body).reason, "Vídeo fora do padrão técnico do GUTO."),
  };
  saveCustomExerciseRequest(updated);
  res.json({ exercise: customExerciseView(updated) });
}));

// ─── Students ────────────────────────────────────────────────────────────────

adminRouter.get("/team/summary", asyncHandler(async (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const requestedTeamId = queryText(req.query.teamId);
  const teamId = actor.role === "super_admin"
    ? requestedTeamId || normalizeAccessTeamId(actor.teamId) || GUTO_CORE_TEAM_ID
    : normalizeAccessTeamId(actor.teamId);
  if (actor.role !== "super_admin" && requestedTeamId && requestedTeamId !== teamId) {
    res.status(403).json({ message: "Time sem permissão para acessar este resumo.", code: "TEAM_ACCESS_FORBIDDEN" });
    return;
  }

  try {
    const team = getTeam(teamId);
    if (!team) throw new GutoTeamNotFoundError(teamId);
    const usage = getTeamPlanUsage(teamId, await getAllUserAccessAsync());
    res.json({
      team: {
        id: team.id,
        name: team.name,
        plan: team.plan,
        planLabel: usage.label,
        status: team.status,
      },
      limits: {
        maxStudents: usage.maxStudents,
        maxCoaches: usage.maxCoaches,
      },
      usage: {
        students: usage.students,
        coaches: usage.coaches,
      },
    });
  } catch (error) {
    if (sendTeamPlanError(res, error)) return;
    throw error;
  }
}));

adminRouter.get(["/students", "/users"], asyncHandler(async (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const students = await listManagedStudents(req);
  const users = isAdminRole(actor.role)
    ? getScopedUserAccessList(actor, await getAllUserAccessAsync())
    : students;
  res.json({ students, users });
}));

adminRouter.post(["/students", "/users"], asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const actor = requireActor(req, res);
  if (!actor) return;
  const body = req.body as Partial<UserAccess> & { password?: string };
  const firstName = normalizePersonName(body.firstName || body.name);
  const lastName = normalizePersonName(body.lastName);
  const email = asString(body.email, "").trim().toLowerCase();
  const phone = normalizePhone(body.phone);
  if (!firstName || !lastName) {
    res.status(400).json({ message: "Nome e sobrenome do aluno são obrigatórios." });
    return;
  }
  if (!email || !isValidEmail(email)) {
    res.status(400).json({ message: "Email válido do aluno é obrigatório." });
    return;
  }
  if (!phone || !isValidPhone(phone)) {
    res.status(400).json({ message: "Telefone válido do aluno é obrigatório." });
    return;
  }
  if (body.role && body.role !== "student") {
    res.status(403).json({ message: "Esta rota cria apenas alunos.", code: "ADMIN_ACCESS_FORBIDDEN" });
    return;
  }
  if (actor.role === "student") {
    res.status(403).json({ message: "Aluno não pode criar acesso administrativo.", code: "ADMIN_ACCESS_FORBIDDEN" });
    return;
  }

  const requestedTeamId = typeof body.teamId === "string" ? body.teamId.trim() : undefined;
  if (actor.role === "super_admin" && !requestedTeamId) {
    res.status(400).json({ message: "super_admin precisa informar teamId ao criar aluno.", code: "GUTO_TEAM_REQUIRED" });
    return;
  }
  const teamId = actor.role === "super_admin"
    ? requestedTeamId!
    : normalizeAccessTeamId(actor.teamId);
  if (actor.role !== "super_admin" && requestedTeamId && requestedTeamId !== teamId) {
    res.status(403).json({ message: "Admin/coach não pode criar aluno em outro Time.", code: "TEAM_ACCESS_FORBIDDEN" });
    return;
  }

  const fullName = `${firstName} ${lastName}`.trim();
  const userId = body.userId || buildStudentUserId({ ...body, firstName, lastName, name: fullName });
  let coachId = body.coachId || actor.userId;
  if (actor.role === "coach") {
    if (body.coachId && body.coachId !== actor.userId) {
      res.status(403).json({ message: "Coach não pode criar aluno para outro coach.", code: "COACH_STUDENT_ACCESS_FORBIDDEN" });
      return;
    }
    coachId = actor.userId;
  } else if (body.coachId) {
    const assignedCoach = getUserAccess(body.coachId);
    if (!assignedCoach || assignedCoach.role !== "coach") {
      res.status(404).json({ message: "Coach não encontrado." });
      return;
    }
    if (normalizeAccessTeamId(assignedCoach.teamId) !== teamId) {
      res.status(403).json({ message: "Coach pertence a outro Time.", code: "TEAM_ACCESS_FORBIDDEN" });
      return;
    }
  }
  if (!(await ensureTeamPlanCapacity(res, teamId, "student", userId))) return;
  const passwordHash = body.password ? await bcrypt.hash(body.password, 10) : undefined;
  const active = body.active ?? Boolean(passwordHash);
  const durationDays = body.accessDurationDays || 30;
  const subscriptionEndsAt = active ? (body.subscriptionEndsAt || setDaysFromNow(durationDays)) : (body.subscriptionEndsAt || null);

  const user = await upsertUserAccessAsync(userId, {
    ...publicUserPatch({ ...body, firstName, lastName, name: fullName, email, phone }),
    role: "student",
    coachId,
    teamId,
    active,
    archived: false,
    visibleInArena: body.visibleInArena ?? true,
    subscriptionStatus: active ? "active" : (body.subscriptionStatus ?? "pending_payment"),
    paymentStatus: active ? "active" : (body.paymentStatus ?? "pending_payment"),
    subscriptionEndsAt,
    ...(passwordHash ? { passwordHash } : {}),
  });

  await updateMemoryFromStudentPatch(userId, { ...body, firstName, lastName, name: fullName, email, phone });

  let inviteLink = "";
  if (!passwordHash) {
    const { rawToken } = await createInvite({ userId, name: fullName, coachId });
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
  const actor = requireActor(req, res);
  if (!actor) return;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const body = req.body as Partial<UserAccess> & LooseRecord;
  if (typeof body.email === "string" && body.email.trim() && !isValidEmail(body.email)) {
    res.status(400).json({ message: "Email inválido." });
    return;
  }
  if (typeof body.phone === "string" && body.phone.trim() && !isValidPhone(normalizePhone(body.phone))) {
    res.status(400).json({ message: "Telefone inválido." });
    return;
  }
  if (typeof body.firstName === "string" && !normalizePersonName(body.firstName)) {
    res.status(400).json({ message: "Nome não pode ser vazio." });
    return;
  }
  if (typeof body.lastName === "string" && !normalizePersonName(body.lastName)) {
    res.status(400).json({ message: "Sobrenome não pode ser vazio." });
    return;
  }

  if (body.role && body.role !== "student") {
    res.status(403).json({ message: "Esta rota altera apenas alunos.", code: "ADMIN_ACCESS_FORBIDDEN" });
    return;
  }
  if (body.teamId && actor.role !== "super_admin" && body.teamId !== normalizeAccessTeamId(student.teamId)) {
    res.status(403).json({ message: "Admin/coach não pode mover aluno para outro Time.", code: "TEAM_ACCESS_FORBIDDEN" });
    return;
  }
  if (isCoachRole(actor.role)) {
    const forbiddenField = COACH_FORBIDDEN_STUDENT_PATCH_FIELDS.find((field) => hasBodyField(body, field));
    if (forbiddenField) {
      res.status(403).json({
        message: "Coach não pode alterar acesso, pagamento, assinatura, Time ou visibilidade de Arena.",
        code: "ADMIN_ACCESS_FORBIDDEN",
        field: forbiddenField,
      });
      return;
    }
    if (body.coachId && body.coachId !== actor.userId) {
      res.status(403).json({ message: "Coach não pode transferir aluno para outro coach.", code: "COACH_STUDENT_ACCESS_FORBIDDEN" });
      return;
    }
  }
  if (body.coachId && body.coachId !== student.coachId && actor.role !== "coach") {
    const assignedCoach = getUserAccess(body.coachId);
    if (!assignedCoach || assignedCoach.role !== "coach") {
      res.status(404).json({ message: "Coach não encontrado." });
      return;
    }
    if (normalizeAccessTeamId(assignedCoach.teamId) !== normalizeAccessTeamId(student.teamId)) {
      res.status(403).json({ message: "Coach pertence a outro Time.", code: "TEAM_ACCESS_FORBIDDEN" });
      return;
    }
  }

  const patch = publicUserPatch(body);
  if (actor.role === "coach") patch.coachId = actor.userId;
  if (actor.role === "super_admin" && typeof body.teamId === "string") patch.teamId = body.teamId;
  const targetTeamId = normalizeAccessTeamId(patch.teamId ?? student.teamId);
  const finalArchived = patch.archived ?? student.archived;
  if (!finalArchived && (targetTeamId !== normalizeAccessTeamId(student.teamId) || student.archived)) {
    if (!(await ensureTeamPlanCapacity(res, targetTeamId, "student", student.userId))) return;
  }
  const updated = await upsertUserAccessAsync(student.userId, patch);
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
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;

  await deleteStudentEverywhere(student.userId);
  addLog({
    action: "user_deleted",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: student.userId,
  });
  res.status(204).send();
}));

adminRouter.post("/students/:userId/reactivate", requireAdmin, asyncHandler(async (req, res) => {
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
  if (student.archived && !(await ensureTeamPlanCapacity(res, normalizeAccessTeamId(student.teamId), "student", student.userId))) return;
  const updated = await upsertUserAccessAsync(student.userId, patch);
  await updateInviteByUserId(student.userId, { subscriptionStatus: "active", subscriptionEndsAt: updated.subscriptionEndsAt });
  addLog({ action: "access_reactivated", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId });
  res.json({ student: buildStudentView(updated), user: updated });
}));

adminRouter.post("/students/:userId/pause", requireAdmin, asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const updated = await upsertUserAccessAsync(student.userId, { active: false });
  addLog({ action: "access_paused", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId });
  res.json({ student: buildStudentView(updated), user: updated });
}));

adminRouter.post("/students/:userId/renew", requireAdmin, asyncHandler(async (req, res) => {
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

adminRouter.post("/students/:userId/reset-password", requireAdmin, asyncHandler(async (req, res) => {
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

adminRouter.post("/students/:userId/reset", requireAdmin, asyncHandler(async (req, res) => {
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
  const actor = requireActor(req, res);
  if (!actor || !requireSuperAdminLike(req, res)) return;
  const users = await getAllUserAccessAsync();
  const coaches = (actor.role === "super_admin" ? users : getScopedUserAccessList(actor, users))
    .filter((user) => user.role === "coach");
  res.json({ coaches });
}));

adminRouter.post("/coaches", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const actor = requireActor(req, res);
  if (!actor || !requireSuperAdminLike(req, res)) return;
  const body = req.body as Partial<UserAccess> & { password?: string };
  if (!body.name?.trim() || !body.email?.trim()) {
    res.status(400).json({ message: "Nome e email do coach são obrigatórios." });
    return;
  }
  const requestedTeamId = typeof body.teamId === "string" ? body.teamId.trim() : undefined;
  if (actor.role === "super_admin" && !requestedTeamId) {
    res.status(400).json({ message: "super_admin precisa informar teamId ao criar coach.", code: "GUTO_TEAM_REQUIRED" });
    return;
  }
  const teamId = actor.role === "super_admin"
    ? requestedTeamId!
    : normalizeAccessTeamId(actor.teamId);
  if (actor.role !== "super_admin" && requestedTeamId && requestedTeamId !== teamId) {
    res.status(403).json({ message: "Admin não pode criar coach em outro Time.", code: "TEAM_ACCESS_FORBIDDEN" });
    return;
  }
  const userId = body.userId || `coach-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  if (!(await ensureTeamPlanCapacity(res, teamId, "coach", userId))) return;
  const temporaryPassword = body.password?.trim() || `GUTO-${crypto.randomBytes(4).toString("hex")}`;
  const passwordHash = await bcrypt.hash(temporaryPassword, 10);
  const coach = await upsertUserAccessAsync(userId, {
    ...publicUserPatch(body),
    role: "coach",
    coachId: userId,
    teamId,
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
  const coach = getManagedCoach(req, res, routeParam(req, "coachId"));
  if (!coach) return;
  const body = req.body as Partial<UserAccess>;
  if (body.teamId && req.gutoUser!.role !== "super_admin" && body.teamId !== normalizeAccessTeamId(coach.teamId)) {
    res.status(403).json({ message: "Admin não pode mover coach para outro Time.", code: "TEAM_ACCESS_FORBIDDEN" });
    return;
  }
  const patch = publicUserPatch(body);
  patch.coachId = coach.userId;
  if (req.gutoUser!.role === "super_admin" && typeof body.teamId === "string") patch.teamId = body.teamId;
  const targetTeamId = normalizeAccessTeamId(patch.teamId ?? coach.teamId);
  const finalArchived = patch.archived ?? coach.archived;
  if (!finalArchived && (targetTeamId !== normalizeAccessTeamId(coach.teamId) || coach.archived)) {
    if (!(await ensureTeamPlanCapacity(res, targetTeamId, "coach", coach.userId))) return;
  }
  const updated = await upsertUserAccessAsync(coach.userId, patch);
  addLog({ action: "coach_updated", actorUserId: caller.userId, actorRole: caller.role, targetUserId: coach.userId });
  res.json({ coach: updated });
}));

adminRouter.delete("/coaches/:coachId", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  if (!requireSuperAdminLike(req, res)) return;
  const coach = getManagedCoach(req, res, routeParam(req, "coachId"));
  if (!coach) return;
  const users = await getAllUserAccessAsync();
  const assigned = users.filter(
    (user) =>
      user.role === "student" &&
      normalizeAccessTeamId(user.teamId) === normalizeAccessTeamId(coach.teamId) &&
      user.coachId === coach.userId
  );
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
  const coach = getManagedCoach(req, res, routeParam(req, "coachId"));
  if (!coach) return;
  const student = await getManagedStudent(req, res, routeParam(req, "studentId"));
  if (!student) return;
  if (normalizeAccessTeamId(coach.teamId) !== normalizeAccessTeamId(student.teamId)) {
    res.status(403).json({ message: "Coach e aluno precisam pertencer ao mesmo Time.", code: "TEAM_ACCESS_FORBIDDEN" });
    return;
  }
  const updated = await upsertUserAccessAsync(student.userId, { coachId: coach.userId });
  addLog({ action: "coach_assigned", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { coachId: coach.userId } });
  res.json({ student: buildStudentView(updated) });
}));

adminRouter.delete("/coaches/:coachId/students/:studentId", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  if (!requireSuperAdminLike(req, res)) return;
  const coach = getManagedCoach(req, res, routeParam(req, "coachId"));
  if (!coach) return;
  const student = await getManagedStudent(req, res, routeParam(req, "studentId"));
  if (!student) return;
  if (student.coachId !== routeParam(req, "coachId")) {
    res.status(404).json({ message: "Aluno não está atribuído a este coach." });
    return;
  }
  if (normalizeAccessTeamId(coach.teamId) !== normalizeAccessTeamId(student.teamId)) {
    res.status(403).json({ message: "Coach e aluno precisam pertencer ao mesmo Time.", code: "TEAM_ACCESS_FORBIDDEN" });
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

// ─── Weekly Workout Plan ──────────────────────────────────────────────────────

function getTodayDayKey(): WeekDayKey {
  const dayIndex = new Date().getDay(); // 0=Sunday
  const map: Record<number, WeekDayKey> = { 0: "sunday", 1: "monday", 2: "tuesday", 3: "wednesday", 4: "thursday", 5: "friday", 6: "saturday" };
  return map[dayIndex];
}

adminRouter.get("/students/:userId/workout/week", asyncHandler(async (req, res) => {
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  res.json({ weeklyWorkout: memory.weeklyWorkoutPlan || null });
}));

adminRouter.put("/students/:userId/workout/week", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  const body = req.body as { days?: unknown };
  const rawDays = asRecord(body.days ?? req.body);
  const VALID_DAYS: WeekDayKey[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const days: Partial<Record<WeekDayKey, any>> = {};
  for (const day of VALID_DAYS) {
    const rawDay = rawDays[day];
    if (rawDay == null) continue;
    const normalized = normalizeWorkoutPlan(rawDay, null, req, `Weekly plan — ${day}`);
    normalized.studentId = student.userId;
    normalized.weekDay = day;
    days[day] = normalizeWorkoutPlanAgainstCatalog(normalized);
  }
  const weeklyWorkoutPlan: WeeklyWorkoutPlan = {
    studentId: student.userId,
    updatedAt: new Date().toISOString(),
    updatedBy: caller.userId,
    days: days as WeeklyWorkoutPlan["days"],
  };
  memory.weeklyWorkoutPlan = weeklyWorkoutPlan;
  saveMemory(memory);
  addLog({ action: "workout_weekly_saved", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { days: Object.keys(days) } });
  res.json({ weeklyWorkout: weeklyWorkoutPlan });
}));

adminRouter.get("/students/:userId/workout/today", asyncHandler(async (req, res) => {
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  const today = getTodayDayKey();
  const todayWorkout = memory.weeklyWorkoutPlan?.days?.[today] ?? null;
  if (todayWorkout) {
    res.json({ workout: todayWorkout, dayKey: today, fromWeeklyPlan: true });
    return;
  }
  if (memory.lastWorkoutPlan) {
    res.json({ workout: memory.lastWorkoutPlan, dayKey: today, fromWeeklyPlan: false });
    return;
  }
  res.json({ workout: null, dayKey: today, fromWeeklyPlan: false });
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
  const calorieError = dietCalorieValidationMessage(diet);
  if (calorieError) {
    res.status(400).json({ message: calorieError, code: "DIET_CALORIES_MISMATCH" });
    return;
  }
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
  const calorieError = dietCalorieValidationMessage(diet);
  if (calorieError) {
    res.status(400).json({ message: calorieError, code: "DIET_CALORIES_MISMATCH" });
    return;
  }
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

// ─── Weekly Diet Plan ──────────────────────────────────────────────────────────

const VALID_DIET_DAYS: WeekDayKey[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const VALID_DIET_DAY_FIELDS: Array<keyof WeeklyDietDay> = ["breakfast", "lunch", "dinner", "snacks", "notes", "hydration", "caloriesEstimate", "proteinEstimate", "status"];
const MAX_DIET_TEXT_LENGTH = 2000;

function normalizeDietDay(rawValue: unknown): WeeklyDietDay | null {
  if (rawValue == null || typeof rawValue !== "object" || Array.isArray(rawValue)) return null;
  const raw = rawValue as Record<string, unknown>;

  // Reject unknown keys
  const keys = Object.keys(raw);
  for (const key of keys) {
    if (!VALID_DIET_DAY_FIELDS.includes(key as keyof WeeklyDietDay)) {
      throw new Error(`Campo inválido no dia de dieta: "${key}".`);
    }
  }

  const day: WeeklyDietDay = {};
  const textFields = ["breakfast", "lunch", "dinner", "snacks", "notes", "hydration", "status"] as const;
  for (const field of textFields) {
    if (raw[field] !== undefined) {
      const val = typeof raw[field] === "string" ? (raw[field] as string).trim() : String(raw[field] ?? "").trim();
      if (val.length > MAX_DIET_TEXT_LENGTH) {
        throw new Error(`Campo "${field}" excede o limite de ${MAX_DIET_TEXT_LENGTH} caracteres.`);
      }
      if (val) day[field] = val;
    }
  }
  if (raw.caloriesEstimate !== undefined) {
    const n = Number(raw.caloriesEstimate);
    if (Number.isFinite(n) && n >= 0) day.caloriesEstimate = Math.round(n);
  }
  if (raw.proteinEstimate !== undefined) {
    const n = Number(raw.proteinEstimate);
    if (Number.isFinite(n) && n >= 0) day.proteinEstimate = Math.round(n);
  }

  // Day is "empty" if no text field was filled and no numeric fields
  const hasContent = textFields.some((f) => day[f]) || day.caloriesEstimate != null || day.proteinEstimate != null;
  if (!hasContent) return null;

  return day;
}

adminRouter.get("/students/:userId/diet/week", asyncHandler(async (req, res) => {
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  res.json({ weeklyDiet: memory.weeklyDietPlan || null });
}));

adminRouter.put("/students/:userId/diet/week", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;

  const body = req.body as { days?: unknown };
  const rawDays = asRecord(body.days ?? req.body);

  // Reject keys outside the valid day names
  const incomingKeys = Object.keys(rawDays);
  if (incomingKeys.length === 0) {
    res.status(400).json({ message: "Payload vazio: informe pelo menos um dia com dados." });
    return;
  }
  for (const key of incomingKeys) {
    if (!VALID_DIET_DAYS.includes(key as WeekDayKey)) {
      res.status(400).json({ message: `Dia inválido: "${key}". Use monday, tuesday, wednesday, thursday, friday, saturday ou sunday.` });
      return;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const days: Partial<Record<WeekDayKey, WeeklyDietDay>> = {};
  try {
    for (const day of VALID_DIET_DAYS) {
      const rawDay = rawDays[day];
      if (rawDay == null) continue;
      const normalized = normalizeDietDay(rawDay);
      if (normalized) days[day] = normalized;
    }
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "Payload de dieta inválido." });
    return;
  }

  if (Object.keys(days).length === 0) {
    res.status(400).json({ message: "Nenhum dia válido com dados foi encontrado no payload." });
    return;
  }

  const weeklyDietPlan: WeeklyDietPlan = {
    studentId: student.userId,
    updatedAt: new Date().toISOString(),
    updatedBy: caller.userId,
    days,
  };

  const memory = getMemory(student.userId);
  memory.weeklyDietPlan = weeklyDietPlan;
  saveMemory(memory);

  addLog({
    action: "diet_weekly_saved",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: student.userId,
    metadata: { days: Object.keys(days) },
  });

  res.json({ weeklyDiet: weeklyDietPlan });
}));

adminRouter.get("/students/:userId/diet/today", asyncHandler(async (req, res) => {
  // NOTE: endpoint GET /admin/students/:userId/diet/today is intentionally available
  // for future student-side integration. The student app can consume this endpoint
  // to display today's diet. Integration with the student UI is planned for a future phase.
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  const today = getTodayDayKey();
  const todayDiet = memory.weeklyDietPlan?.days?.[today] ?? null;
  if (todayDiet) {
    res.json({ diet: todayDiet, dayKey: today, fromWeeklyPlan: true });
    return;
  }
  // Fallback: return existing official diet if no weekly plan day exists
  const officialDiet = await getDietPlan(student.userId);
  if (officialDiet) {
    res.json({ diet: officialDiet, dayKey: today, fromWeeklyPlan: false, fallback: "official_diet" });
    return;
  }
  res.json({ diet: null, dayKey: today, fromWeeklyPlan: false });
}));

// ─── Teams ───────────────────────────────────────────────────────────────────

adminRouter.get("/teams", asyncHandler(async (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  if (actor.role === "super_admin") {
    res.json({ teams: getAllTeams() });
    return;
  }
  const teamId = normalizeAccessTeamId(actor.teamId);
  const team = getTeam(teamId);
  if (!team) {
    res.status(404).json({ message: `Time não encontrado: ${teamId}`, code: "GUTO_TEAM_NOT_FOUND" });
    return;
  }
  res.json({ teams: [team] });
}));

adminRouter.post("/teams", requireSuperAdmin, asyncHandler(async (req, res) => {
  const body = asRecord(req.body);
  const name = asString(body.name, "").trim();
  if (!name) {
    res.status(400).json({ message: "Nome do Time é obrigatório." });
    return;
  }
  const plan = asString(body.plan, "");
  if (!VALID_TEAM_PLANS.includes(plan as GutoTeamPlan)) {
    res.status(400).json({ message: `Plano inválido. Use: ${VALID_TEAM_PLANS.join(", ")}.` });
    return;
  }
  const customLimitsRaw = asRecord(body.customLimits);
  const customLimits = plan === "custom" && Object.keys(customLimitsRaw).length
    ? {
        maxStudents: customLimitsRaw.maxStudents !== undefined ? asNumber(customLimitsRaw.maxStudents, 0) || null : undefined,
        maxCoaches: customLimitsRaw.maxCoaches !== undefined ? asNumber(customLimitsRaw.maxCoaches, 0) || null : undefined,
      }
    : undefined;
  const id = `team-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();
  const team: GutoTeam = {
    id,
    name,
    plan: plan as GutoTeamPlan,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...(customLimits ? { customLimits } : {}),
  };
  const created = createTeam(team);
  addLog({
    action: "team_created",
    actorUserId: req.gutoUser!.userId,
    actorRole: req.gutoUser!.role,
    metadata: { teamId: created.id, name: created.name, plan: created.plan },
  });
  res.status(201).json({ team: created });
}));

adminRouter.patch("/teams/:teamId", requireSuperAdmin, asyncHandler(async (req, res) => {
  const teamId = routeParam(req, "teamId");
  const existing = getTeam(teamId);
  if (!existing) {
    res.status(404).json({ message: `Time não encontrado: ${teamId}`, code: "GUTO_TEAM_NOT_FOUND" });
    return;
  }
  const body = asRecord(req.body);
  const patch: Partial<GutoTeam> = {};
  if (body.name !== undefined) {
    const name = asString(body.name, "").trim();
    if (!name) { res.status(400).json({ message: "Nome do Time não pode ser vazio." }); return; }
    patch.name = name;
  }
  if (body.plan !== undefined) {
    const plan = asString(body.plan, "");
    if (!VALID_TEAM_PLANS.includes(plan as GutoTeamPlan)) {
      res.status(400).json({ message: `Plano inválido. Use: ${VALID_TEAM_PLANS.join(", ")}.` }); return;
    }
    patch.plan = plan as GutoTeamPlan;
  }
  if (body.status !== undefined) {
    const status = asString(body.status, "");
    if (!["active", "paused", "archived"].includes(status)) {
      res.status(400).json({ message: "Status inválido. Use: active, paused, archived." }); return;
    }
    patch.status = status as GutoTeam["status"];
  }
  if (body.customLimits !== undefined) {
    const raw = asRecord(body.customLimits);
    patch.customLimits = Object.keys(raw).length
      ? {
          maxStudents: raw.maxStudents !== undefined ? asNumber(raw.maxStudents, 0) || null : undefined,
          maxCoaches: raw.maxCoaches !== undefined ? asNumber(raw.maxCoaches, 0) || null : undefined,
        }
      : undefined;
  }
  const updated = updateTeam(teamId, patch);
  addLog({
    action: "team_updated",
    actorUserId: req.gutoUser!.userId,
    actorRole: req.gutoUser!.role,
    metadata: { teamId, ...patch },
  });
  res.json({ team: updated });
}));

// ─── Invite recovery ──────────────────────────────────────────────────────────

adminRouter.get("/students/:userId/invite", asyncHandler(async (req, res) => {
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const invite = await findInviteByUserId(student.userId);
  if (!invite || invite.status === "revoked") {
    res.status(404).json({ message: "Convite não encontrado para este aluno.", code: "GUTO_INVITE_NOT_FOUND" });
    return;
  }
  const inviteLink = invite.rawToken && invite.status === "pending_claim"
    ? buildInviteLink(invite.rawToken)
    : null;
  const message =
    invite.status === "active" ? "Convite já foi utilizado pelo aluno." :
    invite.status === "expired" ? "Convite expirado. Use regenerar para criar um novo." :
    invite.status === "pending_claim" && !invite.rawToken ? "Link do convite não disponível. Use regenerar." :
    undefined;
  res.json({ invite: { ...invite, rawToken: undefined }, inviteLink, ...(message ? { message } : {}) });
}));

adminRouter.post("/students/:userId/invite/regenerate", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const { rawToken } = await regenerateInviteByUserId({
    userId: student.userId,
    name: student.name || student.userId,
    coachId: student.coachId || "admin",
  });
  const inviteLink = buildInviteLink(rawToken);
  addLog({
    action: "invite_regenerated",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: student.userId,
  });
  res.json({ inviteLink });
}));

// ─── Logs ────────────────────────────────────────────────────────────────────

adminRouter.get("/logs", asyncHandler(async (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const targetUserId = req.query.targetUserId ? String(req.query.targetUserId) : undefined;
  if (targetUserId) {
    const target = getUserAccess(targetUserId);
    if (!target) {
      res.status(404).json({ message: "Usuário não encontrado." });
      return;
    }
    if (!canAccessUserAccess(actor, target)) {
      res.status(403).json({ message: "Sem permissão para ver histórico deste usuário.", code: "TEAM_ACCESS_FORBIDDEN" });
      return;
    }
    res.json({ logs: getLogs({ targetUserId }) });
    return;
  }

  if (!isAdminRole(actor.role)) {
    res.status(403).json({ message: "Apenas admin pode ver logs globais." });
    return;
  }

  if (actor.role === "super_admin") {
    res.json({ logs: getLogs() });
    return;
  }

  const scopedUserIds = new Set(getScopedUserAccessList(actor, await getAllUserAccessAsync()).map((user) => user.userId));
  res.json({ logs: getLogs().filter((log) => !log.targetUserId || scopedUserIds.has(log.targetUserId)) });
}));

// ─── Maintenance: backfill arena XP for existing users ──────────────────────
// Bug fix one-shot: usuários criados antes do fix de grantInitialXp ficaram
// com arenaProfile.totalXp 100 abaixo de memory.totalXp. Este endpoint
// adiciona +100 XP em todos os arenaProfiles que estão com totalXp < 100,
// alinhando-os com os 100 XP que já foram concedidos no memory.
adminRouter.post("/maintenance/backfill-arena-initial-xp", requireAdmin, asyncHandler(async (_req, res) => {
  const profiles = getAllArenaProfiles();
  const fixed: Array<{ userId: string; before: number; after: number }> = [];
  for (const profile of profiles) {
    if (profile.totalXp < 100) {
      const before = profile.totalXp;
      profile.totalXp = profile.totalXp + 100;
      profile.weeklyXp = profile.weeklyXp + 100;
      profile.monthlyXp = profile.monthlyXp + 100;
      profile.updatedAt = new Date().toISOString();
      saveArenaProfile(profile);
      fixed.push({ userId: profile.userId, before, after: profile.totalXp });
    }
  }
  res.json({ fixedCount: fixed.length, fixed });
}));

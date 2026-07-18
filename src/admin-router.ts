import express, { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { getAggregatedExerciseCatalog, getCatalogById, type CatalogLanguage, type CatalogMuscleGroup } from "../exercise-catalog.js";
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
  deleteTeam,
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
  readArenaStoreAsync,
  mutateArenaStoreAsync,
} from "./arena-store.js";
import { getAvatarStage, DEFAULT_ARENA_GROUP } from "./arena.js";
import {
  readPersistedUserMemorySnapshot,
  updateUserMemoryAtomically,
} from "./memory-store.js";
import {
  getMemory,
  saveMemory,
  buildDietProfileFingerprint,
  resolveDietFoodRestrictionAtomically,
  buildWorkoutPlanFromSemanticFocus,
  invalidateDietIfNeeded,
  type WeekDayKey,
  type WeeklyWorkoutPlan,
  type WeeklyDietDay,
  type WeeklyDietPlan,
} from "../server.js";
import {
  DietPlanWriteConflictError,
  deleteDietPlan,
  deleteDietPlanIfUnchanged,
  getDietPlanConcurrencyToken,
  readPersistedDietPlan,
  saveDietPlanIfUnchanged,
} from "./diet-store.js";
import { addLog, getLogs } from "./log-store.js";
import { config } from "./config.js";
import { parseRequestOriginalUrl } from "./http/request-url.js";
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
  calculateMacros,
  type DietMeal,
  type DietPlan,
  type NutritionProfile,
} from "./nutrition.js";
import {
  buildBaseDietSkeleton,
  type UserFoodConstraints,
} from "./food-availability.js";
import type { FoodCountry, FoodLanguage } from "./food-catalog.js";
import {
  getPendingClarification,
} from "./dirty-data-resolver.js";
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
adminRouter.use((_req, _res, next) => {
  void readArenaStoreAsync().then(() => next(), next);
});

type PlanSource = "guto_generated" | "coach_manual" | "mixed";
type LooseRecord = Record<string, any>;
type BiologicalSex = "female" | "male";
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

function matchesStudentFilters(student: ReturnType<typeof buildStudentView>, searchParams: URLSearchParams): boolean {
  const search = queryText(searchParams.get("search")).toLowerCase();
  const coachId = queryText(searchParams.get("coachId"));
  const gender = queryText(searchParams.get("gender")).toLowerCase();
  const status = queryText(searchParams.get("status"));
  const subscriptionStatus = queryText(searchParams.get("subscriptionStatus"));
  const minAge = queryNumber(searchParams.get("minAge"));
  const maxAge = queryNumber(searchParams.get("maxAge"));
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
  const searchParams = parseRequestOriginalUrl(req.originalUrl).searchParams;
  return getScopedUserAccessList(actor, allUsers)
    .filter((user) => user.role === "student")
    .map(buildStudentView)
    .filter((student) => matchesStudentFilters(student, searchParams));
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

// Operational contact fields for a Team/Empresa. Email is validated when sent
// (the panel form requires it); phone/address são contato comercial opcional.
// Returns the partial patch, or null after responding with 400.
function readTeamContactFields(
  body: LooseRecord,
  res: Response,
): Partial<Pick<GutoTeam, "email" | "phone" | "addressLine" | "city" | "country">> | null {
  const patch: Partial<Pick<GutoTeam, "email" | "phone" | "addressLine" | "city" | "country">> = {};
  if (body.email !== undefined) {
    const email = asString(body.email, "").trim().toLowerCase();
    if (email && !isValidEmail(email)) {
      res.status(400).json({ message: "Email de contato da empresa é inválido.", code: "GUTO_EMAIL_INVALID" });
      return null;
    }
    patch.email = email || undefined;
  }
  if (body.phone !== undefined) {
    const phone = normalizePhone(body.phone);
    if (phone && !isValidPhone(phone)) {
      res.status(400).json({ message: "Telefone da empresa é inválido.", code: "GUTO_PHONE_INVALID" });
      return null;
    }
    patch.phone = phone || undefined;
  }
  if (body.addressLine !== undefined) patch.addressLine = asString(body.addressLine, "").trim() || undefined;
  if (body.city !== undefined) patch.city = asString(body.city, "").trim() || undefined;
  if (body.country !== undefined) patch.country = asString(body.country, "").trim() || undefined;
  return patch;
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

function normalizeBiologicalSex(value: unknown): BiologicalSex | undefined {
  return value === "female" || value === "male" ? value : undefined;
}

function normalizeIntegerInRange(value: unknown, min: number, max: number): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return undefined;
  const rounded = Math.round(numberValue);
  return rounded >= min && rounded <= max ? rounded : undefined;
}

function normalizeDecimalInRange(value: unknown, min: number, max: number, decimals = 1): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return undefined;
  const factor = 10 ** decimals;
  const rounded = Math.round(numberValue * factor) / factor;
  return rounded >= min && rounded <= max ? rounded : undefined;
}

async function updateMemoryFromStudentPatch(userId: string, patch: Partial<UserAccess> & LooseRecord): Promise<void> {
  const memory = getMemory(userId);
  if (typeof patch.firstName === "string" && patch.firstName.trim()) memory.name = patch.firstName.trim();
  else if (typeof patch.name === "string" && patch.name.trim()) memory.name = patch.name.trim();
  const calibration = asRecord(patch.calibration);
  const merged = { ...patch, ...calibration };
  const changedFields = new Set<string>();
  const setStringField = (field: keyof typeof memory, value: string): void => {
    if (memory[field] !== value) changedFields.add(String(field));
    (memory as LooseRecord)[field] = value;
  };

  const nextUserAge = normalizeIntegerInRange(merged.userAge, 14, 99);
  if (nextUserAge !== undefined) {
    if (memory.userAge !== nextUserAge) changedFields.add("userAge");
    memory.userAge = nextUserAge;
  }
  const nextBiologicalSex = normalizeBiologicalSex(merged.biologicalSex);
  if (nextBiologicalSex) {
    if (memory.biologicalSex !== nextBiologicalSex) changedFields.add("biologicalSex");
    memory.biologicalSex = nextBiologicalSex;
  }
  if (typeof merged.trainingLevel === "string") {
    setStringField("trainingLevel", merged.trainingLevel);
    if (typeof merged.trainingStatus !== "string") setStringField("trainingStatus", merged.trainingLevel);
  }
  if (typeof merged.trainingStatus === "string") setStringField("trainingStatus", merged.trainingStatus);
  if (typeof merged.trainingGoal === "string") setStringField("trainingGoal", merged.trainingGoal);
  if (typeof merged.preferredTrainingLocation === "string") setStringField("preferredTrainingLocation", merged.preferredTrainingLocation);
  if (typeof merged.trainingPathology === "string") setStringField("trainingPathology", merged.trainingPathology);
  const countryChanged = typeof merged.country === "string" && memory.country !== merged.country;
  if (typeof merged.country === "string") setStringField("country", merged.country);
  if (typeof merged.countryCode === "string") {
    const nextCountryCode = merged.countryCode.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(nextCountryCode)) setStringField("countryCode", nextCountryCode);
  } else if (countryChanged && memory.countryCode) {
    memory.countryCode = undefined;
    changedFields.add("countryCode");
  }
  if (typeof merged.city === "string") setStringField("city", merged.city);
  const nextHeightCm = normalizeIntegerInRange(merged.heightCm, 100, 250);
  if (nextHeightCm !== undefined) {
    if (memory.heightCm !== nextHeightCm) changedFields.add("heightCm");
    memory.heightCm = nextHeightCm;
  }
  const nextWeightKg = normalizeDecimalInRange(merged.weightKg, 30, 300);
  if (nextWeightKg !== undefined) {
    if (memory.weightKg !== nextWeightKg) changedFields.add("weightKg");
    memory.weightKg = nextWeightKg;
  }
  if (typeof merged.foodRestrictions === "string") setStringField("foodRestrictions", merged.foodRestrictions);
  await invalidateDietIfNeeded(memory, changedFields);
  saveMemory(memory);
}

export async function deleteStudentEverywhere(userId: string): Promise<void> {
  await updateUserMemoryAtomically(userId, () => null);

  await mutateArenaStoreAsync((arenaStore) => {
    delete arenaStore.profiles[userId];
    arenaStore.events = arenaStore.events.filter((event) => event.userId !== userId);
  });

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

function normalizeWorkoutPlan(rawValue: unknown, existing: LooseRecord | null, req: Request, reason?: string, language?: CatalogLanguage): LooseRecord {
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
  // Idioma do aluno: hidrata os nomes do catálogo no idioma certo. Antes era
  // default "pt-BR", o que fazia coach EN/IT ver "agachamento" em vez de "squat"
  // ao editar treino (bug do fundador 2026-05-28, par do fix em server.ts
  // markGutoGeneratedWorkout).
  return normalizeWorkoutPlanAgainstCatalog(workout, language);
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

const ADMIN_DIET_COUNTRY_BY_CODE: Record<string, FoodCountry> = {
  BR: "brazil",
  IT: "italy",
  ES: "spain",
  PT: "portugal",
  US: "usa",
  GB: "uk",
  UK: "uk",
  DE: "germany",
  FR: "france",
  AR: "argentina",
};

const ADMIN_DIET_COUNTRY_BY_NAME: Record<string, FoodCountry> = {
  brasil: "brazil",
  brazil: "brazil",
  italia: "italy",
  italy: "italy",
  espanha: "spain",
  spain: "spain",
  portugal: "portugal",
  estadosunidos: "usa",
  eua: "usa",
  usa: "usa",
  unitedstates: "usa",
  reinounido: "uk",
  unitedkingdom: "uk",
  uk: "uk",
  alemanha: "germany",
  germany: "germany",
  franca: "france",
  france: "france",
  argentina: "argentina",
};

const ADMIN_DIET_GOALS: NutritionProfile["trainingGoal"][] = [
  "fat_loss",
  "muscle_gain",
  "conditioning",
  "mobility_health",
  "consistency",
];

const ADMIN_DIET_LEVELS: NutritionProfile["trainingLevel"][] = [
  "beginner",
  "returning",
  "consistent",
  "advanced",
];

function normalizeAdminDietKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizeAdminDietLanguage(value: unknown): FoodLanguage {
  if (value === "en-US" || value === "it-IT" || value === "pt-BR") return value;
  const lower = asString(value, "").toLowerCase();
  if (lower.startsWith("en")) return "en-US";
  if (lower.startsWith("it")) return "it-IT";
  return "pt-BR";
}

function normalizeAdminDietGoal(value: unknown): NutritionProfile["trainingGoal"] | null {
  return ADMIN_DIET_GOALS.includes(value as NutritionProfile["trainingGoal"])
    ? value as NutritionProfile["trainingGoal"]
    : null;
}

function normalizeAdminDietLevel(value: unknown): NutritionProfile["trainingLevel"] | null {
  const raw = asString(value, "");
  if (ADMIN_DIET_LEVELS.includes(raw as NutritionProfile["trainingLevel"])) {
    return raw as NutritionProfile["trainingLevel"];
  }
  const key = normalizeAdminDietKey(raw);
  if (["iniciante", "beginner"].includes(key)) return "beginner";
  if (["intermediario", "intermediate", "returning"].includes(key)) return "returning";
  if (["consistente", "consistent"].includes(key)) return "consistent";
  if (["avancado", "advanced"].includes(key)) return "advanced";
  return null;
}

function isNoAdminFoodRestrictionText(value: unknown): boolean {
  const raw = asString(value, "").trim();
  if (!raw) return true;
  const key = normalizeAdminDietKey(raw);
  return [
    "none",
    "no",
    "nada",
    "nenhuma",
    "semrestricao",
    "semrestricoes",
    "semrestricaoalimentar",
    "semalergia",
    "semalergias",
    "semintolerancia",
    "semintolerancias",
    "comodetudo",
    "ieateverything",
    "nofoodrestriction",
    "nofoodrestrictions",
    "noallergy",
    "noallergies",
    "mangiotutto",
    "nessuna",
    "nessuno",
    "nessunaallergia",
    "nessunaintolleranza",
  ].includes(key);
}

function resolveAdminDietCountry(memory: LooseRecord): FoodCountry | null {
  const code = asString(memory.countryCode, "").trim().toUpperCase();
  if (ADMIN_DIET_COUNTRY_BY_CODE[code]) return ADMIN_DIET_COUNTRY_BY_CODE[code];

  const resolvedCountry = asRecord(asRecord(memory.resolvedFields).country);
  const normalizedResolved = normalizeAdminDietKey(asString(resolvedCountry.normalizedValue, ""));
  if (ADMIN_DIET_COUNTRY_BY_NAME[normalizedResolved]) return ADMIN_DIET_COUNTRY_BY_NAME[normalizedResolved];

  const countryKey = normalizeAdminDietKey(asString(memory.country, ""));
  return ADMIN_DIET_COUNTRY_BY_NAME[countryKey] || null;
}

function buildAdminDietRestrictionConstraints(normalizedValue: string | undefined, rawValue: string): UserFoodConstraints | null {
  const normalized = normalizeAdminDietKey(normalizedValue || "");
  const raw = normalizeAdminDietKey(rawValue);
  const restrictions = new Set<string>();
  const allergens = new Set<string>();

  if (normalized === "lactoseintolerance" || raw.includes("lactose") || raw.includes("lattosio")) {
    restrictions.add("lactose_intolerance");
  }
  if (normalized === "milkallergy" || raw.includes("leite") || raw.includes("milk") || raw.includes("latte")) {
    restrictions.add("milk_allergy");
    allergens.add("milk");
  }
  if (normalized === "fishseafoodrestriction" || normalized === "fishallergy" || raw.includes("peixe") || raw.includes("fish") || raw.includes("pesce") || raw.includes("frutosdomar") || raw.includes("seafood")) {
    restrictions.add("fish_allergy");
    allergens.add("fish");
    allergens.add("shellfish");
  }
  if (normalized === "eggrestriction" || normalized === "eggallergy" || raw.includes("ovo") || raw.includes("egg") || raw.includes("uovo")) {
    restrictions.add("egg_allergy");
    allergens.add("egg");
  }

  if (!restrictions.size && !allergens.size) return null;
  return { restrictions: Array.from(restrictions), allergens: Array.from(allergens) };
}

async function resolveAdminDietConstraints(memory: LooseRecord): Promise<{
  foodRestrictions: string;
  constraints?: UserFoodConstraints;
  error?: { status: number; code: string; message: string; rawValue?: string };
}> {
  const rawRestriction = asString(memory.foodRestrictions, "").trim();
  const foodRestrictions = isNoAdminFoodRestrictionText(rawRestriction) ? "none" : rawRestriction;
  if (foodRestrictions === "none") return { foodRestrictions };

  // A rota de geração resolve e persiste este campo atomicamente antes de
  // capturar o fingerprint. Aqui apenas consumimos o snapshot já confirmado,
  // evitando um save full-snapshot que poderia sobrescrever perfil/treino.
  const resolvedFields = asRecord(memory.resolvedFields) as any;

  const pending = getPendingClarification(resolvedFields, "diet");
  if (pending?.field === "foodRestriction") {
    return {
      foodRestrictions,
      error: {
        status: 422,
        code: "FOOD_RESTRICTION_NEEDS_CLARIFICATION",
        message: `Restrição alimentar precisa de confirmação antes de gerar dieta: ${pending.rawValue}.`,
        rawValue: pending.rawValue,
      },
    };
  }

  const normalizedValue =
    resolvedFields.foodRestriction?.status === "clear"
      ? resolvedFields.foodRestriction.normalizedValue
      : undefined;
  const constraints = buildAdminDietRestrictionConstraints(normalizedValue, rawRestriction);
  if (!constraints) {
    return {
      foodRestrictions,
      error: {
        status: 422,
        code: "FOOD_RESTRICTION_UNSUPPORTED",
        message: `Restrição alimentar ainda não suportada pelo gerador determinístico do painel: ${rawRestriction}.`,
        rawValue: rawRestriction,
      },
    };
  }

  return { foodRestrictions, constraints };
}

function splitAdminDietCalories(totalKcal: number, slots: number): number[] {
  const base = Math.floor(totalKcal / slots);
  const values = Array.from({ length: slots }, () => base);
  let remainder = totalKcal - base * slots;
  for (let i = 0; i < values.length && remainder > 0; i += 1, remainder -= 1) {
    values[i] += 1;
  }
  return values;
}

function adminDietSlotLabels(language: FoodLanguage): Record<string, string> {
  if (language === "en-US") {
    return { cafe: "Breakfast", lanche1: "Snack 1", almoco: "Lunch", lanche2: "Snack 2", jantar: "Dinner" };
  }
  if (language === "it-IT") {
    return { cafe: "Colazione", lanche1: "Spuntino 1", almoco: "Pranzo", lanche2: "Spuntino 2", jantar: "Cena" };
  }
  return { cafe: "Café da manhã", lanche1: "Lanche 1", almoco: "Almoço", lanche2: "Lanche 2", jantar: "Jantar" };
}

async function buildAdminGeneratedDietPlan(userId: string, memory: LooseRecord): Promise<{
  plan?: DietPlan;
  error?: { status: number; code: string; message: string; missing?: string[]; rawValue?: string };
}> {
  const language = normalizeAdminDietLanguage(memory.language);
  const biologicalSex = memory.biologicalSex === "female" || memory.biologicalSex === "male"
    ? memory.biologicalSex
    : null;
  const userAge = asNumber(memory.userAge, 0);
  const heightCm = asNumber(memory.heightCm, 0);
  const weightKg = asNumber(memory.weightKg, 0);
  const trainingLevel = normalizeAdminDietLevel(memory.trainingLevel || memory.trainingStatus);
  const trainingGoal = normalizeAdminDietGoal(memory.trainingGoal);
  const country = asString(memory.country, "").trim();
  const city = asString(memory.city, "").trim();
  const countryCode = asString(memory.countryCode, "").trim().toUpperCase();

  const missing: string[] = [];
  if (!biologicalSex) missing.push("biologicalSex");
  if (!userAge) missing.push("userAge");
  if (!heightCm) missing.push("heightCm");
  if (!weightKg) missing.push("weightKg");
  if (!trainingLevel) missing.push("trainingLevel");
  if (!trainingGoal) missing.push("trainingGoal");
  if (!country) missing.push("country");
  if (!city) missing.push("city");
  if (missing.length > 0) {
    return {
      error: {
        status: 422,
        code: "DIET_PROFILE_INCOMPLETE",
        message: `Perfil incompleto para gerar dieta: ${missing.join(", ")}.`,
        missing,
      },
    };
  }
  const dietBiologicalSex = biologicalSex as NutritionProfile["biologicalSex"];
  const dietTrainingLevel = trainingLevel as NutritionProfile["trainingLevel"];
  const dietTrainingGoal = trainingGoal as NutritionProfile["trainingGoal"];

  const catalogCountry = resolveAdminDietCountry(memory);
  if (!catalogCountry) {
    return {
      error: {
        status: 422,
        code: "DIET_COUNTRY_UNSUPPORTED",
        message: `País ainda não suportado pelo gerador determinístico do painel: ${country}.`,
      },
    };
  }

  const restrictionResolution = await resolveAdminDietConstraints(memory);
  if (restrictionResolution.error) return { error: restrictionResolution.error };

  const profile: NutritionProfile = {
    biologicalSex: dietBiologicalSex,
    userAge,
    heightCm,
    weightKg,
    trainingLevel: dietTrainingLevel,
    trainingGoal: dietTrainingGoal,
    country,
    countryCode,
    city,
    foodRestrictions: restrictionResolution.foodRestrictions,
  };
  const macros = calculateMacros(profile);
  const skeleton = buildBaseDietSkeleton({
    country: catalogCountry,
    goal: dietTrainingGoal,
    constraints: restrictionResolution.constraints,
    language,
    limitPerType: 3,
  });
  const byType = {
    breakfast: skeleton.filter((meal) => meal.mealType === "breakfast"),
    snack: skeleton.filter((meal) => meal.mealType === "snack"),
    lunch: skeleton.filter((meal) => meal.mealType === "lunch"),
    dinner: skeleton.filter((meal) => meal.mealType === "dinner"),
  };
  const selected = [
    { id: "cafe", time: "08:00", block: byType.breakfast[0], ratio: 0.25 },
    { id: "lanche1", time: "10:30", block: byType.snack[0], ratio: 0.10 },
    { id: "almoco", time: "13:00", block: byType.lunch[0], ratio: 0.30 },
    { id: "lanche2", time: "16:30", block: byType.snack[1] || byType.snack[0], ratio: 0.10 },
    { id: "jantar", time: "20:00", block: byType.dinner[0], ratio: 0.25 },
  ];
  if (selected.some((slot) => !slot.block)) {
    return {
      error: {
        status: 422,
        code: "DIET_NO_SAFE_LOCAL_BLOCKS",
        message: "Não há blocos alimentares locais suficientes para gerar dieta segura com esse perfil.",
      },
    };
  }

  const labels = adminDietSlotLabels(language);
  const mealTargets = selected.map((slot, index) => {
    if (index === selected.length - 1) {
      const previous = selected.slice(0, -1).reduce((sum, item) => sum + Math.round(macros.targetKcal * item.ratio), 0);
      return macros.targetKcal - previous;
    }
    return Math.round(macros.targetKcal * slot.ratio);
  });
  const meals: DietMeal[] = selected.map((slot, index) => {
    const block = slot.block!;
    const calories = splitAdminDietCalories(mealTargets[index], block.ingredients.length);
    const foods = block.ingredients.map((ingredient, foodIndex) => ({
      name: ingredient.name,
      quantity: "1 porção",
      kcal: calories[foodIndex],
    }));
    return {
      id: slot.id,
      name: labels[slot.id] || block.title,
      time: slot.time,
      foods,
      totalKcal: foods.reduce((sum, food) => sum + food.kcal, 0),
      gutoNote: language === "en-US"
        ? "Local, simple and matched to your goal."
        : language === "it-IT"
          ? "Locale, semplice e coerente col tuo obiettivo."
          : "Local, simples e alinhado ao objetivo.",
    };
  });

  return {
    plan: {
      userId,
      title: "Dieta oficial",
      language,
      generatedAt: new Date().toISOString(),
      country,
      countryCode,
      city,
      macros,
      meals,
      goal: dietTrainingGoal,
      source: "guto_generated",
      planSource: "ai_generated",
      lockedByCoach: false,
      manualOverride: false,
      foodRestrictions: restrictionResolution.foodRestrictions,
      restrictions: restrictionResolution.foodRestrictions,
      updatedAt: new Date().toISOString(),
    },
  };
}

function workoutHistory(userId: string) {
  return getLogs({ targetUserId: userId }).filter((log) => log.action.startsWith("workout_"));
}

function dietHistory(userId: string) {
  return getLogs({ targetUserId: userId }).filter((log) => log.action.startsWith("diet_"));
}

async function resetArenaAndMemory(userId: string, scope: ResetScope): Promise<void> {
  await mutateArenaStoreAsync((arenaStore) => {
    const arena = arenaStore.profiles[userId];
    if (!arena) return;
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
  });

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
    await saveMemory(memory);
  }
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((error) => {
      console.error("[GUTO_ADMIN] route error:", error);
      if (error instanceof DietPlanWriteConflictError) {
        res.status(409).json({
          message: "A dieta mudou enquanto esta operação era aplicada. Recarregue e tente novamente.",
          code: error.code,
        });
        return;
      }
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
  const requestedTeamId = queryText(parseRequestOriginalUrl(req.originalUrl).searchParams.get("teamId"));
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
  // Nome soberano: aceita "name" único OU firstName/lastName separados. O sobrenome é
  // opcional — o aluno confirma o nome soberano no app. Mesma leniência de POST /coaches.
  const fullNameInput = normalizePersonName(body.firstName || body.name);
  let firstName = fullNameInput;
  let lastName = normalizePersonName(body.lastName);
  if (!lastName && fullNameInput.includes(" ")) {
    const [head, ...rest] = fullNameInput.split(" ");
    firstName = head;
    lastName = rest.join(" ");
  }
  const email = asString(body.email, "").trim().toLowerCase();
  const phone = normalizePhone(body.phone);
  if (!firstName) {
    res.status(400).json({ message: "Nome do aluno é obrigatório.", code: "GUTO_NAME_REQUIRED" });
    return;
  }
  if (!email || !isValidEmail(email)) {
    res.status(400).json({ message: "Email válido do aluno é obrigatório.", code: "GUTO_EMAIL_INVALID" });
    return;
  }
  // Telefone é contato comercial opcional para o aluno; valida só quando enviado.
  if (phone && !isValidPhone(phone)) {
    res.status(400).json({ message: "Telefone do aluno é inválido.", code: "GUTO_PHONE_INVALID" });
    return;
  }
  // Email é o identificador de login: precisa ser único na plataforma.
  const emailTaken = (await getAllUserAccessAsync()).some(
    (u) => asString(u.email, "").trim().toLowerCase() === email,
  );
  if (emailTaken) {
    res.status(409).json({ message: "Já existe um usuário com este email.", code: "GUTO_EMAIL_DUPLICATE" });
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
  let coachId = typeof body.coachId === "string" && body.coachId.trim()
    ? body.coachId.trim()
    : undefined;
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
  } else if (teamId !== GUTO_CORE_TEAM_ID) {
    // Admin/super_admin criando aluno em empresa CLIENTE sem coachId: não
    // vinculamos o aluno ao operador administrativo. Exige um coach real da
    // empresa. Exceção documentada: GUTO_CORE (alunos internos).
    res.status(400).json({
      message: "Aluno em empresa cliente precisa de um coach responsável. Crie um coach na empresa antes de adicionar alunos.",
      code: "GUTO_COACH_REQUIRED",
    });
    return;
  } else {
    coachId = actor.coachId || actor.userId;
  }
  if (!coachId) {
    res.status(400).json({ message: "Coach responsável é obrigatório.", code: "GUTO_COACH_REQUIRED" });
    return;
  }
  const resolvedCoachId = coachId;
  if (!(await ensureTeamPlanCapacity(res, teamId, "student", userId))) return;
  const requestedPassword = body.password?.trim();
  const temporaryPassword =
    !requestedPassword && body.active === true ? `GUTO-${crypto.randomBytes(4).toString("hex")}` : undefined;
  const passwordHash = requestedPassword || temporaryPassword
    ? await bcrypt.hash(requestedPassword || temporaryPassword!, 10)
    : undefined;
  const active = body.active ?? Boolean(passwordHash);
  const durationDays = body.accessDurationDays || 30;
  const subscriptionEndsAt = active ? (body.subscriptionEndsAt || setDaysFromNow(durationDays)) : (body.subscriptionEndsAt || null);

  const user = await upsertUserAccessAsync(userId, {
    ...publicUserPatch({ ...body, firstName, lastName, name: fullName, email, phone }),
    role: "student",
    coachId: resolvedCoachId,
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
    const { rawToken } = await createInvite({ userId, name: fullName, coachId: resolvedCoachId });
    inviteLink = buildInviteLink(rawToken);
  }

  addLog({
    action: "user_created",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: userId,
    metadata: { role: "student", coachId: resolvedCoachId, active },
  });

  res.status(201).json({ user, student: buildStudentView(user), inviteLink, temporaryPassword });
}));

adminRouter.get(["/students/:userId", "/users/:userId"], asyncHandler(async (req, res) => {
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const persistedMemory = await readPersistedUserMemorySnapshot(student.userId);
  const memory = {
    ...getMemory(student.userId),
    ...(persistedMemory && typeof persistedMemory === "object" && !Array.isArray(persistedMemory)
      ? persistedMemory as Record<string, unknown>
      : {}),
  };
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

adminRouter.delete(["/students/:userId", "/users/:userId"], requireSuperAdmin, asyncHandler(async (req, res) => {
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
  const subscriptionEndsAt = student.subscriptionEndsAt || setDaysFromNow(30);
  const updated = await upsertUserAccessAsync(student.userId, {
    passwordHash,
    active: true,
    archived: false,
    subscriptionStatus: "active",
    paymentStatus: "active",
    subscriptionEndsAt,
  });
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
  await resetArenaAndMemory(student.userId, scope);
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
  const workout = normalizeWorkoutPlan(body.workout ?? req.body, previous, req, body.reason, memory.language as CatalogLanguage);
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
  const workout = normalizeWorkoutPlan({ ...(previous || {}), ...asRecord(body.workout ?? req.body) }, previous, req, body.reason, memory.language as CatalogLanguage);
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

  // Gate de calibragem: não gerar treino com defaults silenciosos (decisão do
  // fundador, 2026-05-28). Antes a rota caía em "casa"/"iniciante"/"sem dor"
  // mesmo com perfil vazio. Mesma estratégia do gate de dieta (DIET_PROFILE_INCOMPLETE).
  const trainingLocation = (memory.preferredTrainingLocation || memory.trainingLocation || "").toString().trim();
  const trainingLevel = (memory.trainingLevel || memory.trainingStatus || "").toString().trim();
  const trainingGoal = (memory.trainingGoal || "").toString().trim();
  const biologicalSex = memory.biologicalSex === "female" || memory.biologicalSex === "male" ? memory.biologicalSex : null;
  const userAge = asNumber(memory.userAge ?? memory.trainingAge, 0);
  const heightCm = asNumber(memory.heightCm, 0);
  const weightKg = asNumber(memory.weightKg, 0);

  const missing: string[] = [];
  if (!biologicalSex) missing.push("biologicalSex");
  if (!userAge) missing.push("userAge");
  if (!heightCm) missing.push("heightCm");
  if (!weightKg) missing.push("weightKg");
  if (!trainingLevel) missing.push("trainingLevel");
  if (!trainingGoal) missing.push("trainingGoal");
  if (!trainingLocation) missing.push("preferredTrainingLocation");

  if (missing.length > 0) {
    res.status(422).json({
      message: `Perfil incompleto para gerar treino: ${missing.join(", ")}.`,
      code: "WORKOUT_PROFILE_INCOMPLETE",
      missing,
    });
    return;
  }

  const generated = buildWorkoutPlanFromSemanticFocus({
    language: memory.language,
    location: trainingLocation,
    status: trainingLevel,
    limitation: memory.trainingLimitations || memory.trainingPathology || "sem dor",
    age: userAge,
    scheduleIntent: memory.trainingSchedule,
    focus: memory.nextWorkoutFocus,
    trainingGoal,
  });
  const workout = normalizeWorkoutPlan({ ...generated, source: "guto_generated", lockedByCoach: false }, null, req, "Generated by GUTO through admin panel", memory.language as CatalogLanguage);
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

// GET /admin/students/:userId/validations
// Retorna o histórico completo de validações de treino (até 5 últimas, com fotos)
// + o histórico de feedback (dificuldade, energia, dor). Usado pelo painel do
// coach para acompanhar a evolução do aluno — bug do fundador (2026-05-28):
// "o coach precisa ver as fotos das validações". Antes só havia validationsTotal
// (contagem) e lastValidationAt em buildStudentView.
adminRouter.get("/students/:userId/validations", asyncHandler(async (req, res) => {
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const memory = getMemory(student.userId);
  const validations = Array.isArray(memory.validationHistory) ? memory.validationHistory : [];
  const feedback = Array.isArray(memory.workoutFeedbackHistory) ? memory.workoutFeedbackHistory : [];
  res.json({
    // Ordem mais recente primeiro (UI mostra cards do mais novo pro mais velho).
    validations: [...validations].reverse(),
    feedback: [...feedback].reverse(),
  });
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
  const studentLanguage = memory.language as CatalogLanguage;
  for (const day of VALID_DAYS) {
    const rawDay = rawDays[day];
    if (rawDay == null) continue;
    const normalized = normalizeWorkoutPlan(rawDay, null, req, `Weekly plan — ${day}`, studentLanguage);
    normalized.studentId = student.userId;
    normalized.weekDay = day;
    // Re-normaliza pra garantir idioma do aluno (igual ao caminho de daily).
    days[day] = normalizeWorkoutPlanAgainstCatalog(normalized, studentLanguage);
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
  const diet = await readPersistedDietPlan(student.userId);
  res.json({ diet });
}));

adminRouter.put(["/students/:userId/diet", "/users/:userId/diet"], asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const body = req.body as { diet?: unknown; reason?: string };
  const previous = await readPersistedDietPlan(student.userId);
  const diet = normalizeDietPlan(body.diet ?? req.body, previous as LooseRecord | null, req, student.userId, body.reason);
  const calorieError = dietCalorieValidationMessage(diet);
  if (calorieError) {
    res.status(400).json({ message: calorieError, code: "DIET_CALORIES_MISMATCH" });
    return;
  }
  await saveDietPlanIfUnchanged(diet as any, getDietPlanConcurrencyToken(previous), { allowLockedCurrent: true });
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
  const previous = await readPersistedDietPlan(student.userId);
  const diet = normalizeDietPlan({ ...(previous || {}), ...asRecord(body.diet ?? req.body) }, previous as LooseRecord | null, req, student.userId, body.reason);
  const calorieError = dietCalorieValidationMessage(diet);
  if (calorieError) {
    res.status(400).json({ message: calorieError, code: "DIET_CALORIES_MISMATCH" });
    return;
  }
  await saveDietPlanIfUnchanged(diet as any, getDietPlanConcurrencyToken(previous), { allowLockedCurrent: true });
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
  const existing = await readPersistedDietPlan(student.userId);
  if (existing?.lockedByCoach) {
    res.status(409).json({ message: "Plano bloqueado pelo coach.", code: "COACH_LOCKED_PLAN" });
    return;
  }

  const persistedDietMemory = await readPersistedUserMemorySnapshot(student.userId);
  let memory = {
    ...getMemory(student.userId),
    ...(persistedDietMemory && typeof persistedDietMemory === "object" && !Array.isArray(persistedDietMemory)
      ? persistedDietMemory as Record<string, unknown>
      : {}),
  };
  memory = await resolveDietFoodRestrictionAtomically(memory as any) as unknown as typeof memory;
  const profileFingerprint = buildDietProfileFingerprint(memory);
  const generationLanguage = normalizeAdminDietLanguage(memory.language);
  const generated = await buildAdminGeneratedDietPlan(student.userId, memory as LooseRecord);
  if (generated.error) {
    res.status(generated.error.status).json({
      message: generated.error.message,
      code: generated.error.code,
      missing: generated.error.missing,
      rawValue: generated.error.rawValue,
    });
    return;
  }

  const diet = generated.plan!;
  const memoryBeforeCommitRaw = await readPersistedUserMemorySnapshot(student.userId);
  const memoryBeforeCommit = memoryBeforeCommitRaw && typeof memoryBeforeCommitRaw === "object" && !Array.isArray(memoryBeforeCommitRaw)
    ? memoryBeforeCommitRaw as ReturnType<typeof getMemory>
    : null;
  if (
    !memoryBeforeCommit ||
    buildDietProfileFingerprint(memoryBeforeCommit) !== profileFingerprint ||
    normalizeAdminDietLanguage(memoryBeforeCommit.language) !== generationLanguage
  ) {
    res.status(409).json({ message: "Perfil mudou durante a geração da dieta.", code: "DIET_CONTEXT_CHANGED" });
    return;
  }
  diet.profileFingerprint = profileFingerprint;
  diet.language = generationLanguage;
  await saveDietPlanIfUnchanged(diet, getDietPlanConcurrencyToken(existing));
  let statusCommitted = false;
  await updateUserMemoryAtomically(student.userId, (snapshot) => {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
    const current = snapshot as ReturnType<typeof getMemory>;
    if (
      buildDietProfileFingerprint(current) !== profileFingerprint ||
      normalizeAdminDietLanguage(current.language) !== generationLanguage
    ) {
      return current;
    }
    current.dietGenerationStatus = "generated";
    statusCommitted = true;
    return current;
  });
  if (!statusCommitted) {
    res.status(409).json({ message: "Perfil mudou durante o commit da dieta.", code: "DIET_CONTEXT_CHANGED" });
    return;
  }
  addLog({
    action: "diet_generated",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: student.userId,
    metadata: { sourceBefore: existing?.source, sourceAfter: diet.source, country: diet.country, city: diet.city },
  });
  res.json({ diet });
}));

adminRouter.post("/students/:userId/diet/lock", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const existing = await readPersistedDietPlan(student.userId);
  if (!existing) {
    res.status(404).json({ message: "Dieta não encontrada." });
    return;
  }
  const diet = { ...existing, lockedByCoach: true, updatedBy: caller.userId, updatedAt: new Date().toISOString() };
  await saveDietPlanIfUnchanged(diet, getDietPlanConcurrencyToken(existing), { allowLockedCurrent: true });
  addLog({ action: "diet_locked", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { lockedByCoach: true } });
  res.json({ diet });
}));

adminRouter.post("/students/:userId/diet/unlock", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const existing = await readPersistedDietPlan(student.userId);
  if (!existing) {
    res.status(404).json({ message: "Dieta não encontrada." });
    return;
  }
  const diet = { ...existing, lockedByCoach: false, updatedBy: caller.userId, updatedAt: new Date().toISOString() };
  await saveDietPlanIfUnchanged(diet, getDietPlanConcurrencyToken(existing), { allowLockedCurrent: true });
  addLog({ action: "diet_unlocked", actorUserId: caller.userId, actorRole: caller.role, targetUserId: student.userId, metadata: { lockedByCoach: false } });
  res.json({ diet });
}));

adminRouter.post("/students/:userId/diet/reset", asyncHandler(async (req, res) => {
  const caller = req.gutoUser!;
  const student = await getManagedStudent(req, res, routeParam(req, "userId"));
  if (!student) return;
  const previous = await readPersistedDietPlan(student.userId);
  await deleteDietPlanIfUnchanged(student.userId, getDietPlanConcurrencyToken(previous));
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
  const officialDiet = await readPersistedDietPlan(student.userId);
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
  const contact = readTeamContactFields(body, res);
  if (contact === null) return;
  const statusInput = asString(body.status, "active");
  const status = ["active", "paused", "archived"].includes(statusInput)
    ? (statusInput as GutoTeam["status"])
    : "active";
  const id = `team-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();
  const team: GutoTeam = {
    id,
    name,
    plan: plan as GutoTeamPlan,
    status,
    createdAt: now,
    updatedAt: now,
    ...(customLimits ? { customLimits } : {}),
    ...contact,
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
  const contact = readTeamContactFields(body, res);
  if (contact === null) return;
  Object.assign(patch, contact);
  const updated = updateTeam(teamId, patch);
  addLog({
    action: "team_updated",
    actorUserId: req.gutoUser!.userId,
    actorRole: req.gutoUser!.role,
    metadata: { teamId, ...patch },
  });
  res.json({ team: updated });
}));

// Conta coaches/alunos vinculados a um Time (qualquer estado).
function countTeamMembers(teamId: string, users: UserAccess[]): { coaches: number; students: number } {
  const normalized = normalizeAccessTeamId(teamId);
  let coaches = 0;
  let students = 0;
  for (const u of users) {
    if (normalizeAccessTeamId(u.teamId) !== normalized) continue;
    if (u.role === "coach") coaches += 1;
    else if (u.role === "student") students += 1;
  }
  return { coaches, students };
}

// DELETE de empresa — super_admin. Bloqueia GUTO_CORE e empresas com coaches/alunos.
adminRouter.delete("/teams/:teamId", requireSuperAdmin, asyncHandler(async (req, res) => {
  const teamId = routeParam(req, "teamId");
  if (teamId === GUTO_CORE_TEAM_ID) {
    res.status(400).json({ message: "A empresa interna GUTO_CORE não pode ser removida.", code: "GUTO_CORE_PROTECTED" });
    return;
  }
  const team = getTeam(teamId);
  if (!team) {
    res.status(404).json({ message: `Time não encontrado: ${teamId}`, code: "GUTO_TEAM_NOT_FOUND" });
    return;
  }
  const members = countTeamMembers(teamId, await getAllUserAccessAsync());
  if (members.coaches > 0 || members.students > 0) {
    res.status(409).json({
      message: "Empresa possui coaches ou alunos. Remova/realoque antes de excluir.",
      code: "GUTO_TEAM_NOT_EMPTY",
      members,
    });
    return;
  }
  deleteTeam(teamId);
  addLog({
    action: "team_deleted",
    actorUserId: req.gutoUser!.userId,
    actorRole: req.gutoUser!.role,
    metadata: { teamId, name: team.name },
  });
  res.json({ ok: true, teamId });
}));

// Limpeza de empresas de teste — super_admin. Remove apenas Times vazios
// (0 coaches e 0 alunos), exceto GUTO_CORE. Idempotente.
adminRouter.post("/maintenance/cleanup-empty-teams", requireSuperAdmin, asyncHandler(async (req, res) => {
  const users = await getAllUserAccessAsync();
  const removed: { id: string; name: string }[] = [];
  for (const team of getAllTeams()) {
    if (team.id === GUTO_CORE_TEAM_ID) continue;
    const members = countTeamMembers(team.id, users);
    if (members.coaches === 0 && members.students === 0) {
      deleteTeam(team.id);
      removed.push({ id: team.id, name: team.name });
    }
  }
  addLog({
    action: "teams_cleanup",
    actorUserId: req.gutoUser!.userId,
    actorRole: req.gutoUser!.role,
    metadata: { removedCount: removed.length, removed: removed.map((r) => r.id) },
  });
  res.json({ ok: true, removedCount: removed.length, removed });
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
  const targetUserId = parseRequestOriginalUrl(req.originalUrl).searchParams.get("targetUserId") || undefined;
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
// adiciona +100 XP total em todos os arenaProfiles que estão com totalXp < 100,
// alinhando-os com o buffer do Pacto já concedido na memória. Por contrato
// canônico (AR-5/X-4), esse buffer não entra nos períodos semanal/mensal.
adminRouter.post("/maintenance/backfill-arena-initial-xp", requireAdmin, asyncHandler(async (_req, res) => {
  const fixed: Array<{ userId: string; before: number; after: number }> = [];
  await mutateArenaStoreAsync((arenaStore) => {
    for (const profile of Object.values(arenaStore.profiles)) {
      if (profile.totalXp < 100) {
        const before = profile.totalXp;
        profile.totalXp += 100;
        profile.updatedAt = new Date().toISOString();
        fixed.push({ userId: profile.userId, before, after: profile.totalXp });
      }
    }
  });
  res.json({ fixedCount: fixed.length, fixed });
}));

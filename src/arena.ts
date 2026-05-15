import {
  AvatarStage,
  ArenaProfile,
  getArenaProfile,
  saveArenaProfile,
  appendArenaEvent,
  getProfilesByGroup,
  getAllArenaProfiles,
} from "./arena-store.js";
import { getEffectiveUserAccess } from "./user-access-store.js";
import {
  getGutoEvolutionStage,
  getNextGutoEvolutionXp,
} from "./guto-evolution.js";

function isVisibleInRanking(userId: string): boolean {
  const access = getEffectiveUserAccess(userId);
  return (
    !!access &&
    access.active &&
    access.visibleInArena &&
    !access.archived &&
    access.role === "student"
  );
}

export const DEFAULT_ARENA_GROUP = "will-personal-alpha";

export function getAvatarStage(totalXp: number): AvatarStage {
  return getGutoEvolutionStage(totalXp);
}

export function getNextEvolutionXp(totalXp: number): number | null {
  return getNextGutoEvolutionXp(totalXp);
}

function isSameWeek(dateA: Date, dateB: Date): boolean {
  const startOfWeek = (d: Date) => {
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday-based
    return new Date(d.getFullYear(), d.getMonth(), diff);
  };
  return startOfWeek(dateA).getTime() === startOfWeek(dateB).getTime();
}

function isSameMonth(dateA: Date, dateB: Date): boolean {
  return dateA.getFullYear() === dateB.getFullYear() && dateA.getMonth() === dateB.getMonth();
}

function buildUniquePairName(displayName: string, arenaGroupId: string, ownUserId: string): string {
  const base = `GUTO & ${displayName.toUpperCase()}`;
  const existing = getProfilesByGroup(arenaGroupId).filter((p) => p.userId !== ownUserId);
  if (!existing.some((p) => p.pairName === base)) return base;
  for (let n = 2; n <= 99; n++) {
    const candidate = `${base} #${n}`;
    if (!existing.some((p) => p.pairName === candidate)) return candidate;
  }
  return base;
}

function normalizeArenaDisplayName(displayName: string, userId: string): string {
  const cleaned = displayName.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.toLocaleLowerCase("pt-BR") === "operador") return userId;
  return cleaned;
}

export function createArenaProfileIfNeeded(
  userId: string,
  displayName: string,
  arenaGroupId: string = DEFAULT_ARENA_GROUP
): ArenaProfile {
  const existing = getArenaProfile(userId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const safeDisplayName = normalizeArenaDisplayName(displayName, userId);
  const profile: ArenaProfile = {
    userId,
    displayName: safeDisplayName,
    pairName: buildUniquePairName(safeDisplayName, arenaGroupId, userId),
    arenaGroupId,
    avatarStage: "baby",
    totalXp: 0,
    weeklyXp: 0,
    monthlyXp: 0,
    validatedWorkoutsTotal: 0,
    validatedWorkoutsWeek: 0,
    validatedWorkoutsMonth: 0,
    currentStreak: 0,
    lastWorkoutValidatedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  saveArenaProfile(profile);
  return profile;
}

export function syncArenaDisplayName(
  userId: string,
  displayName: string,
  arenaGroupId: string = DEFAULT_ARENA_GROUP
): ArenaProfile {
  const safeDisplayName = normalizeArenaDisplayName(displayName, userId);
  const profile = createArenaProfileIfNeeded(userId, safeDisplayName, arenaGroupId);

  if (profile.displayName === safeDisplayName && profile.pairName.includes(safeDisplayName.toUpperCase())) {
    return profile;
  }

  profile.displayName = safeDisplayName;
  profile.pairName = buildUniquePairName(safeDisplayName, arenaGroupId, userId);
  profile.updatedAt = new Date().toISOString();
  saveArenaProfile(profile);
  return profile;
}

export interface AwardXpOptions {
  userId: string;
  displayName: string;
  arenaGroupId?: string;
  type: "workout_validated" | "reduced_mission_validated" | "bonus" | "miss_penalty";
  xp: number;
  workoutFocus?: string;
  sourceValidationId?: string;
}

export interface AwardXpResult {
  xpAwarded: number;
  totalXp: number;
  weeklyXp: number;
  monthlyXp: number;
  avatarStage: AvatarStage;
  leveledUp: boolean;
}

export function awardArenaXp(options: AwardXpOptions): AwardXpResult {
  const {
    userId,
    displayName,
    arenaGroupId = DEFAULT_ARENA_GROUP,
    type,
    xp,
    workoutFocus,
    sourceValidationId,
  } = options;

  const profile = createArenaProfileIfNeeded(userId, displayName, arenaGroupId);
  const previousStage = profile.avatarStage;
  const now = new Date();

  // Reset weekly/monthly counters if crossing week/month boundary
  if (profile.lastWorkoutValidatedAt) {
    const lastDate = new Date(profile.lastWorkoutValidatedAt);
    if (!isSameWeek(lastDate, now)) {
      profile.weeklyXp = 0;
      profile.validatedWorkoutsWeek = 0;
    }
    if (!isSameMonth(lastDate, now)) {
      profile.monthlyXp = 0;
      profile.validatedWorkoutsMonth = 0;
    }
  }

  profile.totalXp = Math.max(0, profile.totalXp + xp);
  profile.weeklyXp = Math.max(0, profile.weeklyXp + xp);
  profile.monthlyXp = Math.max(0, profile.monthlyXp + xp);

  if (type === "workout_validated" || type === "reduced_mission_validated") {
    profile.validatedWorkoutsTotal += 1;
    profile.validatedWorkoutsWeek += 1;
    profile.validatedWorkoutsMonth += 1;
  }

  if (profile.lastWorkoutValidatedAt) {
    const lastDate = new Date(profile.lastWorkoutValidatedAt);
    const diffDays = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    profile.currentStreak = diffDays <= 1 ? profile.currentStreak + 1 : 1;
  } else {
    profile.currentStreak = 1;
  }

  profile.lastWorkoutValidatedAt = now.toISOString();
  profile.avatarStage = getAvatarStage(profile.totalXp);
  profile.updatedAt = now.toISOString();

  saveArenaProfile(profile);

  appendArenaEvent({
    id: crypto.randomUUID(),
    userId,
    arenaGroupId,
    type,
    xp,
    workoutFocus,
    sourceValidationId,
    createdAt: now.toISOString(),
  });

  return {
    xpAwarded: xp,
    totalXp: profile.totalXp,
    weeklyXp: profile.weeklyXp,
    monthlyXp: profile.monthlyXp,
    avatarStage: profile.avatarStage,
    leveledUp: profile.avatarStage !== previousStage,
  };
}

// Returns i18n key — frontend translates via arenaStatusLabels map
function deriveStatus(xp: number, workouts: number): string {
  if (workouts >= 5) return "arena.status.on_fire";
  if (workouts >= 3) return "arena.status.rising";
  if (workouts >= 1) return "arena.status.consistent";
  return "arena.status.needs_action";
}

export function getWeeklyRanking(arenaGroupId: string) {
  const profiles = getProfilesByGroup(arenaGroupId).filter((p) => isVisibleInRanking(p.userId));
  const sorted = [...profiles].sort((a, b) => b.weeklyXp - a.weeklyXp);
  return {
    rankingType: "weekly",
    arenaGroupId,
    resetLabel: "Reinicia segunda-feira",
    items: sorted.map((p, i) => ({
      position: i + 1,
      userId: p.userId,
      pairName: p.pairName,
      avatarStage: getAvatarStage(p.totalXp),
      xp: p.weeklyXp,
      validatedWorkouts: p.validatedWorkoutsWeek,
      status: deriveStatus(p.weeklyXp, p.validatedWorkoutsWeek),
    })),
  };
}

export function getMonthlyRanking(arenaGroupId: string) {
  const profiles = getProfilesByGroup(arenaGroupId).filter((p) => isVisibleInRanking(p.userId));
  const sorted = [...profiles].sort((a, b) => b.monthlyXp - a.monthlyXp);
  return {
    rankingType: "monthly",
    arenaGroupId,
    resetLabel: "Reinicia no próximo mês",
    items: sorted.map((p, i) => ({
      position: i + 1,
      userId: p.userId,
      pairName: p.pairName,
      avatarStage: getAvatarStage(p.totalXp),
      xp: p.monthlyXp,
      validatedWorkouts: p.validatedWorkoutsMonth,
      status: deriveStatus(p.monthlyXp, p.validatedWorkoutsMonth),
    })),
  };
}

export function getIndividualRanking(arenaGroupId: string) {
  const profiles = getProfilesByGroup(arenaGroupId).filter((p) => isVisibleInRanking(p.userId));
  const sorted = [...profiles].sort((a, b) => b.totalXp - a.totalXp);
  return {
    rankingType: "individual",
    arenaGroupId,
    items: sorted.map((p, i) => {
      const nextEvolutionXp = getNextEvolutionXp(p.totalXp);
      return {
        position: i + 1,
        userId: p.userId,
        pairName: p.pairName,
        avatarStage: getAvatarStage(p.totalXp),
        xp: p.totalXp,
        validatedWorkouts: p.validatedWorkoutsTotal,
        currentStreak: p.currentStreak,
        nextEvolutionXp,
        xpToNextEvolution: nextEvolutionXp !== null ? nextEvolutionXp - p.totalXp : null,
      };
    }),
  };
}

/**
 * Ranking individual GLOBAL — todos os alunos do GUTO no mundo, independente de Time.
 * Conforme visão do produto: "Ranking individual global com todos os usuários do GUTO".
 * Apenas weekly/monthly ficam scoped por Time.
 */
export function getGlobalIndividualRanking() {
  const profiles = getAllArenaProfiles().filter((p) => isVisibleInRanking(p.userId));
  const sorted = [...profiles].sort((a, b) => b.totalXp - a.totalXp);
  return {
    rankingType: "individual",
    arenaGroupId: "global",
    items: sorted.map((p, i) => {
      const nextEvolutionXp = getNextEvolutionXp(p.totalXp);
      return {
        position: i + 1,
        userId: p.userId,
        pairName: p.pairName,
        avatarStage: getAvatarStage(p.totalXp),
        xp: p.totalXp,
        validatedWorkouts: p.validatedWorkoutsTotal,
        currentStreak: p.currentStreak,
        nextEvolutionXp,
        xpToNextEvolution: nextEvolutionXp !== null ? nextEvolutionXp - p.totalXp : null,
      };
    }),
  };
}

export function getMyArenaProfile(userId: string, arenaGroupId: string) {
  const profile = getArenaProfile(userId);
  if (!profile || profile.arenaGroupId !== arenaGroupId) return null;
  const nextEvolutionXp = getNextEvolutionXp(profile.totalXp);
  const avatarStage = getAvatarStage(profile.totalXp);
  return {
    userId: profile.userId,
    pairName: profile.pairName,
    avatarStage,
    totalXp: profile.totalXp,
    weeklyXp: profile.weeklyXp,
    monthlyXp: profile.monthlyXp,
    currentStreak: profile.currentStreak,
    validatedWorkoutsTotal: profile.validatedWorkoutsTotal,
    nextEvolutionXp,
    xpToNextEvolution: nextEvolutionXp !== null ? nextEvolutionXp - profile.totalXp : null,
  };
}

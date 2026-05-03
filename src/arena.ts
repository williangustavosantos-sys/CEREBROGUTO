import {
  AvatarStage,
  ArenaProfile,
  getArenaProfile,
  saveArenaProfile,
  appendArenaEvent,
  getProfilesByGroup,
} from "./arena-store.js";

export const DEFAULT_ARENA_GROUP = "will-personal-alpha";

const EVOLUTION_THRESHOLDS: { stage: AvatarStage; minXp: number }[] = [
  { stage: "elite", minXp: 12000 },
  { stage: "adult", minXp: 5000 },
  { stage: "teen", minXp: 1500 },
  { stage: "baby", minXp: 0 },
];

export function getAvatarStage(totalXp: number): AvatarStage {
  for (const { stage, minXp } of EVOLUTION_THRESHOLDS) {
    if (totalXp >= minXp) return stage;
  }
  return "baby";
}

export function getNextEvolutionXp(totalXp: number): number | null {
  const order: number[] = [1500, 5000, 12000];
  for (const threshold of order) {
    if (totalXp < threshold) return threshold;
  }
  return null; // already elite
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

export function createArenaProfileIfNeeded(
  userId: string,
  displayName: string,
  arenaGroupId: string = DEFAULT_ARENA_GROUP
): ArenaProfile {
  const existing = getArenaProfile(userId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const profile: ArenaProfile = {
    userId,
    displayName,
    pairName: `GUTO & ${displayName.toUpperCase()}`,
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

export interface AwardXpOptions {
  userId: string;
  displayName: string;
  arenaGroupId?: string;
  type: "workout_validated" | "reduced_mission_validated" | "bonus";
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

  profile.totalXp += xp;
  profile.weeklyXp += xp;
  profile.monthlyXp += xp;

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

function deriveStatus(xp: number, workouts: number): string {
  if (workouts >= 5) return "EM CHAMAS";
  if (workouts >= 3) return "SUBINDO";
  if (workouts >= 1) return "CONSISTENTE";
  return "PRECISA REAGIR";
}

export function getWeeklyRanking(arenaGroupId: string) {
  const profiles = getProfilesByGroup(arenaGroupId);
  const sorted = [...profiles].sort((a, b) => b.weeklyXp - a.weeklyXp);
  return {
    rankingType: "weekly",
    arenaGroupId,
    resetLabel: "Reinicia segunda-feira",
    items: sorted.map((p, i) => ({
      position: i + 1,
      userId: p.userId,
      pairName: p.pairName,
      avatarStage: p.avatarStage,
      xp: p.weeklyXp,
      validatedWorkouts: p.validatedWorkoutsWeek,
      status: deriveStatus(p.weeklyXp, p.validatedWorkoutsWeek),
    })),
  };
}

export function getMonthlyRanking(arenaGroupId: string) {
  const profiles = getProfilesByGroup(arenaGroupId);
  const sorted = [...profiles].sort((a, b) => b.monthlyXp - a.monthlyXp);
  return {
    rankingType: "monthly",
    arenaGroupId,
    resetLabel: "Reinicia no próximo mês",
    items: sorted.map((p, i) => ({
      position: i + 1,
      userId: p.userId,
      pairName: p.pairName,
      avatarStage: p.avatarStage,
      xp: p.monthlyXp,
      validatedWorkouts: p.validatedWorkoutsMonth,
      status: deriveStatus(p.monthlyXp, p.validatedWorkoutsMonth),
    })),
  };
}

export function getIndividualRanking(arenaGroupId: string) {
  const profiles = getProfilesByGroup(arenaGroupId);
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
        avatarStage: p.avatarStage,
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
  return {
    userId: profile.userId,
    pairName: profile.pairName,
    avatarStage: profile.avatarStage,
    totalXp: profile.totalXp,
    weeklyXp: profile.weeklyXp,
    monthlyXp: profile.monthlyXp,
    currentStreak: profile.currentStreak,
    validatedWorkoutsTotal: profile.validatedWorkoutsTotal,
    nextEvolutionXp,
    xpToNextEvolution: nextEvolutionXp !== null ? nextEvolutionXp - profile.totalXp : null,
  };
}

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

// weeklyXp/monthlyXp são contadores com reset preguiçoso: awardArenaXp só zera
// na PRÓXIMA concessão. Sem projeção na leitura, o ranking semanal continua
// exibindo XP da semana passada para quem não ganhou XP depois da virada
// ("Reinicia segunda-feira" virava só label). Não muta o store — só a projeção.
export function projectPeriodCounters(
  profile: Pick<
    ArenaProfile,
    "weeklyXp" | "monthlyXp" | "validatedWorkoutsWeek" | "validatedWorkoutsMonth" | "lastWorkoutValidatedAt" | "lastXpAt"
  >,
  now: Date = new Date()
): { weeklyXp: number; monthlyXp: number; validatedWorkoutsWeek: number; validatedWorkoutsMonth: number } {
  let { weeklyXp, monthlyXp, validatedWorkoutsWeek, validatedWorkoutsMonth } = profile;
  // Âncora = última atividade de XP (qualquer tipo). Fallback p/ lastWorkoutValidatedAt
  // em perfis antigos sem lastXpAt.
  const periodAnchor = profile.lastXpAt ?? profile.lastWorkoutValidatedAt;
  if (periodAnchor) {
    const lastDate = new Date(periodAnchor);
    if (!Number.isNaN(lastDate.getTime())) {
      if (!isSameWeek(lastDate, now)) {
        weeklyXp = 0;
        validatedWorkoutsWeek = 0;
      }
      if (!isSameMonth(lastDate, now)) {
        monthlyXp = 0;
        validatedWorkoutsMonth = 0;
      }
    }
  }
  return { weeklyXp, monthlyXp, validatedWorkoutsWeek, validatedWorkoutsMonth };
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

  // Reset weekly/monthly counters if crossing week/month boundary.
  // Âncora = última atividade de XP (qualquer tipo), não só treino: assim o
  // pacto/bônus também reseta no fim do ciclo. Fallback p/ perfis antigos.
  const periodAnchor = profile.lastXpAt ?? profile.lastWorkoutValidatedAt;
  if (periodAnchor) {
    const lastDate = new Date(periodAnchor);
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

  // O bônus do Pacto é um buffer de boas-vindas: entra no total geral, mas não
  // infla os períodos competitivos da Arena (AR-5) nem representa presença real
  // (X-4). Validações e penalidades continuam refletidas em weekly/monthly.
  const countsForPeriod = type !== "bonus";
  if (countsForPeriod) {
    profile.weeklyXp = Math.max(0, profile.weeklyXp + xp);
    profile.monthlyXp = Math.max(0, profile.monthlyXp + xp);
  }

  // Contagem de treinos e streak continuam atreladas à PRESENÇA DE TREINO, não ao
  // XP em si: o pacto/bônus não vira treino validado nem sequência; a falta zera.
  const isValidatedWorkout = type === "workout_validated" || type === "reduced_mission_validated";
  if (isValidatedWorkout) {
    profile.validatedWorkoutsTotal += 1;
    profile.validatedWorkoutsWeek += 1;
    profile.validatedWorkoutsMonth += 1;

    if (profile.lastWorkoutValidatedAt) {
      const lastDate = new Date(profile.lastWorkoutValidatedAt);
      const diffDays = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
      profile.currentStreak = diffDays <= 1 ? profile.currentStreak + 1 : 1;
    } else {
      profile.currentStreak = 1;
    }
    profile.lastWorkoutValidatedAt = now.toISOString();
  } else if (type === "miss_penalty") {
    // Faltar quebra a sequência (espelha memory.streak = 0 no server).
    profile.currentStreak = 0;
  }

  // Toda concessão marca a âncora genérica de período.
  profile.lastXpAt = now.toISOString();
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
  const now = new Date();
  const profiles = getProfilesByGroup(arenaGroupId)
    .filter((p) => isVisibleInRanking(p.userId))
    .map((p) => ({ profile: p, period: projectPeriodCounters(p, now) }));
  const sorted = [...profiles].sort((a, b) => b.period.weeklyXp - a.period.weeklyXp);
  return {
    rankingType: "weekly",
    arenaGroupId,
    resetLabel: "Reinicia segunda-feira",
    items: sorted.map(({ profile: p, period }, i) => ({
      position: i + 1,
      userId: p.userId,
      pairName: p.pairName,
      avatarStage: getAvatarStage(p.totalXp),
      xp: period.weeklyXp,
      validatedWorkouts: period.validatedWorkoutsWeek,
      status: deriveStatus(period.weeklyXp, period.validatedWorkoutsWeek),
    })),
  };
}

export function getMonthlyRanking(arenaGroupId: string) {
  const now = new Date();
  const profiles = getProfilesByGroup(arenaGroupId)
    .filter((p) => isVisibleInRanking(p.userId))
    .map((p) => ({ profile: p, period: projectPeriodCounters(p, now) }));
  const sorted = [...profiles].sort((a, b) => b.period.monthlyXp - a.period.monthlyXp);
  return {
    rankingType: "monthly",
    arenaGroupId,
    resetLabel: "Reinicia no próximo mês",
    items: sorted.map(({ profile: p, period }, i) => ({
      position: i + 1,
      userId: p.userId,
      pairName: p.pairName,
      avatarStage: getAvatarStage(p.totalXp),
      xp: period.monthlyXp,
      validatedWorkouts: period.validatedWorkoutsMonth,
      status: deriveStatus(period.monthlyXp, period.validatedWorkoutsMonth),
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
  const period = projectPeriodCounters(profile);
  return {
    userId: profile.userId,
    pairName: profile.pairName,
    avatarStage,
    totalXp: profile.totalXp,
    weeklyXp: period.weeklyXp,
    monthlyXp: period.monthlyXp,
    currentStreak: profile.currentStreak,
    validatedWorkoutsTotal: profile.validatedWorkoutsTotal,
    nextEvolutionXp,
    xpToNextEvolution: nextEvolutionXp !== null ? nextEvolutionXp - profile.totalXp : null,
  };
}

import { GUTO_TEAM_PLAN_LIMITS, GutoTeamPlan } from "./team-plans.js";
import type { UserAccess } from "./user-access-store.js";

export type GutoTeam = {
    id: string;
    name: string;
    slug?: string;
    plan: GutoTeamPlan;
    customLimits?: {
        maxCoaches?: number | null;
        maxStudents?: number | null;
    };
    status: "active" | "paused" | "archived";
    createdAt: string;
    updatedAt: string;
};

export const GUTO_CORE_TEAM_ID = "GUTO_CORE";

export type TeamCapacitySubject = "coach" | "student";

export type GutoTeamPlanUsage = {
    teamId: string;
    plan: GutoTeamPlan;
    label: string;
    coaches: number;
    students: number;
    maxCoaches: number | null;
    maxStudents: number | null;
};

export class GutoTeamPlanLimitError extends Error {
    code = "GUTO_TEAM_PLAN_LIMIT_REACHED" as const;
    status = 409;
    subject: TeamCapacitySubject;
    usage: GutoTeamPlanUsage;

    constructor(subject: TeamCapacitySubject, usage: GutoTeamPlanUsage) {
        const limit = subject === "coach" ? usage.maxCoaches : usage.maxStudents;
        const label = subject === "coach" ? "coaches" : "alunos";
        super(`${usage.label} atingiu o limite de ${limit} ${label}.`);
        this.name = "GutoTeamPlanLimitError";
        this.subject = subject;
        this.usage = usage;
    }
}

export class GutoTeamNotFoundError extends Error {
    code = "GUTO_TEAM_NOT_FOUND" as const;
    status = 404;
    teamId: string;

    constructor(teamId: string) {
        super(`Time não encontrado: ${teamId}.`);
        this.name = "GutoTeamNotFoundError";
        this.teamId = teamId;
    }
}

const teams: Record<string, GutoTeam> = {
    [GUTO_CORE_TEAM_ID]: {
        id: GUTO_CORE_TEAM_ID,
        name: "GUTO Core",
        plan: "custom",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }
};

export function getTeam(teamId: string): GutoTeam | undefined {
    return teams[teamId];
}

export function getAllTeams(): GutoTeam[] {
    return Object.values(teams);
}

export function createTeam(team: GutoTeam): GutoTeam {
    teams[team.id] = team;
    return team;
}

export function updateTeam(teamId: string, patch: Partial<Omit<GutoTeam, "id" | "createdAt">>): GutoTeam {
    const existing = teams[teamId];
    if (!existing) throw new GutoTeamNotFoundError(teamId);
    const updated: GutoTeam = { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
    teams[teamId] = updated;
    return updated;
}

export function normalizeTeamId(teamId?: string | null): string {
    return teamId || GUTO_CORE_TEAM_ID;
}

export function getTeamPlanUsage(
    teamId: string,
    users: UserAccess[],
    options: { excludeUserId?: string } = {}
): GutoTeamPlanUsage {
    const normalizedTeamId = normalizeTeamId(teamId);
    const team = getTeam(normalizedTeamId);
    if (!team) {
        throw new GutoTeamNotFoundError(normalizedTeamId);
    }

    const baseLimits = GUTO_TEAM_PLAN_LIMITS[team.plan];
    const maxCoaches = team.customLimits?.maxCoaches ?? baseLimits.maxCoaches;
    const maxStudents = team.customLimits?.maxStudents ?? baseLimits.maxStudents;
    const activeUsers = users.filter((user) => {
        if (options.excludeUserId && user.userId === options.excludeUserId) return false;
        return normalizeTeamId(user.teamId) === normalizedTeamId && !user.archived;
    });

    return {
        teamId: normalizedTeamId,
        plan: team.plan,
        label: baseLimits.label,
        coaches: activeUsers.filter((user) => user.role === "coach").length,
        students: activeUsers.filter((user) => user.role === "student").length,
        maxCoaches,
        maxStudents,
    };
}

export function assertTeamPlanCapacity(
    teamId: string,
    subject: TeamCapacitySubject,
    users: UserAccess[],
    options: { excludeUserId?: string } = {}
): GutoTeamPlanUsage {
    const usage = getTeamPlanUsage(teamId, users, options);
    if (subject === "coach" && usage.maxCoaches !== null && usage.coaches >= usage.maxCoaches) {
        throw new GutoTeamPlanLimitError(subject, usage);
    }
    if (subject === "student" && usage.maxStudents !== null && usage.students >= usage.maxStudents) {
        throw new GutoTeamPlanLimitError(subject, usage);
    }
    return usage;
}

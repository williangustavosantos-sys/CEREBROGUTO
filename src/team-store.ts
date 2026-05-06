import { GutoTeamPlan } from "./team-plans.js";

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
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { GUTO_TEAM_PLAN_LIMITS, GutoTeamPlan } from "./team-plans.js";
import type { UserAccess } from "./user-access-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEAM_STORE_PATH = path.join(__dirname, "../tmp/teams.json");

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

// ─── Storage layer (Redis → file → memory) ────────────────────────────────────

interface TeamStore {
    teams: Record<string, GutoTeam>;
}

const GUTO_CORE_SEED: GutoTeam = {
    id: GUTO_CORE_TEAM_ID,
    name: "GUTO Core",
    plan: "custom",
    status: "active",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
};

let memCache: TeamStore = { teams: { [GUTO_CORE_TEAM_ID]: GUTO_CORE_SEED } };

const REDIS_KEY = "guto:teams";

function useRedis(): boolean {
    return Boolean(config.upstashRedisUrl && config.upstashRedisToken);
}

async function redisGet(key: string): Promise<string | null> {
    try {
        const res = await fetch(`${config.upstashRedisUrl}/get/${key}`, {
            headers: { Authorization: `Bearer ${config.upstashRedisToken}` },
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { result: string | null };
        return data.result;
    } catch {
        return null;
    }
}

async function redisSet(key: string, value: string): Promise<void> {
    try {
        await fetch(`${config.upstashRedisUrl}/set/${key}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.upstashRedisToken}` },
            body: value,
        });
    } catch {
        // ignore
    }
}

function ensureStoreFile(): void {
    if (!fs.existsSync(TEAM_STORE_PATH)) {
        fs.mkdirSync(path.dirname(TEAM_STORE_PATH), { recursive: true });
        fs.writeFileSync(TEAM_STORE_PATH, JSON.stringify({ teams: { [GUTO_CORE_TEAM_ID]: GUTO_CORE_SEED } }, null, 2));
    }
}

function readTeamsSync(): TeamStore {
    if (useRedis() && Object.keys(memCache.teams).length > 0) {
        return memCache;
    }
    try {
        ensureStoreFile();
        const parsed = JSON.parse(fs.readFileSync(TEAM_STORE_PATH, "utf-8")) as TeamStore;
        const store = parsed && typeof parsed.teams === "object" ? parsed : { teams: {} };
        // Always ensure GUTO_CORE exists
        if (!store.teams[GUTO_CORE_TEAM_ID]) {
            store.teams[GUTO_CORE_TEAM_ID] = GUTO_CORE_SEED;
        }
        if (Object.keys(store.teams).length === 0 && Object.keys(memCache.teams).length > 0) {
            return memCache;
        }
        return store;
    } catch {
        return memCache;
    }
}

function writeTeamsSync(store: TeamStore): void {
    memCache = store;
    try {
        ensureStoreFile();
        fs.writeFileSync(TEAM_STORE_PATH, JSON.stringify(store, null, 2));
    } catch {
        // in-memory only
    }
}

async function readTeamsAsync(): Promise<TeamStore> {
    if (useRedis()) {
        try {
            const raw = await redisGet(REDIS_KEY);
            if (raw) {
                let parsed = JSON.parse(raw);
                if (typeof parsed === "string") parsed = JSON.parse(parsed);
                if (!parsed || typeof parsed !== "object" || !("teams" in parsed)) {
                    parsed = { teams: {} };
                }
                if (!parsed.teams[GUTO_CORE_TEAM_ID]) {
                    parsed.teams[GUTO_CORE_TEAM_ID] = GUTO_CORE_SEED;
                }
                memCache = parsed as TeamStore;
                return memCache;
            }
        } catch {
            // fall through
        }
    }
    const store = readTeamsSync();
    memCache = store;
    return store;
}

async function writeTeamsAsync(store: TeamStore): Promise<void> {
    memCache = store;
    if (useRedis()) {
        await redisSet(REDIS_KEY, JSON.stringify(store));
    }
    writeTeamsSync(store);
}

// Bootstrap: load persisted teams on module init
readTeamsAsync().catch(() => {});

export function getTeam(teamId: string): GutoTeam | undefined {
    return readTeamsSync().teams[teamId];
}

export function getAllTeams(): GutoTeam[] {
    return Object.values(readTeamsSync().teams);
}

export function createTeam(team: GutoTeam): GutoTeam {
    const store = readTeamsSync();
    store.teams[team.id] = team;
    writeTeamsSync(store);
    writeTeamsAsync(store).catch(() => {});
    return team;
}

export function updateTeam(teamId: string, patch: Partial<Omit<GutoTeam, "id" | "createdAt">>): GutoTeam {
    const store = readTeamsSync();
    const existing = store.teams[teamId];
    if (!existing) throw new GutoTeamNotFoundError(teamId);
    const updated: GutoTeam = { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
    store.teams[teamId] = updated;
    writeTeamsSync(store);
    writeTeamsAsync(store).catch(() => {});
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

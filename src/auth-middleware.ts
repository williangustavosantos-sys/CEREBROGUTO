import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { GUTO_CORE_TEAM_ID } from "./team-store.js";
import {
  getAllUserAccess,
  getUserAccess,
  requireActiveUserAccess,
  type UserAccess,
} from "./user-access-store.js";

export interface GutoJwtPayload {
  userId: string;
  role: "student" | "coach" | "admin" | "super_admin";
  coachId?: string;
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      gutoUser?: GutoJwtPayload;
    }
  }
}

export type TeamAccessForbiddenCode =
  | "TEAM_ACCESS_FORBIDDEN"
  | "COACH_STUDENT_ACCESS_FORBIDDEN"
  | "ADMIN_ACCESS_FORBIDDEN"
  | "USER_ACCESS_NOT_FOUND";

export class TeamAccessError extends Error {
  status: number;
  code: TeamAccessForbiddenCode;

  constructor(status: number, code: TeamAccessForbiddenCode, message: string) {
    super(message);
    this.name = "TeamAccessError";
    this.status = status;
    this.code = code;
  }
}

export type GutoAccessActor = Pick<UserAccess, "userId" | "role" | "coachId"> & {
  teamId?: string;
};

export function normalizeAccessTeamId(teamId?: string | null): string {
  return teamId || GUTO_CORE_TEAM_ID;
}

export function normalizeUserAccessTeam<T extends UserAccess>(access: T): T {
  return {
    ...access,
    teamId: normalizeAccessTeamId(access.teamId),
  };
}

function fallbackActorFromToken(token: GutoJwtPayload): GutoAccessActor {
  return {
    userId: token.userId,
    role: token.role,
    coachId: token.coachId || token.userId,
    teamId: GUTO_CORE_TEAM_ID,
  };
}

export function getEffectiveActorAccess(token: GutoJwtPayload): GutoAccessActor {
  if (token.role === "super_admin") {
    return fallbackActorFromToken(token);
  }

  const stored = getUserAccess(token.userId);
  if (stored) {
    return {
      ...normalizeUserAccessTeam(stored),
      coachId: stored.coachId || token.coachId || token.userId,
    };
  }

  return fallbackActorFromToken(token);
}

export function getRequestActorAccess(req: Request): GutoAccessActor | null {
  if (!req.gutoUser) return null;
  return getEffectiveActorAccess(req.gutoUser);
}

export function canAccessUserAccess(actor: GutoAccessActor, target: UserAccess): boolean {
  if (actor.role === "super_admin") return true;

  const actorTeamId = normalizeAccessTeamId(actor.teamId);
  const targetTeamId = normalizeAccessTeamId(target.teamId);
  if (actorTeamId !== targetTeamId) return false;

  if (actor.role === "admin") return true;
  if (actor.role === "coach") {
    return target.role === "student" && target.coachId === actor.userId;
  }

  return false;
}

export function getAccessForbiddenCode(actor: GutoAccessActor, target: UserAccess): TeamAccessForbiddenCode {
  if (actor.role === "coach" && normalizeAccessTeamId(actor.teamId) === normalizeAccessTeamId(target.teamId)) {
    return "COACH_STUDENT_ACCESS_FORBIDDEN";
  }
  if (actor.role === "admin") return "TEAM_ACCESS_FORBIDDEN";
  return "ADMIN_ACCESS_FORBIDDEN";
}

export function assertCanAccessUserAccess(actor: GutoAccessActor, target?: UserAccess | null): asserts target is UserAccess {
  if (!target) {
    throw new TeamAccessError(404, "USER_ACCESS_NOT_FOUND", "Usuário não encontrado.");
  }
  if (!canAccessUserAccess(actor, target)) {
    throw new TeamAccessError(
      403,
      getAccessForbiddenCode(actor, target),
      actor.role === "coach"
        ? "Coach não tem acesso a este aluno."
        : "Time sem permissão para acessar este usuário."
    );
  }
}

export function getScopedUserAccessList(
  actor: GutoAccessActor,
  users: UserAccess[] = getAllUserAccess()
): UserAccess[] {
  const normalizedUsers = users.map(normalizeUserAccessTeam);
  if (actor.role === "super_admin") return normalizedUsers;
  if (actor.role === "student") return [];
  return normalizedUsers.filter((user) => canAccessUserAccess(actor, user));
}

export function signToken(payload: Omit<GutoJwtPayload, "iat" | "exp">): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): GutoJwtPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as GutoJwtPayload;
  } catch {
    return null;
  }
}

// Parses Bearer token and attaches gutoUser to req. Does NOT block — use requireAuth for that.
export function parseAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const payload = verifyToken(header.slice(7));
    if (payload) req.gutoUser = payload;
  }
  next();
}

// Requires a valid JWT. Returns 401 if missing/invalid.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.gutoUser) {
    res.status(401).json({ message: "Autenticação necessária." });
    return;
  }
  next();
}

// Requires valid JWT AND active subscription.
export function requireActiveUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.gutoUser) {
    res.status(401).json({ message: "Autenticação necessária." });
    return;
  }

  const access = requireActiveUserAccess(req.gutoUser.userId);
  if (!access) {
    res.status(403).json({
      message: "Acesso pausado ou expirado.",
      code: "ACCESS_PAUSED",
    });
    return;
  }
  next();
}

// Requires role = admin or super_admin.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.gutoUser) {
    res.status(401).json({ message: "Autenticação necessária." });
    return;
  }
  if (req.gutoUser.role !== "admin" && req.gutoUser.role !== "super_admin") {
    res.status(403).json({ message: "Acesso restrito a administradores." });
    return;
  }
  next();
}

// Requires role = super_admin.
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.gutoUser) {
    res.status(401).json({ message: "Autenticação necessária." });
    return;
  }
  if (req.gutoUser.role !== "super_admin") {
    res.status(403).json({ message: "Acesso restrito ao super administrador." });
    return;
  }
  next();
}

// Requires role = admin, super_admin or coach.
export function requireCoachOrAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.gutoUser) {
    res.status(401).json({ message: "Autenticação necessária." });
    return;
  }
  if (req.gutoUser.role !== "admin" && req.gutoUser.role !== "coach" && req.gutoUser.role !== "super_admin") {
    res.status(403).json({ message: "Acesso restrito a coaches ou administradores." });
    return;
  }
  next();
}

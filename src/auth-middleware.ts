import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { requireActiveUserAccess } from "./user-access-store.js";

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

import express, { Request, Response } from "express";
import bcrypt from "bcrypt";
import { config } from "./config.js";
import {
  getRequestActorAccess,
  normalizeAccessTeamId,
  requireAuth,
  signToken,
  verifyToken,
} from "./auth-middleware.js";
import {
  findInviteByToken,
  claimInvite,
  createInvite,
  getAllInvites,
  updateInviteByUserId,
} from "./invite-store.js";
import {
  getUserAccessAsync,
  requireActiveUserAccessAsync,
  upsertUserAccessAsync,
  getUserAccess,
  getAllUserAccess,
} from "./user-access-store.js";
import {
  assertTeamPlanCapacity,
  GUTO_CORE_TEAM_ID,
  GutoTeamNotFoundError,
  GutoTeamPlanLimitError,
} from "./team-store.js";
import crypto from "crypto";

export const authRouter = express.Router();

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

// ─── POST /auth/admin/login ───────────────────────────────────────────────────

authRouter.post("/admin/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ message: "Email e senha são obrigatórios." });
    return;
  }

  if (!config.adminEmail || !config.adminPasswordHash) {
    res.status(503).json({ message: "Admin não configurado no servidor." });
    return;
  }

  if (email !== config.adminEmail) {
    res.status(401).json({ message: "Credenciais inválidas." });
    return;
  }

  const match = await bcrypt.compare(password, config.adminPasswordHash);
  if (!match) {
    res.status(401).json({ message: "Credenciais inválidas." });
    return;
  }

  const token = signToken({ userId: "admin", role: "super_admin" });
  res.json({ token, role: "super_admin", userId: "admin", teamId: GUTO_CORE_TEAM_ID });
});

// ─── POST /auth/coach/login ───────────────────────────────────────────────────

authRouter.post("/coach/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ message: "Email e senha são obrigatórios." });
    return;
  }

  // In dev mode, accept any login if GUTO_ALLOW_DEV_ACCESS is set
  if (config.allowDevAccess) {
    const devCoachId = process.env.DEV_COACH_ID ?? "will-coach";
    const token = signToken({ userId: devCoachId, role: "coach", coachId: devCoachId });
    res.json({ token, role: "coach", userId: devCoachId, coachId: devCoachId, teamId: GUTO_CORE_TEAM_ID });
    return;
  }

  // Find coach user by email
  const allUsers = getAllUserAccess();
  const coachUser = allUsers.find(
    (u) => u.role === "coach" && u.email === email && u.active
  );

  if (!coachUser || !coachUser.passwordHash) {
    res.status(401).json({ message: "Credenciais inválidas." });
    return;
  }

  const match = await bcrypt.compare(password, coachUser.passwordHash);
  if (!match) {
    res.status(401).json({ message: "Credenciais inválidas." });
    return;
  }

  const token = signToken({
    userId: coachUser.userId,
    role: "coach",
    coachId: coachUser.coachId,
  });
  res.json({ token, role: "coach", userId: coachUser.userId, coachId: coachUser.coachId, teamId: normalizeAccessTeamId(coachUser.teamId) });
});

// ─── POST /auth/user/login ────────────────────────────────────────────────────

authRouter.post("/user/login", async (req: Request, res: Response) => {
  const { emailOrId, password } = req.body as { emailOrId?: string; password?: string };
  if (!emailOrId || !password) {
    res.status(400).json({ message: "Identificador e senha são obrigatórios." });
    return;
  }

  const allUsers = getAllUserAccess();
  const user = allUsers.find(
    (u) =>
      u.role === "student" &&
      (u.email === emailOrId || u.userId === emailOrId)
  );

  if (!user || !user.passwordHash) {
    res.status(401).json({ message: "Credenciais inválidas." });
    return;
  }

  const activeAccess = await requireActiveUserAccessAsync(user.userId);
  if (!activeAccess) {
    res.status(403).json({ message: "Acesso pausado ou expirado.", code: "ACCESS_PAUSED" });
    return;
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    res.status(401).json({ message: "Credenciais inválidas." });
    return;
  }

  const token = signToken({ userId: user.userId, role: "student", coachId: user.coachId });
  res.json({
    token,
    role: "student" as const,
    userId: user.userId,
    coachId: user.coachId,
    name: user.name,
    email: user.email,
    teamId: normalizeAccessTeamId(user.teamId),
    subscriptionStatus: user.subscriptionStatus,
    subscriptionEndsAt: user.subscriptionEndsAt,
  });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

authRouter.get("/me", requireAuth, async (req: Request, res: Response) => {
  const { userId, role, coachId } = req.gutoUser!;

  if (role === "super_admin" || role === "admin") {
    const actor = getRequestActorAccess(req);
    res.json({ userId, role, email: config.adminEmail, teamId: normalizeAccessTeamId(actor?.teamId) });
    return;
  }

  const access = await getUserAccessAsync(userId);
  if (!access) {
    res.status(404).json({ message: "Usuário não encontrado." });
    return;
  }

  res.json({
    userId: access.userId,
    role: access.role,
    coachId: access.coachId,
    active: access.active,
    name: access.name,
    email: access.email,
    teamId: normalizeAccessTeamId(access.teamId),
    subscriptionStatus: access.subscriptionStatus,
    subscriptionEndsAt: access.subscriptionEndsAt,
  });
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
// JWT is stateless — logout is handled client-side by discarding the token.

authRouter.post("/logout", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// ─── GET /guto/invite/:token ─────────────────────────────────────────────────

authRouter.get("/invite/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const tokenLen = token.length;
  const safeToken = tokenLen > 8 ? `${token.slice(0, 4)}...${token.slice(-4)}` : "too-short";
  
  console.log(`[GET /auth/invite/:token] token length: ${tokenLen}, partial: ${safeToken}`);

  try {
    const invite = await findInviteByToken(token);
    console.log(`[GET /auth/invite/:token] findInviteByToken returned:`, invite ? `Invite(id: ${invite.id})` : "null");

    if (!invite) {
      res.status(404).json({ message: "Convite não encontrado." });
      return;
    }
    if (invite.status === "revoked") {
      res.status(410).json({ message: "Este convite foi revogado." });
      return;
    }
    if (invite.status === "active" || invite.status === "expired") {
      res.status(410).json({ message: "Este convite já foi utilizado." });
      return;
    }
    if (new Date(invite.expiresAt) < new Date()) {
      res.status(410).json({ message: "Este convite expirou." });
      return;
    }
    res.json({ name: invite.name, userId: invite.userId, coachId: invite.coachId });
  } catch (error: any) {
    console.error(`[GET /auth/invite/:token] Error:`, error.message, error.stack);
    res.status(500).json({ message: "Erro interno ao validar convite. Tente novamente em alguns segundos." });
  }
});

// ─── POST /guto/invite/:token/claim ──────────────────────────────────────────

authRouter.post("/invite/:token/claim", async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const { password } = req.body as { password?: string };

  if (!password || password.length < 6) {
    res.status(400).json({ message: "Senha precisa ter pelo menos 6 caracteres." });
    return;
  }

  const invite = await findInviteByToken(token);
  if (!invite) {
    res.status(404).json({ message: "Convite não encontrado." });
    return;
  }
  if (invite.status !== "pending_claim") {
    res.status(410).json({ message: "Este convite já foi utilizado ou expirou." });
    return;
  }
  if (new Date(invite.expiresAt) < new Date()) {
    res.status(410).json({ message: "Este convite expirou." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const claimedInvite = await claimInvite(token);
  if (!claimedInvite) {
    res.status(410).json({ message: "Falha ao ativar convite." });
    return;
  }

  const endsAt = new Date();
  endsAt.setDate(endsAt.getDate() + 30);

  await upsertUserAccessAsync(invite.userId, {
    role: "student",
    coachId: invite.coachId,
    active: true,
    archived: false,
    passwordHash,
    subscriptionStatus: "active",
    subscriptionEndsAt: endsAt.toISOString(),
  });

  const jwtToken = signToken({
    userId: invite.userId,
    role: "student",
    coachId: invite.coachId,
  });

  res.json({
    token: jwtToken,
    userId: invite.userId,
    name: invite.name,
    subscriptionStatus: "active",
    subscriptionEndsAt: endsAt.toISOString(),
  });
});

// ─── Admin: create invite ─────────────────────────────────────────────────────

authRouter.post("/admin/invites", requireAuth, async (req: Request, res: Response) => {
  const caller = req.gutoUser!;
  if (caller.role !== "admin" && caller.role !== "coach" && caller.role !== "super_admin") {
    res.status(403).json({ message: "Apenas admin ou coach pode criar convites." });
    return;
  }

  const { name, coachId, expiresInDays, teamId: requestedTeamId } = req.body as {
    name?: string;
    coachId?: string;
    expiresInDays?: number;
    teamId?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ message: "Nome do aluno é obrigatório." });
    return;
  }

  const actor = getRequestActorAccess(req);
  if (!actor) {
    res.status(401).json({ message: "Autenticação necessária." });
    return;
  }
  const teamId = actor.role === "super_admin"
    ? requestedTeamId || GUTO_CORE_TEAM_ID
    : normalizeAccessTeamId(actor.teamId);
  if (actor.role !== "super_admin" && requestedTeamId && requestedTeamId !== teamId) {
    res.status(403).json({ message: "Admin/coach não pode criar convite em outro Time.", code: "TEAM_ACCESS_FORBIDDEN" });
    return;
  }

  let resolvedCoachId =
    actor.role === "admin" || actor.role === "super_admin" ? (coachId ?? actor.coachId ?? actor.userId) : actor.userId;
  if (actor.role === "coach" && coachId && coachId !== actor.userId) {
    res.status(403).json({ message: "Coach não pode criar convite para outro coach.", code: "COACH_STUDENT_ACCESS_FORBIDDEN" });
    return;
  }
  if (coachId && actor.role !== "coach") {
    const assignedCoach = await getUserAccessAsync(coachId);
    if (!assignedCoach || assignedCoach.role !== "coach") {
      res.status(404).json({ message: "Coach não encontrado." });
      return;
    }
    if (normalizeAccessTeamId(assignedCoach.teamId) !== teamId) {
      res.status(403).json({ message: "Coach pertence a outro Time.", code: "TEAM_ACCESS_FORBIDDEN" });
      return;
    }
    resolvedCoachId = assignedCoach.userId;
  }

  const userId = `u-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  try {
    assertTeamPlanCapacity(teamId, "student", getAllUserAccess(), { excludeUserId: userId });
  } catch (error) {
    if (sendTeamPlanError(res, error)) return;
    throw error;
  }

  await upsertUserAccessAsync(userId, {
    role: "student",
    coachId: resolvedCoachId,
    teamId,
    active: false,
    subscriptionStatus: "pending_payment",
  });

  const { invite, rawToken } = await createInvite({
    userId,
    name: name.trim(),
    coachId: resolvedCoachId,
    expiresInDays,
  });

  const inviteLink = `${config.frontendPublicUrl}/convite/${rawToken}`;

  res.json({ invite: { ...invite, tokenHash: undefined }, inviteLink, userId });
});

// ─── Admin: update user access ────────────────────────────────────────────────

authRouter.patch("/admin/users/:userId/access", requireAuth, async (req: Request, res: Response) => {
  if (req.gutoUser!.role !== "admin" && req.gutoUser!.role !== "coach" && req.gutoUser!.role !== "super_admin") {
    res.status(403).json({ message: "Acesso negado." });
    return;
  }

  const userId = String(req.params.userId);
  const { active } = req.body as { active?: boolean };

  if (typeof active !== "boolean") {
    res.status(400).json({ message: "Campo 'active' obrigatório." });
    return;
  }

  const updated = await upsertUserAccessAsync(userId, { active });
  res.json(updated);
});

// ─── Admin: update subscription ───────────────────────────────────────────────

authRouter.patch("/admin/users/:userId/subscription", requireAuth, async (req: Request, res: Response) => {
  if (req.gutoUser!.role !== "admin" && req.gutoUser!.role !== "coach" && req.gutoUser!.role !== "super_admin") {
    res.status(403).json({ message: "Acesso negado." });
    return;
  }

  const userId = String(req.params.userId);
  const { subscriptionStatus, subscriptionEndsAt, extendDays } = req.body as {
    subscriptionStatus?: string;
    subscriptionEndsAt?: string;
    extendDays?: number;
  };

  const patch: Record<string, unknown> = {};
  if (subscriptionStatus) patch.subscriptionStatus = subscriptionStatus;
  if (subscriptionEndsAt) patch.subscriptionEndsAt = subscriptionEndsAt;
  if (extendDays) {
    const existing = await getUserAccessAsync(userId);
    const base = existing?.subscriptionEndsAt
      ? new Date(existing.subscriptionEndsAt)
      : new Date();
    if (base < new Date()) base.setTime(new Date().getTime());
    base.setDate(base.getDate() + extendDays);
    patch.subscriptionEndsAt = base.toISOString();
    patch.subscriptionStatus = "active";
    patch.active = true;
  }

  const updated = await upsertUserAccessAsync(userId, patch as Parameters<typeof upsertUserAccessAsync>[1]);
  await updateInviteByUserId(userId, {
    subscriptionStatus: updated.subscriptionStatus,
    subscriptionEndsAt: updated.subscriptionEndsAt,
  });

  res.json(updated);
});

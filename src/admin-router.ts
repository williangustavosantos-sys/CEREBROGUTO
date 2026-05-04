import express, { Request, Response } from "express";
import crypto from "crypto";
import {
  requireCoachOrAdmin,
  requireAdmin,
  requireSuperAdmin,
} from "./auth-middleware.js";
import {
  getUserAccess,
  upsertUserAccess,
  getAllUserAccess,
  deleteUserAccessHard,
  type UserAccess,
  type UserRole,
  type UserPlan,
  type PaymentStatus,
} from "./user-access-store.js";
import { getMemory, saveMemory } from "../server.js";
import { getDietPlan, saveDietPlan } from "./diet-store.js";
import { addLog, getLogs } from "./log-store.js";
import { config } from "./config.js";
import { createInvite } from "./invite-store.js";

export const adminRouter = express.Router();

adminRouter.use(requireCoachOrAdmin);

// ─── Users Management ────────────────────────────────────────────────────────

adminRouter.get("/users", (req: Request, res: Response) => {
  const caller = req.gutoUser!;
  const allUsers = getAllUserAccess();

  const filtered = caller.role === "coach"
    ? allUsers.filter(u => u.role === "student" && u.coachId === (caller.coachId || caller.userId))
    : allUsers;

  res.json({ users: filtered });
});

// POST /admin/users - Create a new user
adminRouter.post("/users", async (req: Request, res: Response) => {
  const caller = req.gutoUser!;
  const body = req.body as Partial<UserAccess>;
  
  if (!body.name || !body.role) {
    res.status(400).json({ message: "Nome e Role são obrigatórios." });
    return;
  }
  
  // Security checks
  if (caller.role === "coach" && body.role !== "student") {
    res.status(403).json({ message: "Coaches só podem criar alunos." });
    return;
  }
  if (caller.role === "admin" && (body.role === "admin" || body.role === "super_admin")) {
    res.status(403).json({ message: "Apenas super_admin pode criar admins." });
    return;
  }

  const userId = body.userId || `u-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const coachId = body.coachId || (caller.role === "coach" ? (caller.coachId || caller.userId) : "admin");

  const newUser = upsertUserAccess(userId, {
    ...body,
    coachId,
    active: body.active ?? false,
    subscriptionStatus: body.subscriptionStatus ?? "pending_payment",
    paymentStatus: body.paymentStatus ?? "pending_payment",
  });

  // Create invite if it's a student
  let inviteLink = "";
  if (body.role === "student") {
    const { rawToken } = await createInvite({
      userId,
      name: body.name,
      coachId,
    });
    inviteLink = `${config.frontendPublicUrl}/convite/${rawToken}`;
  }

  addLog({
    action: "user_created",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: userId,
    metadata: { role: body.role, name: body.name }
  });

  res.json({ user: newUser, inviteLink });
});

// GET /admin/users/:userId - Get full profile
adminRouter.get("/users/:userId", (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const user = getUserAccess(userId);
  if (!user) {
    res.status(404).json({ message: "Usuário não encontrado." });
    return;
  }
  
  const memory = getMemory(userId);
  res.json({ user, memory });
});

// PATCH /admin/users/:userId - Update user
adminRouter.patch("/users/:userId", (req: Request, res: Response) => {
  const caller = req.gutoUser!;
  const userId = req.params.userId as string;
  const body = req.body as Partial<UserAccess>;
  
  const existing = getUserAccess(userId);
  if (!existing) {
    res.status(404).json({ message: "Usuário não encontrado." });
    return;
  }

  // Security: coaches only their students
  if (caller.role === "coach" && existing.coachId !== (caller.coachId || caller.userId)) {
    res.status(403).json({ message: "Sem permissão para editar este usuário." });
    return;
  }

  const updated = upsertUserAccess(userId, body);
  
  addLog({
    action: "user_updated",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: userId,
    metadata: { updatedFields: Object.keys(body) }
  });

  res.json(updated);
});

// DELETE /admin/users/:userId - Hard delete
adminRouter.delete("/users/:userId", requireAdmin, async (req: Request, res: Response) => {
  const caller = req.gutoUser!;
  const userId = req.params.userId as string;
  
  // Only super_admin can delete other admins
  const target = getUserAccess(userId);
  if (target?.role === "admin" || target?.role === "super_admin") {
    if (caller.role !== "super_admin") {
      res.status(403).json({ message: "Apenas super_admin pode excluir outros administradores." });
      return;
    }
  }

  deleteUserAccessHard(userId);
  
  addLog({
    action: "user_deleted",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: userId
  });

  res.status(204).send();
});

// ─── Workout Override ────────────────────────────────────────────────────────

adminRouter.get("/users/:userId/workout", (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const memory = getMemory(userId);
  res.json({ workout: memory.lastWorkoutPlan });
});

adminRouter.put("/users/:userId/workout", (req: Request, res: Response) => {
  const caller = req.gutoUser!;
  const userId = req.params.userId as string;
  const { workout, reason } = req.body as { workout: any, reason?: string };
  
  const memory = getMemory(userId);
  memory.lastWorkoutPlan = {
    ...workout,
    manualOverride: true,
    editedBy: caller.userId,
    editedAt: new Date().toISOString(),
    editReason: reason || "Manual adjustment",
    planSource: caller.role === "coach" ? "coach_override" : "admin_override",
  };
  
  saveMemory(memory);
  
  addLog({
    action: "workout_edited",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: userId,
    metadata: { reason }
  });

  res.json({ workout: memory.lastWorkoutPlan });
});

adminRouter.post("/users/:userId/workout/reset", (req: Request, res: Response) => {
  const caller = req.gutoUser!;
  const userId = req.params.userId as string;
  
  const memory = getMemory(userId);
  if (memory.lastWorkoutPlan) {
    memory.lastWorkoutPlan.manualOverride = false;
    // GUTO will overwrite it on next request or we could trigger a regeneration
  }
  
  saveMemory(memory);
  res.json({ ok: true });
});

// ─── Diet Override ───────────────────────────────────────────────────────────

adminRouter.get("/users/:userId/diet", async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const diet = await getDietPlan(userId);
  res.json({ diet });
});

adminRouter.put("/users/:userId/diet", async (req: Request, res: Response) => {
  const caller = req.gutoUser!;
  const userId = req.params.userId as string;
  const { diet, reason } = req.body as { diet: any, reason?: string };
  
  const newDiet = {
    ...diet,
    userId,
    manualOverride: true,
    editedBy: caller.userId,
    editedAt: new Date().toISOString(),
    editReason: reason || "Manual adjustment",
    planSource: caller.role === "coach" ? "coach_override" : "admin_override",
  };
  
  await saveDietPlan(newDiet);
  
  addLog({
    action: "diet_edited",
    actorUserId: caller.userId,
    actorRole: caller.role,
    targetUserId: userId,
    metadata: { reason }
  });

  res.json({ diet: newDiet });
});

// ─── Logs ────────────────────────────────────────────────────────────────────

adminRouter.get("/logs", requireAdmin, (req: Request, res: Response) => {
  const { targetUserId } = req.query;
  const logs = getLogs(targetUserId ? { targetUserId: String(targetUserId) } : undefined);
  res.json({ logs });
});

import "./test-env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import { getUserAccess, writeUserAccessStoreRaw, type UserAccess } from "../src/user-access-store.js";
import { config } from "../src/config.js";

const tmpDir = join(process.cwd(), "tmp");
const userAccessFile = join(tmpDir, "user-access.json");
const inviteFile = join(tmpDir, "invites.json");
const auditLogFile = join(tmpDir, "audit-logs.json");
const teamsFile = join(tmpDir, "teams.json");
const testMemoryFile = join(tmpDir, "guto-memory.operational-beta-flow-test.json");
const testDietFile = join(tmpDir, "guto-diet.operational-beta-flow-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalUserAccess: string | null = null;
let originalInvites: string | null = null;
let originalAuditLogs: string | null = null;
let originalTeams: string | null = null;

function superToken(): string {
  return jwt.sign({ userId: "super-operational-beta-test", role: "super_admin" }, config.jwtSecret);
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function request(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, init);
}

before(async () => {
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  process.env.GUTO_DIET_FILE = testDietFile;
  config.memoryFile = testMemoryFile;
  mkdirSync(tmpDir, { recursive: true });
  originalUserAccess = existsSync(userAccessFile) ? readFileSync(userAccessFile, "utf8") : null;
  originalInvites = existsSync(inviteFile) ? readFileSync(inviteFile, "utf8") : null;
  originalAuditLogs = existsSync(auditLogFile) ? readFileSync(auditLogFile, "utf8") : null;
  originalTeams = existsSync(teamsFile) ? readFileSync(teamsFile, "utf8") : null;
  writeUserAccessStoreRaw({ users: {} });
  writeFileSync(inviteFile, JSON.stringify({ invites: {} }, null, 2));
  writeFileSync(auditLogFile, JSON.stringify({ logs: [] }, null, 2));
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  writeFileSync(testDietFile, JSON.stringify({}, null, 2));
  writeFileSync(teamsFile, JSON.stringify({
    teams: {
      GUTO_CORE: {
        id: "GUTO_CORE",
        name: "GUTO Core",
        plan: "custom",
        status: "active",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    },
  }, null, 2));

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  app = serverModule.app;
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind operational beta flow test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  for (const [file, original] of [[userAccessFile, originalUserAccess], [inviteFile, originalInvites], [auditLogFile, originalAuditLogs], [teamsFile, originalTeams]] as const) {
    if (original === null) rmSync(file, { force: true });
    else writeFileSync(file, original);
  }
  rmSync(testMemoryFile, { force: true });
  rmSync(testDietFile, { force: true });
});

describe("Beta interno — fluxo operacional mínimo", () => {
  it("empresa → coach → aluno → convite/login → memória → treino/dieta no painel", async () => {
    const adminToken = superToken();

    const teamRes = await request("/admin/teams", {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: "Action Fit Roma",
        email: "ops@actionfit.test",
        phone: "+39 06 1234 5678",
        addressLine: "Via Roma 10",
        city: "Roma",
        country: "Itália",
        plan: "pro",
        status: "active",
      }),
    });
    assert.equal(teamRes.status, 201);
    const teamBody = (await teamRes.json()) as { team: { id: string; email?: string; phone?: string; city?: string; country?: string; plan?: string; status?: string } };
    assert.equal(teamBody.team.email, "ops@actionfit.test");
    assert.equal(teamBody.team.city, "Roma");
    assert.equal(teamBody.team.country, "Itália");
    assert.equal(teamBody.team.plan, "pro");
    assert.equal(teamBody.team.status, "active");

    const teamsAfterRefresh = await request("/admin/teams", { headers: authHeaders(adminToken) });
    assert.equal(teamsAfterRefresh.status, 200);
    const teams = ((await teamsAfterRefresh.json()) as { teams: Array<{ id: string; name: string }> }).teams;
    assert.ok(teams.some((team) => team.id === teamBody.team.id), "empresa deve reaparecer após refresh");
    assert.ok(!teams.some((team) => team.id === "GUTO_CORE" && team.name === "Action Fit Roma"), "GUTO_CORE não pode se confundir com empresa cliente");

    const coachRes = await request("/admin/coaches", {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: "Coach Beta",
        email: "coach.beta@actionfit.test",
        teamId: teamBody.team.id,
        password: "CoachBeta123",
      }),
    });
    assert.equal(coachRes.status, 201);
    const coach = ((await coachRes.json()) as { coach: UserAccess }).coach;
    assert.equal(coach.role, "coach");
    assert.equal(coach.teamId, teamBody.team.id);

    const looseStudent = await request("/admin/students", {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: "Aluno Sem Coach",
        email: "sem.coach@actionfit.test",
        teamId: teamBody.team.id,
      }),
    });
    assert.equal(looseStudent.status, 400);
    assert.equal(((await looseStudent.json()) as { code?: string }).code, "GUTO_COACH_REQUIRED");

    const studentRes = await request("/admin/students", {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: "Aluno Beta",
        email: "aluno.beta@actionfit.test",
        teamId: teamBody.team.id,
        coachId: coach.userId,
      }),
    });
    assert.equal(studentRes.status, 201);
    const created = (await studentRes.json()) as { user: UserAccess; inviteLink: string };
    assert.ok(created.inviteLink, "criação de aluno sem senha deve gerar convite");
    assert.equal(getUserAccess(created.user.userId)?.teamId, teamBody.team.id);
    assert.equal(getUserAccess(created.user.userId)?.coachId, coach.userId);

    const inviteToken = created.inviteLink.split("/convite/")[1];
    assert.ok(inviteToken, "inviteLink deve conter token");
    const preview = await request(`/auth/invite/${inviteToken}`);
    assert.equal(preview.status, 200);
    assert.equal(((await preview.json()) as { userId: string }).userId, created.user.userId);

    const claim = await request(`/auth/invite/${inviteToken}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "AlunoBeta123" }),
    });
    assert.equal(claim.status, 200);
    const claimBody = (await claim.json()) as { token: string; userId: string };
    assert.equal(claimBody.userId, created.user.userId);
    assert.ok(claimBody.token);

    const login = await request("/auth/user/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emailOrId: "aluno.beta@actionfit.test", password: "AlunoBeta123" }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as { token: string; role: string; teamId?: string; coachId?: string };
    assert.equal(loginBody.role, "student");
    assert.equal(loginBody.teamId, teamBody.team.id);
    assert.equal(loginBody.coachId, coach.userId);

    const consent = await request("/guto/consent/accept", {
      method: "POST",
      headers: authHeaders(loginBody.token),
      body: JSON.stringify({}),
    });
    assert.equal(consent.status, 200);

    const memoryRes = await request("/guto/memory", {
      method: "POST",
      headers: authHeaders(loginBody.token),
      body: JSON.stringify({
        name: "Aluno Beta",
        language: "pt-BR",
        biologicalSex: "male",
        userAge: 34,
        weightKg: 84,
        heightCm: 181,
        trainingLevel: "beginner",
        trainingGoal: "fat_loss",
        preferredTrainingLocation: "gym",
        trainingPathology: "dor no joelho direito",
        country: "Itália",
        countryCode: "IT",
        city: "Roma",
        foodRestrictions: "sem lactose",
        initialXpRewardSeen: true,
      }),
    });
    assert.equal(memoryRes.status, 200);
    const memory = (await memoryRes.json()) as Record<string, any>;
    assert.equal(memory.consentHealthFitness, true);
    assert.equal(memory.acceptedTerms, true);
    assert.equal(memory.city, "Roma");
    assert.equal(memory.countryCode, "IT");
    assert.equal(memory.trainingPathology, "dor no joelho direito");
    assert.equal(memory.foodRestrictions, "sem lactose");
    assert.doesNotMatch(memory.foodRestrictions || "", /joelho|\bdor\b/i);
    assert.doesNotMatch(memory.trainingPathology || "", /lactose|leite|milk/i);
    assert.equal(memory.resolvedFields?.foodRestriction?.normalizedValue, "lactose_intolerance");

    const panelDetail = await request(`/admin/students/${created.user.userId}`, { headers: authHeaders(adminToken) });
    assert.equal(panelDetail.status, 200);
    const detail = (await panelDetail.json()) as { user: UserAccess; memory: Record<string, any> };
    assert.equal(detail.user.teamId, teamBody.team.id);
    assert.equal(detail.user.coachId, coach.userId);
    assert.equal(detail.memory.city, "Roma");
    assert.equal(detail.memory.foodRestrictions, "sem lactose");

    const workoutRes = await request(`/admin/students/${created.user.userId}/workout/generate`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({}),
    });
    assert.equal(workoutRes.status, 200);
    const workout = ((await workoutRes.json()) as { workout: { source?: string; exercises?: unknown[]; location?: string } }).workout;
    assert.equal(workout.source, "guto_generated");
    assert.ok(Array.isArray(workout.exercises) && workout.exercises.length > 0);

    const dietRes = await request(`/admin/students/${created.user.userId}/diet/generate`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({}),
    });
    assert.equal(dietRes.status, 200);
    const diet = ((await dietRes.json()) as { diet: { source?: string; country?: string; countryCode?: string; city?: string; foodRestrictions?: string; meals: Array<{ foods: Array<{ name: string; kcal: number }>; totalKcal: number }>; macros: { targetKcal: number } } }).diet;
    assert.equal(diet.source, "guto_generated");
    assert.equal(diet.country, "Itália");
    assert.equal(diet.countryCode, "IT");
    assert.equal(diet.city, "Roma");
    assert.match(diet.foodRestrictions || "", /lactose/i);
    const allFoodNames = diet.meals.flatMap((meal) => meal.foods.map((food) => food.name)).join(" ");
    assert.doesNotMatch(allFoodNames, /iogurte|yogurt|latte|leite|queijo|cheese|ricotta|mozzarella/i);
    const dailyTotal = diet.meals.reduce((sum, meal) => sum + meal.totalKcal, 0);
    assert.equal(dailyTotal, diet.macros.targetKcal);

    const persistedDiet = await request(`/admin/students/${created.user.userId}/diet`, { headers: authHeaders(adminToken) });
    assert.equal(persistedDiet.status, 200);
    assert.equal(((await persistedDiet.json()) as { diet: { city?: string } }).diet.city, "Roma");
  });
});

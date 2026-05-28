import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import { getUserAccess, writeUserAccessStoreRaw, type UserAccess } from "../src/user-access-store.js";
import { createTeam } from "../src/team-store.js";
import { config } from "../src/config.js";

// Painel P0 — contrato de criação/convite de aluno.
// Cobre: nome soberano único, telefone opcional, email duplicado, criação de
// UserAccess, geração de convite vs senha temporária e escopo de coach.

const tmpDir = join(process.cwd(), "tmp");
const userAccessFile = join(tmpDir, "user-access.json");
const inviteFile = join(tmpDir, "invites.json");
const auditLogFile = join(tmpDir, "audit-logs.json");
const testMemoryFile = join(tmpDir, "guto-memory.panel-student-create-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalUserAccess: string | null = null;
let originalInvites: string | null = null;
let originalAuditLogs: string | null = null;

function access(userId: string, role: UserAccess["role"], coachId: string, teamId?: string, patch: Partial<UserAccess> = {}): UserAccess {
  const now = new Date().toISOString();
  return {
    userId,
    role,
    coachId,
    teamId,
    active: true,
    visibleInArena: true,
    archived: false,
    createdAt: now,
    updatedAt: now,
    subscriptionStatus: "active",
    subscriptionEndsAt: null,
    ...patch,
  };
}

const adminA = access("admin-a", "admin", "admin-a", "TEAM_A");
const coachA = access("coach-a", "coach", "coach-a", "TEAM_A");
const coachOtherA = access("coach-other-a", "coach", "coach-other-a", "TEAM_A");
const coachB = access("coach-b", "coach", "coach-b", "TEAM_B");

function seedTeams(): void {
  const now = new Date().toISOString();
  createTeam({ id: "TEAM_A", name: "Time A", plan: "pro", status: "active", createdAt: now, updatedAt: now });
  createTeam({ id: "TEAM_B", name: "Time B", plan: "pro", status: "active", createdAt: now, updatedAt: now });
}

function seedAccessStore(): void {
  writeUserAccessStoreRaw({
    users: {
      [adminA.userId]: adminA,
      [coachA.userId]: coachA,
      [coachOtherA.userId]: coachOtherA,
      [coachB.userId]: coachB,
    },
  });
}

function token(user: UserAccess): string {
  return jwt.sign({ userId: user.userId, role: user.role, coachId: user.coachId }, config.jwtSecret);
}

function superToken(): string {
  return jwt.sign({ userId: "super-panel-test", role: "super_admin" }, config.jwtSecret);
}

function post(path: string, authToken: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string, authToken: string) {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${authToken}` } });
}

before(async () => {
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  config.memoryFile = testMemoryFile;
  mkdirSync(tmpDir, { recursive: true });
  originalUserAccess = existsSync(userAccessFile) ? readFileSync(userAccessFile, "utf8") : null;
  originalInvites = existsSync(inviteFile) ? readFileSync(inviteFile, "utf8") : null;
  originalAuditLogs = existsSync(auditLogFile) ? readFileSync(auditLogFile, "utf8") : null;

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  app = serverModule.app;

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind panel student-create test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  seedTeams();
  seedAccessStore();
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  writeFileSync(inviteFile, JSON.stringify({ invites: {} }, null, 2));
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (originalUserAccess === null) rmSync(userAccessFile, { force: true });
  else writeFileSync(userAccessFile, originalUserAccess);
  if (originalInvites === null) rmSync(inviteFile, { force: true });
  else writeFileSync(inviteFile, originalInvites);
  if (originalAuditLogs === null) rmSync(auditLogFile, { force: true });
  else writeFileSync(auditLogFile, originalAuditLogs);
  rmSync(testMemoryFile, { force: true });
});

describe("Painel P0 — criar/convidar aluno", () => {
  it("coach cria aluno com nome único e sem telefone → 201, convite gerado, UserAccess criado", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Will Santos",
      email: "will.santos@guto.test",
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      user: UserAccess;
      inviteLink?: string;
      temporaryPassword?: string;
    };
    // Sem senha → convite, não senha temporária.
    assert.ok(body.inviteLink && body.inviteLink.length > 0, "deve retornar inviteLink");
    assert.equal(body.temporaryPassword, undefined);
    // UserAccess real criado, escopado ao time/coach do operador, e pendente.
    const created = getUserAccess(body.user.userId);
    assert.ok(created, "UserAccess deve existir");
    assert.equal(created!.role, "student");
    assert.equal(created!.teamId, "TEAM_A");
    assert.equal(created!.coachId, coachA.userId);
    assert.equal(created!.active, false);
    assert.equal(created!.email, "will.santos@guto.test");
  });

  it("aceita nome único de uma palavra (sobrenome opcional)", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Madonna",
      email: "madonna@guto.test",
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { user: UserAccess };
    const created = getUserAccess(body.user.userId);
    assert.ok(created, "UserAccess deve existir mesmo sem sobrenome");
    assert.equal(created!.role, "student");
  });

  it("com senha inicial → 201, senha temporária retornada, acesso ativo, sem convite", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Ana Lima",
      email: "ana.lima@guto.test",
      password: "GUTOtest123",
      active: true,
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { user: UserAccess; inviteLink?: string };
    const created = getUserAccess(body.user.userId);
    assert.ok(created, "UserAccess deve existir");
    assert.equal(created!.active, true);
    // Com senha definida não há link de convite ativo.
    assert.ok(!body.inviteLink, "não deve gerar convite quando senha foi definida");
  });

  it("email duplicado → 409 GUTO_EMAIL_DUPLICATE", async () => {
    const first = await post("/admin/students", token(coachA), {
      name: "Bruno Mendes",
      email: "duplicado@guto.test",
    });
    assert.equal(first.status, 201);

    const second = await post("/admin/students", token(coachA), {
      name: "Outro Nome",
      email: "duplicado@guto.test",
    });
    assert.equal(second.status, 409);
    const body = (await second.json()) as { code?: string };
    assert.equal(body.code, "GUTO_EMAIL_DUPLICATE");
  });

  it("email inválido → 400 GUTO_EMAIL_INVALID", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Sem Email",
      email: "nao-e-email",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "GUTO_EMAIL_INVALID");
  });

  it("telefone inválido (quando enviado) → 400 GUTO_PHONE_INVALID", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Telefone Ruim",
      email: "telefone.ruim@guto.test",
      phone: "123",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "GUTO_PHONE_INVALID");
  });

  it("coach não pode criar aluno para outro coach → 403 COACH_STUDENT_ACCESS_FORBIDDEN", async () => {
    const response = await post("/admin/students", token(coachA), {
      name: "Aluno Alheio",
      email: "alheio@guto.test",
      coachId: coachOtherA.userId,
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "COACH_STUDENT_ACCESS_FORBIDDEN");
  });

  it("super_admin sem teamId → 400 GUTO_TEAM_REQUIRED", async () => {
    const response = await post("/admin/students", superToken(), {
      name: "Sem Time",
      email: "semtime@guto.test",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "GUTO_TEAM_REQUIRED");
  });

  it("super_admin cria aluno em empresa cliente SEM coach → 400 GUTO_COACH_REQUIRED", async () => {
    const response = await post("/admin/students", superToken(), {
      name: "Sem Coach",
      email: "semcoach@guto.test",
      teamId: "TEAM_A",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "GUTO_COACH_REQUIRED");
  });

  it("super_admin cria aluno com coach de OUTRO time → 403 TEAM_ACCESS_FORBIDDEN", async () => {
    const response = await post("/admin/students", superToken(), {
      name: "Coach Errado",
      email: "coacherrado@guto.test",
      teamId: "TEAM_A",
      coachId: coachB.userId,
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "TEAM_ACCESS_FORBIDDEN");
  });

  it("super_admin cria aluno em empresa cliente COM coach da empresa → 201, vinculado", async () => {
    const response = await post("/admin/students", superToken(), {
      name: "Aluno Vinculado",
      email: "vinculado@guto.test",
      teamId: "TEAM_A",
      coachId: coachA.userId,
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { user: UserAccess };
    const created = getUserAccess(body.user.userId);
    assert.equal(created!.teamId, "TEAM_A");
    assert.equal(created!.coachId, coachA.userId);
  });

  it("super_admin cria aluno em GUTO_CORE SEM coach → 201 (exceção documentada)", async () => {
    const response = await post("/admin/students", superToken(), {
      name: "Aluno Core",
      email: "alunocore@guto.test",
      teamId: "GUTO_CORE",
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { user: UserAccess };
    const created = getUserAccess(body.user.userId);
    assert.equal(created!.teamId, "GUTO_CORE");
  });

  it("convite criado é recuperável via GET /admin/students/:userId/invite", async () => {
    const create = await post("/admin/students", token(coachA), {
      name: "Convite Recuperavel",
      email: "convite.recuperavel@guto.test",
    });
    assert.equal(create.status, 201);
    const created = (await create.json()) as { user: UserAccess; inviteLink: string };

    const inviteRes = await get(`/admin/students/${created.user.userId}/invite`, token(coachA));
    assert.equal(inviteRes.status, 200);
    const inviteBody = (await inviteRes.json()) as { inviteLink: string | null };
    assert.equal(inviteBody.inviteLink, created.inviteLink);
  });

  it("PUT /admin/students/:id/workout hidrata nomes no idioma do aluno (en-US, it-IT)", async () => {
    // Bug do fundador (2026-05-28): coach edita treino do aluno EN/IT mas
    // exercícios voltam em PT ("agachamento", "puxada"). Causa: normalizeWorkoutPlan
    // chamava normalizeWorkoutPlanAgainstCatalog sem language → default pt-BR.
    // Mesmo bug histórico do server.ts markGutoGeneratedWorkout (PR #35).
    const create = await post("/admin/students", token(coachA), {
      name: "Aluno En",
      email: "aluno.en@guto.test",
    });
    assert.equal(create.status, 201);
    const created = (await create.json()) as { user: UserAccess };

    // Define o idioma do aluno via memória direta (igual ao patch do app).
    const langMemStore = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>;
    langMemStore[created.user.userId] = { ...(langMemStore[created.user.userId] || {}), userId: created.user.userId, language: "en-US" };
    writeFileSync(testMemoryFile, JSON.stringify(langMemStore, null, 2));

    // Coach envia treino com exercício do catálogo. Backend deve hidratar o
    // nome em EN, não cair em "Agachamento livre" (canonicalNamePt).
    const putRes = await fetch(`${baseUrl}/admin/students/${created.user.userId}/workout`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token(coachA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workout: {
          focus: "legs_core",
          focusKey: "legs_core",
          exercises: [{ id: "agachamento_livre", sets: 3, reps: "10" }],
        },
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = (await putRes.json()) as { workout: { exercises: Array<{ id: string; name: string }> } };
    assert.equal(putBody.workout.exercises[0].id, "agachamento_livre");
    // namesByLanguage["en-US"] do catálogo:
    assert.equal(putBody.workout.exercises[0].name, "Bodyweight squat");

    // Repeat em IT.
    langMemStore[created.user.userId].language = "it-IT";
    writeFileSync(testMemoryFile, JSON.stringify(langMemStore, null, 2));
    const putItRes = await fetch(`${baseUrl}/admin/students/${created.user.userId}/workout`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token(coachA)}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workout: {
          focus: "legs_core",
          focusKey: "legs_core",
          exercises: [{ id: "agachamento_livre", sets: 3, reps: "10" }],
        },
      }),
    });
    assert.equal(putItRes.status, 200);
    const putItBody = (await putItRes.json()) as { workout: { exercises: Array<{ id: string; name: string }> } };
    // namesByLanguage["it-IT"] do catálogo:
    assert.equal(putItBody.workout.exercises[0].name, "Squat libero");
  });

  it("GET /admin/students/:userId/validations retorna validations + feedback do mais novo para o mais velho", async () => {
    // Coach precisa ver as fotos das validações do aluno (bug do fundador 2026-05-28).
    // O endpoint expõe memory.validationHistory + memory.workoutFeedbackHistory,
    // que antes só eram visíveis via lastValidationAt + validationsTotal.
    const create = await post("/admin/students", token(coachA), {
      name: "Aluno Com Historico",
      email: "aluno.historico@guto.test",
    });
    assert.equal(create.status, 201);
    const created = (await create.json()) as { user: UserAccess };

    // Sem nenhuma validação: arrays vazios.
    const empty = await get(`/admin/students/${created.user.userId}/validations`, token(coachA));
    assert.equal(empty.status, 200);
    const emptyBody = (await empty.json()) as { validations: unknown[]; feedback: unknown[] };
    assert.deepEqual(emptyBody.validations, []);
    assert.deepEqual(emptyBody.feedback, []);

    // Popula validationHistory direto no JSON file (mesmo store que o backend lê).
    const memStore = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>;
    memStore[created.user.userId] = {
      ...(memStore[created.user.userId] || {}),
      userId: created.user.userId,
      validationHistory: [
        {
          id: "v-1",
          userId: created.user.userId,
          createdAt: "2026-05-26T10:00:00.000Z",
          dateLabel: "26 mai",
          workoutFocus: "chest_triceps",
          workoutLabel: "Peito e tríceps",
          locationMode: "gym",
          language: "pt-BR",
          photoUrl: "/img/v1-photo.jpg",
          posterUrl: "/img/v1-poster.jpg",
          thumbUrl: "/img/v1-thumb.jpg",
          xp: 100,
          status: "validated",
          gutoMessage: "Missão fechada.",
        },
        {
          id: "v-2",
          userId: created.user.userId,
          createdAt: "2026-05-27T10:00:00.000Z",
          dateLabel: "27 mai",
          workoutFocus: "back_biceps",
          workoutLabel: "Costas e bíceps",
          locationMode: "gym",
          language: "pt-BR",
          photoUrl: "/img/v2-photo.jpg",
          posterUrl: "/img/v2-poster.jpg",
          thumbUrl: "/img/v2-thumb.jpg",
          xp: 100,
          status: "validated",
          gutoMessage: "Missão fechada.",
        },
      ],
      workoutFeedbackHistory: [
        {
          userId: created.user.userId,
          createdAt: "2026-05-27T10:05:00.000Z",
          workoutFocus: "back_biceps",
          workoutLabel: "Costas e bíceps",
          locationMode: "gym",
          difficulty: "hard",
          energy: "normal",
          exerciseIds: ["x"],
        },
      ],
    };
    writeFileSync(testMemoryFile, JSON.stringify(memStore, null, 2));

    const res = await get(`/admin/students/${created.user.userId}/validations`, token(coachA));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      validations: Array<{ id: string; status: string }>;
      feedback: Array<{ difficulty: string }>;
    };
    // Mais novo primeiro:
    assert.equal(body.validations.length, 2);
    assert.equal(body.validations[0].id, "v-2");
    assert.equal(body.validations[1].id, "v-1");
    assert.equal(body.feedback.length, 1);
    assert.equal(body.feedback[0].difficulty, "hard");
  });

  it("gerar treino sem calibragem → 422 WORKOUT_PROFILE_INCOMPLETE com lista de campos faltando", async () => {
    // Bug do fundador (2026-05-28): aluno criado só com nome+email, abre aba Treino,
    // clica em Gerar → backend devolvia treino genérico com defaults silenciosos
    // ("casa", "iniciante", "sem dor"). Decisão: gerar treino sem calibragem é
    // proibido — mesmo padrão do gate da dieta (DIET_PROFILE_INCOMPLETE).
    const create = await post("/admin/students", token(coachA), {
      name: "Aluno Sem Calibragem",
      email: "aluno.sem.calibragem@guto.test",
    });
    assert.equal(create.status, 201);
    const created = (await create.json()) as { user: UserAccess };

    const res = await post(
      `/admin/students/${created.user.userId}/workout/generate`,
      token(coachA),
      {},
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as { code: string; missing: string[] };
    assert.equal(body.code, "WORKOUT_PROFILE_INCOMPLETE");
    assert.ok(Array.isArray(body.missing));
    // Campos críticos que faltam num aluno só com nome+email:
    for (const field of [
      "biologicalSex",
      "userAge",
      "heightCm",
      "weightKg",
      "trainingLevel",
      "trainingGoal",
      "preferredTrainingLocation",
    ]) {
      assert.ok(body.missing.includes(field), `missing deve conter "${field}", veio: ${JSON.stringify(body.missing)}`);
    }
  });
});

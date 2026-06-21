import "./test-env.js";

process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";
process.env.CLOUDINARY_URL = "";
process.env.CLOUDINARY_CLOUD_NAME = "";
process.env.CLOUDINARY_API_KEY = "";
process.env.CLOUDINARY_API_SECRET = "";
process.env.GEMINI_API_KEY = "";
process.env.GUTO_RATE_LIMIT_MAX_REQUESTS = "10000";
process.env.GUTO_CURATOR_BACKOFF_MS = "0";

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.system-integration-test.json");
const testDietFile = join(tmpDir, "guto-diet.system-integration-test.json");
const userAccessFile = join(tmpDir, "user-access.json");
const arenaFile = join(tmpDir, "arena-store.json");
const auditLogFile = join(tmpDir, "audit-logs.json");
const inviteFile = join(tmpDir, "invites.json");
const teamsFile = join(tmpDir, "teams.json");
const validationImagesDir = join(tmpDir, "validation-images");
const validImageBase64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

process.env.GUTO_MEMORY_FILE = testMemoryFile;
process.env.GUTO_DIET_FILE = testDietFile;

type Role = "student" | "coach" | "admin" | "super_admin";
type AccessRecord = {
  userId: string;
  role: Role;
  coachId: string;
  active: boolean;
  visibleInArena: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  subscriptionStatus: "active" | "pending_payment" | "expired" | "cancelled";
  subscriptionEndsAt: string | null;
  teamId: string;
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
};
type Org = { teamId: string; admin: AccessRecord; coach: AccessRecord; student: AccessRecord };

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearMemoryStoreCache: () => void;
let writeUserAccessStoreRaw: (store: { users: Record<string, AccessRecord> }) => void;
let writeArenaStore: (store: { profiles: Record<string, unknown>; events: unknown[] }) => void;
let createTeam: (team: Record<string, unknown>) => unknown;
let addProactiveMemory: (userId: string, data: Record<string, unknown>) => Promise<Record<string, unknown>>;
let awardArenaXp: (options: Record<string, unknown>) => unknown;
let filterExercisesBySafety: (ids: string[], options: { userRiskTags?: string[]; userBodyRegion?: string }) => string[];
let getCatalogById: (id: string) => Record<string, any> | undefined;

const snapshots = new Map<string, string | null>();
let originalValidationImages = new Set<string>();
let originalFetch: typeof globalThis.fetch;

function snapshotFile(path: string): void {
  snapshots.set(path, existsSync(path) ? readFileSync(path, "utf8") : null);
}

function restoreFile(path: string): void {
  const original = snapshots.get(path);
  if (original === undefined) return;
  if (original === null) rmSync(path, { force: true });
  else writeFileSync(path, original);
}

function resetFileStores(): void {
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  writeFileSync(testDietFile, JSON.stringify({}, null, 2));
  writeFileSync(auditLogFile, JSON.stringify({ logs: [] }, null, 2));
  writeFileSync(inviteFile, JSON.stringify({ invites: {} }, null, 2));
  clearMemoryStoreCache();
  writeUserAccessStoreRaw({ users: {} });
  writeArenaStore({ profiles: {}, events: [] });
}

function nowIso(): string {
  return new Date().toISOString();
}

function dateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function makeAccess(
  userId: string,
  role: Role,
  coachId: string,
  teamId: string,
  patch: Partial<AccessRecord> = {}
): AccessRecord {
  const now = nowIso();
  return {
    userId,
    role,
    coachId,
    teamId,
    active: true,
    visibleInArena: role === "student",
    archived: false,
    createdAt: now,
    updatedAt: now,
    subscriptionStatus: "active",
    subscriptionEndsAt: null,
    email: `${userId}@example.test`,
    name: userId,
    ...patch,
  };
}

function seedOrg(tag: string): Org {
  const teamId = `TEAM_SYS_${tag.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const now = nowIso();
  createTeam({
    id: teamId,
    name: `System ${tag}`,
    plan: "custom",
    status: "active",
    customLimits: { maxCoaches: null, maxStudents: null },
    createdAt: now,
    updatedAt: now,
  });
  const admin = makeAccess(`${tag}-admin`, "admin", `${tag}-admin`, teamId, { visibleInArena: false });
  const coach = makeAccess(`${tag}-coach`, "coach", `${tag}-coach`, teamId, { visibleInArena: false });
  const student = makeAccess(`${tag}-student`, "student", coach.userId, teamId, { name: `Aluno ${tag}` });
  writeUserAccessStoreRaw({ users: { [admin.userId]: admin, [coach.userId]: coach, [student.userId]: student } });
  return { teamId, admin, coach, student };
}

function tokenFor(access: Pick<AccessRecord, "userId" | "role" | "coachId">): string {
  return jwt.sign({ userId: access.userId, role: access.role, coachId: access.coachId }, process.env.JWT_SECRET!);
}

function superToken(userId = "system-super-admin"): string {
  return jwt.sign({ userId, role: "super_admin" }, process.env.JWT_SECRET!);
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function requestJson<T = any>(
  method: string,
  path: string,
  token: string,
  body?: unknown
): Promise<{ res: Response; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as T;
  return { res, body: parsed };
}

async function confirmTripEventThenCanTrain(student: AccessRecord, memoryId: string): Promise<Record<string, any>> {
  const token = tokenFor(student);
  const eventConfirm = await requestJson("POST", "/guto/proactivity/confirm", token, { memoryId });
  assert.equal(eventConfirm.res.status, 200);
  assert.equal(eventConfirm.body.memory.status, "confirmed");
  assert.equal(eventConfirm.body.impact, null);
  assert.equal(eventConfirm.body.expectedResponse?.context, "travel_training");

  const impactReply = await requestJson("POST", "/guto", token, {
    input: "consigo treinar no hotel",
    language: "pt-BR",
    history: [],
  });
  assert.equal(impactReply.res.status, 200);
  const impact = impactReply.body.memoryPatch?.proactiveImpacts?.find((item: Record<string, unknown>) => item.memoryId === memoryId);
  assert.ok(impact, `impacto proativo não retornou no memoryPatch: ${JSON.stringify(impactReply.body)}`);
  return { ...impactReply.body, impact };
}

function readStore(): Record<string, any> {
  return existsSync(testMemoryFile) ? JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any> : {};
}

function readMemory(userId: string): Record<string, any> {
  return readStore()[userId] || {};
}

function writeMemory(userId: string, data: Record<string, unknown>): void {
  const store = readStore();
  store[userId] = { ...store[userId], ...data };
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2));
  clearMemoryStoreCache();
}

function baseMemory(userId: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId,
    name: `Aluno ${userId}`,
    language: "pt-BR",
    hasSeenChatOpening: true,
    initialXpGranted: true,
    initialXpRewardSeen: true,
    totalXp: 100,
    streak: 0,
    trainedToday: false,
    adaptedMissionToday: false,
    lastActiveAt: nowIso(),
    completedWorkoutDates: [],
    adaptedMissionDates: [],
    missedMissionDates: [],
    xpEvents: [],
    proactiveSent: {},
    proactiveMemories: [],
    proactiveImpacts: [],
    biologicalSex: "male",
    userAge: 31,
    heightCm: 178,
    weightKg: 80,
    trainingLevel: "consistent",
    trainingStatus: "consistent",
    trainingGoal: "muscle_gain",
    preferredTrainingLocation: "gym",
    trainingLocation: "gym",
    trainingPathology: "sem dor",
    trainingLimitations: "sem dor",
    country: "Brasil",
    countryCode: "BR",
    city: "Sao Paulo",
    foodRestrictions: "nenhuma",
    ...patch,
  };
}

function seedMemory(userId: string, patch: Record<string, unknown> = {}): void {
  writeMemory(userId, baseMemory(userId, patch));
}

function catalogExercise(id: string, index: number): Record<string, unknown> {
  const exercise = getCatalogById(id);
  if (!exercise) throw new Error(`Missing catalog exercise ${id}`);
  return {
    id: exercise.id,
    name: exercise.canonicalNamePt,
    canonicalNamePt: exercise.canonicalNamePt,
    muscleGroup: exercise.muscleGroup,
    sets: index === 0 ? 2 : 3,
    reps: "10-12",
    rest: "60s",
    restSeconds: 60,
    cue: "Execucao controlada.",
    note: "Plano de teste.",
    alternatives: [],
    order: index + 1,
    videoUrl: exercise.videoUrl,
    videoProvider: "local",
    sourceFileName: exercise.sourceFileName,
  };
}

function workoutPlan(
  title = "Treino oficial QA",
  focusKey = "chest_triceps",
  ids = ["supino_reto", "triceps_barra_v_cabo"]
): Record<string, unknown> {
  return {
    title,
    focus: title,
    focusKey,
    dateLabel: "Hoje",
    scheduledFor: nowIso(),
    summary: "Treino oficial para teste de integracao.",
    location: "gym",
    exercises: ids.map(catalogExercise),
    estimatedDurationMinutes: 25,
    difficulty: "moderado",
    source: "guto_generated",
    planSource: "ai_generated",
    lockedByCoach: false,
  };
}

function dietPlan(userId: string, title = "Dieta oficial QA"): Record<string, unknown> {
  return {
    userId,
    title,
    generatedAt: nowIso(),
    country: "Brasil",
    countryCode: "BR",
    city: "Sao Paulo",
    source: "coach_manual",
    planSource: "coach_override",
    lockedByCoach: false,
    manualOverride: true,
    macros: { bmr: 1500, tdee: 2000, targetKcal: 500, proteinG: 120, carbsG: 50, fatG: 20, goal: "muscle_gain" },
    meals: [
      {
        id: "meal-1",
        name: "Almoco",
        time: "13:00",
        foods: [{ name: "Frango grelhado", quantity: "1 porcao", kcal: 500 }],
        totalKcal: 500,
        kcal: 500,
      },
    ],
    foodRestrictions: "none",
    restrictions: "none",
  };
}

async function validateWorkout(userId: string, token: string, plan = workoutPlan()): Promise<{ res: Response; body: any }> {
  return requestJson("POST", "/guto/validate-workout", token, {
    imageBase64: validImageBase64,
    workoutFocus: (plan.focusKey as string) || "chest_triceps",
    workoutLabel: String(plan.title || "Treino oficial QA"),
    locationMode: "gym",
    language: "pt-BR",
    workoutPlan: plan,
  });
}

function assertNoMeat(meals: Array<Record<string, any>>): void {
  const text = JSON.stringify(meals).toLowerCase();
  assert.doesNotMatch(text, /frango|carne|peixe|atum|salmao|salm[aã]o|tilapia|porco|bacon|presunto|peru/);
}

before(async () => {
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(validationImagesDir, { recursive: true });
  for (const file of [userAccessFile, arenaFile, auditLogFile, inviteFile, teamsFile]) snapshotFile(file);
  originalValidationImages = new Set(existsSync(validationImagesDir) ? readdirSync(validationImagesDir) : []);
  originalFetch = globalThis.fetch.bind(globalThis);
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  writeFileSync(testDietFile, JSON.stringify({}, null, 2));

  const serverModule = await import(pathToFileURL(join(process.cwd(), "server.ts")).href) as any;
  const memoryStore = await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href) as any;
  const userAccessStore = await import(pathToFileURL(join(process.cwd(), "src/user-access-store.ts")).href) as any;
  const arenaStore = await import(pathToFileURL(join(process.cwd(), "src/arena-store.ts")).href) as any;
  const teamStore = await import(pathToFileURL(join(process.cwd(), "src/team-store.ts")).href) as any;
  const proactivityStore = await import(pathToFileURL(join(process.cwd(), "src/proactivity/proactive-store.ts")).href) as any;
  const arena = await import(pathToFileURL(join(process.cwd(), "src/arena.ts")).href) as any;
  const catalog = await import(pathToFileURL(join(process.cwd(), "exercise-catalog.ts")).href) as any;

  app = serverModule.app;
  clearMemoryStoreCache = memoryStore.clearMemoryStoreCache;
  writeUserAccessStoreRaw = userAccessStore.writeUserAccessStoreRaw;
  writeArenaStore = arenaStore.writeArenaStore;
  createTeam = teamStore.createTeam;
  addProactiveMemory = proactivityStore.addProactiveMemory;
  awardArenaXp = arena.awardArenaXp;
  filterExercisesBySafety = catalog.filterExercisesBySafety;
  getCatalogById = catalog.getCatalogById;

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind system integration test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  resetFileStores();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const file of [userAccessFile, arenaFile, auditLogFile, inviteFile, teamsFile]) restoreFile(file);
  rmSync(testMemoryFile, { force: true });
  rmSync(testDietFile, { force: true });
  if (existsSync(validationImagesDir)) {
    for (const file of readdirSync(validationImagesDir)) {
      if (!originalValidationImages.has(file)) rmSync(join(validationImagesDir, file), { force: true });
    }
  }
});

describe("GUTO as a single organism - 20 cross-system scenarios", () => {
  it("01 viajo quarta: memoria proativa confirmada cria impacto em treino, missao, XP, arena, evolucao e percurso", async () => {
    const { student } = seedOrg("s01");
    seedMemory(student.userId);
    // Continuidade primeiro: a viagem só vira impacto cross-system DEFINITIVO com
    // o dado crítico (consegue treinar). Viagem nua é ask_critical — coberto em
    // guto-proactive-continuity / guto-proactivity-http.
    const memory = await addProactiveMemory(student.userId, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "viajo quarta, consigo treinar no hotel",
      understood: "Viagem na quarta, treina no hotel",
      dateText: "quarta",
      weekKey: "2026-W23",
    });

    const body = await confirmTripEventThenCanTrain(student, String(memory.id));
    assert.equal(body.impact.decision.reason, "travel");
    assert.equal(body.impact.workoutEffect, "short_light");
    assert.equal(body.impact.missionEffect, "reduced");
    for (const surface of ["workout", "mission", "xp", "arena", "path", "evolution"]) {
      assert.ok(body.impact.surfaces.includes(surface), `impacto deve incluir ${surface}`);
    }
  });

  it("02 semana corrida: proatividade reduz a semana inteira sem liberar XP gratis", async () => {
    const { student } = seedOrg("s02");
    seedMemory(student.userId);
    const memory = await addProactiveMemory(student.userId, {
      type: "other",
      status: "pending_confirmation",
      rawText: "semana corrida",
      understood: "Semana corrida",
      weekKey: "2026-W23",
    });

    const { res, body } = await requestJson("POST", "/guto/proactivity/confirm", tokenFor(student), { memoryId: memory.id });
    assert.equal(res.status, 200);
    assert.equal(body.impact.decision.reason, "busy_week");
    assert.equal(body.impact.affectedDates.length, 7);
    assert.equal(body.impact.workoutEffect, "minimal");
    assert.equal(body.impact.missionEffect, "reduced");
    assert.equal(body.impact.xpEffect, "no_free_xp_context_only");
  });

  it("03 dor no joelho: memoria corporal altera treino gerado e remove exercicios inseguros", async () => {
    const { student } = seedOrg("s03");
    seedMemory(student.userId, {
      nextWorkoutFocus: "legs_core",
      trainingPathology: "dor no joelho",
      trainingLimitations: "dor no joelho",
      resolvedFields: {
        pathology: {
          status: "clear",
          rawValue: "dor no joelho",
          normalizedValue: "knee pain",
          bodyRegion: "knee",
          riskTags: ["knee"],
          resolvedAt: nowIso(),
          source: "local",
        },
      },
    });

    const { res, body } = await requestJson("POST", "/guto", tokenFor(student), {
      input: "monta meu treino agora",
      language: "pt-BR",
      history: [],
    });
    assert.equal(res.status, 200);
    assert.equal(body.acao, "updateWorkout");
    const ids = body.workoutPlan.exercises.map((exercise: Record<string, unknown>) => String(exercise.id));
    assert.deepEqual(ids, filterExercisesBySafety(ids, { userBodyRegion: "joelho", userRiskTags: ["knee"] }));
  });

  it("04 sem lactose: memoria nutricional gera dieta sem alimentos lacteos", async () => {
    const { student } = seedOrg("s04");
    seedMemory(student.userId, {
      foodRestrictions: "sem lactose",
      resolvedFields: {
        foodRestriction: {
          status: "clear",
          rawValue: "sem lactose",
          normalizedValue: "lactose_intolerance",
          source: "local",
          resolvedAt: nowIso(),
        },
      },
    });
    const { res, body } = await requestJson("POST", `/admin/students/${student.userId}/diet/generate`, superToken(), {});
    assert.equal(res.status, 200, JSON.stringify(body));
    const text = JSON.stringify(body.diet.meals).toLowerCase();
    assert.doesNotMatch(text, /leite|queijo|iogurte|whey|milk|cheese|yogurt|latte|formaggio/);
    assert.equal(body.diet.foodRestrictions, "sem lactose");
  });

  it("05 vegetariano: memoria alimentar guia geracao de dieta do app sem carne/peixe", async () => {
    const { student } = seedOrg("s05");
    seedMemory(student.userId, {
      foodRestrictions: "vegetariano",
      resolvedFields: {
        foodRestriction: {
          status: "clear",
          rawValue: "vegetariano",
          normalizedValue: "vegetarian",
          source: "local",
          resolvedAt: nowIso(),
        },
      },
    });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        const payload = {
          meals: [
            { id: "cafe", name: "Cafe", time: "08:00", foods: [{ name: "Aveia", quantity: "100g", kcal: 520 }], totalKcal: 520 },
            { id: "lanche1", name: "Lanche 1", time: "10:30", foods: [{ name: "Banana", quantity: "100g", kcal: 250 }], totalKcal: 250 },
            { id: "almoco", name: "Almoco", time: "13:00", foods: [{ name: "Arroz", quantity: "160g", kcal: 520 }, { name: "Feijao", quantity: "160g", kcal: 430 }], totalKcal: 950 },
            { id: "lanche2", name: "Lanche 2", time: "16:30", foods: [{ name: "Castanhas", quantity: "60g", kcal: 330 }], totalKcal: 330 },
            { id: "jantar", name: "Jantar", time: "20:00", foods: [{ name: "Lentilha", quantity: "180g", kcal: 620 }], totalKcal: 620 },
          ],
        };
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof globalThis.fetch;

    const { res, body } = await requestJson("POST", "/guto/diet/generate", tokenFor(student), { language: "pt-BR" });
    assert.equal(res.status, 200);
    assertNoMeat(body.meals);
    assert.equal(readMemory(student.userId).dietGenerationStatus, "generated");
  });

  it("06 faltou 5 dias completos: ausencia vira penalidade, XP baixo, streak zerada e datas perdidas", async () => {
    const { student } = seedOrg("s06");
    seedMemory(student.userId, { totalXp: 100, streak: 4, lastActiveAt: daysAgo(6) });
    const { res, body } = await requestJson("GET", "/guto/memory", tokenFor(student));
    assert.equal(res.status, 200);
    assert.equal(body.missedMissionDates.length, 5);
    assert.equal(body.totalXp, 0);
    assert.equal(body.streak, 0);
  });

  it("07 faltou 10 dias: risco persiste em memoria e painel recebe sinais operacionais", async () => {
    const { student } = seedOrg("s07");
    seedMemory(student.userId, { totalXp: 100, streak: 8, lastActiveAt: daysAgo(11) });
    await requestJson("GET", "/guto/memory", tokenFor(student));

    const { res, body } = await requestJson("GET", "/admin/students", superToken(), undefined);
    assert.equal(res.status, 200);
    const row = body.students.find((entry: Record<string, unknown>) => entry.userId === student.userId);
    assert.ok(row, "painel deve listar aluno em risco");
    assert.equal(row.totalXp, 0);
    assert.equal(row.currentStreak, 0);
    assert.ok(row.lastActiveAt, "painel deve receber lastActiveAt para classificar risco/retorno");
  });

  it("08 coach alterou treino: app do aluno recebe o plano manual e historico registra edicao", async () => {
    const { coach, student } = seedOrg("s08");
    seedMemory(student.userId);
    const plan = { ...workoutPlan("Treino coach QA"), source: "coach_manual" };

    const save = await requestJson("PUT", `/admin/students/${student.userId}/workout`, tokenFor(coach), { workout: plan, reason: "Ajuste QA" });
    assert.equal(save.res.status, 200);

    const memory = await requestJson("GET", "/guto/memory", tokenFor(student));
    assert.equal(memory.res.status, 200);
    assert.equal(memory.body.lastWorkoutPlan.title, "Treino coach QA");
    assert.equal(memory.body.lastWorkoutPlan.planSource, "coach_override");

    const history = await requestJson("GET", `/admin/students/${student.userId}/workout/history`, tokenFor(coach));
    assert.equal(history.res.status, 200);
    assert.ok(history.body.history.some((log: Record<string, unknown>) => log.action === "workout_edited"));
  });

  it("09 coach alterou dieta: app do aluno recebe dieta manual e historico registra edicao", async () => {
    const { coach, student } = seedOrg("s09");
    seedMemory(student.userId);

    const save = await requestJson("PUT", `/admin/students/${student.userId}/diet`, tokenFor(coach), {
      diet: dietPlan(student.userId, "Dieta coach QA"),
      reason: "Ajuste de dieta QA",
    });
    assert.equal(save.res.status, 200);

    const appDiet = await requestJson("GET", "/guto/diet", tokenFor(student));
    assert.equal(appDiet.res.status, 200);
    assert.equal(appDiet.body.title, "Dieta coach QA");
    assert.equal(appDiet.body.planSource, "coach_override");

    const history = await requestJson("GET", `/admin/students/${student.userId}/diet/history`, tokenFor(coach));
    assert.equal(history.res.status, 200);
    assert.ok(history.body.history.some((log: Record<string, unknown>) => log.action === "diet_edited"));
  });

  it("10 treino validado: validacao atualiza XP, percurso e historico do aluno", async () => {
    const { student } = seedOrg("s10");
    seedMemory(student.userId, { totalXp: 100, streak: 1 });
    const { res, body } = await validateWorkout(student.userId, tokenFor(student));
    assert.equal(res.status, 200);
    assert.equal(body.validation.xp, 100);

    const memory = readMemory(student.userId);
    assert.equal(memory.totalXp, 200);
    assert.equal(memory.trainedToday, true);
    assert.ok(memory.completedWorkoutDates.includes(dateKey()));
    assert.equal(memory.validationHistory.length, 1);
  });

  it("11 treino duplicado: segunda validacao do mesmo dia nao duplica XP nem arena", async () => {
    const { student } = seedOrg("s11");
    seedMemory(student.userId, { totalXp: 100 });
    const first = await validateWorkout(student.userId, tokenFor(student));
    assert.equal(first.res.status, 200);
    const second = await validateWorkout(student.userId, tokenFor(student));
    assert.equal(second.res.status, 409);

    const memory = readMemory(student.userId);
    assert.equal(memory.totalXp, 200);
    assert.equal(memory.xpEvents.filter((event: Record<string, unknown>) => event.type === "complete_daily_mission").length, 1);
  });

  it("12 usuario revive apos ausencia: validacao real tira XP de zero e marca percurso concluido", async () => {
    const { student } = seedOrg("s12");
    seedMemory(student.userId, {
      totalXp: 0,
      streak: 0,
      missedMissionDates: ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"],
    });
    const { res } = await validateWorkout(student.userId, tokenFor(student));
    assert.equal(res.status, 200);
    const memory = readMemory(student.userId);
    assert.equal(memory.totalXp, 100);
    assert.equal(memory.streak, 1);
    assert.equal(memory.trainedToday, true);
    assert.ok(memory.completedWorkoutDates.includes(dateKey()));
  });

  it("13 admin cria coach e atribui aluno: coach passa a enxergar aluno no painel", async () => {
    const { teamId, student } = seedOrg("s13");
    seedMemory(student.userId);

    const coachCreate = await requestJson("POST", "/admin/coaches", superToken(), {
      userId: "s13-new-coach",
      name: "Coach Novo",
      email: "s13-new-coach@example.test",
      password: "123456",
      teamId,
    });
    assert.equal(coachCreate.res.status, 201);

    const assign = await requestJson("POST", `/admin/coaches/s13-new-coach/students/${student.userId}`, superToken(), {});
    assert.equal(assign.res.status, 200);

    const coachAccess = makeAccess("s13-new-coach", "coach", "s13-new-coach", teamId, { visibleInArena: false });
    const listing = await requestJson("GET", "/admin/students", tokenFor(coachAccess));
    assert.equal(listing.res.status, 200);
    assert.ok(listing.body.students.some((entry: Record<string, unknown>) => entry.userId === student.userId));
  });

  it("14 GUTO Online: exercicio ativo fica na memoria unica consumida pelo app", async () => {
    const { student } = seedOrg("s14");
    seedMemory(student.userId);
    const active = await requestJson("POST", "/guto/active-exercise", tokenFor(student), {
      exercise: {
        source: "online",
        name: "Supino reto",
        muscleGroup: "peito",
        reps: "10-12",
        currentSet: 2,
        totalSets: 4,
      },
    });
    assert.equal(active.res.status, 200);

    const memory = await requestJson("GET", "/guto/memory", tokenFor(student));
    assert.equal(memory.res.status, 200);
    assert.equal(memory.body.activeExercise.name, "Supino reto");
    assert.equal(memory.body.activeExercise.source, "online");
    assert.equal(memory.body.activeExercise.currentSet, 2);
  });

  it("15 admin cria/altera aluno: UserAccess e GutoMemory ficam sincronizados", async () => {
    const { teamId, coach } = seedOrg("s15");
    const created = await requestJson("POST", "/admin/students", superToken(), {
      userId: "s15-created-student",
      name: "Maria QA",
      email: "maria.qa@example.test",
      password: "123456",
      teamId,
      coachId: coach.userId,
      active: true,
      calibration: {
        userAge: 29,
        biologicalSex: "female",
        heightCm: 166,
        weightKg: 62,
        trainingLevel: "beginner",
        trainingGoal: "fat_loss",
        preferredTrainingLocation: "home",
        country: "Brasil",
        countryCode: "BR",
        city: "Sao Paulo",
      },
    });
    assert.equal(created.res.status, 201);

    const detail = await requestJson("GET", "/admin/students/s15-created-student", superToken());
    assert.equal(detail.res.status, 200);
    assert.equal(detail.body.user.coachId, coach.userId);
    assert.equal(detail.body.memory.name, "Maria");
    assert.equal(detail.body.user.firstName, "Maria");
    assert.equal(detail.body.user.lastName, "QA");
    assert.equal(detail.body.memory.userAge, 29);
    assert.equal(detail.body.memory.trainingGoal, "fat_loss");
  });

  it("16 XP vai para arena e ranking semanal apos validacao", async () => {
    const { student } = seedOrg("s16");
    seedMemory(student.userId, { totalXp: 100 });
    const validation = await validateWorkout(student.userId, tokenFor(student));
    assert.equal(validation.res.status, 200);

    const me = await requestJson("GET", "/guto/arena/me", tokenFor(student));
    assert.equal(me.res.status, 200);
    assert.equal(me.body.totalXp, 100);
    assert.equal(me.body.weeklyXp, 100);

    const weekly = await requestJson("GET", "/guto/arena/weekly", tokenFor(student));
    assert.equal(weekly.res.status, 200);
    assert.ok(weekly.body.items.some((item: Record<string, unknown>) => item.userId === student.userId && item.xp === 100));
  });

  it("17 XP cruza threshold e evolucao muda para teen", async () => {
    const { teamId, student } = seedOrg("s17");
    seedMemory(student.userId, { totalXp: 1400 });
    awardArenaXp({
      userId: student.userId,
      displayName: "Aluno S17",
      arenaGroupId: teamId,
      type: "bonus",
      xp: 1400,
    });
    const validation = await validateWorkout(student.userId, tokenFor(student));
    assert.equal(validation.res.status, 200);

    const me = await requestJson("GET", "/guto/arena/me", tokenFor(student));
    assert.equal(me.res.status, 200);
    assert.equal(me.body.totalXp, 1500);
    assert.equal(me.body.avatarStage, "teen");
  });

  it("18 proatividade altera treino gerado no dia impactado", async () => {
    const { student } = seedOrg("s18");
    seedMemory(student.userId, { nextWorkoutFocus: "full_body" });
    // Continuidade primeiro: viagem COM o dado crítico (consegue treinar) mantém
    // o treino adaptado no dia. Viagem nua (ask_critical) não fabrica treino.
    const memory = await addProactiveMemory(student.userId, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "viajo hoje, consigo treinar no hotel",
      understood: "Viagem hoje, treina no hotel",
      dateParsed: dateKey(),
      weekKey: "2026-W23",
    });
    const confirm = await confirmTripEventThenCanTrain(student, String(memory.id));
    assert.equal(confirm.impact.workoutEffect, "short_light");

    const generated = await requestJson("POST", "/guto", tokenFor(student), {
      input: "monta meu treino agora",
      language: "pt-BR",
      history: [],
    });
    assert.equal(generated.res.status, 200);
    assert.equal(generated.body.acao, "updateWorkout");
    assert.equal(generated.body.workoutPlan.proactiveAdaptationMode, "short_light");
    assert.equal(generated.body.workoutPlan.estimatedDurationMinutes, 20);
  });

  it("19 proatividade altera missao sem conceder XP gratis", async () => {
    const { student } = seedOrg("s19");
    seedMemory(student.userId);
    // Continuidade primeiro: treino mantido e adaptado (reduced), e mesmo assim
    // SEM XP grátis — a adaptação não vira atalho de pontuação.
    const memory = await addProactiveMemory(student.userId, {
      type: "trip",
      status: "pending_confirmation",
      rawText: "viajo hoje, consigo treinar no hotel",
      understood: "Viagem hoje, treina no hotel",
      dateParsed: dateKey(),
      weekKey: "2026-W23",
    });
    const confirm = await confirmTripEventThenCanTrain(student, String(memory.id));
    assert.equal(confirm.impact.missionEffect, "reduced");
    assert.equal(confirm.impact.xpEffect, "no_free_xp_context_only");

    const stored = readMemory(student.userId);
    assert.equal(stored.totalXp, 100);
    assert.equal((stored.xpEvents || []).length, 0);
  });

  it("20 coach lock preserva treino e mudanca de peso invalida dieta nao travada", async () => {
    const { coach, student } = seedOrg("s20");
    seedMemory(student.userId, {
      dietGenerationStatus: "generated",
    });
    const savedWorkout = await requestJson("PUT", `/admin/students/${student.userId}/workout`, tokenFor(coach), {
      workout: { ...workoutPlan("Treino travado coach"), source: "coach_manual" },
      reason: "Plano travado QA",
    });
    assert.equal(savedWorkout.res.status, 200);
    const diet = await requestJson("PUT", `/admin/students/${student.userId}/diet`, tokenFor(coach), {
      diet: { ...dietPlan(student.userId, "Dieta revisavel"), source: "guto_generated", planSource: "ai_generated", manualOverride: false },
    });
    assert.equal(diet.res.status, 200);

    const lock = await requestJson("POST", `/admin/students/${student.userId}/workout/lock`, tokenFor(coach), {});
    assert.equal(lock.res.status, 200);

    const chat = await requestJson("POST", "/guto", tokenFor(student), {
      input: "monta outro treino agora",
      language: "pt-BR",
      history: [],
    });
    assert.equal(chat.res.status, 200);
    const lockedPlan = readMemory(student.userId).lastWorkoutPlan;
    assert.equal(lockedPlan.title || lockedPlan.focus, "Treino travado coach");
    assert.equal(lockedPlan.lockedByCoach, true);

    const profilePatch = await requestJson("POST", "/guto/memory", tokenFor(student), { weightKg: 83 });
    assert.equal(profilePatch.res.status, 200);
    assert.equal(profilePatch.body.dietGenerationStatus, "needs_clarification");
  });
});

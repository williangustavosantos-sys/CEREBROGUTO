import "./test-env.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

process.env.GEMINI_API_KEY = "";

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.post-confirmation-redirect-test.json");
const USER_ID = "post-confirmation-redirect-user";

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearMemoryStoreCache: () => void = () => {};
let addProactiveMemory: (userId: string, data: Record<string, unknown>) => Promise<{ id: string }>;
let originalFetch: typeof globalThis.fetch;

function dateKey(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.GUTO_TIME_ZONE || "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function missionPlan(title = "Corpo Inteiro com cuidado no ombro") {
  return {
    title,
    focus: title,
    focusKey: "full_body",
    dateLabel: "hoje",
    scheduledFor: dateKey(),
    summary: "Missao do dia pronta.",
    exercises: [
      {
        id: "mobilidade_ombro",
        name: "Mobilidade de ombro",
        canonicalNamePt: "Mobilidade de ombro",
        muscleGroup: "shoulders_abs",
        sets: 2,
        reps: "10",
        rest: "45s",
        cue: "Controle o movimento.",
        note: "Sem irritar o ombro.",
        videoUrl: "/videos/mobilidade_ombro.mp4",
        videoProvider: "local",
        sourceFileName: "mobilidade_ombro.mp4",
      },
    ],
  };
}

const baseCalibration = {
  name: "Will",
  language: "pt-BR",
  hasSeenChatOpening: true,
  initialXpGranted: true,
  totalXp: 100,
  streak: 2,
  trainedToday: false,
  xpEvents: [],
  completedWorkoutDates: [],
  proactiveMemories: [],
  proactiveImpacts: [],
  weeklyConversation: null,
  biologicalSex: "male",
  userAge: 35,
  heightCm: 180,
  weightKg: 82,
  trainingLevel: "consistent",
  trainingStatus: "treinando",
  trainingGoal: "muscle_gain",
  preferredTrainingLocation: "gym",
  trainingLocation: "gym",
  trainingPathology: "ombro direito sensivel",
  trainingLimitations: "ombro direito sensivel",
  dietGenerationStatus: "idle",
};

function readStore(): Record<string, any> {
  if (!existsSync(testMemoryFile)) return {};
  return JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>;
}

function readUserMemory(userId = USER_ID) {
  return readStore()[userId] as Record<string, any>;
}

function writeUserMemory(userId: string, data: Record<string, unknown>) {
  const store = readStore();
  store[userId] = { userId, ...baseCalibration, ...data };
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2));
  clearMemoryStoreCache();
}

function authHeaders(userId = USER_ID) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function postGuto(input: string, userId = USER_ID) {
  const response = await originalFetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: authHeaders(userId),
    body: JSON.stringify({ language: "pt-BR", history: [], input }),
  });
  assert.equal(response.status, 200, `POST /guto deveria responder 200, veio ${response.status}`);
  return response.json() as Promise<Record<string, any>>;
}

async function seedPendingTripCannotTrain() {
  writeUserMemory(USER_ID, {
    lastWorkoutPlan: missionPlan(),
  });
  await addProactiveMemory(USER_ID, {
    type: "trip",
    status: "pending_confirmation",
    rawText: "Vou viajar sexta.",
    understood: "Viagem na sexta.",
    dateText: "sexta",
    dateParsed: dateKey(2),
    weekKey: "2026-W24",
  });
  clearMemoryStoreCache();
}

describe("POST_CONFIRMATION_REDIRECT", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    mkdirSync(tmpDir, { recursive: true });
    originalFetch = globalThis.fetch.bind(globalThis);

    const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
    };
    const memoryStoreModule = (await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as {
      clearMemoryStoreCache: () => void;
    };
    const proactiveStoreModule = (await import(pathToFileURL(join(process.cwd(), "src/proactivity/proactive-store.ts")).href)) as {
      addProactiveMemory: (userId: string, data: Record<string, unknown>) => Promise<{ id: string }>;
    };

    app = serverModule.app;
    clearMemoryStoreCache = memoryStoreModule.clearMemoryStoreCache;
    addProactiveMemory = proactiveStoreModule.addProactiveMemory;

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind post-confirmation test server.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    clearMemoryStoreCache();
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(testMemoryFile, { force: true });
  });

  it("viagem + cannot_train abre card e não protege antes da confirmação", async () => {
    await seedPendingTripCannotTrain();

    const body = await postGuto("Não vou conseguir treinar.");

    assert.match(body.fala, /confirma|card|impacto/i);
    assert.doesNotMatch(body.fala, /Agora volta comigo para hoje/i);
    assert.notEqual(body.acao, "updateWorkout");
    assert.equal(body.workoutPlan ?? null, null);

    const memory = readUserMemory();
    assert.equal(memory.proactiveMemories?.[0]?.status, "pending_confirmation");
    assert.equal(memory.proactiveMemories?.[0]?.confirmationStage, "event");
    assert.doesNotMatch(memory.proactiveMemories?.[0]?.rawText || "", /não vou conseguir treinar/i);
    assert.deepEqual(memory.proactiveImpacts || [], []);
  });

  it("dor confirmada registra, adapta a fala e direciona para a proxima acao", async () => {
    writeUserMemory(USER_ID, {
      trainingPathology: "sem dor",
      trainingLimitations: "sem dor",
      lastWorkoutPlan: missionPlan("Corpo Inteiro base"),
    });

    const body = await postGuto("Estou com dor no ombro direito.");

    assert.match(body.fala, /Dor registrada|Ombro entendido/i);
    assert.match(body.fala, /reduz impacto|sem irritar|proteger/i);
    assert.match(body.fala, /Agora volta comigo para hoje/i);
    assert.match(body.fala, /Pr[oó]xima a[cç][aã]o|miss[aã]o/i);

    const memory = readUserMemory();
    assert.match(memory.trainingLimitations || "", /ombro/i);
  });

  it("janela curta com missao ativa adapta e redireciona para a missao", async () => {
    writeUserMemory(USER_ID, {
      lastWorkoutPlan: missionPlan("Corpo Inteiro reduzido"),
    });

    const body = await postGuto("Só tenho 10 minutos hoje.");

    assert.match(body.fala, /curt|janela/i);
    assert.match(body.fala, /Agora volta comigo para hoje/i);
    assert.match(body.fala, /miss[aã]o/i);
    assert.match(body.fala, /Corpo Inteiro reduzido/i);
    assert.notEqual(body.acao, "updateWorkout");
    assert.equal(body.workoutPlan ?? null, null);
  });

  it("proactive_context + travel_cannot_train cria pendência e não protege ainda", async () => {
    writeUserMemory(USER_ID, {
      lastWorkoutPlan: missionPlan("Corpo Inteiro com cuidado no ombro"),
    });

    const before = readUserMemory();
    const body = await postGuto("viajo sexta, não consigo treinar nesse dia");
    const afterMemory = readUserMemory();

    assert.match(body.fala, /confirma|card|impacto/i);
    assert.doesNotMatch(body.fala, /Agora volta comigo para hoje/i);
    assert.notEqual(body.acao, "updateWorkout");
    assert.equal(body.workoutPlan ?? null, null);
    assert.equal(afterMemory.totalXp, before.totalXp);
    assert.deepEqual(afterMemory.xpEvents, before.xpEvents);
    assert.deepEqual(afterMemory.completedWorkoutDates, before.completedWorkoutDates);
    assert.equal(afterMemory.lastWorkoutPlan?.title, before.lastWorkoutPlan?.title);
    assert.equal(afterMemory.proactiveMemories?.[0]?.status, "pending_confirmation");
    assert.equal(afterMemory.proactiveMemories?.[0]?.confirmationStage, "event");
    assert.deepEqual(afterMemory.proactiveImpacts || [], before.proactiveImpacts || []);
  });

  it("viagem nova abre card de evento antes de perguntar impacto", async () => {
    writeUserMemory(USER_ID, {
      lastWorkoutPlan: missionPlan("Corpo Inteiro com cuidado no ombro"),
    });

    const body = await postGuto("viajo sexta");

    assert.match(body.fala, /confirma primeiro no card|impacto no treino/i);
    assert.doesNotMatch(body.fala, /Agora volta comigo para hoje/i);
    assert.notEqual(body.acao, "updateWorkout");
    assert.equal(body.workoutPlan ?? null, null);

    const memory = readUserMemory();
    assert.equal(memory.proactiveMemories?.length, 1);
    assert.equal(memory.proactiveMemories?.[0]?.status, "pending_confirmation");
    assert.equal(memory.proactiveMemories?.[0]?.confirmationStage, "event");
    assert.equal(memory.activeConversationContext?.kind, "travel_confirmation");
    assert.deepEqual(memory.proactiveImpacts || [], []);
  });

  it("sem missao ativa nao inventa missao e usa redirecionamento neutro", async () => {
    writeUserMemory(USER_ID, {
      lastWorkoutPlan: null,
      weeklyWorkoutPlan: null,
      weeklyDietPlan: null,
      dietGenerationStatus: "idle",
    });

    const body = await postGuto("Só tenho 10 minutos hoje.");

    assert.match(body.fala, /Agora volta comigo para hoje/i);
    assert.match(body.fala, /Pr[oó]xima a[cç][aã]o/i);
    assert.doesNotMatch(body.fala, /miss[aã]o/i);
    assert.notEqual(body.acao, "updateWorkout");
    assert.equal(body.workoutPlan ?? null, null);
  });

  it("card pendente nao gera XP, Arena ou treino novo por conta propria", async () => {
    await seedPendingTripCannotTrain();

    const before = readUserMemory();
    const body = await postGuto("Não vou conseguir treinar.");
    const afterMemory = readUserMemory();

    assert.match(body.fala, /confirma|card|proteg/i);
    assert.doesNotMatch(body.fala, /Agora volta comigo para hoje/i);
    assert.notEqual(body.acao, "updateWorkout");
    assert.equal(body.workoutPlan ?? null, null);
    assert.equal(afterMemory.totalXp, before.totalXp);
    assert.deepEqual(afterMemory.xpEvents, before.xpEvents);
    assert.deepEqual(afterMemory.completedWorkoutDates, before.completedWorkoutDates);
    assert.equal(afterMemory.lastWorkoutPlan?.title, before.lastWorkoutPlan?.title);
    assert.deepEqual(afterMemory.proactiveImpacts || [], []);
  });
});

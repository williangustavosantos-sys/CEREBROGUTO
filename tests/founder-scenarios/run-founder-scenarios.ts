import "../test-env.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import jwt from "jsonwebtoken";

process.env.GEMINI_API_KEY = "";
process.env.GUTO_GEMINI_MODEL = process.env.GUTO_GEMINI_MODEL || "gemini-3.1-flash-lite";
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";

type GutoResponse = {
  fala?: string;
  acao?: string;
  expectedResponse?: unknown;
  workoutPlan?: unknown;
};

type MemoryRecord = Record<string, unknown>;

type FounderContext = {
  chat: (userId: string, input: string) => Promise<GutoResponse>;
  confirmProactiveMemory: (userId: string, memoryId: string) => Promise<GutoResponse & { ok?: boolean; memoryPatch?: MemoryRecord }>;
  readMemory: (userId: string) => MemoryRecord;
  seedMemory: (userId: string, data?: MemoryRecord) => void;
  seedDiet: (userId: string) => Promise<void>;
  seedPendingTrip: (userId: string) => Promise<void>;
};

type FounderScenario = {
  id: number;
  name: string;
  run: (ctx: FounderContext) => Promise<void>;
};

type DietPlanSeed = {
  userId: string;
  generatedAt: string;
  country: string;
  countryCode: string;
  macros: {
    targetKcal: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
  };
  meals: Array<{
    id: string;
    name: string;
    time: string;
    foods: Array<{ name: string; quantity: string; kcal: number }>;
    totalKcal: number;
    gutoNote: string;
  }>;
};

const tmpDir = join(process.cwd(), "tmp", "founder-scenarios");
const memoryFile = join(tmpDir, "guto-memory.founder-scenarios.json");
const dietFile = join(tmpDir, "guto-diet.founder-scenarios.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server | null = null;
let baseUrl = "";
let clearMemoryStoreCache: () => void = () => {};
let saveDietPlan: (plan: DietPlanSeed) => Promise<void> = async () => {};
let addProactiveMemory: (userId: string, data: MemoryRecord) => Promise<{ id: string }> = async () => ({ id: "" });

const originalConsoleLog = console.log.bind(console);

const baseMemory: MemoryRecord = {
  name: "Will",
  language: "pt-BR",
  hasSeenChatOpening: true,
  initialXpGranted: true,
  totalXp: 100,
  streak: 3,
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
  trainingStatus: "consistent",
  trainingGoal: "muscle_gain",
  preferredTrainingLocation: "gym",
  trainingLocation: "gym",
  trainingPathology: "sem dor",
  trainingLimitations: "sem dor",
  foodRestrictions: "nenhuma",
  dietGenerationStatus: "idle",
  lastSuggestedFocus: "full_body",
};

function dateKey(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.GUTO_TIME_ZONE || "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function missionPlan(title = "Corpo Inteiro com cuidado no ombro"): MemoryRecord {
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
        videoUrl: "/exercise/visuals/ombros_abdomen/prancha_isometrica.mp4",
        videoProvider: "local",
        sourceFileName: "prancha_isometrica.mp4",
      },
    ],
  };
}

function readStore(): Record<string, MemoryRecord> {
  if (!existsSync(memoryFile)) return {};
  return JSON.parse(readFileSync(memoryFile, "utf8")) as Record<string, MemoryRecord>;
}

function writeStore(store: Record<string, MemoryRecord>) {
  writeFileSync(memoryFile, JSON.stringify(store, null, 2));
  clearMemoryStoreCache();
}

function readMemory(userId: string): MemoryRecord {
  return readStore()[userId] || {};
}

function seedMemory(userId: string, data: MemoryRecord = {}) {
  const store = readStore();
  store[userId] = { userId, ...baseMemory, lastWorkoutPlan: missionPlan(), ...data };
  writeStore(store);
}

function authHeaders(userId: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function chat(userId: string, input: string): Promise<GutoResponse> {
  const response = await fetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: authHeaders(userId),
    body: JSON.stringify({ language: "pt-BR", profile: { userId, name: "Will" }, history: [], input }),
  });
  assert.equal(response.status, 200, `POST /guto deveria responder 200, veio ${response.status}`);
  return (await response.json()) as GutoResponse;
}

async function confirmProactiveMemory(userId: string, memoryId: string): Promise<GutoResponse & { ok?: boolean; memoryPatch?: MemoryRecord }> {
  const response = await fetch(`${baseUrl}/guto/proactivity/confirm`, {
    method: "POST",
    headers: authHeaders(userId),
    body: JSON.stringify({ memoryId }),
  });
  assert.equal(response.status, 200, `POST /guto/proactivity/confirm deveria responder 200, veio ${response.status}`);
  return (await response.json()) as GutoResponse & { ok?: boolean; memoryPatch?: MemoryRecord };
}

async function seedDiet(userId: string) {
  const plan: DietPlanSeed = {
    userId,
    generatedAt: new Date().toISOString(),
    country: "Brazil",
    countryCode: "BR",
    macros: { targetKcal: 2200, proteinG: 160, carbsG: 230, fatG: 70 },
    meals: [
      {
        id: "cafe",
        name: "Café da manhã",
        time: "08:00",
        foods: [
          { name: "Ovos mexidos", quantity: "3 unidades", kcal: 220 },
          { name: "Aveia", quantity: "40g", kcal: 150 },
        ],
        totalKcal: 370,
        gutoNote: "Combustível do dia.",
      },
      {
        id: "almoco",
        name: "Almoço",
        time: "13:00",
        foods: [{ name: "Frango grelhado", quantity: "180g", kcal: 300 }],
        totalKcal: 600,
        gutoNote: "Proteína limpa.",
      },
    ],
  };
  await saveDietPlan(plan);
  seedMemory(userId, {
    dietGenerationStatus: "generated",
    weeklyDietPlan: plan,
  });
}

async function seedPendingTrip(userId: string) {
  seedMemory(userId, {
    lastWorkoutPlan: missionPlan("Corpo Inteiro com cuidado no ombro"),
  });
  await addProactiveMemory(userId, {
    type: "trip",
    status: "pending_confirmation",
    rawText: "viajo sexta",
    understood: "Viagem na sexta.",
    dateText: "sexta",
    dateParsed: dateKey(2),
    weekKey: "founder-week",
  });
  clearMemoryStoreCache();
}

function falaOf(response: GutoResponse) {
  return response.fala || "";
}

function assertSpeaks(response: GutoResponse, pattern: RegExp, message: string) {
  assert.match(falaOf(response), pattern, message);
}

function assertDoesNotSpeak(response: GutoResponse, pattern: RegExp, message: string) {
  assert.doesNotMatch(falaOf(response), pattern, message);
}

function assertNoWorkoutGeneration(response: GutoResponse) {
  assert.notEqual(response.acao, "updateWorkout", "não deve gerar treino pelo chat nesse cenário");
  assert.equal(response.workoutPlan ?? null, null, "não deve retornar treino novo");
}

const scenarios: FounderScenario[] = [
  {
    id: 1,
    name: "viagem cria card e só depois pergunta dado crítico",
    run: async (ctx) => {
      const userId = "founder-01-trip";
      ctx.seedMemory(userId);
      const response = await ctx.chat(userId, "viajo sexta");

      assertSpeaks(response, /confirma.*card|card.*impacto|viagem.*card/i, "viagem precisa criar card antes de perguntar impacto");
      assertNoWorkoutGeneration(response);
      const memory = ctx.readMemory(userId);
      const trip = ((memory.proactiveMemories || []) as Array<{ id?: string; status?: string; confirmationStage?: string }>)[0];
      assert.equal(trip?.status, "pending_confirmation", "viagem precisa ficar pendente no card");
      assert.equal(trip?.confirmationStage, "event", "primeiro card precisa confirmar o evento");

      const confirm = await ctx.confirmProactiveMemory(userId, String(trip.id));
      assertSpeaks(confirm, /20 minutos|treino adaptado|conseguir fazer/i, "confirmar viagem precisa perguntar se há treino possível");
      assert.equal((confirm.expectedResponse as { context?: string } | null)?.context, "travel_training");
    },
  },
  {
    id: 2,
    name: "viagem indisponível abre card antes de proteger",
    run: async (ctx) => {
      const userId = "founder-02-trip-unavailable";
      await ctx.seedPendingTrip(userId);
      const before = ctx.readMemory(userId);
      const response = await ctx.chat(userId, "não consigo treinar nesse dia");
      const after = ctx.readMemory(userId);

      assertSpeaks(response, /confirma|card|impacto/i, "indisponibilidade antes do card precisa manter confirmação visual do evento");
      assertDoesNotSpeak(response, /Agora volta comigo para hoje/i, "sem confirmação no card ainda não redireciona");
      assertNoWorkoutGeneration(response);
      assert.equal(after.totalXp, before.totalXp, "redirect não deve criar XP");
      assert.deepEqual(after.xpEvents, before.xpEvents, "redirect não deve criar evento de XP");
      assert.deepEqual(after.completedWorkoutDates, before.completedWorkoutDates, "redirect não deve validar treino");
      const afterMemories = (after.proactiveMemories || []) as Array<{ status?: string; confirmationStage?: string; rawText?: string }>;
      assert.equal(afterMemories[0]?.status, "pending_confirmation", "card mantém memória pendente até confirmação");
      assert.equal(afterMemories[0]?.confirmationStage, "event", "não pode pular para impacto antes de confirmar viagem");
      assert.doesNotMatch(afterMemories[0]?.rawText || "", /não consigo treinar/i, "não deve salvar impacto antes de confirmar evento");
      assert.deepEqual(after.proactiveImpacts || [], before.proactiveImpacts || [], "impacto protegido só nasce após confirmar card");
    },
  },
  {
    id: 3,
    name: "café mantém treino",
    run: async (ctx) => {
      const userId = "founder-03-breakfast";
      ctx.seedMemory(userId);
      await ctx.seedDiet(userId);
      const response = await ctx.chat(userId, "vou tomar café primeiro");

      assertSpeaks(response, /café|cafe|dieta|refei/i, "café deve puxar dieta/refeição quando existe plano");
      assertSpeaks(response, /come e volta|te puxo pro treino|continua de pé|continua de pe/i, "preparo deve manter o treino de pé");
      assertDoesNotSpeak(response, /caminhada|perde XP|ningu[eé]m desiste/i, "café não pode virar recusa");
      assertNoWorkoutGeneration(response);
    },
  },
  {
    id: 4,
    name: "dor no ombro adapta",
    run: async (ctx) => {
      const userId = "founder-04-shoulder";
      ctx.seedMemory(userId, {
        trainingPathology: "sem dor",
        trainingLimitations: "sem dor",
        lastWorkoutPlan: missionPlan("Corpo Inteiro base"),
      });
      const response = await ctx.chat(userId, "estou com dor no ombro");
      const memory = ctx.readMemory(userId);

      assertSpeaks(response, /dor|ombro/i, "dor no ombro precisa ser reconhecida");
      assertSpeaks(response, /adapta|reduz impacto|sem irritar|proteg|cuidado/i, "dor precisa conduzir adaptação/proteção");
      assert.match(String(memory.trainingLimitations || ""), /ombro/i, "memória precisa registrar ombro");
    },
  },
  {
    id: 5,
    name: "janela curta vira missão curta",
    run: async (ctx) => {
      const userId = "founder-05-short-window";
      ctx.seedMemory(userId, {
        lastWorkoutPlan: missionPlan("Corpo Inteiro reduzido"),
      });
      const response = await ctx.chat(userId, "só tenho 10 minutos");

      assertSpeaks(response, /curt|janela|10|min/i, "janela curta precisa ser reconhecida");
      assertSpeaks(response, /Agora volta comigo para hoje|miss[aã]o|bloco/i, "janela curta precisa conduzir uma ação curta");
      assertNoWorkoutGeneration(response);
    },
  },
  {
    id: 6,
    name: "fiz o treino pede validação sem XP direto",
    run: async (ctx) => {
      const userId = "founder-06-workout-done";
      ctx.seedMemory(userId);
      const before = ctx.readMemory(userId);
      const response = await ctx.chat(userId, "fiz o treino");
      const after = ctx.readMemory(userId);

      assertSpeaks(response, /feito|conta|valid|valida|como foi/i, "conclusão precisa conduzir validação/fechamento");
      assertNoWorkoutGeneration(response);
      assert.equal(after.totalXp, before.totalXp, "chat não pode dar XP direto");
      assert.deepEqual(after.xpEvents, before.xpEvents, "chat não pode criar evento XP direto");
    },
  },
  {
    id: 7,
    name: "não gostei do treino pede ajuste",
    run: async (ctx) => {
      const userId = "founder-07-dislike-workout";
      ctx.seedMemory(userId);
      const response = await ctx.chat(userId, "não gostei do treino");

      assertSpeaks(response, /ajust|troco|trocar|mudo|mudar|qual parte|me diz|o que n[aã]o/i, "feedback negativo precisa abrir ajuste");
      assertDoesNotSpeak(response, /deu um curto|manda de novo|perde XP|amanh[aã] a gente volta/i, "feedback negativo não pode encerrar nem virar erro genérico");
      assertNoWorkoutGeneration(response);
    },
  },
  {
    id: 8,
    name: "e minha dieta responde dieta",
    run: async (ctx) => {
      const userId = "founder-08-diet";
      await ctx.seedDiet(userId);
      const response = await ctx.chat(userId, "e minha dieta?");

      assertSpeaks(response, /dieta|refei|café|cafe|almo[cç]o|macro|kcal/i, "pergunta de dieta precisa responder dieta");
      assertDoesNotSpeak(response, /deu um curto|distra[cç][aã]o|treino primeiro/i, "dieta não pode virar erro genérico nem distração");
      assertNoWorkoutGeneration(response);
    },
  },
];

async function setup(): Promise<FounderContext> {
  console.log = (...args: unknown[]) => {
    const first = String(args[0] || "");
    if (first.startsWith("PASS") || first.startsWith("FAIL")) originalConsoleLog(...args);
  };

  process.env.GUTO_MEMORY_FILE = memoryFile;
  process.env.GUTO_DIET_FILE = dietFile;
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_ALLOW_DEV_ACCESS = "true";

  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(memoryFile, JSON.stringify({}, null, 2));
  writeFileSync(dietFile, JSON.stringify({}, null, 2));

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  const memoryStoreModule = (await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as {
    clearMemoryStoreCache: () => void;
  };
  const dietStoreModule = (await import(pathToFileURL(join(process.cwd(), "src/diet-store.ts")).href)) as {
    saveDietPlan: (plan: DietPlanSeed) => Promise<void>;
  };
  const proactiveStoreModule = (await import(pathToFileURL(join(process.cwd(), "src/proactivity/proactive-store.ts")).href)) as {
    addProactiveMemory: (userId: string, data: MemoryRecord) => Promise<{ id: string }>;
  };

  app = serverModule.app;
  clearMemoryStoreCache = memoryStoreModule.clearMemoryStoreCache;
  saveDietPlan = dietStoreModule.saveDietPlan;
  addProactiveMemory = proactiveStoreModule.addProactiveMemory;

  await new Promise<void>((resolve, reject) => {
    const localServer = app.listen(0, "127.0.0.1", () => resolve());
    server = localServer;
    localServer.once("error", reject);
  });
  if (!server) throw new Error("Failed to start founder scenarios server.");
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("Failed to bind founder scenarios server.");
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    chat,
    confirmProactiveMemory,
    readMemory,
    seedMemory,
    seedDiet,
    seedPendingTrip,
  };
}

async function teardown() {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
  rmSync(tmpDir, { recursive: true, force: true });
  console.log = originalConsoleLog;
}

async function main() {
  const context = await setup();
  const failures: Array<{ id: number; name: string; error: string }> = [];

  try {
    for (const scenario of scenarios) {
      try {
        await scenario.run(context);
      } catch (error) {
        failures.push({
          id: scenario.id,
          name: scenario.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await teardown();
  }

  if (failures.length === 0) {
    originalConsoleLog(`PASS ${scenarios.length}/${scenarios.length}`);
    return;
  }

  originalConsoleLog("FAIL:");
  for (const failure of failures) {
    originalConsoleLog(`- cenário ${failure.id}: ${failure.name} — ${failure.error}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  originalConsoleLog("FAIL:");
  originalConsoleLog(`- infraestrutura: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

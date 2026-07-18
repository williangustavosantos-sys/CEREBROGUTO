import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { getCatalogById } from "../exercise-catalog.js";

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.diet-generation-test.json");
const testDietFile = join(tmpDir, "guto-diet.generation-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalFetch: typeof globalThis.fetch;
let dietModelCalls = 0;
let dietModelDelayMs = 0;
let saveDietPlanForTest: (plan: any) => Promise<void>;
let saveDietPlanIfUnchangedForTest: (plan: any, expectedToken: string) => Promise<void>;
let getDietPlanConcurrencyTokenForTest: (plan: any) => string;
let setMemoryStoreRedisClientForTests: (client: {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options?: { nx: true; px: number }) => Promise<unknown>;
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
} | null | undefined) => void;

function readMemory(userId: string) {
  if (!existsSync(testMemoryFile)) return {};
  return (JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>)[userId] || {};
}

function defaultMissionPlan() {
  const exercise = getCatalogById("supino_reto");
  assert.ok(exercise);
  return {
    focus: "Peito e tríceps",
    focusKey: "chest_triceps",
    location: "academia",
    locationMode: "gym",
    dateLabel: "Hoje",
    scheduledFor: new Date().toISOString(),
    summary: "Missão persistida antes da dieta.",
    exercises: [{
      id: exercise.id,
      name: exercise.canonicalNamePt,
      canonicalNamePt: exercise.canonicalNamePt,
      muscleGroup: exercise.muscleGroup,
      sets: 3,
      reps: "10",
      rest: "60s",
      cue: "",
      note: "",
      videoUrl: exercise.videoUrl,
      videoProvider: "local",
      sourceFileName: exercise.sourceFileName,
    }],
  };
}

function writeMemory(userId: string, data: Record<string, any>) {
  const store = existsSync(testMemoryFile)
    ? JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>
    : {};
  store[userId] = {
    userId,
    name: "Will",
    language: "it-IT",
    lastWorkoutPlan: defaultMissionPlan(),
    ...data,
  };
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2));
}

function authHeaders(userId: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeCoachDietPlan(userId: string) {
  return {
    userId,
    generatedAt: new Date().toISOString(),
    country: "Italia",
    language: "it-IT",
    source: "coach_manual",
    planSource: "coach_override",
    manualOverride: true,
    lockedByCoach: true,
    macros: {
      bmr: 1800,
      tdee: 2400,
      targetKcal: 2400,
      proteinG: 160,
      carbsG: 280,
      fatG: 70,
      goal: "muscle_gain",
    },
    meals: [{
      id: "coach-breakfast",
      name: "Piano coach",
      time: "08:00",
      totalKcal: 500,
      gutoNote: "Piano sovrano del coach.",
      foods: [{ name: "Avena", quantity: "80g", kcal: 500 }],
    }],
  };
}

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.GUTO_TIME_ZONE || "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function defaultDietModelResponse() {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                meals: [
                  {
                    id: "breakfast",
                    name: "Colazione",
                    time: "08:00",
                    totalKcal: 700,
                    gutoNote: "Base pulita, niente lattosio.",
                    foods: [
                      { name: "Avena", quantity: "80g", kcal: 300 },
                      { name: "Banana", quantity: "1 unit", kcal: 120 },
                      { name: "Uova", quantity: "3 units", kcal: 220 },
                      { name: "Olio di oliva", quantity: "5g", kcal: 60 },
                    ],
                  },
                  {
                    id: "lunch",
                    name: "Pranzo",
                    time: "13:00",
                    totalKcal: 800,
                    gutoNote: "Carbo e proteina senza inventare.",
                    foods: [
                      { name: "Pollo", quantity: "200g", kcal: 330 },
                      { name: "Riso", quantity: "180g", kcal: 250 },
                      { name: "Verdure", quantity: "200g", kcal: 80 },
                      { name: "Olio di oliva", quantity: "15g", kcal: 140 },
                    ],
                  },
                  {
                    id: "snack",
                    name: "Spuntino",
                    time: "17:00",
                    totalKcal: 800,
                    gutoNote: "Energia prima del blocco serale.",
                    foods: [
                      { name: "Tonno", quantity: "160g", kcal: 260 },
                      { name: "Patata", quantity: "300g", kcal: 260 },
                      { name: "Pane integrale", quantity: "100g", kcal: 220 },
                      { name: "Frutto", quantity: "1 unit", kcal: 60 },
                    ],
                  },
                  {
                    id: "dinner",
                    name: "Cena",
                    time: "20:30",
                    totalKcal: 620,
                    gutoNote: "Chiude il giorno senza latticini.",
                    foods: [
                      { name: "Pesce", quantity: "200g", kcal: 300 },
                      { name: "Pasta", quantity: "100g", kcal: 180 },
                      { name: "Verdure", quantity: "200g", kcal: 80 },
                      { name: "Olio di oliva", quantity: "5g", kcal: 60 },
                    ],
                  },
                ],
              }),
            },
          ],
        },
      },
    ],
  };
}

let dietModelResponse = defaultDietModelResponse;

function dietModelResponseWithFoodInjected(foodName: string) {
  const response = defaultDietModelResponse();
  const part = response.candidates[0]?.content.parts[0];
  assert.ok(part);
  const parsed = JSON.parse(part.text) as {
    meals: Array<{ foods: Array<{ name: string; quantity: string; kcal: number }> }>;
  };
  // Mantém kcal do slot (300) — só troca o alimento por um staple fora da
  // localidade, para exercitar a validação/reparo de localidade sem mexer no
  // fechamento calórico do plano.
  parsed.meals[0].foods[0].name = foodName;
  parsed.meals[0].foods[0].quantity = "100g";
  part.text = JSON.stringify(parsed);
  return response;
}

// Staple brasileiro REPARÁVEL fora do Brasil (tem equivalente local seguro).
function dietModelResponseWithBrazilianStapleOutsideBrazil() {
  return dietModelResponseWithFoodInjected("Tapioca");
}

// Item GENUINAMENTE exótico, sem equivalente local de confiança → irrecuperável.
function dietModelResponseWithUnrepairableExoticOutsideBrazil() {
  return dietModelResponseWithFoodInjected("Cupuaçu");
}

// Modelo devolve um plano levemente fora da meta calórica (infla ~450 kcal num
// alimento). Sem reparo, isto bloqueava em "calorie_validation"; com o reparo
// determinístico, o backend escala e gera (200).
function dietModelResponseOffByCalories() {
  const response = defaultDietModelResponse();
  const part = response.candidates[0]?.content.parts[0];
  assert.ok(part);
  const parsed = JSON.parse(part.text) as {
    meals: Array<{ totalKcal: number; foods: Array<{ name: string; quantity: string; kcal: number }> }>;
  };
  parsed.meals[0].foods[0].kcal += 450;
  parsed.meals[0].totalKcal = parsed.meals[0].foods.reduce((s, f) => s + f.kcal, 0);
  part.text = JSON.stringify(parsed);
  return response;
}

function dietModelResponseWithoutGutoNotes() {
  const response = defaultDietModelResponse();
  const part = response.candidates[0]?.content.parts[0];
  assert.ok(part);
  const parsed = JSON.parse(part.text) as { meals: Array<{ gutoNote?: string }> };
  parsed.meals.forEach((meal) => {
    delete meal.gutoNote;
  });
  part.text = JSON.stringify(parsed);
  return response;
}

describe("diet generation contract", () => {
  before(async () => {
    // O resolver de campos livres também usa Gemini e é interceptado pelo mock
    // abaixo. Sem uma chave de teste ele encerra antes do fetch, e os testes de
    // concorrência sincronizam por engano com a geração da dieta já iniciada.
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-only-gemini-key";
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    process.env.GUTO_DIET_FILE = testDietFile;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    mkdirSync(tmpDir, { recursive: true });
    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("generativelanguage.googleapis.com")) {
        return originalFetch(input as any, init);
      }
      dietModelCalls += 1;
      if (dietModelDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, dietModelDelayMs));
      }
      return new Response(JSON.stringify(dietModelResponse()), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
    };
    const dietStoreModule = await import(pathToFileURL(join(process.cwd(), "src/diet-store.ts")).href) as any;
    saveDietPlanForTest = dietStoreModule.saveDietPlan;
    saveDietPlanIfUnchangedForTest = dietStoreModule.saveDietPlanIfUnchanged;
    getDietPlanConcurrencyTokenForTest = dietStoreModule.getDietPlanConcurrencyToken;
    const memoryStoreModule = await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href) as {
      setMemoryStoreRedisClientForTests: typeof setMemoryStoreRedisClientForTests;
    };
    setMemoryStoreRedisClientForTests = memoryStoreModule.setMemoryStoreRedisClientForTests;
    app = serverModule.app;
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind diet test server.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    setMemoryStoreRedisClientForTests(undefined);
    dietModelResponse = defaultDietModelResponse;
    dietModelCalls = 0;
    dietModelDelayMs = 0;
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
    rmSync(testDietFile, { force: true });
  });

  after(async () => {
    setMemoryStoreRedisClientForTests(undefined);
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(testMemoryFile, { force: true });
    rmSync(testDietFile, { force: true });
  });

  it("pacto de usuário zero persiste missão, treino e dieta antes de abrir abas", async () => {
    const userId = "post-pact-zero-state-user";
    writeMemory(userId, {
      name: "Rafael",
      language: "pt-BR",
      initialXpGranted: false,
      totalXp: 0,
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingStatus: "consistent",
      trainingGoal: "muscle_gain",
      trainingLocation: "gym",
      preferredTrainingLocation: "gym",
      trainingPathology: "sem dor",
      trainingLimitations: "sem dor",
      trainingSchedule: "today",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
        pathology: { rawValue: "sem dor", status: "clear", normalizedValue: "none" },
      },
      lastWorkoutPlan: undefined,
      weeklyWorkoutPlan: undefined,
      weeklyDietPlan: undefined,
      dietGenerationStatus: "idle",
      proactiveMemories: [],
      proactiveImpacts: [],
    });

    const pact = await originalFetch(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR", xpEvent: "grant_initial_xp" }),
    });
    const pactText = await pact.text();
    assert.equal(pact.status, 200, pactText);
    const pactBody = JSON.parse(pactText) as {
      initialXpGranted?: boolean;
      lastWorkoutPlan?: { exercises?: unknown[] };
      lastDietPlan?: { meals?: unknown[] };
      dietGenerationStatus?: string;
    };
    assert.equal(pactBody.initialXpGranted, true);
    assert.ok(pactBody.lastWorkoutPlan?.exercises?.length);
    assert.ok(pactBody.lastDietPlan?.meals?.length);
    assert.equal(pactBody.dietGenerationStatus, "generated");

    const persistedMemory = readMemory(userId);
    assert.ok(persistedMemory.lastWorkoutPlan?.exercises?.length);
    assert.equal(persistedMemory.dietGenerationStatus, "generated");
    const diet = await originalFetch(`${baseUrl}/guto/diet`, { headers: authHeaders(userId) });
    assert.equal(diet.status, 200);
    const dietBody = await diet.json() as { meals?: unknown[] };
    assert.ok(dietBody.meals?.length);
    assert.ok(dietModelCalls >= 1);
  });

  it("gera dieta a partir do intake validado e respeita lattosio", async () => {
    const userId = "diet-lattosio-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "Lattosio",
      resolvedFields: {
        foodRestriction: { rawValue: "Lattosio", status: "clear", normalizedValue: "lactose_intolerance" },
      },
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });

    assert.equal(res.status, 200);
    const plan = await res.json() as {
      meals: Array<{ totalKcal: number; foods: Array<{ name: string; kcal: number }> }>;
      foodRestrictions: string;
      macros: { targetKcal: number };
    };
    const foodText = JSON.stringify(plan.meals).toLowerCase();
    assert.doesNotMatch(foodText, /latte|yogurt|mozzarella|ricotta|parmigiano/);
    assert.equal(plan.foodRestrictions, "Lattosio");

    // BUG 1 (contrato que o frontend passa a confiar): o backend é a fonte de
    // verdade. O plano gerado deve respeitar ±80 kcal/dia e soma exata por
    // refeição — exatamente o que o sanitizeDietPlan do app agora aceita sem
    // re-rejeitar. Isto prova que dieta válida não cai mais em "checagem final".
    const dailyTotal = plan.meals.reduce((sum, meal) => sum + meal.totalKcal, 0);
    assert.ok(
      Math.abs(dailyTotal - plan.macros.targetKcal) <= 80,
      `total diário (${dailyTotal}) deve ficar a ±80 kcal da meta (${plan.macros.targetKcal})`
    );
    for (const meal of plan.meals) {
      const foodsKcal = meal.foods.reduce((sum, food) => sum + Math.round(food.kcal), 0);
      assert.equal(Math.round(meal.totalKcal), foodsKcal, "totalKcal da refeição deve bater com a soma dos alimentos");
    }

    const memory = readMemory(userId);
    assert.equal(memory.dietGenerationStatus, "generated");
    assert.ok(memory.memoryAudit.some((entry: any) => entry.source === "diet_generated"));

    const memoryRes = await originalFetch(`${baseUrl}/guto/memory`, {
      headers: authHeaders(userId),
    });
    assert.equal(memoryRes.status, 200);
    const memoryBody = await memoryRes.json() as { lastDietPlan?: { meals?: unknown[] } };
    assert.ok(memoryBody.lastDietPlan?.meals?.length, "GET /guto/memory deve expor o plano oficial como lastDietPlan");
  });

  it("serializa duas gerações concorrentes do mesmo usuário em uma única chamada ao modelo", async () => {
    const userId = "diet-single-flight-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });
    dietModelDelayMs = 120;

    const request = () => originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    const [first, second] = await Promise.all([request(), request()]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(dietModelCalls, 1, "a exclusão por usuário deve impedir duas chamadas Gemini");
    const [firstPlan, secondPlan] = await Promise.all([first.json(), second.json()]) as Array<{ generatedAt: string; meals: unknown[] }>;
    assert.equal(firstPlan.generatedAt, secondPlan.generatedAt);
    assert.ok(firstPlan.meals.length > 0);
    assert.equal(readMemory(userId).dietGenerationStatus, "generated");
  });

  it("gera dieta base mesmo com confirmação de viagem pendente", async () => {
    const userId = "diet-pending-trip-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
      proactiveMemories: [
        {
          id: "pm-diet-trip",
          userId,
          type: "trip",
          status: "pending_confirmation",
          stage: "impact_confirmation",
          rawText: "viajo terça; impossível treinar",
          understood: "Viagem terça; dia sem treino aguardando confirmação",
          dateParsed: "2026-06-23",
          weekKey: "2026-W26",
          createdAt: "2026-06-21T10:00:00.000Z",
          updatedAt: "2026-06-21T10:00:00.000Z",
        },
      ],
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });

    assert.equal(res.status, 200);
    const memory = readMemory(userId);
    assert.equal(memory.dietGenerationStatus, "generated");
    assert.equal(memory.proactiveMemories?.[0]?.stage, "impact_confirmation");
  });

  it("dieta confirmada usa o contexto da viagem no dia sem alterar alimentos ou macros", async () => {
    const userId = "diet-confirmed-trip-today";
    const day = todayKey();
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
      proactiveMemories: [{
        id: "pm-diet-trip-today",
        userId,
        type: "trip",
        status: "confirmed",
        stage: "confirmed_adapted",
        trainingAdapted: true,
        rawText: "viaggio oggi",
        understood: "Viaggio oggi",
        dateParsed: day,
        weekKey: "current",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString(),
      }],
      proactiveImpacts: [{
        id: "pi-diet-trip-today",
        memoryId: "pm-diet-trip-today",
        status: "active",
        surfaces: ["diet"],
        priority: 90,
        affectedDates: [day],
        workoutEffect: "short_light",
        missionEffect: "reduced",
        pushEffect: "avoid_blind_charge",
        xpEffect: "no_free_xp_context_only",
        arenaEffect: "validation_required",
        pathEffect: "adapted_context",
        evolutionEffect: "adapted_context",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        decision: {
          id: "decision-diet-trip-today",
          memoryId: "pm-diet-trip-today",
          kind: "adapt_day",
          reason: "travel",
          priority: 90,
          affectedDates: [day],
          workoutEffect: "short_light",
          missionEffect: "reduced",
          message: "Viaggio confermato.",
          createdAt: new Date().toISOString(),
        },
      }],
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    assert.equal(res.status, 200);
    const plan = await res.json() as {
      meals: Array<{ gutoNote: string; foods: Array<{ name: string; quantity: string; kcal: number }> }>;
      macros: { targetKcal: number };
    };
    assert.ok(plan.meals.every((meal) => /giorno di viaggio/i.test(meal.gutoNote)));
    assert.ok(plan.meals.every((meal) => meal.foods.length > 0));
    assert.ok(plan.macros.targetKcal > 0);
  });

  it("dieta em viagem não falha quando o cérebro omite gutoNote", async () => {
    const userId = "diet-trip-no-guto-note";
    const day = todayKey();
    dietModelResponse = dietModelResponseWithoutGutoNotes;
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
      proactiveImpacts: [{
        id: "pi-diet-trip-no-note",
        memoryId: "pm-diet-trip-no-note",
        status: "active",
        surfaces: ["diet"],
        priority: 90,
        affectedDates: [day],
        workoutEffect: "short_light",
        missionEffect: "reduced",
        pushEffect: "avoid_blind_charge",
        xpEffect: "no_free_xp_context_only",
        arenaEffect: "validation_required",
        pathEffect: "adapted_context",
        evolutionEffect: "adapted_context",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        decision: {
          id: "decision-diet-trip-no-note",
          memoryId: "pm-diet-trip-no-note",
          kind: "adapt_day",
          reason: "travel",
          priority: 90,
          affectedDates: [day],
          workoutEffect: "short_light",
          missionEffect: "reduced",
          message: "Viaggio confermato.",
          createdAt: new Date().toISOString(),
        },
      }],
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });

    assert.equal(res.status, 200);
    const plan = await res.json() as { meals: Array<{ gutoNote: string }> };
    assert.ok(plan.meals.every((meal) => /giorno di viaggio/i.test(meal.gutoNote)));
  });

  it("repara plano levemente fora da meta calórica em vez de bloquear", async () => {
    const userId = "diet-calorie-repair";
    dietModelResponse = dietModelResponseOffByCalories;
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });

    // NÃO pode bloquear por calorias — o backend repara e gera.
    assert.equal(res.status, 200);
    const plan = await res.json() as { meals: Array<{ totalKcal: number; foods: Array<{ kcal: number }> }>; macros: { targetKcal: number } };
    const dailyTotal = plan.meals.reduce((s, m) => s + m.totalKcal, 0);
    assert.ok(
      Math.abs(dailyTotal - plan.macros.targetKcal) <= 80,
      `após reparo, total (${dailyTotal}) deve fechar com ±80 da meta (${plan.macros.targetKcal})`
    );
    assert.equal(readMemory(userId).dietGenerationStatus, "generated");
  });

  it("gera dieta mesmo com patologia física ambígua: patologia NÃO bloqueia nem aparece na dieta", async () => {
    // Bug 3: limitação física (treino) estava contaminando a dieta. A dieta só
    // pode depender de perfil nutricional + restrição alimentar. Mesmo com uma
    // patologia incerta pendente, a dieta deve ser gerada normalmente.
    const userId = "diet-pathology-decoupled";
    writeMemory(userId, {
      language: "pt-BR",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Brasil",
      countryCode: "BR",
      city: "São Paulo",
      trainingPathology: "Gambia",
      trainingLimitations: "Gambia",
      foodRestrictions: "lactose",
      resolvedFields: {
        foodRestriction: { rawValue: "lactose", status: "clear", normalizedValue: "lactose_intolerance" },
        pathology: { rawValue: "Gambia", status: "needs_confirmation" },
      },
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { meals?: unknown[]; code?: string; message?: string };
    // Nunca pode retornar o código/mensagem de patologia na dieta.
    assert.notEqual(body.code, "TRAINING_PATHOLOGY_NEEDS_CLARIFICATION");
    assert.equal(body.message, undefined);
    assert.ok(Array.isArray(body.meals) && body.meals.length > 0);
    // Não pode vazar lactose (restrição alimentar real).
    const foodText = JSON.stringify(body.meals).toLowerCase();
    assert.doesNotMatch(foodText, /latte|yogurt|mozzarella|ricotta|parmigiano|leite|queijo/);
    // Não pode aparecer texto de treino/patologia/limitação dentro da dieta.
    const wholeBody = JSON.stringify(body).toLowerCase();
    assert.doesNotMatch(wholeBody, /gambia|patolog|limita(c|ç|z)|limitation|joelho|dor\b/);

    const memory = readMemory(userId);
    assert.equal(memory.dietGenerationStatus, "generated");
  });

  it("recusa gerar sem countryCode e peso (422) com mensagem em en-US", async () => {
    const userId = "diet-missing-profile-en";
    writeMemory(userId, {
      biologicalSex: "female",
      userAge: 28,
      heightCm: 165,
      trainingLevel: "beginner",
      trainingGoal: "fat_loss",
      country: "Brazil",
      // countryCode, weightKg missing
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "en-US" }),
    });

    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: string; missing: string[]; message: string };
    assert.equal(body.error, "missing_profile_fields");
    assert.ok(body.missing.includes("countryCode"));
    assert.ok(body.missing.includes("weightKg"));
    assert.match(body.message, /calibration/i);
  });

  it("recusa gerar sem perfil completo em pt-BR", async () => {
    const userId = "diet-missing-profile-pt";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 30,
      weightKg: 80,
      heightCm: 180,
      trainingGoal: "muscle_gain",
      countryCode: "BR",
      country: "Brasil",
      // trainingLevel missing
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 422);
    const body = (await res.json()) as { message: string };
    assert.match(body.message, /calibragem|montar tua dieta/i);
  });

  it("gera dieta com perfil completo mesmo sem missão persistida", async () => {
    const userId = "diet-independent-from-mission-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
      lastWorkoutPlan: undefined,
      weeklyWorkoutPlan: undefined,
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { meals?: unknown[] };
    assert.ok(body.meals?.length);
    assert.equal(dietModelCalls, 1);
    assert.equal(existsSync(testDietFile), true);
  });

  it("REPARA comida brasileira fora da localidade (tapioca na Itália) e gera 200 em vez de bloquear", async () => {
    // Regressão do bug reportado: "Bloqueei essa dieta porque ela usou alimento
    // que não bate com onde você mora". O comportamento correto agora é REPARAR
    // (substituir por equivalente local seguro) e devolver plano 200.
    const userId = "diet-italy-portuguese-tapioca-repair";
    dietModelResponse = dietModelResponseWithBrazilianStapleOutsideBrazil;
    writeMemory(userId, {
      language: "pt-BR",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 200);
    const plan = (await res.json()) as {
      meals: Array<{ totalKcal: number; foods: Array<{ name: string; kcal: number }> }>;
      macros: { targetKcal: number };
    };
    const foodText = JSON.stringify(plan.meals).toLowerCase();
    // O staple fora da localidade foi removido e trocado por equivalente local.
    assert.doesNotMatch(foodText, /tapioca|açaí|acai|farofa|cupua|queijo coalho|farinha de mandioca/);
    assert.match(foodText, /batata|arroz/);
    // Macros/calorias seguem dentro da margem aceita após o reparo.
    const dailyTotal = plan.meals.reduce((sum, meal) => sum + meal.totalKcal, 0);
    assert.ok(
      Math.abs(dailyTotal - plan.macros.targetKcal) <= 80,
      `após reparo de localidade, total (${dailyTotal}) deve fechar com ±80 da meta (${plan.macros.targetKcal})`
    );
    const memory = readMemory(userId);
    assert.equal(memory.dietGenerationStatus, "generated");
  });

  it("REPARA staple fora da localidade respeitando lactose: troca local sem introduzir laticínio", async () => {
    const userId = "diet-italy-lactose-tapioca-repair";
    dietModelResponse = dietModelResponseWithBrazilianStapleOutsideBrazil;
    writeMemory(userId, {
      language: "pt-BR",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "Lattosio",
      resolvedFields: {
        foodRestriction: { rawValue: "Lattosio", status: "clear", normalizedValue: "lactose_intolerance" },
      },
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 200);
    const plan = (await res.json()) as { meals: unknown[] };
    const foodText = JSON.stringify(plan.meals).toLowerCase();
    assert.doesNotMatch(foodText, /tapioca/);
    // O reparo não pode introduzir laticínio para quem tem lactose.
    assert.doesNotMatch(foodText, /latte|yogurt|mozzarella|ricotta|parmigiano|leite|queijo/);
    assert.equal(readMemory(userId).dietGenerationStatus, "generated");
  });

  it("regenerar não repete erro por estado/cache: dois generate seguidos retornam 200 (staple reparável)", async () => {
    const userId = "diet-regenerate-no-stale";
    dietModelResponse = dietModelResponseWithBrazilianStapleOutsideBrazil;
    writeMemory(userId, {
      language: "pt-BR",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });

    const first = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });
    assert.equal(first.status, 200);

    const second = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });
    assert.equal(second.status, 200, "regenerar deve voltar 200, não ficar preso no erro anterior");
    assert.equal(readMemory(userId).dietGenerationStatus, "generated");
  });

  it("bloqueia (último recurso) só quando o item é genuinamente exótico e irreparável (cupuaçu)", async () => {
    const userId = "diet-italy-unrepairable-exotic";
    dietModelResponse = dietModelResponseWithUnrepairableExoticOutsideBrazil;
    writeMemory(userId, {
      language: "pt-BR",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 500);
    const body = (await res.json()) as { reason?: string; issues?: string[]; message?: string };
    assert.equal(body.reason, "location");
    assert.ok(body.issues?.some((issue) => issue.includes("cupua")));
    assert.match(body.message || "", /onde você mora|local/i);
    assert.equal(readMemory(userId).dietGenerationStatus, "failed");
  });

  it("recusa peixe quando NÃO COMO declara peixe ou frutos do mar", async () => {
    const userId = "diet-no-fish-user";
    writeMemory(userId, {
      language: "pt-BR",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "não como peixe",
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string; reason?: string; issues?: string[]; message?: string };
    assert.equal(body.error, "diet_generation_failed");
    assert.equal(body.reason, "food_restriction");
    assert.ok(body.issues?.some((issue) => issue.includes("seafood/fish")));
    assert.match(body.message || "", /não come|do not eat/i);
    const memory = readMemory(userId);
    assert.equal(memory.dietGenerationStatus, "failed");
  });

  it("recusa ovo quando NÃO COMO declara ovo", async () => {
    const userId = "diet-no-egg-user";
    writeMemory(userId, {
      language: "pt-BR",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "não como ovo",
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string; reason?: string; issues?: string[]; message?: string };
    assert.equal(body.error, "diet_generation_failed");
    assert.equal(body.reason, "food_restriction");
    assert.ok(body.issues?.some((issue) => issue.includes("egg")));
    assert.match(body.message || "", /não come|do not eat/i);
    const memory = readMemory(userId);
    assert.equal(memory.dietGenerationStatus, "failed");
  });

  it("GET /guto/diet devolve plano após generate", async () => {
    const userId = "diet-get-after-generate";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });

    const generate = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    assert.equal(generate.status, 200);

    const getRes = await originalFetch(`${baseUrl}/guto/diet`, {
      method: "GET",
      headers: authHeaders(userId),
    });
    assert.equal(getRes.status, 200);
    const plan = (await getRes.json()) as { meals: unknown[] };
    assert.ok(Array.isArray(plan.meals) && plan.meals.length > 0);
  });

  it("memória pública não expõe dieta cacheada quando a memória persistida está indisponível", async () => {
    const userId = "diet-memory-read-fail-closed-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });

    const generate = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    assert.equal(generate.status, 200);

    setMemoryStoreRedisClientForTests({
      get: async () => {
        throw new Error("redis memory unavailable");
      },
      set: async () => "OK",
      eval: async () => 1,
    });
    try {
      const memoryResponse = await originalFetch(`${baseUrl}/guto/memory`, {
        headers: authHeaders(userId),
      });
      assert.equal(memoryResponse.status, 200);
      const body = await memoryResponse.json() as { lastDietPlan?: unknown };
      assert.equal(body.lastDietPlan, undefined);
    } finally {
      setMemoryStoreRedisClientForTests(undefined);
    }
  });

  it("resolver de restrição não restaura perfil stale antes de criar o guard", async () => {
    const userId = "diet-resolver-profile-race-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "Lattosio",
      resolvedFields: undefined,
    });
    dietModelDelayMs = 180;

    const generation = originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    await waitUntil(() => dietModelCalls >= 1);

    const concurrentProfile = readMemory(userId);
    writeMemory(userId, { ...concurrentProfile, weightKg: 91 });

    const response = await generation;
    assert.equal(response.status, 200);
    assert.equal(readMemory(userId).weightKg, 91, "o resolver não pode restaurar o peso do snapshot anterior");
    assert.ok(dietModelCalls >= 2, "o teste deve atravessar o resolver e a geração da dieta");
  });

  it("cancela a dieta se o perfil muda durante a geração e preserva o perfil novo", async () => {
    const userId = "diet-profile-race-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "none",
      dietGenerationStatus: "ready_to_generate",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });
    const normalizeProfile = await originalFetch(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    assert.equal(normalizeProfile.status, 200);
    dietModelDelayMs = 180;

    const generation = originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    await waitUntil(() => dietModelCalls >= 1);

    const profileUpdate = await originalFetch(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT", weightKg: 91 }),
    });
    assert.equal(profileUpdate.status, 200);

    const response = await generation;
    assert.equal(response.status, 409);
    const body = await response.json() as { code?: string };
    assert.equal(body.code, "DIET_CONTEXT_CHANGED");
    const memory = readMemory(userId);
    assert.equal(memory.weightKg, 91, "o commit terminal não pode restaurar o peso antigo");
    assert.notEqual(memory.dietGenerationStatus, "generated");

    const dietResponse = await originalFetch(`${baseUrl}/guto/diet`, {
      headers: authHeaders(userId),
    });
    assert.equal(dietResponse.status, 404);
    const memoryResponse = await originalFetch(`${baseUrl}/guto/memory`, {
      headers: authHeaders(userId),
    });
    const publicMemory = await memoryResponse.json() as { lastDietPlan?: unknown };
    assert.equal(publicMemory.lastDietPlan, undefined);
  });

  it("cancela a dieta se o idioma muda durante a geração", async () => {
    const userId = "diet-language-race-user";
    writeMemory(userId, {
      language: "it-IT",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "none",
      dietGenerationStatus: "ready_to_generate",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });
    dietModelDelayMs = 180;

    const generation = originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    await waitUntil(() => dietModelCalls >= 1);

    const languageUpdate = await originalFetch(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "en-US" }),
    });
    assert.equal(languageUpdate.status, 200);

    const response = await generation;
    assert.equal(response.status, 409);
    const body = await response.json() as { code?: string };
    assert.equal(body.code, "DIET_CONTEXT_CHANGED");
    const memory = readMemory(userId);
    assert.equal(memory.language, "en-US");
    assert.notEqual(memory.dietGenerationStatus, "generated");
    const persisted = existsSync(testDietFile)
      ? JSON.parse(readFileSync(testDietFile, "utf8")) as Record<string, unknown>
      : {};
    assert.equal(persisted[userId], undefined);
  });

  it("mantém geração de dieta quando o treino é invalidado em paralelo", async () => {
    const userId = "diet-workout-independent-race-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingStatus: "consistent",
      trainingGoal: "muscle_gain",
      trainingPathology: "sem dor",
      trainingLimitations: "sem dor",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      dietGenerationStatus: "ready_to_generate",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });
    const normalizeProfile = await originalFetch(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    assert.equal(normalizeProfile.status, 200);
    dietModelDelayMs = 180;

    const generation = originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    await waitUntil(() => dietModelCalls >= 1);

    const profileUpdate = await originalFetch(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({
        language: "it-IT",
        trainingPathology: "dolore al ginocchio destro",
        trainingLimitations: "dolore al ginocchio destro",
      }),
    });
    assert.equal(profileUpdate.status, 200);

    const response = await generation;
    assert.equal(response.status, 200);
    const body = await response.json() as { meals?: unknown[] };
    assert.ok(body.meals?.length);
    const memory = readMemory(userId);
    assert.equal(memory.lastWorkoutPlan, null);
    assert.equal(memory.dietGenerationStatus, "generated");
    const getResponse = await originalFetch(`${baseUrl}/guto/diet`, {
      headers: authHeaders(userId),
    });
    assert.equal(getResponse.status, 200);
  });

  it("preserva plano bloqueado pelo coach se o lock chega durante a geração", async () => {
    const userId = "diet-coach-lock-race-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      dietGenerationStatus: "ready_to_generate",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });
    dietModelDelayMs = 180;

    const generation = originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    await waitUntil(() => dietModelCalls >= 1);
    const coachPlan = makeCoachDietPlan(userId);
    await saveDietPlanForTest(coachPlan);

    const response = await generation;
    assert.equal(response.status, 409);
    const body = await response.json() as { code?: string };
    assert.equal(body.code, "COACH_LOCKED_PLAN");
    const persisted = JSON.parse(readFileSync(testDietFile, "utf8")) as Record<string, any>;
    assert.equal(persisted[userId]?.lockedByCoach, true);
    assert.equal(persisted[userId]?.source, "coach_manual");
    assert.equal(readMemory(userId).dietGenerationStatus, "generated");

    const getResponse = await originalFetch(`${baseUrl}/guto/diet`, {
      headers: authHeaders(userId),
    });
    assert.equal(getResponse.status, 200);
    const visible = await getResponse.json() as { source?: string; lockedByCoach?: boolean };
    assert.equal(visible.source, "coach_manual");
    assert.equal(visible.lockedByCoach, true);
  });

  it("preserva plano coach_manual sem depender de flags redundantes", async () => {
    const userId = "diet-coach-source-only-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      dietGenerationStatus: "generated",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });
    const coachPlan = makeCoachDietPlan(userId) as Record<string, any>;
    delete coachPlan.planSource;
    delete coachPlan.manualOverride;
    delete coachPlan.lockedByCoach;
    await saveDietPlanForTest(coachPlan);

    const response = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { source?: string; meals?: Array<{ name?: string }> };
    assert.equal(body.source, "coach_manual");
    assert.equal(body.meals?.[0]?.name, "Piano coach");
    assert.equal(dietModelCalls, 0);
    const persisted = JSON.parse(readFileSync(testDietFile, "utf8")) as Record<string, any>;
    assert.equal(persisted[userId]?.source, "coach_manual");
    assert.equal(persisted[userId]?.meals?.[0]?.name, "Piano coach");
  });

  it("não expõe plano IA legado sem fingerprint no GET dieta nem na memória", async () => {
    const userId = "diet-legacy-no-fingerprint-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      dietGenerationStatus: "generated",
    });
    const legacyPlan = {
      ...makeCoachDietPlan(userId),
      source: "guto_generated",
      planSource: "ai_generated",
      manualOverride: false,
      lockedByCoach: false,
      profileFingerprint: undefined,
    };
    await saveDietPlanForTest(legacyPlan);

    const getResponse = await originalFetch(`${baseUrl}/guto/diet`, {
      headers: authHeaders(userId),
    });
    assert.equal(getResponse.status, 404);
    const memoryResponse = await originalFetch(`${baseUrl}/guto/memory`, {
      headers: authHeaders(userId),
    });
    const memoryBody = await memoryResponse.json() as { lastDietPlan?: unknown; dietGenerationStatus?: string };
    assert.equal(memoryBody.lastDietPlan, undefined);
    assert.equal(memoryBody.dietGenerationStatus, "ready_to_generate");
  });

  it("CAS não ressuscita plano removido quando o cache local ainda o contém", async () => {
    const userId = "diet-cache-delete-cas-user";
    const current = {
      ...makeCoachDietPlan(userId),
      source: "guto_generated",
      planSource: "ai_generated",
      manualOverride: false,
      lockedByCoach: false,
      profileFingerprint: "old-profile",
    };
    await saveDietPlanForTest(current);
    const token = getDietPlanConcurrencyTokenForTest(current);
    writeFileSync(testDietFile, JSON.stringify({}, null, 2));

    await assert.rejects(
      saveDietPlanIfUnchangedForTest({ ...current, generatedAt: new Date().toISOString() }, token),
      (error: any) => error?.code === "DIET_PLAN_CHANGED_DURING_GENERATION"
    );
    const persisted = JSON.parse(readFileSync(testDietFile, "utf8")) as Record<string, unknown>;
    assert.equal(persisted[userId], undefined);
  });

  it("conditional save rejeita store local ilegível em vez de confirmar plano", async () => {
    const userId = "diet-corrupt-store-cas-user";
    writeFileSync(testDietFile, "{not-json");
    await assert.rejects(
      saveDietPlanIfUnchangedForTest(makeCoachDietPlan(userId), "none"),
      /could not be read/i
    );
    assert.equal(readFileSync(testDietFile, "utf8"), "{not-json");
  });
});

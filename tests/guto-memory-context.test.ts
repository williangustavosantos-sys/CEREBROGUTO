import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

// Fase 3K — Camada VISÍVEL de memória/contexto. O frontend renderiza badges de
// "cuidados do treino" (patologia/limitação) e "perfil usado na dieta"
// (objetivo/país/NÃO COMO). Este teste TRAVA o contrato do GET /guto/memory:
//   1) os campos necessários para os badges chegam ao app;
//   2) patologia/limitação física e restrição alimentar (NÃO COMO) ficam em
//      campos SEPARADOS — nunca uma contaminando a outra;
//   3) resolvedFields (classificação semântica) sobrevive ao reload.

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.context-test.json");

type BackendModule = {
  app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
};

let backend: BackendModule;
let clearMemoryStoreCache: () => void;
let server: Server;
let baseUrl = "";

function readStore(): Record<string, any> {
  if (!existsSync(testMemoryFile)) return {};
  return JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>;
}

function readMemory(userId: string): Record<string, any> {
  return readStore()[userId] || {};
}

function writeRawMemory(userId: string, data: Record<string, any>) {
  const store = readStore();
  store[userId] = {
    userId,
    name: "Will",
    language: "pt-BR",
    initialXpGranted: false,
    totalXp: 0,
    streak: 0,
    trainedToday: false,
    adaptedMissionToday: false,
    lastActiveAt: new Date().toISOString(),
    completedWorkoutDates: [],
    adaptedMissionDates: [],
    missedMissionDates: [],
    xpEvents: [],
    lastWorkoutPlan: null,
    weeklyWorkoutPlan: null,
    weeklyDietPlan: null,
    dietGenerationStatus: "idle",
    recentTrainingHistory: [],
    workoutFeedbackHistory: [],
    proactiveSent: {},
    initialXpRewardSeen: false,
    memoryAudit: [],
    ...data,
  };
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2));
  clearMemoryStoreCache?.();
}

function authHeaders(userId: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function getMemoryHttp(userId: string) {
  return fetch(`${baseUrl}/guto/memory`, { method: "GET", headers: authHeaders(userId) });
}

describe("GET /guto/memory — contrato dos badges de contexto (Fase 3K)", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
    process.env.GEMINI_API_KEY = "";
    process.env.UPSTASH_REDIS_REST_URL = "";
    process.env.UPSTASH_REDIS_REST_TOKEN = "";
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));

    backend = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as BackendModule;
    const memoryStore = (await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as {
      clearMemoryStoreCache: () => void;
    };
    clearMemoryStoreCache = memoryStore.clearMemoryStoreCache;

    await new Promise<void>((resolve, reject) => {
      server = backend.app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind memory-context test server.");
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

  it("devolve os campos que os badges de treino e dieta precisam exibir", async () => {
    const userId = "memory-context-fields";
    writeRawMemory(userId, {
      trainingPathology: "dor no joelho direito",
      trainingLimitations: "dor no joelho direito",
      foodRestrictions: "vegetariano, sem lactose",
      country: "Itália",
      countryCode: "IT",
      city: "Roma",
      trainingGoal: "fat_loss",
      trainingLevel: "consistent",
      preferredTrainingLocation: "gym",
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      resolvedFields: {
        pathology: {
          field: "pathology",
          rawValue: "dor no joelho direito",
          rawValueHash: "abc",
          bodyRegion: "knee",
          riskTags: ["knee_sensitive"],
          confidence: 0.9,
          status: "clear",
          resolvedAt: new Date().toISOString(),
        },
        foodRestriction: {
          field: "foodRestriction",
          rawValue: "vegetariano, sem lactose",
          rawValueHash: "def",
          normalizedValue: "vegetarian",
          riskTags: [],
          confidence: 0.9,
          status: "clear",
          resolvedAt: new Date().toISOString(),
        },
      },
    });

    const res = await getMemoryHttp(userId);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;

    // Treino
    assert.match(body.trainingPathology || "", /joelho/i);
    assert.match(body.trainingLimitations || "", /joelho/i);
    assert.equal(body.resolvedFields?.pathology?.bodyRegion, "knee");
    assert.equal(body.resolvedFields?.pathology?.status, "clear");
    // Dieta
    assert.match(body.foodRestrictions || "", /vegetariano/i);
    assert.match(body.foodRestrictions || "", /lactose/i);
    assert.equal(body.country, "Itália");
    assert.equal(body.city, "Roma");
    assert.equal(body.trainingGoal, "fat_loss");
    assert.ok(body.resolvedFields?.foodRestriction);
  });

  it("mantém patologia e restrição alimentar em campos SEPARADOS (uma nunca contamina a outra)", async () => {
    const userId = "memory-context-separation";
    writeRawMemory(userId, {
      trainingPathology: "dor no joelho",
      trainingLimitations: "dor no joelho",
      foodRestrictions: "vegetariano, sem lactose",
      country: "Itália",
      countryCode: "IT",
      trainingGoal: "muscle_gain",
    });

    const res = await getMemoryHttp(userId);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;

    // Restrição alimentar não pode carregar dor/joelho (patologia).
    assert.doesNotMatch(body.foodRestrictions || "", /joelho|\bdor\b/i);
    // Patologia/limitação não pode carregar restrição alimentar.
    assert.doesNotMatch(body.trainingPathology || "", /vegetarian|lactose|gluten/i);
    assert.doesNotMatch(body.trainingLimitations || "", /vegetarian|lactose|gluten/i);
    // E ambos os campos seguem existindo, cada um no seu lugar.
    assert.match(body.trainingPathology || "", /joelho/i);
    assert.match(body.foodRestrictions || "", /vegetariano/i);
  });

  it("vegetariano + sem lactose ficam em foodRestrictions, não viram patologia", async () => {
    const userId = "memory-context-veg-not-pathology";
    writeRawMemory(userId, {
      foodRestrictions: "vegetariano e sem lactose",
      country: "Brasil",
      countryCode: "BR",
      trainingGoal: "fat_loss",
      // sem patologia
    });

    const res = await getMemoryHttp(userId);
    const body = (await res.json()) as Record<string, any>;
    assert.match(body.foodRestrictions || "", /vegetariano/i);
    assert.ok(!body.trainingPathology, "não pode inventar patologia a partir de restrição alimentar");
    assert.ok(!body.trainingLimitations, "não pode inventar limitação a partir de restrição alimentar");
  });

  it("dor no joelho fica em patologia/limitação, nunca em foodRestrictions", async () => {
    const userId = "memory-context-knee-not-food";
    writeRawMemory(userId, {
      trainingPathology: "dor no joelho ao agachar",
      trainingLimitations: "dor no joelho ao agachar",
      country: "Brasil",
      countryCode: "BR",
      trainingGoal: "muscle_gain",
      // sem foodRestrictions
    });

    const res = await getMemoryHttp(userId);
    const body = (await res.json()) as Record<string, any>;
    assert.match(body.trainingPathology || "", /joelho/i);
    assert.ok(
      !body.foodRestrictions || !/joelho|\bdor\b/i.test(body.foodRestrictions),
      "dor no joelho não pode virar restrição alimentar"
    );
  });

  it("resolvedFields persiste e chega no GET /guto/memory mesmo após reload do store", async () => {
    const userId = "memory-context-resolved-persist";
    writeRawMemory(userId, {
      trainingPathology: "joelho sensível",
      trainingLimitations: "joelho sensível",
      resolvedFields: {
        pathology: {
          field: "pathology",
          rawValue: "joelho sensível",
          rawValueHash: "h1",
          bodyRegion: "knee",
          riskTags: ["knee_sensitive"],
          confidence: 0.95,
          status: "clear",
          resolvedAt: new Date().toISOString(),
        },
      },
    });

    const first = await getMemoryHttp(userId);
    const firstBody = (await first.json()) as Record<string, any>;
    assert.equal(firstBody.resolvedFields?.pathology?.bodyRegion, "knee");

    // Força releitura do store (simula novo request/instância) e confirma persistência.
    clearMemoryStoreCache();
    const second = await getMemoryHttp(userId);
    const secondBody = (await second.json()) as Record<string, any>;
    assert.equal(secondBody.resolvedFields?.pathology?.status, "clear");
    assert.equal(secondBody.resolvedFields?.pathology?.bodyRegion, "knee");
    assert.equal(readMemory(userId).resolvedFields?.pathology?.bodyRegion, "knee");
  });
});

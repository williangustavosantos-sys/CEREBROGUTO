import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import type { DietPlan } from "../src/nutrition.js";

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.diet-invalidation-test.json");
const testDietFile = join(tmpDir, "guto-diet.invalidation-test.json");

type BackendModule = {
  app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  getMemory: (userId: string) => any;
  saveMemory: (memory: any) => void;
  applyMemoryPatch: (memory: any, patch?: any) => Promise<any>;
};

let backend: BackendModule;
let saveDietPlan: (plan: DietPlan) => Promise<void>;
let getDietPlan: (userId: string) => Promise<DietPlan | null>;
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

function writeMemory(userId: string, data: Record<string, any>) {
  const store = readStore();
  store[userId] = {
    userId,
    name: "Will",
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
    dietGenerationStatus: "generated",
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

async function postMemory(userId: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/guto/memory`, {
    method: "POST",
    headers: authHeaders(userId),
    body: JSON.stringify(body),
  });
}

function makeDietPlan(userId: string, lockedByCoach = false): DietPlan {
  return {
    userId,
    source: "guto_generated",
    lockedByCoach,
    generatedAt: new Date().toISOString(),
    country: "Italia",
    macros: {
      bmr: 1700,
      tdee: 2550,
      targetKcal: 2825,
      proteinG: 156,
      carbsG: 340,
      fatG: 84,
      goal: "muscle_gain",
    },
    meals: [],
  };
}

function hasProfileSyncAudit(memory: Record<string, any>, field: string) {
  return Boolean(
    memory.memoryAudit?.some(
      (entry: any) =>
        entry?.source === "profile_sync" &&
        Array.isArray(entry.fields) &&
        entry.fields.includes(field)
    )
  );
}

describe("diet invalidation when calibration changes", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    process.env.GUTO_DIET_FILE = testDietFile;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
    process.env.GEMINI_API_KEY = "";
    process.env.UPSTASH_REDIS_REST_URL = "";
    process.env.UPSTASH_REDIS_REST_TOKEN = "";
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
    rmSync(testDietFile, { force: true });

    backend = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as BackendModule;
    const dietStore = (await import(pathToFileURL(join(process.cwd(), "src/diet-store.ts")).href)) as {
      saveDietPlan: (plan: DietPlan) => Promise<void>;
      getDietPlan: (userId: string) => Promise<DietPlan | null>;
    };
    const memoryStore = (await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as {
      clearMemoryStoreCache: () => void;
    };
    saveDietPlan = dietStore.saveDietPlan;
    getDietPlan = dietStore.getDietPlan;
    clearMemoryStoreCache = memoryStore.clearMemoryStoreCache;

    await new Promise<void>((resolve, reject) => {
      server = backend.app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind diet invalidation test server.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    clearMemoryStoreCache();
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
    rmSync(testDietFile, { force: true });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(testMemoryFile, { force: true });
    rmSync(testDietFile, { force: true });
  });

  it("marca a dieta para revisão quando o peso muda via /guto/memory", async () => {
    const userId = "diet-invalidation-weight";
    writeMemory(userId, { weightKg: 82, dietGenerationStatus: "generated" });

    const res = await postMemory(userId, { weightKg: 84 });

    assert.equal(res.status, 200);
    const memory = readMemory(userId);
    assert.equal(memory.weightKg, 84);
    assert.equal(memory.dietGenerationStatus, "needs_clarification");
    assert.equal(hasProfileSyncAudit(memory, "weightKg"), true);
    assert.equal(hasProfileSyncAudit(memory, "dietGenerationStatus"), true);
  });

  it("marca a dieta para revisão quando o NÃO COMO muda via /guto/memory", async () => {
    const userId = "diet-invalidation-food";
    writeMemory(userId, { foodRestrictions: "", dietGenerationStatus: "generated" });

    const res = await postMemory(userId, { foodRestrictions: "sem lactose" });

    assert.equal(res.status, 200);
    const memory = readMemory(userId);
    assert.equal(memory.foodRestrictions, "sem lactose");
    assert.equal(memory.dietGenerationStatus, "needs_clarification");
    assert.equal(hasProfileSyncAudit(memory, "foodRestrictions"), true);
  });

  it("marca a dieta para revisão quando o país técnico muda via countryCode", async () => {
    const userId = "diet-invalidation-country-code";
    writeMemory(userId, { country: "Italia", countryCode: "IT", dietGenerationStatus: "generated" });

    const res = await postMemory(userId, { countryCode: "BR" });

    assert.equal(res.status, 200);
    const memory = readMemory(userId);
    assert.equal(memory.countryCode, "BR");
    assert.equal(memory.dietGenerationStatus, "needs_clarification");
    assert.equal(hasProfileSyncAudit(memory, "countryCode"), true);
  });

  it("limpa countryCode antigo quando país muda sem novo código técnico via /guto/memory", async () => {
    const userId = "diet-invalidation-country-clears-code";
    writeMemory(userId, { country: "Brasil", countryCode: "BR", dietGenerationStatus: "generated" });

    const res = await postMemory(userId, { country: "Italia" });

    assert.equal(res.status, 200);
    const memory = readMemory(userId);
    assert.equal(memory.country, "Italia");
    assert.equal(memory.countryCode, undefined);
    assert.equal(memory.dietGenerationStatus, "needs_clarification");
    assert.equal(hasProfileSyncAudit(memory, "country"), true);
    assert.equal(hasProfileSyncAudit(memory, "countryCode"), true);
  });

  it("não invalida dieta quando muda campo fora da lista nutricional", async () => {
    const userId = "diet-invalidation-name";
    writeMemory(userId, { name: "Will", language: "pt-BR", dietGenerationStatus: "generated" });

    const res = await postMemory(userId, { name: "William", language: "it-IT" });

    assert.equal(res.status, 200);
    const memory = readMemory(userId);
    assert.equal(memory.name, "William");
    assert.equal(memory.language, "it-IT");
    assert.equal(memory.dietGenerationStatus, "generated");
    assert.equal(hasProfileSyncAudit(memory, "dietGenerationStatus"), false);
  });

  it("preserva dieta travada pelo coach e só registra auditoria", async () => {
    const userId = "diet-invalidation-locked";
    writeMemory(userId, { weightKg: 82, dietGenerationStatus: "generated" });
    await saveDietPlan(makeDietPlan(userId, true));

    const res = await postMemory(userId, { weightKg: 86 });

    assert.equal(res.status, 200);
    const memory = readMemory(userId);
    const diet = await getDietPlan(userId);
    assert.equal(memory.weightKg, 86);
    assert.equal(memory.dietGenerationStatus, "generated");
    assert.equal(diet?.lockedByCoach, true);
    assert.equal(hasProfileSyncAudit(memory, "weightKg"), true);
    assert.equal(hasProfileSyncAudit(memory, "dietGenerationStatus"), false);
  });

  it("GET /guto/diet regenera (404) quando o idioma do plano difere do idioma do usuário", async () => {
    const userId = "diet-language-mismatch";
    writeMemory(userId, { language: "it-IT", dietGenerationStatus: "generated" });
    await saveDietPlan({ ...makeDietPlan(userId), language: "pt-BR" });

    const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
    const res = await fetch(`${baseUrl}/guto/diet`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 404);
    assert.equal(body.error, "diet_language_mismatch");
  });

  it("GET /guto/diet serve normalmente quando o idioma do plano bate com o usuário", async () => {
    const userId = "diet-language-match";
    writeMemory(userId, { language: "it-IT", dietGenerationStatus: "generated" });
    await saveDietPlan({ ...makeDietPlan(userId), language: "it-IT" });

    const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
    const res = await fetch(`${baseUrl}/guto/diet`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });

  it("GET /guto/diet não invalida plano travado pelo coach por idioma", async () => {
    const userId = "diet-language-coach-locked";
    writeMemory(userId, { language: "it-IT", dietGenerationStatus: "generated" });
    await saveDietPlan({ ...makeDietPlan(userId, true), language: "pt-BR" });

    const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
    const res = await fetch(`${baseUrl}/guto/diet`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });

  it("também invalida quando a mudança vem do memoryPatch do chat", async () => {
    const userId = "diet-invalidation-chat-patch";
    writeMemory(userId, { weightKg: 82, dietGenerationStatus: "generated" });
    const memory = backend.getMemory(userId);

    await backend.applyMemoryPatch(memory, { weightKg: 83 });
    backend.saveMemory(memory);

    const saved = readMemory(userId);
    assert.equal(saved.weightKg, 83);
    assert.equal(saved.dietGenerationStatus, "needs_clarification");
    assert.equal(hasProfileSyncAudit(saved, "weightKg"), true);
  });

  it("limpa countryCode antigo quando país muda sem novo código técnico pelo chat", async () => {
    const userId = "diet-invalidation-chat-country-clears-code";
    writeMemory(userId, { country: "Brasil", countryCode: "BR", dietGenerationStatus: "generated" });
    const memory = backend.getMemory(userId);

    await backend.applyMemoryPatch(memory, { country: "Italia" });

    const saved = readMemory(userId);
    assert.equal(saved.country, "Italia");
    assert.equal(saved.countryCode, undefined);
    assert.equal(saved.dietGenerationStatus, "needs_clarification");
    assert.equal(hasProfileSyncAudit(saved, "country"), true);
    assert.equal(hasProfileSyncAudit(saved, "countryCode"), true);
  });
});

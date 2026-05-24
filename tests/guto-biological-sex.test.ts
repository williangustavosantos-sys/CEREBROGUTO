import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.biological-sex-test.json");

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

describe("GutoMemory calibration validation", () => {
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
    if (!address || typeof address === "string") throw new Error("Failed to bind biologicalSex test server.");
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

  it("nao devolve biologicalSex legado indefinido", async () => {
    const userId = "biosex-legacy-invalid";
    writeRawMemory(userId, { biologicalSex: "prefer_not_to_say" });

    const res = await fetch(`${baseUrl}/guto/memory`, {
      method: "GET",
      headers: authHeaders(userId),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(Object.prototype.hasOwnProperty.call(body, "biologicalSex"), false);
  });

  it("ignora biologicalSex invalido no payload publico", async () => {
    const userId = "biosex-post-invalid";
    writeRawMemory(userId, { biologicalSex: "prefer_not_to_say" });

    const res = await fetch(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ biologicalSex: "prefer_not_to_say", weightKg: 82 }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    const saved = readMemory(userId);
    assert.equal(body.weightKg, 82);
    assert.equal(saved.weightKg, 82);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "biologicalSex"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(saved, "biologicalSex"), false);
  });

  it("aceita somente male ou female no payload publico", async () => {
    const userId = "biosex-post-valid";
    writeRawMemory(userId, {});

    const res = await fetch(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ biologicalSex: "female" }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    const saved = readMemory(userId);
    assert.equal(body.biologicalSex, "female");
    assert.equal(saved.biologicalSex, "female");
  });

  it("nao devolve numeros legados fora dos ranges oficiais", async () => {
    const userId = "calibration-ranges-legacy-invalid";
    writeRawMemory(userId, { userAge: 13, heightCm: 99, weightKg: 301 });

    const res = await fetch(`${baseUrl}/guto/memory`, {
      method: "GET",
      headers: authHeaders(userId),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(Object.prototype.hasOwnProperty.call(body, "userAge"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "heightCm"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "weightKg"), false);
  });

  it("ignora numeros fora dos ranges oficiais no payload publico", async () => {
    const userId = "calibration-ranges-post-invalid";
    writeRawMemory(userId, { userAge: 35, heightCm: 178, weightKg: 82 });

    const res = await fetch(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ userAge: 12, heightCm: 251, weightKg: 301 }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    const saved = readMemory(userId);
    assert.equal(body.userAge, 35);
    assert.equal(body.heightCm, 178);
    assert.equal(body.weightKg, 82);
    assert.equal(saved.userAge, 35);
    assert.equal(saved.heightCm, 178);
    assert.equal(saved.weightKg, 82);
  });

  it("normaliza numeros validos dentro dos ranges oficiais", async () => {
    const userId = "calibration-ranges-post-valid";
    writeRawMemory(userId, {});

    const res = await fetch(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ userAge: 35.6, heightCm: 178.4, weightKg: 82.44 }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    const saved = readMemory(userId);
    assert.equal(body.userAge, 36);
    assert.equal(body.heightCm, 178);
    assert.equal(body.weightKg, 82.4);
    assert.equal(saved.userAge, 36);
    assert.equal(saved.heightCm, 178);
    assert.equal(saved.weightKg, 82.4);
  });
});

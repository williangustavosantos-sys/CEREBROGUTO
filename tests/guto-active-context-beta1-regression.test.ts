import "./test-env.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

const tmpDir = join(process.cwd(), "tmp");
const memoryFile = join(tmpDir, "guto-memory.active-context-beta1.json");
const dietFile = join(tmpDir, "guto-diet.active-context-beta1.json");
const userA = "active-context-beta-user-a";
const userB = "active-context-beta-user-b";

let server: Server;
let baseUrl = "";
let originalFetch: typeof globalThis.fetch;
let clearMemoryStoreCache: () => void = () => {};

function headers(userId: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function workoutContext(id: string, exerciseId = "supino_reto_maquina", name = "Supino reto máquina") {
  const now = new Date().toISOString();
  const item = {
    id: exerciseId,
    name,
    workoutId: "today",
    sets: 3,
    reps: "10-12",
    rest: "90s",
  };
  return {
    id,
    version: 1,
    type: "workout",
    sourceSurface: "mission",
    originalItem: item,
    currentItem: item,
    lastSuggestedItem: null,
    rejectedItems: [],
    acceptedItem: null,
    createdAt: now,
    updatedAt: now,
  };
}

function baseMemory(userId: string) {
  return {
    userId,
    name: userId === userA ? "Alpha" : "Beta",
    language: "pt-BR",
    trainingGoal: "muscle_gain",
    trainingLevel: "consistent",
    preferredTrainingLocation: "gym",
    userAge: 35,
    trainingLimitations: "sem dor",
    lastWorkoutPlan: {
      scheduledFor: "today",
      focus: "Peito e tríceps",
      location: "gym",
      exercises: [{
        id: "supino_reto_maquina",
        name: "Supino reto máquina",
        canonicalNamePt: "Supino reto máquina",
        sets: 3,
        reps: "10-12",
        rest: "90s",
      }],
    },
  };
}

function seedStore(users = [userA]) {
  const store = Object.fromEntries(users.map((userId) => [userId, baseMemory(userId)]));
  writeFileSync(memoryFile, JSON.stringify(store, null, 2));
  clearMemoryStoreCache();
}

async function request(userId: string, method: string, path: string, body?: unknown) {
  const response = await originalFetch(`${baseUrl}${path}`, {
    method,
    headers: headers(userId),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, any>;
  return { response, payload };
}

async function activate(userId: string, context: Record<string, any>) {
  const { response, payload } = await request(userId, "POST", "/guto/active-context", { context });
  assert.equal(response.status, 200);
  return payload.activeContext as Record<string, any>;
}

async function swap(userId: string, active: Record<string, any>, input: string, suffix: string) {
  const { response, payload } = await request(userId, "POST", "/guto", {
    language: "pt-BR",
    history: [],
    input,
    turnId: `${userId}-${suffix}`,
    requestId: `${userId}-${suffix}-request`,
    contextId: active.id,
    contextVersion: active.version,
    activeContextType: active.type,
    activeItemId: active.currentItem.id,
    lastSuggestedItem: active.lastSuggestedItem
      ? { id: active.lastSuggestedItem.id, name: active.lastSuggestedItem.name, kind: "exercise" }
      : null,
  });
  assert.equal(response.status, 200);
  return payload;
}

async function freshMemory(userId: string) {
  const { response, payload } = await request(userId, "GET", "/guto/memory");
  assert.equal(response.status, 200);
  return payload;
}

describe("active context Beta 1.0 regressions", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = memoryFile;
    process.env.GUTO_DIET_FILE = dietFile;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    process.env.GEMINI_API_KEY = "active-context-beta1-test-key";
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(dietFile, "{}");

    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).includes("generativelanguage.googleapis.com")) {
        return originalFetch(input as RequestInfo, init);
      }
      const requestBody = JSON.parse(String(init?.body || "{}")) as {
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
      };
      const prompt = requestBody.contents?.[0]?.parts?.[0]?.text || "";
      const worldStateText = prompt
        .split("WORLD_STATE_V2:\n").pop()
        ?.split("\n\nHISTÓRICO RECENTE:")[0];
      const worldState = worldStateText ? JSON.parse(worldStateText) as {
        activeContext?: { currentItem?: { name?: string }; lastSuggestedItem?: { name?: string } | null };
        catalog?: { workoutSubstitutes?: Array<{ id: string; name: string }> };
        contextSignals?: { explicitlyUnavailableExercise?: { name?: string } | null };
      } : {};
      const candidate = worldState.catalog?.workoutSubstitutes?.[0];
      const unavailable =
        worldState.contextSignals?.explicitlyUnavailableExercise?.name ||
        worldState.activeContext?.lastSuggestedItem?.name ||
        worldState.activeContext?.currentItem?.name ||
        "exercício";
      const decision = candidate
        ? {
            fala: `${unavailable} indisponível. Troca por ${candidate.name}.`,
            acao: "swapExercise",
            expectedResponse: null,
            memoryPatch: {},
          }
        : {
            fala: "Não encontrei uma alternativa segura.",
            acao: "none",
            expectedResponse: null,
            memoryPatch: {},
          };
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(decision) }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    const module = await import(pathToFileURL(join(process.cwd(), "server.ts")).href) as {
      app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
    };
    const memoryStore = await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href) as {
      clearMemoryStoreCache: () => void;
    };
    clearMemoryStoreCache = memoryStore.clearMemoryStoreCache;
    await new Promise<void>((resolve, reject) => {
      server = module.app.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind test server");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    seedStore();
    writeFileSync(dietFile, "{}");
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(memoryFile, { force: true });
    rmSync(dietFile, { force: true });
  });

  it("1. troca o exercício ocupado e persiste a alternativa", async () => {
    const opened = await activate(userA, workoutContext("ctx-beta-first"));
    const first = await swap(userA, opened, "O equipamento está ocupado.", "first");
    assert.equal(first.activeContext.version, 2);
    assert.notEqual(first.activeContext.currentItem.id, opened.currentItem.id);
    assert.equal(first.workoutPlan.exercises[0].id, first.activeContext.currentItem.id);
  });

  it("2. troca novamente sem repetir a primeira alternativa", async () => {
    const opened = await activate(userA, workoutContext("ctx-beta-second"));
    const first = await swap(userA, opened, "O equipamento está ocupado.", "first");
    const second = await swap(userA, first.activeContext, "Esse também está ocupado.", "second");
    assert.equal(second.activeContext.version, 3);
    assert.notEqual(second.activeContext.currentItem.id, first.activeContext.currentItem.id);
    assert.ok(second.activeContext.rejectedItems.some((item: any) => item.id === first.activeContext.currentItem.id));
  });

  it("3. chega à terceira alternativa sem repetir nenhuma anterior", async () => {
    const opened = await activate(userA, workoutContext("ctx-beta-third"));
    const first = await swap(userA, opened, "O equipamento está ocupado.", "first");
    const second = await swap(userA, first.activeContext, "Esse também está ocupado.", "second");
    const third = await swap(userA, second.activeContext, "Esse também está ocupado.", "third");
    assert.equal(third.activeContext.version, 4);
    assert.equal(new Set([
      opened.currentItem.id,
      first.activeContext.currentItem.id,
      second.activeContext.currentItem.id,
      third.activeContext.currentItem.id,
    ]).size, 4);
  });

  it("4. refresh reidrata exatamente o contexto e o plano confirmados", async () => {
    const opened = await activate(userA, workoutContext("ctx-beta-refresh"));
    const first = await swap(userA, opened, "O equipamento está ocupado.", "first");
    clearMemoryStoreCache();
    const rehydrated = await freshMemory(userA);
    assert.equal(rehydrated.activeContext.id, first.activeContext.id);
    assert.equal(rehydrated.activeContext.version, first.activeContext.version);
    assert.equal(rehydrated.activeContext.currentItem.id, first.activeContext.currentItem.id);
    assert.equal(rehydrated.lastWorkoutPlan.exercises[0].id, first.activeContext.currentItem.id);
  });

  it("5. dois usuários simultâneos preservam contextos e planos isolados", async () => {
    seedStore([userA, userB]);
    const [openedA, openedB] = await Promise.all([
      activate(userA, workoutContext("ctx-beta-user-a")),
      activate(userB, workoutContext("ctx-beta-user-b")),
    ]);
    const [resultA, resultB] = await Promise.all([
      swap(userA, openedA, "O equipamento está ocupado.", "first"),
      swap(userB, openedB, "O equipamento está ocupado.", "first"),
    ]);
    clearMemoryStoreCache();
    const stored = JSON.parse(readFileSync(memoryFile, "utf8"));
    assert.equal(stored[userA].activeContext.id, "ctx-beta-user-a");
    assert.equal(stored[userB].activeContext.id, "ctx-beta-user-b");
    assert.equal(stored[userA].lastWorkoutPlan.exercises[0].id, resultA.activeContext.currentItem.id);
    assert.equal(stored[userB].lastWorkoutPlan.exercises[0].id, resultB.activeContext.currentItem.id);
  });

  it("6. contexto expirado não reaparece após reload nem pode ser reativado", async () => {
    const expired = workoutContext("ctx-beta-expired");
    const old = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    expired.createdAt = old;
    expired.updatedAt = old;
    const store = { [userA]: { ...baseMemory(userA), activeContext: expired } };
    writeFileSync(memoryFile, JSON.stringify(store, null, 2));
    clearMemoryStoreCache();

    const rehydrated = await freshMemory(userA);
    assert.equal(rehydrated.activeContext, null);
    const { response, payload } = await request(userA, "POST", "/guto/active-context", { context: expired });
    assert.equal(response.status, 400);
    assert.equal(payload.code, "ACTIVE_CONTEXT_INVALID");
  });

  it("7. exercício inexistente não altera o plano oficial", async () => {
    const opened = await activate(
      userA,
      workoutContext("ctx-beta-missing", "exercise_does_not_exist", "Exercício inexistente"),
    );
    const result = await swap(userA, opened, "O equipamento está ocupado.", "missing");
    assert.equal(result.acao, "none");
    assert.match(result.fala, /não está mais no seu treino|não encontrei.*treino oficial/i);
    assert.equal(result.activeContext.currentItem.id, "exercise_does_not_exist");
    assert.equal(result.workoutPlan ?? null, null);
    clearMemoryStoreCache();
    const stored = JSON.parse(readFileSync(memoryFile, "utf8"))[userA];
    assert.equal(stored.lastWorkoutPlan.exercises[0].id, "supino_reto_maquina");
  });
});

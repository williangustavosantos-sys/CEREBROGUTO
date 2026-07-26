import "./test-env.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

const tmpDir = join(process.cwd(), "tmp");
const memoryFile = join(tmpDir, "guto-memory.active-context-test.json");
const userId = "active-context-user";
let server: Server;
let baseUrl = "";
let originalFetch: typeof globalThis.fetch;
let clearMemoryStoreCache: () => void = () => {};

function authHeaders() {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function context(id: string, type: "workout" | "diet", itemId: string, name: string) {
  const now = new Date().toISOString();
  const item = type === "workout"
    ? { id: itemId, name, workoutId: "today", sets: 3, reps: "10", rest: "60s" }
    : { id: itemId, name, mealId: "lunch", mealName: "Almoço", quantity: "100 g" };
  return {
    id,
    version: 1,
    type,
    sourceSurface: type === "workout" ? "mission" : "diet",
    originalItem: item,
    currentItem: item,
    lastSuggestedItem: null,
    rejectedItems: [],
    acceptedItem: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function post(path: string, body: unknown) {
  const response = await originalFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  return response.json() as Promise<Record<string, any>>;
}

describe("active context correlation", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = memoryFile;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    process.env.GEMINI_API_KEY = "active-context-test-key";
    mkdirSync(tmpDir, { recursive: true });
    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("generativelanguage.googleapis.com")) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        const requestBody = String(init?.body || "").toLocaleLowerCase("pt-BR");
        const modelResponse = requestBody.includes("também não tenho essa opção")
          ? {
              fala: "Sem estresse. Vamos simplificar: você tem alguma fruta? Me diz o que tem na despensa.",
              acao: "none",
              expectedResponse: null,
              memoryPatch: {},
            }
          : requestBody.includes("não tenho aveia em flocos")
            ? {
                fala: "Sem problemas. Pode substituir por 30g de farelo de trigo ou 2 fatias de pão integral.",
                acao: "none",
                expectedResponse: null,
                memoryPatch: {},
              }
          : requestBody.includes("não tenho banana")
            ? {
                fala: "Troca banana por maçã. Mesma função no prato.",
                acao: "none",
                expectedResponse: null,
                memoryPatch: {},
              }
            : {
                fala: "Resposta antiga do treino.",
                acao: "updateWorkout",
                expectedResponse: null,
                memoryPatch: { trainingGoal: "fat_loss" },
              };
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(modelResponse) }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input as RequestInfo, init);
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
    clearMemoryStoreCache();
    writeFileSync(memoryFile, JSON.stringify({
      [userId]: {
        userId,
        name: "Will",
        language: "pt-BR",
        trainingGoal: "muscle_gain",
        trainingLevel: "consistent",
        preferredTrainingLocation: "gym",
        userAge: 35,
        trainingLimitations: "sem dor",
      },
    }, null, 2));
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(memoryFile, { force: true });
  });

  it("troca treino→dieta enquanto o modelo responde descarta o turno antigo sem mutação", async () => {
    const workoutContext = context("ctx-workout", "workout", "supino_reto", "Supino reto");
    const dietContext = context("ctx-diet", "diet", "lunch:rice", "Arroz");
    await post("/guto/active-context", { context: workoutContext });

    const delayedTurn = post("/guto", {
      profile: { userId, name: "Will" },
      language: "pt-BR",
      history: [],
      input: "Explique detalhadamente.",
      turnId: "turn-workout",
      requestId: "request-workout",
      contextId: workoutContext.id,
      contextVersion: workoutContext.version,
      activeContextType: workoutContext.type,
      activeItemId: workoutContext.currentItem.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await post("/guto/active-context", { context: dietContext });

    const response = await delayedTurn;
    assert.equal(response.turnId, "turn-workout");
    assert.equal(response.requestId, "request-workout");
    assert.equal(response.contextId, "ctx-workout");
    assert.equal(response.discardedReason, "stale_context");
    assert.equal(response.acao, "none");
    assert.deepEqual(response.memoryPatch, {});
    assert.equal(response.workoutPlan, null);

    clearMemoryStoreCache();
    const stored = JSON.parse(readFileSync(memoryFile, "utf8"))[userId];
    assert.equal(stored.activeContext.id, "ctx-diet");
    assert.equal(stored.activeContext.type, "diet");
    assert.equal(stored.trainingGoal, "muscle_gain", "stale model patch must not reach durable memory");
    assert.equal(stored.lastWorkoutPlan ?? null, null);
    assert.equal(stored.lastDietPlan ?? null, null);
  });

  it("sequência fundadora: Supino e Banana avançam alternativas sem repetir item", async () => {
    const workoutContext = context("ctx-sequence-workout", "workout", "supino_reto_maquina", "Supino reto máquina");
    await post("/guto/active-context", { context: workoutContext });
    const sendInContext = (active: Record<string, any>, input: string, suffix: string) => post("/guto", {
      profile: { userId, name: "Will" },
      language: "pt-BR",
      history: [],
      input,
      turnId: `turn-${suffix}`,
      requestId: `request-${suffix}`,
      contextId: active.id,
      contextVersion: active.version,
      activeContextType: active.type,
      activeItemId: active.currentItem.id,
    });

    const first = await sendInContext(workoutContext, "Ocupado", "first");
    assert.equal(first.contextId, workoutContext.id);
    assert.equal(first.activeContext.type, "workout");
    assert.equal(first.activeContext.version, 2);
    assert.equal(first.activeContext.originalItem.id, "supino_reto_maquina");
    assert.notEqual(first.activeContext.currentItem.id, "supino_reto_maquina");
    assert.deepEqual(first.activeContext.rejectedItems.map((item: any) => item.id), ["supino_reto_maquina"]);

    const second = await sendInContext(first.activeContext, "Tbm está ocupado", "second");
    assert.equal(second.activeContext.version, 3);
    assert.notEqual(second.activeContext.currentItem.id, first.activeContext.currentItem.id);
    assert.deepEqual(
      second.activeContext.rejectedItems.map((item: any) => item.id),
      ["supino_reto_maquina", first.activeContext.currentItem.id],
    );
    assert.match(second.fala || "", new RegExp(first.activeContext.currentItem.name, "i"));
    assert.doesNotMatch(second.fala || "", /Supino reto máquina ocupado/i);

    const dietContext = context("ctx-sequence-diet", "diet", "banana", "Banana prata");
    await post("/guto/active-context", { context: dietContext });
    const dietFirst = await sendInContext(dietContext, "Não tenho", "diet-first");
    assert.equal(dietFirst.activeContext.type, "diet");
    assert.equal(dietFirst.activeContext.originalItem.id, "banana");
    assert.notEqual(dietFirst.activeContext.currentItem.id, "banana");
    assert.deepEqual(dietFirst.activeContext.rejectedItems.map((item: any) => item.id), ["banana"]);
    const dietSecond = await sendInContext(dietFirst.activeContext, "Não tenho tbm", "diet-second");
    assert.equal(dietSecond.activeContext.type, "diet");
    assert.notEqual(dietSecond.activeContext.currentItem.id, dietFirst.activeContext.currentItem.id);
    assert.deepEqual(
      dietSecond.activeContext.rejectedItems.map((item: any) => item.id),
      ["banana", dietFirst.activeContext.currentItem.id],
    );
    assert.doesNotMatch(dietSecond.fala || "", /supino|crucifixo/i);
    assert.equal(dietSecond.workoutPlan ?? null, null);

    clearMemoryStoreCache();
    const stored = JSON.parse(readFileSync(memoryFile, "utf8"))[userId];
    assert.equal(stored.activeContext.id, "ctx-sequence-diet");
    assert.equal(stored.substitutionContext.kind, "food");
    assert.equal(stored.activeConversationContext.kind, "diet_substitution");
    assert.equal(stored.activeConversationContext.originalId, "banana");
    assert.equal(stored.contextHistory.at(-1).id, "ctx-sequence-workout");
    assert.equal(stored.contextHistory.at(-1).currentItem.id, second.activeContext.currentItem.id);
  });

  it("contexto explícito preserva Supino reto máquina quando o plano contém Supino reto", async () => {
    const store = JSON.parse(readFileSync(memoryFile, "utf8"));
    store[userId].lastWorkoutPlan = {
      location: "gym",
      exercises: [{
        id: "supino_reto",
        name: "Supino reto",
        canonicalNamePt: "Supino reto",
        sets: 4,
        reps: "8-12",
        rest: "90s",
      }],
    };
    writeFileSync(memoryFile, JSON.stringify(store, null, 2));
    clearMemoryStoreCache();

    const workoutContext = context(
      "ctx-literal-machine",
      "workout",
      "supino_reto_maquina",
      "Supino reto máquina",
    );
    await post("/guto/active-context", { context: workoutContext });
    const response = await post("/guto", {
      profile: { userId, name: "Will" },
      language: "pt-BR",
      history: [],
      input: "Ocupado",
      turnId: "turn-literal-machine",
      requestId: "request-literal-machine",
      contextId: workoutContext.id,
      contextVersion: workoutContext.version,
      activeContextType: workoutContext.type,
      activeItemId: workoutContext.currentItem.id,
    });

    assert.equal(response.activeContext.originalItem.id, "supino_reto_maquina");
    assert.deepEqual(response.activeContext.rejectedItems.map((item: any) => item.id), ["supino_reto_maquina"]);
    assert.match(response.fala || "", /Supino reto máquina ocupado/i);
  });

  it("it-IT preserva duas referências curtas no contexto ativo de treino", async () => {
    const workoutContext = context(
      "ctx-italian-short-reference",
      "workout",
      "supino_reto_maquina",
      "Supino reto macchina",
    );
    await post("/guto/active-context", { context: workoutContext });
    const send = (active: Record<string, any>, input: string, suffix: string) => post("/guto", {
      profile: { userId, name: "Will" },
      language: "it-IT",
      history: [],
      input,
      turnId: `turn-italian-${suffix}`,
      requestId: `request-italian-${suffix}`,
      contextId: active.id,
      contextVersion: active.version,
      activeContextType: active.type,
      activeItemId: active.currentItem.id,
    });

    const first = await send(workoutContext, "Occupato", "first");
    assert.equal(first.activeContext.version, 2);
    assert.deepEqual(first.activeContext.rejectedItems.map((item: any) => item.id), ["supino_reto_maquina"]);
    assert.equal(first.expectedResponse ?? null, null);

    const second = await send(first.activeContext, "Anche quello", "second");
    assert.equal(second.activeContext.version, 3);
    assert.notEqual(second.activeContext.currentItem.id, first.activeContext.currentItem.id);
    assert.deepEqual(
      second.activeContext.rejectedItems.map((item: any) => item.id),
      ["supino_reto_maquina", first.activeContext.currentItem.id],
    );
  });

  it("it-IT rejeita a sugestão alimentar após reidratar o contexto", async () => {
    const dietContext = context("ctx-italian-diet-reload", "diet", "banana", "Banana");
    await post("/guto/active-context", { context: dietContext });
    const send = (active: Record<string, any>, input: string, suffix: string) => post("/guto", {
      profile: { userId, name: "Will" },
      language: "it-IT",
      history: [],
      input,
      turnId: `turn-italian-diet-${suffix}`,
      requestId: `request-italian-diet-${suffix}`,
      contextId: active.id,
      contextVersion: active.version,
      activeContextType: active.type,
      activeItemId: active.currentItem.id,
    });

    const first = await send(dietContext, "Non ce l'ho", "first");
    assert.equal(first.activeContext.version, 2);
    assert.deepEqual(first.activeContext.rejectedItems.map((item: any) => item.id), ["banana"]);
    clearMemoryStoreCache();

    const second = await send(first.activeContext, "Non ce l'ho neanche", "second");
    assert.equal(second.activeContext.version, 3);
    assert.notEqual(second.activeContext.currentItem.id, first.activeContext.currentItem.id);
    assert.deepEqual(
      second.activeContext.rejectedItems.map((item: any) => item.id),
      ["banana", first.activeContext.currentItem.id],
    );
  });

  it("Supino rejeitado → Banana → 'Não tenho tbm' fica exclusivamente na dieta", async () => {
    const workoutContext = context("ctx-switch-workout", "workout", "supino_reto_maquina", "Supino reto máquina");
    await post("/guto/active-context", { context: workoutContext });
    const workout = await post("/guto", {
      profile: { userId, name: "Will" }, language: "pt-BR", history: [], input: "Ocupado",
      turnId: "turn-switch-workout", requestId: "request-switch-workout",
      contextId: workoutContext.id, contextVersion: 1, activeContextType: "workout", activeItemId: "supino_reto_maquina",
    });
    assert.notEqual(workout.activeContext.currentItem.id, "supino_reto_maquina");

    const dietContext = context("ctx-switch-diet", "diet", "banana", "Banana prata");
    await post("/guto/active-context", { context: dietContext });
    const diet = await post("/guto", {
      profile: { userId, name: "Will" }, language: "pt-BR", history: [], input: "Não tenho tbm",
      turnId: "turn-switch-diet", requestId: "request-switch-diet",
      contextId: dietContext.id, contextVersion: 1, activeContextType: "diet", activeItemId: "banana",
    });
    assert.equal(diet.activeContext.type, "diet");
    assert.equal(diet.activeContext.originalItem.id, "banana");
    assert.notEqual(diet.activeContext.currentItem.id, "banana");
    assert.doesNotMatch(diet.fala || "", /supino|crucifixo/i);
    assert.deepEqual(diet.memoryPatch || {}, {});
    assert.equal(diet.workoutPlan ?? null, null);
  });

  it("menção explícita de alimento troca o contexto workout→diet e mantém o follow-up alimentar", async () => {
    const workoutContext = context("ctx-natural-switch", "workout", "supino_reto_maquina", "Supino reto máquina");
    await post("/guto/active-context", { context: workoutContext });

    const first = await post("/guto", {
      profile: { userId, name: "Will" },
      language: "pt-BR",
      history: [],
      input: "não tenho banana",
      turnId: "turn-natural-food-first",
      requestId: "request-natural-food-first",
      contextId: workoutContext.id,
      contextVersion: workoutContext.version,
      activeContextType: workoutContext.type,
      activeItemId: workoutContext.currentItem.id,
    });
    assert.equal(first.discardedReason ?? null, null);
    assert.equal(first.activeContext.type, "diet");
    assert.equal(first.activeContext.originalItem.id, "banana");
    assert.equal(first.activeContext.currentItem.id, "apple");
    assert.doesNotMatch(first.fala || "", /supino|crucifixo/i);

    const second = await post("/guto", {
      profile: { userId, name: "Will" },
      language: "pt-BR",
      history: [],
      input: "também não tenho essa opção",
      turnId: "turn-natural-food-second",
      requestId: "request-natural-food-second",
      contextId: first.activeContext.id,
      contextVersion: first.activeContext.version,
      activeContextType: first.activeContext.type,
      activeItemId: first.activeContext.currentItem.id,
    });
    assert.equal(second.activeContext.type, "diet");
    assert.equal(second.activeContext.originalItem.id, "banana");
    assert.equal(second.activeContext.currentItem.id, "berries");
    assert.deepEqual(
      second.activeContext.rejectedItems.map((item: any) => item.id),
      ["banana", "apple"],
    );
    assert.doesNotMatch(second.fala || "", /supino|crucifixo|flexão/i);
  });

  it("Elíptico → Aveia → substituto A → rejeição → substituto B → reload permanece na dieta", async () => {
    const workoutContext = context("ctx-food-domain-workout", "workout", "eliptico", "Elíptico");
    await post("/guto/active-context", { context: workoutContext });
    const workoutSwap = await post("/guto", {
      profile: { userId, name: "Will" },
      language: "pt-BR",
      history: [],
      input: "Ocupado",
      turnId: "turn-food-domain-workout",
      requestId: "request-food-domain-workout",
      contextId: workoutContext.id,
      contextVersion: workoutContext.version,
      activeContextType: workoutContext.type,
      activeItemId: workoutContext.currentItem.id,
    });
    assert.equal(workoutSwap.activeContext.type, "workout");

    const openedAt = new Date().toISOString();
    const oatsItem = {
      id: "cafe:aveia em flocos",
      name: "Aveia em flocos",
      position: 1,
      mealId: "cafe",
      mealName: "Café da manhã proteico",
      quantity: "80g",
    };
    const dietContext = {
      id: "ctx-food-domain-diet",
      version: 1,
      type: "diet",
      sourceSurface: "diet",
      originalItem: oatsItem,
      currentItem: oatsItem,
      lastSuggestedItem: null,
      rejectedItems: [],
      acceptedItem: null,
      createdAt: openedAt,
      updatedAt: openedAt,
    };
    await post("/guto/active-context", { context: dietContext });

    clearMemoryStoreCache();
    const afterOpen = JSON.parse(readFileSync(memoryFile, "utf8"))[userId];
    assert.equal(afterOpen.activeContext.type, "diet");
    assert.equal(afterOpen.activeContext.originalItem.name, "Aveia em flocos");
    assert.equal(afterOpen.substitutionContext, null);
    assert.equal(afterOpen.activeConversationContext.kind, "diet_item");
    assert.doesNotMatch(
      JSON.stringify({
        activeContext: afterOpen.activeContext,
        substitutionContext: afterOpen.substitutionContext,
        activeConversationContext: afterOpen.activeConversationContext,
      }),
      /workout_substitution|eliptico|"kind":"exercise"/i,
    );

    const send = (active: Record<string, any>, input: string, suffix: string) => post("/guto", {
      profile: { userId, name: "Will" },
      language: "pt-BR",
      history: [],
      input,
      turnId: `turn-food-domain-${suffix}`,
      requestId: `request-food-domain-${suffix}`,
      contextId: active.id,
      contextVersion: active.version,
      activeContextType: active.type,
      activeItemId: active.currentItem.id,
    });

    const first = await send(dietContext, "não tenho aveia em flocos", "first");
    assert.equal(first.activeContext.type, "diet");
    assert.equal(first.activeContext.originalItem.name, "Aveia em flocos");
    assert.notEqual(first.activeContext.currentItem.id, "cafe:aveia em flocos");
    assert.deepEqual(first.activeContext.currentItem, first.activeContext.lastSuggestedItem);
    assert.doesNotMatch(first.fala || "", /\bou\b.*p[ãa]o|\bou\b.*biscoito/i);

    clearMemoryStoreCache();
    const afterFirst = JSON.parse(readFileSync(memoryFile, "utf8"))[userId];
    assert.equal(afterFirst.substitutionContext.kind, "food");
    assert.equal(afterFirst.activeConversationContext.kind, "diet_substitution");
    assert.equal(afterFirst.substitutionContext.lastSuggestedId, first.activeContext.currentItem.id);

    const second = await send(first.activeContext, "também não tenho essa opção", "second");
    assert.equal(second.activeContext.type, "diet");
    assert.equal(second.activeContext.originalItem.name, "Aveia em flocos");
    assert.notEqual(second.activeContext.currentItem.id, first.activeContext.currentItem.id);
    assert.notEqual(second.activeContext.currentItem.id, "cafe:aveia em flocos");
    assert.equal(second.activeContext.lastSuggestedItem.id, second.activeContext.currentItem.id);
    assert.ok(
      second.activeContext.rejectedItems.some((item: any) => item.id === first.activeContext.currentItem.id),
      "a primeira sugestão precisa ser registrada como rejeitada",
    );
    assert.match(second.fala || "", new RegExp(first.activeContext.currentItem.name, "i"));

    clearMemoryStoreCache();
    const afterReload = JSON.parse(readFileSync(memoryFile, "utf8"))[userId];
    assert.equal(afterReload.activeContext.type, "diet");
    assert.equal(afterReload.activeContext.currentItem.id, second.activeContext.currentItem.id);
    assert.equal(afterReload.activeContext.lastSuggestedItem.id, second.activeContext.currentItem.id);
    assert.equal(afterReload.substitutionContext.kind, "food");
    assert.equal(afterReload.substitutionContext.lastSuggestedId, second.activeContext.currentItem.id);
    assert.equal(afterReload.activeConversationContext.kind, "diet_substitution");
    assert.doesNotMatch(
      JSON.stringify({
        activeContext: afterReload.activeContext,
        substitutionContext: afterReload.substitutionContext,
        activeConversationContext: afterReload.activeConversationContext,
      }),
      /workout_substitution|eliptico|"kind":"exercise"/i,
    );
  });

  it("resposta concorrente do treino não restaura o domínio após abrir a dieta", async () => {
    const workoutContext = context("ctx-concurrent-workout", "workout", "eliptico", "Elíptico");
    await post("/guto/active-context", { context: workoutContext });
    const workoutSwap = await post("/guto", {
      profile: { userId, name: "Will" }, language: "pt-BR", history: [], input: "Ocupado",
      turnId: "turn-concurrent-swap", requestId: "request-concurrent-swap",
      contextId: workoutContext.id, contextVersion: 1, activeContextType: "workout", activeItemId: "eliptico",
    });

    const delayedWorkoutTurn = post("/guto", {
      profile: { userId, name: "Will" }, language: "pt-BR", history: [], input: "Explique melhor.",
      turnId: "turn-concurrent-late", requestId: "request-concurrent-late",
      contextId: workoutSwap.activeContext.id,
      contextVersion: workoutSwap.activeContext.version,
      activeContextType: "workout",
      activeItemId: workoutSwap.activeContext.currentItem.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const dietContext = context("ctx-concurrent-diet", "diet", "cafe:aveia em flocos", "Aveia em flocos");
    await post("/guto/active-context", { context: dietContext });
    const late = await delayedWorkoutTurn;
    assert.equal(late.discardedReason, "stale_context");

    clearMemoryStoreCache();
    const stored = JSON.parse(readFileSync(memoryFile, "utf8"))[userId];
    assert.equal(stored.activeContext.id, dietContext.id);
    assert.equal(stored.activeContext.type, "diet");
    assert.equal(stored.substitutionContext, null);
    assert.equal(stored.activeConversationContext.kind, "diet_item");
    assert.doesNotMatch(
      JSON.stringify({
        activeContext: stored.activeContext,
        substitutionContext: stored.substitutionContext,
        activeConversationContext: stored.activeConversationContext,
      }),
      /workout_substitution|eliptico|"kind":"exercise"/i,
    );
  });
});

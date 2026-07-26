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
let brainCalls = 0;
let brainPrompts: string[] = [];
let forcedFoodQuantity: string | null = null;

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
        const requestBody = JSON.parse(String(init?.body || "{}")) as {
          contents?: Array<{ parts?: Array<{ text?: string }> }>;
        };
        const prompt = requestBody.contents?.[0]?.parts?.[0]?.text || "";
        if (prompt.includes("CÉREBRO SOBERANO V2")) {
          brainCalls += 1;
          brainPrompts.push(prompt);
        }
        const message = prompt.split("MENSAGEM DO USUÁRIO:").pop()?.trim() || "";
        const worldStateText = prompt
          .split("WORLD_STATE_V2:\n").pop()
          ?.split("\n\nHISTÓRICO RECENTE:")[0];
        const worldState = worldStateText ? JSON.parse(worldStateText) as {
          language?: string;
          activeContext?: {
            type?: string;
            currentItem?: { name?: string };
            lastSuggestedItem?: { name?: string } | null;
          } | null;
          catalog?: {
            activeExercise?: { id?: string; name?: string } | null;
            foodSubstitutes?: Array<{ id: string; name: string; quantityHint?: string }>;
            workoutSubstitutes?: Array<{ id: string; name: string }>;
          };
          contextSignals?: {
            explicitlyUnavailableFood?: { id?: string; name?: string } | null;
            explicitlyUnavailableExercise?: { id?: string; name?: string } | null;
          };
        } : {};
        const foodCandidate = worldState.catalog?.foodSubstitutes?.[0];
        const workoutCandidate = worldState.catalog?.workoutSubstitutes?.[0];
        const language = worldState.language || "pt-BR";
        const isFoodTurn = Boolean(foodCandidate) && /n[aã]o (?:tenho|tem)|non ce l|non ho|don'?t have/i.test(message);
        const activeFoodLabel =
          worldState.contextSignals?.explicitlyUnavailableFood?.name ||
          (worldState.activeContext?.type === "diet"
            ? worldState.activeContext.lastSuggestedItem?.name || worldState.activeContext.currentItem?.name
            : null);
        const foodQuantity = foodCandidate
          ? forcedFoodQuantity ||
            foodCandidate.quantityHint ||
            (foodCandidate.id === "rice_cakes"
              ? language === "it-IT" ? "4 gallette" : "4 unidades"
              : language === "it-IT" ? "1 porzione" : "1 porção")
          : "";
        const modelResponse = isFoodTurn && foodCandidate
          ? {
              fala: language === "it-IT"
                ? `Cambia ${activeFoodLabel || "questo alimento"} con ${foodQuantity} di ${foodCandidate.name}.`
                : `Troca ${activeFoodLabel || "esse alimento"} por ${foodQuantity} de ${foodCandidate.name}.`,
              acao: "none",
              expectedResponse: null,
              memoryPatch: {},
              foodSubstitution: {
                foodId: foodCandidate.id,
                quantity: foodQuantity,
                basis: "approximate_carbs",
              },
            }
          : worldState.activeContext?.type === "workout" && workoutCandidate && /ocupad|occupat|busy|anche/i.test(message)
            ? {
                fala: language === "it-IT"
                  ? `${worldState.contextSignals?.explicitlyUnavailableExercise?.name || worldState.activeContext.lastSuggestedItem?.name || worldState.catalog?.activeExercise?.name || worldState.activeContext.currentItem?.name} occupato? Cambia con ${workoutCandidate.name}.`
                  : `${worldState.contextSignals?.explicitlyUnavailableExercise?.name || worldState.activeContext.lastSuggestedItem?.name || worldState.catalog?.activeExercise?.name || worldState.activeContext.currentItem?.name} ocupado? Troca por ${workoutCandidate.name}.`,
                acao: "swapExercise",
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
    brainCalls = 0;
    brainPrompts = [];
    forcedFoodQuantity = null;
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
    clearMemoryStoreCache();
    const afterSecondWorkoutSwap = JSON.parse(readFileSync(memoryFile, "utf8"))[userId];
    assert.equal(afterSecondWorkoutSwap.substitutionContext.originalId, "supino_reto_maquina");
    assert.equal(afterSecondWorkoutSwap.activeContext.originalItem.id, "supino_reto_maquina");

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

  it("exercício novo explícito substitui o contexto de treino anterior", async () => {
    const oldContext = context("ctx-explicit-exercise-change", "workout", "supino_reto_maquina", "Supino reto máquina");
    await post("/guto/active-context", { context: oldContext });

    const response = await post("/guto", {
      profile: { userId, name: "Will" },
      language: "pt-BR",
      history: [],
      input: "Tríceps polia alta ocupado",
      turnId: "turn-explicit-exercise-change",
      requestId: "request-explicit-exercise-change",
      contextId: oldContext.id,
      contextVersion: oldContext.version,
      activeContextType: oldContext.type,
      activeItemId: oldContext.currentItem.id,
    });

    assert.equal(response.activeContext.type, "workout");
    assert.equal(response.activeContext.originalItem.id, "triceps_polia_alta");
    assert.notEqual(response.activeContext.currentItem.id, "triceps_polia_alta");
    assert.doesNotMatch(JSON.stringify(response.activeContext), /supino_reto_maquina/i);
    assert.match(brainPrompts[0] || "", /"activeExercise": \{\s*"id": "triceps_polia_alta"/);
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
    assert.equal(first.activeContext.currentItem.quantity, "2 fatias");
    assert.ok(!("foodSubstitution" in first), "a decisão estruturada interna não pode vazar para o frontend");
    assert.doesNotMatch(first.fala || "", /\bou\b.*p[ãa]o|\bou\b.*biscoito/i);
    assert.doesNotMatch(first.fala || "", /\?|semana|viagem|agenda|treino/i);

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
    assert.notEqual(second.activeContext.currentItem.quantity, "80g");
    assert.doesNotMatch(second.fala || "", /\?|semana|viagem|agenda|treino/i);
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
    assert.equal(brainCalls, 3, "ocupação + as duas trocas alimentares devem passar pelo cérebro soberano");
    assert.match(brainPrompts[1] || "", /"activeContext": \{/);
    assert.match(brainPrompts[1] || "", /"type": "diet"/);
    assert.match(brainPrompts[2] || "", /"lastSuggestedId":/);
    assert.doesNotMatch(
      JSON.stringify({
        activeContext: afterReload.activeContext,
        substitutionContext: afterReload.substitutionContext,
        activeConversationContext: afterReload.activeConversationContext,
      }),
      /workout_substitution|eliptico|"kind":"exercise"/i,
    );
  });

  it("alimento novo explícito encerra a referência anterior e vira o contexto ativo", async () => {
    const openedAt = new Date().toISOString();
    const oatsItem = {
      id: "cafe:aveia em flocos",
      name: "Aveia em flocos",
      mealId: "cafe",
      mealName: "Café da manhã",
      quantity: "80g",
    };
    const dietContext = {
      id: "ctx-explicit-food-change",
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

    const send = (active: Record<string, any>, input: string, suffix: string) => post("/guto", {
      profile: { userId, name: "Will" },
      language: "pt-BR",
      history: [],
      input,
      turnId: `turn-explicit-food-${suffix}`,
      requestId: `request-explicit-food-${suffix}`,
      contextId: active.id,
      contextVersion: active.version,
      activeContextType: active.type,
      activeItemId: active.currentItem.id,
    });

    const oatsSwap = await send(dietContext, "não tenho aveia", "oats");
    assert.equal(oatsSwap.activeContext.originalItem.name, "Aveia em flocos");
    assert.equal(oatsSwap.activeContext.currentItem.id, "wholegrain_bread");

    const bananaSwap = await send(oatsSwap.activeContext, "não tem banana", "banana");
    assert.equal(bananaSwap.activeContext.type, "diet");
    assert.equal(bananaSwap.activeContext.originalItem.id, "banana");
    assert.equal(bananaSwap.activeContext.currentItem.id, "apple");
    assert.deepEqual(
      bananaSwap.activeContext.rejectedItems.map((item: any) => item.id),
      ["banana"],
    );
    assert.doesNotMatch(
      JSON.stringify(bananaSwap.activeContext),
      /wholegrain_bread|rice_cakes|aveia em flocos/i,
    );
    assert.match(brainPrompts[1] || "", /"explicitlyUnavailableFood": \{\s*"id": "banana"/);
  });

  it("rejeita 80g de pão quando a porção validada é 2 fatias", async () => {
    const openedAt = new Date().toISOString();
    const oatsItem = {
      id: "cafe:aveia",
      name: "Aveia",
      mealId: "cafe",
      mealName: "Café da manhã",
      quantity: "80g",
    };
    const dietContext = {
      id: "ctx-invalid-food-quantity",
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
    forcedFoodQuantity = "80g";

    const response = await post("/guto", {
      profile: { userId, name: "Will" },
      language: "pt-BR",
      history: [],
      input: "não tenho aveia",
      turnId: "turn-invalid-food-quantity",
      requestId: "request-invalid-food-quantity",
      contextId: dietContext.id,
      contextVersion: dietContext.version,
      activeContextType: dietContext.type,
      activeItemId: dietContext.currentItem.id,
    });

    assert.equal(response.acao, "none");
    assert.match(response.fala || "", /não vou inventar/i);
    assert.equal(response.activeContext.currentItem.id, oatsItem.id);
    assert.equal(response.activeContext.currentItem.quantity, "80g");
    assert.equal(response.activeContext.lastSuggestedItem, null);
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

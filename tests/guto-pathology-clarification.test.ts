import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

import { getCatalogById, getExerciseRiskTags } from "../exercise-catalog";

// Fase 3 — Bug 2: esclarecimento de dor no chat tem que FECHAR em treino.
// Fluxo real (iPhone): calibragem com limitação ambígua → GUTO pergunta →
// usuário responde "Tenho dor nas pernas" → o backend tem que normalizar como
// lower body, liberar o gate, gerar treino seguro, preencher lastWorkoutPlan e
// NÃO repetir a pergunta. Estes testes provam o ciclo fechado de ponta a ponta.

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.pathology-clarification-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearMemoryStoreCache: () => void = () => {};
let originalFetch: typeof globalThis.fetch;

function readMemoryStore() {
  if (!existsSync(testMemoryFile)) return {} as Record<string, any>;
  return JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>;
}

function readUserMemory(userId: string) {
  return readMemoryStore()[userId];
}

function writeUserMemory(userId: string, data: Record<string, any>) {
  const store = readMemoryStore();
  store[userId] = { userId, name: "Will", language: "pt-BR", ...data };
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2));
}

function buildGeminiResponse(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function extractPrompt(init?: RequestInit) {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  return String(body?.contents?.[0]?.parts?.[0]?.text || "");
}

type GutoResponse = {
  fala?: string;
  acao?: string;
  expectedResponse?: { type?: string; instruction?: string; context?: string } | null;
  workoutPlan?: { exercises?: Array<{ id?: string; videoUrl?: string; videoProvider?: string }> } | null;
};

// Mock do modelo: o turno do chat (prompt com "Mensagem atual do usuário")
// devolve o contrato do GUTO. A chamada do curador (sem esse marcador) cai no
// fallback determinístico de template no backend.
function installGeminiMock() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) {
      return originalFetch(input as any, init);
    }

    const prompt = extractPrompt(init);
    const isBrainTurn = prompt.includes("CÉREBRO SOBERANO V2");
    const inputMatch = prompt.match(/MENSAGEM DO USUÁRIO:\s*([\s\S]*)$/);
    const inputMsg = inputMatch ? inputMatch[1].trim().toLowerCase() : "";

    if (isBrainTurn && inputMsg.includes("dor nas pernas")) {
      // Esclarecimento da limitação → atualiza o campo certo + executa o treino.
      return new Response(
        JSON.stringify(buildGeminiResponse(JSON.stringify({
          fala: "Dor nas pernas anotada. Vou proteger e montar um treino seguro.",
          acao: "updateWorkout",
          expectedResponse: null,
          avatarEmotion: "reward",
          memoryPatch: {
            trainingPathology: "tenho dor nas pernas",
            acknowledgeClarification: "pathology",
          },
        }))),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (isBrainTurn && inputMsg.includes("bora treinar")) {
      return new Response(
        JSON.stringify(buildGeminiResponse(JSON.stringify({
          fala: "Bora. Treino montado na aba treino do dia.",
          acao: "updateWorkout",
          expectedResponse: null,
          avatarEmotion: "reward",
          memoryPatch: {},
        }))),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fallback (inclui chamada do curador): não fornece exercícios → backend usa
    // o template determinístico.
    return new Response(
      JSON.stringify(buildGeminiResponse(JSON.stringify({
        fala: "Me diz como está o corpo.",
        acao: "none",
        expectedResponse: { type: "text", context: null, instruction: "responder" },
      }))),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof globalThis.fetch;
}

async function postGuto(userId: string, input: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  const response = await originalFetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      language: "pt-BR",
      profile: { userId, name: "Will" },
      history: [],
      input,
    }),
  });
  assert.equal(response.status, 200, `POST /guto deveria responder 200, veio ${response.status}`);
  return (await response.json()) as GutoResponse;
}

const CLARIFICATION_RE = /não entendi direito|me explica melhor|colocou .* como limita/i;

const baseCalibration = {
  biologicalSex: "male",
  userAge: 30,
  heightCm: 178,
  weightKg: 80,
  trainingLevel: "beginner",
  trainingGoal: "fat_loss",
  preferredTrainingLocation: "home",
  trainingLocation: "home",
  // foco preferido upper body → treino gerado sobrevive ao filtro de perna
  nextWorkoutFocus: "chest_triceps",
};

describe("Fase 3 — esclarecimento de dor fecha em treino real", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    mkdirSync(tmpDir, { recursive: true });
    originalFetch = globalThis.fetch.bind(globalThis);
    installGeminiMock();

    const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
    };
    app = serverModule.app;

    const memStoreModule = (await import(
      pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href
    )) as { clearMemoryStoreCache: () => void };
    clearMemoryStoreCache = memStoreModule.clearMemoryStoreCache;

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind pathology test server.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    clearMemoryStoreCache();
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(testMemoryFile, { force: true });
  });

  it("'Tenho dor nas pernas' → atualiza memória, libera gate, gera treino seguro e preenche lastWorkoutPlan", async () => {
    const userId = "pathology-legs-flow";
    writeUserMemory(userId, {
      ...baseCalibration,
      // limitação ambígua pendente da calibragem
      trainingPathology: "Gambia",
      trainingLimitations: "Gambia",
      resolvedFields: {
        pathology: {
          field: "pathology",
          rawValue: "Gambia",
          rawValueHash: "seed",
          riskTags: ["user_declared", "physical_attention"],
          confidence: 0.4,
          status: "needs_confirmation",
          resolvedAt: new Date().toISOString(),
        },
      },
    });
    clearMemoryStoreCache();

    const res = await postGuto(userId, "Tenho dor nas pernas");

    // 1. Ação operacional concluída — não ficou preso no chat.
    assert.equal(res.acao, "updateWorkout");
    assert.doesNotMatch(res.fala || "", CLARIFICATION_RE, "não pode repetir a pergunta de limitação");
    assert.ok((res.workoutPlan?.exercises?.length || 0) > 0, "deve devolver treino com exercícios");

    const memory = readUserMemory(userId);
    // 2. Persistiu no campo correto de limitação física + normalização conservadora.
    assert.match(memory.trainingPathology, /perna/i);
    assert.equal(memory.resolvedFields?.pathology?.status, "clear");
    assert.equal(memory.resolvedFields?.pathology?.normalizedValue, "lower_body_sensitive");
    // 3. Missão deixa de ficar vazia: lastWorkoutPlan preenchido.
    assert.ok(memory.lastWorkoutPlan, "lastWorkoutPlan deve ser preenchido");
    assert.ok((memory.lastWorkoutPlan.exercises?.length || 0) > 0);

    // 4. Filtro determinístico de segurança: nada agressivo de perna/joelho/quadril/tornozelo.
    for (const ex of memory.lastWorkoutPlan.exercises as Array<{ id: string; videoUrl?: string; videoProvider?: string }>) {
      const entry = getCatalogById(ex.id);
      assert.ok(entry, `${ex.id} deve existir no catálogo oficial`);
      const tags = getExerciseRiskTags(entry!);
      assert.ok(
        !tags.includes("knee") && !tags.includes("hip") && !tags.includes("ankle"),
        `${ex.id} não pode estressar a perna com dor declarada`
      );
      // 5. Gate de vídeo local mantido.
      assert.ok(ex.videoUrl && ex.videoUrl.startsWith("/exercise/visuals/"), `${ex.id} precisa de vídeo local`);
    }
  });

  it("depois de registrar a dor, o GUTO NÃO repete a pergunta no turno seguinte", async () => {
    const userId = "pathology-legs-no-repeat";
    writeUserMemory(userId, {
      ...baseCalibration,
      trainingPathology: "Gambia",
      trainingLimitations: "Gambia",
      resolvedFields: {
        pathology: {
          field: "pathology",
          rawValue: "Gambia",
          rawValueHash: "seed",
          riskTags: ["user_declared", "physical_attention"],
          confidence: 0.4,
          status: "needs_confirmation",
          resolvedAt: new Date().toISOString(),
        },
      },
    });
    clearMemoryStoreCache();

    // Turno 1: esclarece a dor → registra e executa.
    const first = await postGuto(userId, "Tenho dor nas pernas");
    assert.equal(first.acao, "updateWorkout");
    assert.equal(readUserMemory(userId)?.resolvedFields?.pathology?.status, "clear");

    // Turno 2: pede treino de novo → NÃO pode reabrir a pergunta da limitação.
    const second = await postGuto(userId, "Bora treinar hoje");
    assert.notEqual(second.expectedResponse?.context, "training_limitations");
    assert.doesNotMatch(second.fala || "", CLARIFICATION_RE);
    assert.equal(second.acao, "updateWorkout");
    assert.ok((second.workoutPlan?.exercises?.length || 0) > 0);
  });
});

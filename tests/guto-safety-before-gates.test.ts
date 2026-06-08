import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

// P0 — Segurança antes dos gates. Reproduz o bug VIVO encontrado no chat real:
// o GUTO ficava preso em gates determinísticos (abertura semanal / calibragem)
// e ignorava o relato de dor — chegando a perguntar "tem dor ou limitação?"
// logo depois do usuário dizer "tenho dor no joelho". A correção roda o
// risk-classifier e captura a limitação ANTES de qualquer gate.

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.safety-before-gates-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearMemoryStoreCache: () => void = () => {};
let originalFetch: typeof globalThis.fetch;

function readMemoryStore(): Record<string, any> {
  if (!existsSync(testMemoryFile)) return {};
  return JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>;
}
function readUserMemory(userId: string) {
  return readMemoryStore()[userId];
}
function writeUserMemory(userId: string, data: Record<string, any>) {
  const store = readMemoryStore();
  store[userId] = { userId, name: "Bia", language: "pt-BR", ...data };
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2));
}

function buildGeminiResponse(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}
function extractPrompt(init?: RequestInit) {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  return String(body?.contents?.[0]?.parts?.[0]?.text || "");
}

// Mock do Gemini: distingue o classificador de risco, o turno do cérebro e o
// fallback (curador / contract-intent → template determinístico no backend).
function installGeminiMock() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) {
      return originalFetch(input as any, init);
    }
    const prompt = extractPrompt(init);

    // 1) Classificador de risco — formato {flag, confidence, reasoning}.
    // Extrai SÓ o input do usuário (após "USER MESSAGE TO CLASSIFY:"), nunca as
    // instruções do prompt — senão "swelling" das instruções marcaria tudo agudo.
    if (prompt.includes("Possible flags")) {
      const m = prompt.match(/USER MESSAGE TO CLASSIFY:\s*("(?:[^"\\]|\\.)*")/);
      let userMsg = "";
      try {
        userMsg = m ? String(JSON.parse(m[1])).toLowerCase() : "";
      } catch {
        userMsg = "";
      }
      const acute = /estalou|inchou|incha[çc]|n[ãa]o consigo apoiar/.test(userMsg);
      const payload = acute
        ? { flag: "trauma_acute", confidence: 0.92, reasoning: "pop + swelling, cannot bear weight" }
        : { flag: null, confidence: 0, reasoning: "chronic/mechanical knee pain, not acute" };
      return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify(payload))), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2) Turno do cérebro — o modelo tenta atualizar o treino (aciona o gate).
    if (prompt.includes("Mensagem atual do usuário")) {
      return new Response(
        JSON.stringify(
          buildGeminiResponse(
            JSON.stringify({
              fala: "Anotado. Vou montar respeitando isso.",
              acao: "updateWorkout",
              expectedResponse: null,
              avatarEmotion: "default",
              memoryPatch: {},
            })
          )
        ),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3) Fallback (curador etc.) — sem exercícios → backend usa template.
    return new Response(
      JSON.stringify(buildGeminiResponse(JSON.stringify({ fala: "ok", acao: "none", expectedResponse: null }))),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof globalThis.fetch;
}

type GutoResponse = {
  fala?: string;
  acao?: string;
  expectedResponse?: { type?: string; instruction?: string; context?: string } | null;
  workoutPlan?: { exercises?: Array<unknown> } | null;
  avatarEmotion?: string;
};

async function postGuto(userId: string, input: string, expectedResponse?: unknown) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  const response = await originalFetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "pt-BR", history: [], input, expectedResponse }),
  });
  assert.equal(response.status, 200, `POST /guto deveria responder 200, veio ${response.status}`);
  return (await response.json()) as GutoResponse;
}

// Gate de "dor/limitação" em qualquer idioma — o GUTO NÃO pode responder isto
// logo depois de o usuário relatar dor.
const PAIN_GATE_RE = /tem dor ou limita|any pain or limitation|dolore o limite/i;

// Tudo calibrado EXCETO a limitação corporal: força o gate de dor (1544) a ser
// o próximo a disparar — exatamente o estado do bug vivo.
const calibratedExceptLimitation = {
  biologicalSex: "female",
  userAge: 28,
  heightCm: 165,
  weightKg: 62,
  trainingLevel: "intermediate",
  trainingStatus: "treinando",
  trainingGoal: "consistency",
  preferredTrainingLocation: "home",
  trainingLocation: "home",
  hasSeenChatOpening: true,
  nextWorkoutFocus: "chest_triceps",
};

describe("P0 — segurança/limitação antes dos gates", () => {
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
    if (!address || typeof address === "string") throw new Error("Failed to bind safety test server.");
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

  it("calibragem incompleta + 'dor forte no joelho' → captura limitação e NÃO pergunta 'tem dor?'", async () => {
    const userId = "safety-incomplete-calibration";
    writeUserMemory(userId, calibratedExceptLimitation);
    clearMemoryStoreCache();

    const res = await postGuto(userId, "tô com dor forte no joelho direito quando dobro");

    const mem = readUserMemory(userId);
    assert.ok(
      mem.trainingLimitations && /joelho/i.test(mem.trainingLimitations),
      `trainingLimitations deveria capturar a dor no joelho, veio: ${JSON.stringify(mem.trainingLimitations)}`
    );
    assert.ok(
      !PAIN_GATE_RE.test(res.fala || ""),
      `GUTO não pode repetir o gate de dor depois do relato. Fala: ${res.fala}`
    );
  });

  it("preso na abertura semanal + 'tô sentindo dor no joelho' → captura limitação, sem loop de gate", async () => {
    const userId = "safety-weekly-opening";
    // hasSeenChatOpening=true + sem weeklyConversation → estado de abertura semanal.
    writeUserMemory(userId, { ...calibratedExceptLimitation, trainedToday: false });
    clearMemoryStoreCache();

    const res = await postGuto(userId, "tô sentindo dor no joelho");

    const mem = readUserMemory(userId);
    assert.ok(
      mem.trainingLimitations && /joelho/i.test(mem.trainingLimitations),
      `trainingLimitations deveria capturar a dor mesmo na abertura semanal, veio: ${JSON.stringify(mem.trainingLimitations)}`
    );
    assert.ok(!PAIN_GATE_RE.test(res.fala || ""), `Não pode repetir o gate de dor. Fala: ${res.fala}`);
  });

  it("responde 'sim, tenho dor no joelho' AO gate de dor → preenche memória, não repete a pergunta", async () => {
    const userId = "safety-answering-pain-gate";
    writeUserMemory(userId, calibratedExceptLimitation);
    clearMemoryStoreCache();

    // Simula o usuário respondendo exatamente o gate de limitação.
    const res = await postGuto(userId, "sim, tenho dor no joelho direito", {
      type: "text",
      context: "training_limitations",
      instruction: "Responder dor/limitação ou dizer que está livre.",
    });

    const mem = readUserMemory(userId);
    assert.ok(
      mem.trainingLimitations && /joelho/i.test(mem.trainingLimitations),
      `A resposta do usuário ao gate deve preencher trainingLimitations, veio: ${JSON.stringify(mem.trainingLimitations)}`
    );
    assert.ok(
      !PAIN_GATE_RE.test(res.fala || ""),
      `Não pode re-perguntar "tem dor?" depois de "tenho dor". Fala: ${res.fala}`
    );
  });

  it("risco AGUDO (joelho estalou e inchou) → suspende treino e responde segurança", async () => {
    const userId = "safety-acute-trauma";
    writeUserMemory(userId, calibratedExceptLimitation);
    clearMemoryStoreCache();

    const res = await postGuto(userId, "o joelho estalou e inchou agora, não consigo apoiar");

    assert.equal(res.acao, "none", "risco agudo não pode gerar/atualizar treino");
    assert.ok(!res.workoutPlan, "risco agudo não pode devolver plano de treino");
    assert.ok(
      /n[ãa]o tem treino|para tudo|cuidado|avalia/i.test(res.fala || ""),
      `Esperava resposta de segurança suspendendo o treino. Fala: ${res.fala}`
    );
    const mem = readUserMemory(userId);
    assert.ok(
      mem.trainingLimitations && /joelho/i.test(mem.trainingLimitations),
      "a limitação relatada deve ser salva mesmo no caminho de risco agudo"
    );
  });
});

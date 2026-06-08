import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

// P0 — Dor NOVA relatada no chat deve ATUALIZAR a memória mesmo quando a
// calibragem anterior tinha "sem dor"/"nenhuma"/"livre"/"no pain"/"nessun dolore".
// Antes, o backend tratava "sem dor" como campo preenchido e ignorava a dor nova,
// então o treino futuro podia não adaptar.

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.new-pain-updates-test.json");

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

// Mock: risco SEMPRE null (dores mecânicas, não agudas); turno do cérebro tenta
// treino; fallback genérico.
function installGeminiMock() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return originalFetch(input as any, init);
    const prompt = extractPrompt(init);
    if (prompt.includes("Possible flags")) {
      return new Response(
        JSON.stringify(buildGeminiResponse(JSON.stringify({ flag: null, confidence: 0, reasoning: "mechanical pain, not acute" }))),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (prompt.includes("Mensagem atual do usuário")) {
      return new Response(
        JSON.stringify(buildGeminiResponse(JSON.stringify({ fala: "Anotado, vou respeitar.", acao: "updateWorkout", expectedResponse: null, avatarEmotion: "default", memoryPatch: {} }))),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify({ fala: "ok", acao: "none", expectedResponse: null }))), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
}

async function postGuto(userId: string, input: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  const response = await originalFetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "pt-BR", history: [], input }),
  });
  assert.equal(response.status, 200, `POST /guto deveria responder 200, veio ${response.status}`);
  return response.json();
}

const baseCalibration = {
  biologicalSex: "female",
  userAge: 28,
  heightCm: 165,
  weightKg: 62,
  trainingLevel: "consistent",
  trainingStatus: "consistent",
  trainingGoal: "consistency",
  preferredTrainingLocation: "home",
  trainingLocation: "home",
  hasSeenChatOpening: true,
};

// Plano não travado pelo coach — deve ser invalidado quando a limitação muda.
const sampleWorkout = { focusKey: "legs_core", source: "guto_generated", lockedByCoach: false, exercises: [{ id: "agachamento_livre" }] };

describe("P0 — dor nova atualiza memória sobre 'sem dor'", () => {
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
    const memStoreModule = (await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as { clearMemoryStoreCache: () => void };
    clearMemoryStoreCache = memStoreModule.clearMemoryStoreCache;
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind pain-update test server.");
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

  it("1) calibrado 'sem dor' relata dor no joelho → memória atualiza e treino é invalidado p/ adaptar", async () => {
    const userId = "pain-knee-over-nopain";
    writeUserMemory(userId, { ...baseCalibration, trainingLimitations: "sem dor", trainingPathology: "sem dor", lastWorkoutPlan: sampleWorkout });
    clearMemoryStoreCache();

    await postGuto(userId, "estou com dor no joelho direito");

    const mem = readUserMemory(userId);
    assert.ok(/joelho/i.test(mem.trainingLimitations || ""), `trainingLimitations deveria virar joelho, veio: ${JSON.stringify(mem.trainingLimitations)}`);
    assert.ok(!/^sem dor$/i.test((mem.trainingLimitations || "").trim()), "não pode continuar 'sem dor'");
    // Regra 4: o treino legs_core (que estressa o joelho) tem que adaptar/recalcular.
    assert.notEqual(mem.lastWorkoutPlan?.focusKey, "legs_core", "treino deve recalcular para longe do joelho (regra 4)");
  });

  it("2) calibrado 'nenhuma limitação' relata dor no ombro → memória atualiza para ombro", async () => {
    const userId = "pain-shoulder-over-none";
    writeUserMemory(userId, { ...baseCalibration, trainingLimitations: "nenhuma limitação", trainingPathology: "nenhuma limitação" });
    clearMemoryStoreCache();

    await postGuto(userId, "tô com dor no ombro esquerdo");

    const mem = readUserMemory(userId);
    assert.ok(/ombro/i.test(mem.trainingLimitations || ""), `deveria virar ombro, veio: ${JSON.stringify(mem.trainingLimitations)}`);
  });

  it("3) já tinha limitação real no joelho, relata ombro → não perde joelho, registra ombro também", async () => {
    const userId = "pain-append-real-limitation";
    writeUserMemory(userId, { ...baseCalibration, trainingLimitations: "dor crônica no joelho direito", trainingPathology: "dor crônica no joelho direito" });
    clearMemoryStoreCache();

    await postGuto(userId, "agora também tô com dor no ombro");

    const mem = readUserMemory(userId);
    const lim = (mem.trainingLimitations || "").toLowerCase();
    assert.ok(lim.includes("joelho"), `não pode perder o joelho, veio: ${JSON.stringify(mem.trainingLimitations)}`);
    assert.ok(lim.includes("ombro"), `deveria registrar o ombro também, veio: ${JSON.stringify(mem.trainingLimitations)}`);
  });

  it("4) diz 'sem dor' no chat → NÃO cria limitação falsa", async () => {
    const userId = "pain-says-no-pain";
    writeUserMemory(userId, { ...baseCalibration, trainingLimitations: "sem dor", trainingPathology: "sem dor" });
    clearMemoryStoreCache();

    await postGuto(userId, "hoje tô sem dor nenhuma, livre");

    const mem = readUserMemory(userId);
    const clearRe = /sem dor|nenhuma|livre|no pain|nessun/i;
    assert.ok(clearRe.test(mem.trainingLimitations || "sem dor"), `não pode virar limitação real, veio: ${JSON.stringify(mem.trainingLimitations)}`);
    assert.ok(!/joelho|ombro|lombar/i.test(mem.trainingLimitations || ""), "não pode inventar parte do corpo");
  });

  it("5) multilíngue: 'no pain' / 'nessun dolore' não viram limitação", async () => {
    for (const [userId, lang, msg] of [
      ["pain-en", "en-US", "today I have no pain, all clear"],
      ["pain-it", "it-IT", "oggi nessun dolore"],
    ] as const) {
      writeUserMemory(userId, { ...baseCalibration, language: lang, trainingLimitations: "sem dor", trainingPathology: "sem dor" });
      clearMemoryStoreCache();
      const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
      const res = await originalFetch(`${baseUrl}/guto`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ language: lang, history: [], input: msg }),
      });
      assert.equal(res.status, 200);
      const mem = readUserMemory(userId);
      assert.ok(!/joelho|ombro|knee|shoulder|ginocchio|spalla/i.test(mem.trainingLimitations || ""), `${lang}: 'no pain' não pode virar limitação, veio: ${JSON.stringify(mem.trainingLimitations)}`);
    }
  });
});

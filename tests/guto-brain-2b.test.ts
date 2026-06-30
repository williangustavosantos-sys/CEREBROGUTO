// Fatia 2B — testes ARQUITETURAIS (determinísticos, stub do modelo).
// O cérebro possui updateWorkout: executa o plano, preserva a fala, sem askGutoModel.
import "./test-env.js";
process.env.GEMINI_API_KEY = "test-key-2b";
process.env.GUTO_CURATOR_MAX_ATTEMPTS = "1"; // curador stub falha → fallback template (rápido)
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

const dir = join(process.cwd(), "tmp");
const file = join(dir, "guto-memory.brain-2b-test.json");
const MARKER = "FALA_2B_DO_CEREBRO";
const KNOWN_MARKER = "DADOS JÁ NA MEMÓRIA";

const consoleErrors: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { consoleErrors.push(a.map(String).join(" ")); };

const originalFetch = globalThis.fetch;
let callsByKind: Record<string, number> = {};
let lastBrainBody = "";
let stubPayload: Record<string, unknown> = { flag: null, confidence: 0, fala: MARKER, acao: "updateWorkout", expectedResponse: null, memoryPatch: { nextWorkoutFocus: "chest_triceps" } };

function installFetchStub() {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.includes("generativelanguage")) {
      const body = String(init?.body ?? "");
      let kind = "other";
      if (body.includes("strict semantic safety classifier")) kind = "risk";
      else if (body.includes("semantic contract classifier")) kind = "contractIntent";
      else if (body.includes("VOCÊ É GUTO")) { kind = "brain"; lastBrainBody = body; }
      else kind = "curator"; // curador ou outros
      callsByKind[kind] = (callsByKind[kind] || 0) + 1;
      return {
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(stubPayload) }] } }] }),
      } as unknown as Response;
    }
    return originalFetch(url as RequestInfo, init as RequestInit);
  }) as typeof fetch;
}

let app: { listen: (p: number, h: string, cb?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearCache: () => void = () => {};
let setBrainSlice1: (on: boolean) => void;

// Perfil COMPLETO (trainingStatus + userAge + trainingLimitations) → missingFields=[].
const COMPLETE = {
  name: "Will", language: "pt-BR", biologicalSex: "male", userAge: 33, heightCm: 178, weightKg: 80,
  trainingLevel: "consistent", trainingStatus: "consistent", trainingGoal: "muscle_gain",
  preferredTrainingLocation: "home", trainingLocation: "home", trainingPathology: "sem dor",
  trainingLimitations: "sem dor", initialXpGranted: true, totalXp: 100, streak: 5,
};
function seed(userId: string, over: Record<string, unknown> = {}) {
  const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  store[userId] = { userId, ...COMPLETE, ...over };
  writeFileSync(file, JSON.stringify(store, null, 2));
  clearCache();
}
function readMem(userId: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"))[userId] || {};
}
async function chat(userId: string, input: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  callsByKind = {}; lastBrainBody = ""; const e0 = consoleErrors.length;
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "pt-BR", history: [], input }),
  });
  const body = (await r.json()) as Record<string, any>;
  const headerErr = consoleErrors.slice(e0).some((x) => /ERR_HTTP_HEADERS_SENT|Cannot set headers/i.test(x));
  return { status: r.status, body, headerErr };
}
const META_KEYS = ["validation", "meta", "kind", "via", "reasoning", "modelCalled", "persisted"];

describe("Fatia 2B — cérebro possui updateWorkout (execução de treino)", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = file;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({}, null, 2));
    installFetchStub();
    const mod = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as { app: typeof app };
    app = mod.app;
    clearCache = ((await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as { clearMemoryStoreCache: () => void }).clearMemoryStoreCache;
    const cfg = ((await import(pathToFileURL(join(process.cwd(), "src/config.ts")).href)) as { config: { brainSlice1: boolean } }).config;
    setBrainSlice1 = (on) => { cfg.brainSlice1 = on; };
    await new Promise<void>((resolve, reject) => { server = app.listen(0, "127.0.0.1", () => resolve()); server.once("error", reject); });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(() => {
    stubPayload = { flag: null, confidence: 0, fala: MARKER, acao: "updateWorkout", expectedResponse: null, memoryPatch: { nextWorkoutFocus: "chest_triceps" } };
    setBrainSlice1(false);
  });
  after(async () => {
    globalThis.fetch = originalFetch; console.error = origErr;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(file, { force: true });
  });

  it("flag OFF: updateWorkout continua legado (askGutoModel/contractIntent)", async () => {
    setBrainSlice1(false);
    seed("2b-off");
    const { status, body } = await chat("2b-off", "bora treinar");
    assert.equal(status, 200);
    assert.ok((callsByKind.contractIntent || 0) >= 1, "flag OFF mantém o legado");
    assert.ok(!lastBrainBody.includes(KNOWN_MARKER), "legado não recebe a diretriz 2A/2B");
  });

  it("perfil completo + updateWorkout → cérebro EXECUTA (sem askGutoModel) e preserva a fala", async () => {
    setBrainSlice1(true);
    seed("2b-exec");
    const { status, body, headerErr } = await chat("2b-exec", "bora treinar");
    assert.equal(status, 200);
    assert.equal(body.acao, "updateWorkout");
    assert.equal(body.fala, MARKER, "a fala do cérebro é PRESERVADA (sem template legado)");
    assert.equal(callsByKind.contractIntent || 0, 0, "cérebro possui: askGutoModel NÃO roda");
    assert.ok(body.workoutPlan && Array.isArray(body.workoutPlan.exercises) && body.workoutPlan.exercises.length > 0, "executor gerou o plano");
    assert.equal(headerErr, false, "sem resposta dupla");
    for (const k of META_KEYS) assert.ok(!(k in body), `meta não pode vazar: ${k}`);
    // persistência: o plano foi gravado na memória (lastWorkoutPlan).
    const mem = readMem("2b-exec") as any;
    assert.ok(mem.lastWorkoutPlan && mem.lastWorkoutPlan.exercises?.length > 0, "memory.lastWorkoutPlan persistido");
  });

  it("L3 não altera a fala de updateWorkout (atalho do cérebro)", async () => {
    setBrainSlice1(true);
    const fala = "Fechado, foco em peito. Stiff ou Mesa Flexora, qual prefere? Bora.";
    stubPayload = { flag: null, confidence: 0, fala, acao: "updateWorkout", expectedResponse: null, memoryPatch: { nextWorkoutFocus: "chest_triceps" } };
    seed("2b-l3");
    const { body } = await chat("2b-l3", "bora treinar");
    assert.equal(body.fala, fala, "L3 não pode reescrever a fala do cérebro em updateWorkout");
    assert.equal(body.acao, "updateWorkout");
  });

  it("perfil INCOMPLETO + updateWorkout → defer ao legado (não executa às cegas)", async () => {
    setBrainSlice1(true);
    seed("2b-incompleto", { trainingLimitations: "", trainingStatus: "", userAge: undefined });
    const { status } = await chat("2b-incompleto", "bora treinar");
    assert.equal(status, 200);
    assert.ok((callsByKind.contractIntent || 0) >= 1, "perfil incompleto → defer ao legado");
  });

  it("perfil INCOMPLETO + cérebro pergunta (acao:none) → possui, sem template legado", async () => {
    setBrainSlice1(true);
    stubPayload = { flag: null, confidence: 0, fala: "Antes de montar: você tá voltando, parado ou em ritmo?", acao: "none", expectedResponse: null };
    seed("2b-pergunta", { trainingLimitations: "", trainingStatus: "", userAge: undefined });
    const { body } = await chat("2b-pergunta", "bora treinar");
    assert.equal(body.acao, "none");
    assert.equal(body.fala, "Antes de montar: você tá voltando, parado ou em ritmo?");
    assert.equal(callsByKind.contractIntent || 0, 0, "cérebro pergunta na própria voz — sem legado");
  });

  it("perfil completo → diretriz informa dados conhecidos (não reperguntar)", async () => {
    setBrainSlice1(true);
    seed("2b-known");
    await chat("2b-known", "bora treinar");
    assert.ok(lastBrainBody.includes(KNOWN_MARKER), "o prompt do cérebro lista os dados já na memória");
  });

  it("limitação conhecida (joelho) → executor roda e plano é gerado/persistido", async () => {
    setBrainSlice1(true);
    seed("2b-knee", { trainingLimitations: "dor no joelho", trainingPathology: "dor no joelho" });
    const { body } = await chat("2b-knee", "bora treinar perna");
    assert.equal(body.acao, "updateWorkout");
    assert.ok(body.workoutPlan?.exercises?.length > 0, "executor respeitou e gerou plano com limitação");
    const mem = readMem("2b-knee") as any;
    assert.equal(mem.trainingLimitations, "dor no joelho", "limitação preservada na memória");
  });

  it("ação fora de escopo (generateDiet) → cérebro NÃO executa (defer)", async () => {
    setBrainSlice1(true);
    stubPayload = { flag: null, confidence: 0, fala: "vou montar tua dieta", acao: "generateDiet", expectedResponse: null };
    seed("2b-diet");
    const { status, body } = await chat("2b-diet", "monta minha dieta");
    assert.equal(status, 200);
    // 2B só executa updateWorkout. generateDiet defere (validateContract) → tratado
    // fora do cérebro (gate de dieta ou askGutoModel) — nunca executa treino.
    assert.ok(!(body.acao === "updateWorkout" && body.workoutPlan), "o cérebro NÃO pode executar treino para um pedido de dieta");
  });
});

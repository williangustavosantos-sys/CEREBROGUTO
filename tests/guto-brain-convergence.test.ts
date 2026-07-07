import "./test-env.js";
process.env.GEMINI_API_KEY = "test-key-convergence";
process.env.OPENAI_API_KEY = "test-openai-key-convergence";
process.env.VOICE_API_KEY = "";
process.env.PORT = "3001";
process.env.GUTO_CURATOR_MAX_ATTEMPTS = "1";
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { getCatalogById, suggestExerciseSubstitutes, validateExerciseSubstitute } from "../exercise-catalog.js";

const dir = join(process.cwd(), "tmp");
const file = join(dir, "guto-memory.brain-convergence-test.json");
const dietFile = join(dir, "guto-diet.brain-convergence-test.json");
const MARKER = "FALA_CONVERGENCIA_CEREBRO";
const META_KEYS = ["validation", "meta", "kind", "via", "reasoning", "modelCalled", "persisted"];

const originalFetch = globalThis.fetch;
let callsByKind: Record<string, number> = {};
let stubPayload: Record<string, unknown> = {
  flag: null,
  confidence: 0,
  fala: MARKER,
  acao: "none",
  expectedResponse: null,
};
let transcriptStub = "oi pelo audio";

function installFetchStub() {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (/^http:\/\/localhost:3001\/voz\b/.test(u)) {
      callsByKind.localVoice = (callsByKind.localVoice || 0) + 1;
      throw new Error("/guto-audio não deve depender de localhost:3001/voz");
    }
    if (u.includes("api.openai.com/v1/audio/transcriptions")) {
      callsByKind.transcription = (callsByKind.transcription || 0) + 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: transcriptStub }),
      } as unknown as Response;
    }
    if (u.includes("generativelanguage")) {
      const body = String(init?.body ?? "");
      let kind = "other";
      if (body.includes("strict semantic safety classifier")) kind = "risk";
      else if (body.includes("semantic contract classifier")) kind = "contractIntent";
      else if (body.includes("CÉREBRO SOBERANO V2")) kind = "brain";
      else if (body.includes("Regra de ouro: sempre mantenha o usuário dentro da dieta") || body.includes("VOCÊ É GUTO.\nNão é assistente")) kind = "legacyBrain";
      else if (body.includes("meal") || body.includes("calories") || body.includes("macros")) kind = "diet";
      else kind = "executorModel";
      callsByKind[kind] = (callsByKind[kind] || 0) + 1;
      return {
        ok: true,
        status: 200,
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

const COMPLETE = {
  name: "Will",
  language: "pt-BR",
  biologicalSex: "male",
  userAge: 33,
  heightCm: 178,
  weightKg: 80,
  trainingLevel: "consistent",
  trainingStatus: "consistent",
  trainingGoal: "muscle_gain",
  preferredTrainingLocation: "gym",
  trainingLocation: "gym",
  trainingPathology: "sem dor",
  trainingLimitations: "sem dor",
  country: "Brasil",
  countryCode: "BR",
  city: "São Paulo",
  foodRestrictions: "sem lactose",
  initialXpGranted: true,
  totalXp: 100,
  streak: 5,
};

function abdutoraPlan() {
  const ex = getCatalogById("cadeira_abdutora")!;
  return {
    focus: "Treino",
    focusKey: "legs_core",
    dateLabel: "Hoje",
    scheduledFor: new Date().toISOString(),
    summary: "",
    location: "academia",
    exercises: [{
      id: ex.id,
      name: ex.canonicalNamePt,
      canonicalNamePt: ex.canonicalNamePt,
      muscleGroup: ex.muscleGroup,
      sets: 3,
      reps: "12",
      rest: "60s",
      cue: "",
      note: "",
      videoUrl: ex.videoUrl,
      videoProvider: "local",
      sourceFileName: ex.sourceFileName,
    }],
  };
}

function validAbdutoraSubstituteName(): string {
  const orig = getCatalogById("cadeira_abdutora")!;
  const entry = suggestExerciseSubstitutes("cadeira_abdutora", { location: "gym", userRiskTags: [], userBodyRegion: undefined })
    .map((id) => getCatalogById(id))
    .find((candidate) => candidate && validateExerciseSubstitute(orig, candidate).valid);
  assert.ok(entry, "precisa existir substituto válido para cadeira_abdutora");
  return entry.canonicalNamePt;
}

function seed(userId: string, over: Record<string, unknown> = {}) {
  const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  store[userId] = { userId, ...COMPLETE, ...over };
  writeFileSync(file, JSON.stringify(store, null, 2));
  clearCache();
}

function readMem(userId: string): Record<string, any> {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"))[userId] || {};
}

async function chat(userId: string, input: string, language = "pt-BR") {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  callsByKind = {};
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language, history: [], input }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

async function audioChat(userId: string, language = "pt-BR") {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  callsByKind = {};
  const form = new FormData();
  form.append("language", language);
  form.append("audio", new Blob([new Uint8Array(1200).fill(1)], { type: "audio/webm" }), "voice.webm");
  const r = await fetch(`${baseUrl}/guto-audio`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

describe("Convergência arquitetural — cérebro soberano principal", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = file;
    process.env.GUTO_DIET_FILE = dietFile;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({}, null, 2));
    writeFileSync(dietFile, JSON.stringify({}, null, 2));
    installFetchStub();
    const mod = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as { app: typeof app };
    app = mod.app;
    clearCache = ((await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as { clearMemoryStoreCache: () => void }).clearMemoryStoreCache;
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  beforeEach(() => {
    stubPayload = { flag: null, confidence: 0, fala: MARKER, acao: "none", expectedResponse: null };
    transcriptStub = "oi pelo audio";
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(file, { force: true });
    rmSync(dietFile, { force: true });
  });

  it("/guto não chama askGutoModel/classifyContractIntent e não vaza meta", async () => {
    seed("conv-none");
    const { status, body } = await chat("conv-none", "oi");
    assert.equal(status, 200);
    assert.equal(body.fala, MARKER);
    assert.equal(callsByKind.contractIntent || 0, 0);
    for (const key of META_KEYS) assert.ok(!(key in body), `meta não pode vazar: ${key}`);
  });

  it("smoke /guto em ambiente production-like não depende de listener local em :3001", async () => {
    seed("conv-vercel-smoke");
    assert.notEqual(new URL(baseUrl).port, "3001", "teste deve usar porta efêmera, não o processo local :3001");
    const { status, body } = await chat("conv-vercel-smoke", "oi no vercel");
    assert.equal(status, 200);
    assert.equal(body.fala, MARKER);
    assert.equal(callsByKind.brain || 0, 1);
    assert.equal(callsByKind.contractIntent || 0, 0);
    assert.equal(callsByKind.legacyBrain || 0, 0);
    for (const key of META_KEYS) assert.ok(!(key in body), `meta não pode vazar: ${key}`);
  });

  it("/guto-audio usa transcrição como input soberano, sem prompt legado nem resposta dupla", async () => {
    transcriptStub = "estou feliz pelo audio";
    seed("conv-audio");
    const { status, body } = await audioChat("conv-audio");
    assert.equal(status, 200);
    assert.equal(body.transcript, transcriptStub);
    assert.equal(body.fala, MARKER);
    assert.equal(body.acao, "none");
    assert.equal(callsByKind.transcription || 0, 1);
    assert.equal(callsByKind.brain || 0, 1);
    assert.equal(callsByKind.contractIntent || 0, 0);
    assert.equal(callsByKind.legacyBrain || 0, 0);
    assert.equal(callsByKind.localVoice || 0, 0);
    assert.ok(!("error" in body), "não pode gerar payload duplo com error + fala");
    for (const key of META_KEYS) assert.ok(!(key in body), `meta não pode vazar: ${key}`);
  });

  it("flag OFF não quebra nem reativa o legado", async () => {
    const cfg = ((await import(pathToFileURL(join(process.cwd(), "src/config.ts")).href)) as { config: { brainSlice1: boolean } }).config;
    cfg.brainSlice1 = false;
    seed("conv-flag-off");
    const { body } = await chat("conv-flag-off", "estou feliz");
    assert.equal(body.fala, MARKER);
    assert.equal(callsByKind.contractIntent || 0, 0);
  });

  it("generateDiet não vira legado e executa com fallback determinístico validado quando o modelo falha", async () => {
    stubPayload = { flag: null, confidence: 0, fala: "vou montar tua dieta", acao: "generateDiet", expectedResponse: null };
    seed("conv-diet");
    const { body } = await chat("conv-diet", "quero dieta");
    assert.equal(callsByKind.contractIntent || 0, 0);
    assert.equal(body.acao, "generateDiet");
    assert.ok(!body.workoutPlan, "pedido de dieta não pode virar treino");
  });

  it("swapExercise não vira resolver L1 e preserva a fala em troca válida", async () => {
    const sub = validAbdutoraSubstituteName();
    const fala = `Troca por ${sub}, mesma missão sem irritar o movimento.`;
    stubPayload = { flag: null, confidence: 0, fala, acao: "swapExercise", expectedResponse: null };
    seed("conv-swap", {
      lastWorkoutPlan: abdutoraPlan(),
      activeExercise: { source: "chat", name: "Cadeira abdutora", updatedAt: new Date().toISOString() },
    });
    const { body } = await chat("conv-swap", "quero trocar esse exercício");
    assert.equal(callsByKind.contractIntent || 0, 0);
    assert.equal(body.fala, fala);
    assert.equal(body.acao, "swapExercise");
    assert.ok(body.workoutPlan?.exercises?.some((ex: any) => ex.name === sub));
  });

  it("openProactiveCard preserva fala do cérebro e cria trilho proativo sem template hardcoded", async () => {
    stubPayload = { flag: null, confidence: 0, fala: "Viagem amanhã anotada. Eu adapto o caminho sem compensação maluca.", acao: "openProactiveCard", expectedResponse: null };
    seed("conv-proactive");
    const { body } = await chat("conv-proactive", "viajo amanhã");
    assert.equal(callsByKind.contractIntent || 0, 0);
    assert.equal(body.fala, "Viagem amanhã anotada. Eu adapto o caminho sem compensação maluca.");
    assert.equal(body.acao, "openProactiveCard");
    const mem = readMem("conv-proactive");
    assert.ok(Array.isArray(mem.proactiveMemories) && mem.proactiveMemories.length > 0, "card proativo criado como executor/trilho");
  });

  it("openProactiveCard não cria memória a partir de prompt interno do scheduler", async () => {
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Cheguei, PIETRO. Eu olho tua semana e sigo contigo.",
      acao: "openProactiveCard",
      expectedResponse: null,
    };
    seed("conv-proactive-internal");
    const internalInput = [
      "Evento proativo devido: arrival.",
      "Decida a fala e a próxima ação. Não use culpa por streak nem template de agenda.",
    ].join("\n");
    const { body } = await chat("conv-proactive-internal", internalInput);

    assert.equal(body.fala, "Cheguei, PIETRO. Eu olho tua semana e sigo contigo.");
    assert.equal(body.acao, "none");
    const mem = readMem("conv-proactive-internal");
    assert.equal((mem.proactiveMemories || []).length, 0);
    assert.doesNotMatch(JSON.stringify(body), /Evento proativo devido|Decida a fala|template de agenda/i);
  });

  it("GET /guto/memory sanitiza eventKey legado com prompt interno", async () => {
    const userId = "conv-proactive-memory-sanitize";
    seed(userId, {
      proactiveMemories: [{
        id: "pm-internal",
        userId,
        type: "commitment",
        status: "discarded",
        rawText: "Evento proativo devido: arrival. Decida a fala e a próxima ação.",
        understood: "Compromisso informado: Evento proativo devido: arrival. Não use culpa por streak nem template de agenda.",
        eventKey: `commitment:${userId}:2026-W28:compromisso informado evento proativo devido arrival decida a fala e a proxima acao nao use culpa por streak nem template de agenda`,
        weekKey: "2026-W28",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    });
    const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
    const response = await fetch(`${baseUrl}/guto/memory`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json() as Record<string, any>;

    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(body), /Evento proativo devido|Decida a fala|template de agenda|culpa por streak/i);
    assert.equal(body.proactiveMemories?.[0]?.rawText, "");
    assert.equal(body.proactiveMemories?.[0]?.understood, "Compromisso");
    assert.equal(body.proactiveMemories?.[0]?.eventKey, undefined);
  });

  it("ação fora do contrato vira fallback seguro estruturado", async () => {
    stubPayload = { flag: null, confidence: 0, fala: "travando", acao: "lock", expectedResponse: null };
    seed("conv-invalid-action");
    const { body } = await chat("conv-invalid-action", "faz qualquer coisa");
    assert.equal(callsByKind.contractIntent || 0, 0);
    assert.equal(body.acao, "none");
    assert.ok(body.expectedResponse === null || body.expectedResponse?.type === "text");
  });
});

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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
let brainModelDelayMs = 0;
let curatorStubPayload: Record<string, unknown> | null = null;
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
      if (kind === "brain" && brainModelDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, brainModelDelayMs));
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify(kind === "executorModel" && curatorStubPayload ? curatorStubPayload : stubPayload),
              }],
            },
          }],
        }),
      } as unknown as Response;
    }
    return originalFetch(url as RequestInfo, init as RequestInit);
  }) as typeof fetch;
}

let app: { listen: (p: number, h: string, cb?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearCache: () => void = () => {};
let runSovereignBrainTurnForTest: (params: any) => Promise<Record<string, any>>;
type AtomicMemoryUpdate = <T>(
  userId: string,
  updater: (current: unknown) => T | null | Promise<T | null>
) => Promise<T | null>;
let updateMemoryAtomically: AtomicMemoryUpdate;

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

async function proactiveArrival(userId: string, language = "pt-BR") {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  callsByKind = {};
  const r = await fetch(`${baseUrl}/guto/proactive?force=1&language=${encodeURIComponent(language)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    const mod = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      app: typeof app;
      runSovereignBrainTurn: typeof runSovereignBrainTurnForTest;
    };
    app = mod.app;
    runSovereignBrainTurnForTest = mod.runSovereignBrainTurn;
    const memoryStore = (await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as {
      clearMemoryStoreCache: () => void;
      updateUserMemoryAtomically: AtomicMemoryUpdate;
    };
    clearCache = memoryStore.clearMemoryStoreCache;
    updateMemoryAtomically = memoryStore.updateUserMemoryAtomically;
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  beforeEach(() => {
    stubPayload = { flag: null, confidence: 0, fala: MARKER, acao: "none", expectedResponse: null };
    transcriptStub = "oi pelo audio";
    brainModelDelayMs = 0;
    curatorStubPayload = null;
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

  it("não promete marcar treino por conversa quando o modelo escapa", async () => {
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Boa! Que bom que já garantiu o treino hoje. Vou marcar aqui no seu histórico.",
      acao: "none",
      expectedResponse: null,
    };
    seed("conv-workout-completion-sanitizer");
    const { status, body } = await chat("conv-workout-completion-sanitizer", "já treinei, marca aí");

    assert.equal(status, 200);
    assert.equal(body.acao, "none");
    assert.match(body.fala, /XP|Arena|valida/i);
    assert.doesNotMatch(body.fala, /vou marcar|marquei|registrad|anotei|hist[óo]rico|garantiu o treino|feito conta/i);
    assert.equal(callsByKind.contractIntent || 0, 0);
    assert.equal(callsByKind.legacyBrain || 0, 0);
  });

  it("saudação simples não puxa agenda, viagem ou compromisso", async () => {
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Oi, Pietro! Tudo certo por aí? Se tiver algum compromisso ou viagem no radar, me avisa pra gente deixar tudo alinhado.",
      acao: "none",
      expectedResponse: null,
    };
    seed("conv-no-agenda-tick");
    const { body } = await chat("conv-no-agenda-tick", "oi");

    assert.equal(body.acao, "none");
    assert.match(body.fala, /Oi|Tudo certo/i);
    assert.doesNotMatch(body.fala, /agenda|viagem|compromisso|radar|semana/i);
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
    seed("conv-diet", { lastWorkoutPlan: abdutoraPlan() });
    const { body } = await chat("conv-diet", "quero dieta");
    assert.equal(callsByKind.contractIntent || 0, 0);
    assert.equal(body.acao, "generateDiet");
    assert.ok(!body.workoutPlan, "pedido de dieta não pode virar treino");
  });

  it("restrição alimentar incremental não apaga restrições calibradas nem invalida dieta", async () => {
    seed("conv-food-restriction-merge", {
      foodRestrictions: "vegetariano, sem lactose",
      dietGenerationStatus: "generated",
      weeklyDietPlan: {
        generatedAt: new Date().toISOString(),
        targetKcal: 2200,
        macros: { proteinG: 130, carbsG: 260, fatG: 70 },
        meals: [{
          name: "Almoço",
          foods: [{ name: "Arroz, feijão e tofu", quantity: "1 prato", kcal: 650 }],
          totalKcal: 650,
        }],
      },
    });
    const { body } = await chat("conv-food-restriction-merge", "não como lactose");
    const mem = readMem("conv-food-restriction-merge");

    assert.equal(body.acao, "none");
    assert.equal(mem.foodRestrictions, "vegetariano, sem lactose");
    assert.equal(mem.dietGenerationStatus, "generated");
    assert.ok(mem.weeklyDietPlan?.meals?.length > 0, "dieta gerada continua disponível");
  });

  it("não chama dieta antiga de pronta quando o estado exige regeneração", async () => {
    const userId = "conv-stale-diet-fallback";
    const oldGeneratedAt = "2025-01-01T00:00:00.000Z";
    seed(userId, {
      dietGenerationStatus: "ready_to_generate",
      lastWorkoutPlan: abdutoraPlan(),
      resolvedFields: {
        foodRestriction: { rawValue: "sem lactose", status: "clear", normalizedValue: "lactose_intolerance" },
      },
    });
    writeFileSync(dietFile, JSON.stringify({
      [userId]: {
        userId,
        language: "pt-BR",
        generatedAt: oldGeneratedAt,
        country: "Brasil",
        countryCode: "BR",
        macros: { bmr: 1800, tdee: 2200, targetKcal: 2100, proteinG: 140, carbsG: 240, fatG: 65, goal: "muscle_gain" },
        meals: [{
          id: "old-meal",
          name: "PLANO ANTIGO",
          time: "08:00",
          totalKcal: 400,
          gutoNote: "desatualizado",
          foods: [{ name: "Alimento antigo", quantity: "1", kcal: 400 }],
        }],
      },
    }, null, 2));
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Não consegui gerar a dieta.",
      acao: "none",
      expectedResponse: null,
    };

    const { status, body } = await chat(userId, "qual é minha dieta?");

    assert.equal(status, 200);
    assert.equal(body.acao, "generateDiet");
    assert.doesNotMatch(body.fala || "", /PLANO ANTIGO|dieta est[aá] pronta/i);
    assert.ok((callsByKind.diet || 0) > 0, "o executor deve tentar regenerar em vez de reutilizar o plano vencido");
    const storedDiet = JSON.parse(readFileSync(dietFile, "utf8"))[userId];
    assert.notEqual(storedDiet.generatedAt, oldGeneratedAt);
    assert.equal(readMem(userId).dietGenerationStatus, "generated");
  });

  it("pedido explícito de treino não fica preso em acao none quando perfil está executável", async () => {
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "O treino atual já trabalha braços. Vamos manter?",
      acao: "none",
      expectedResponse: {
        type: "text",
        instruction: "Confirmar se quer manter o treino atual.",
        options: ["Manter", "Ajustar"],
      },
    };
    seed("conv-workout-focus-promote", {
      lastWorkoutPlan: abdutoraPlan(),
      nextWorkoutFocus: "back_biceps",
    });
    const { body } = await chat("conv-workout-focus-promote", "quero treinar braço");

    assert.equal(callsByKind.contractIntent || 0, 0);
    assert.equal(body.acao, "updateWorkout");
    assert.equal(body.expectedResponse, null);
    assert.ok(body.workoutPlan?.exercises?.length > 0, "Missão foi atualizada pelo executor oficial");
    assert.doesNotMatch(JSON.stringify(body), /Confirmar se quer manter|Vamos manter/i);
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

  it("chegada de usuário novo não interpreta o scheduler como compromisso e entrega a primeira missão", async () => {
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Fechado, Will. Esse período fica bloqueado, então eu puxo o treino pra antes. Prefere de manhã ou de tarde?",
      acao: "updateWorkout",
      expectedResponse: null,
      memoryPatch: {
        trainingSchedule: "morning",
        trainingLimitations: "compromisso inventado pelo modelo",
      },
    };
    seed("conv-new-user-arrival", {
      biologicalSex: "male",
      userAge: 20,
      heightCm: 178,
      weightKg: 83.5,
      trainingGoal: "fat_loss",
      trainingPathology: "lombar",
      trainingLimitations: "lombar",
      trainedToday: false,
      hasSeenChatOpening: false,
      lastWorkoutPlan: undefined,
      weeklyWorkoutPlan: undefined,
      proactiveMemories: [],
      proactiveImpacts: [],
      proactiveSent: {},
    });

    const { status, body } = await proactiveArrival("conv-new-user-arrival");

    assert.equal(status, 200);
    assert.equal(body.slot, "arrival");
    assert.equal(body.deliveryCommitted, true);
    assert.equal(body.acao, "updateWorkout");
    assert.ok(body.workoutPlan?.exercises?.length > 0, "a primeira missão deve nascer na chegada");
    assert.match(body.workoutPlan?.summary || "", /lombar|coluna|protegendo|reduzindo/i, "o plano deve evidenciar o cuidado da calibragem");
    assert.ok(body.memoryPatch?.lastWorkoutPlan?.exercises?.length > 0, "o plano oficial deve voltar no patch atômico");
    assert.equal(body.memoryPatch?.lastWorkoutPlan?.summary, body.workoutPlan?.summary);
    assert.equal(body.memoryPatch?.trainingSchedule, undefined);
    assert.equal(body.memoryPatch?.trainingLimitations, undefined);
    assert.equal(body.memoryPatch?.dietGenerationStatus, "ready_to_generate");
    assert.match(body.fala, /primeira missão|Bora/i);
    assert.doesNotMatch(body.fala, /período fica bloqueado|prefere de manhã|compromisso/i);
    const persisted = readMem("conv-new-user-arrival");
    assert.ok(persisted.lastWorkoutPlan?.exercises?.length > 0, "a missão deve persistir antes de concluir a chegada");
    assert.equal(persisted.lastWorkoutPlan?.summary, body.workoutPlan?.summary, "o plano persistido deve ser o mesmo plano mostrado");
    assert.equal(persisted.trainingSchedule, undefined, "turno de sistema não pode persistir horário inventado pelo modelo");
    assert.equal(persisted.trainingLimitations, "lombar", "turno de sistema não pode sobrescrever calibragem validada");
    assert.equal(persisted.dietGenerationStatus, "ready_to_generate");
    assert.equal(persisted.hasSeenChatOpening, true);
    assert.equal((persisted.proactiveMemories || []).length, 0);
    assert.equal(callsByKind.risk || 0, 0, "scheduler não deve passar como fala humana pelo classificador de risco");
  });

  it("chegada confirma a mesma missão localizada quando o curador real devolve foco e resumo próprios", async () => {
    const userId = "conv-new-user-curated-arrival";
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Lucas, finalmente chegou. Tua primeira missão está pronta. Bora?",
      acao: "updateWorkout",
      expectedResponse: null,
    };
    curatorStubPayload = {
      exercises: [
        { id: "supino_reto_maquina", sets: 4, reps: "15-20", rest: "60s", cue: "Costas apoiadas.", note: "Peitoral com suporte." },
        { id: "supino_inclinado_cross_bilateral", sets: 3, reps: "15-20", rest: "0s", cue: "Controle a volta.", note: "Tensão constante." },
        { id: "triceps_polia_alta", sets: 3, reps: "15-20", rest: "40s", cue: "Cotovelos fixos.", note: "Densidade metabólica." },
        { id: "crucifixo_maquina", sets: 3, reps: "15-20", rest: "0s", cue: "Controle o fechamento.", note: "Fadiga de peitoral." },
        { id: "triceps_barra_v_cabo", sets: 3, reps: "15-20", rest: "40s", cue: "Postura ereta.", note: "Finalização de tríceps." },
      ],
      summary: "Resumo autoral longo do curador que será localizado antes do commit.",
      progressionNote: "",
    };
    seed(userId, {
      name: "Lucas",
      trainingGoal: "fat_loss",
      trainingPathology: "lombar",
      trainingLimitations: "lombar",
      trainedToday: false,
      hasSeenChatOpening: false,
      lastWorkoutPlan: undefined,
      weeklyWorkoutPlan: undefined,
      proactiveMemories: [],
      proactiveImpacts: [],
      proactiveSent: {},
    });

    const { status, body } = await proactiveArrival(userId);
    assert.equal(status, 200);
    assert.equal(body.deliveryCommitted, true);
    assert.equal(body.acao, "updateWorkout");
    assert.ok(body.workoutPlan?.exercises?.length >= 5);
    const persisted = readMem(userId);
    assert.deepEqual(body.workoutPlan, persisted.lastWorkoutPlan);
    assert.deepEqual(body.memoryPatch?.lastWorkoutPlan, persisted.lastWorkoutPlan);
    assert.equal(persisted.hasSeenChatOpening, true);
  });

  it("serializa duas chegadas concorrentes e ambas recebem a mesma missão persistida", async () => {
    const userId = "conv-concurrent-arrivals";
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Primeira missão pronta.",
      acao: "updateWorkout",
      expectedResponse: null,
    };
    brainModelDelayMs = 140;
    seed(userId, {
      trainedToday: false,
      hasSeenChatOpening: false,
      lastWorkoutPlan: undefined,
      weeklyWorkoutPlan: undefined,
      proactiveMemories: [],
      proactiveImpacts: [],
      proactiveSent: {},
    });
    callsByKind = {};
    const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
    const request = () => fetch(`${baseUrl}/guto/proactive?force=1&language=pt-BR`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const [firstResponse, secondResponse] = await Promise.all([request(), request()]);
    const [first, second] = await Promise.all([firstResponse.json(), secondResponse.json()]) as Array<Record<string, any>>;
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(first.deliveryCommitted, true);
    assert.equal(second.deliveryCommitted, true);
    assert.equal(callsByKind.brain, 1, "o segundo request deve reutilizar a missão vencedora");
    assert.equal(
      JSON.stringify(first.workoutPlan?.exercises?.map((exercise: any) => exercise.id)),
      JSON.stringify(second.workoutPlan?.exercises?.map((exercise: any) => exercise.id))
    );
    const persisted = readMem(userId);
    assert.equal(
      JSON.stringify(persisted.lastWorkoutPlan?.exercises?.map((exercise: any) => exercise.id)),
      JSON.stringify(first.workoutPlan?.exercises?.map((exercise: any) => exercise.id))
    );
  });

  it("cancela a chegada se a limitação muda enquanto o treino é montado", async () => {
    const userId = "conv-arrival-profile-race";
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Missão pronta com o perfil antigo.",
      acao: "updateWorkout",
      expectedResponse: null,
    };
    brainModelDelayMs = 180;
    seed(userId, {
      trainingPathology: "lombar",
      trainingLimitations: "lombar",
      trainedToday: false,
      hasSeenChatOpening: false,
      lastWorkoutPlan: undefined,
      weeklyWorkoutPlan: undefined,
      proactiveMemories: [],
      proactiveImpacts: [],
      proactiveSent: {},
    });
    callsByKind = {};
    const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
    const arrival = fetch(`${baseUrl}/guto/proactive?force=1&language=pt-BR`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await waitUntil(() => (callsByKind.brain || 0) >= 1);

    const update = await fetch(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        language: "pt-BR",
        trainingPathology: "dor no joelho direito",
        trainingLimitations: "dor no joelho direito",
      }),
    });
    assert.equal(update.status, 200);

    const response = await arrival;
    const body = await response.json() as Record<string, any>;
    assert.equal(response.status, 200);
    assert.equal(body.deliveryCommitted, false);
    const persisted = readMem(userId);
    assert.equal(persisted.trainingLimitations, "dor no joelho direito");
    assert.equal(persisted.lastWorkoutPlan == null, true);
    assert.equal(persisted.hasSeenChatOpening, false);
  });

  it("cancela a chegada se chuva muda o local efetivo enquanto o treino é montado", async () => {
    const userId = "conv-arrival-weather-race";
    const now = new Date().toISOString();
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Rome",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Missão ao ar livre pronta.",
      acao: "updateWorkout",
      expectedResponse: null,
    };
    brainModelDelayMs = 180;
    seed(userId, {
      preferredTrainingLocation: "park",
      trainingLocation: "park",
      trainedToday: false,
      hasSeenChatOpening: false,
      lastWorkoutPlan: undefined,
      weeklyWorkoutPlan: undefined,
      proactiveMemories: [{
        id: "weather-race",
        userId,
        type: "trip",
        status: "confirmed",
        rawText: "Vou treinar no parque.",
        understood: "Treino ao ar livre.",
        createdAt: now,
        updatedAt: now,
        weekKey: "weather-race",
      }],
      proactiveImpacts: [],
      proactiveSent: {},
    });
    callsByKind = {};
    const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
    const arrival = fetch(`${baseUrl}/guto/proactive?force=1&language=pt-BR`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await waitUntil(() => (callsByKind.brain || 0) >= 1);

    await updateMemoryAtomically<Record<string, any>>(userId, (current) => {
      const persisted = { ...(current as Record<string, any>) };
      persisted.proactiveMemories = (persisted.proactiveMemories || []).map((item: Record<string, any>) =>
        item.id === "weather-race"
          ? {
              ...item,
              status: "enriched",
              updatedAt: new Date().toISOString(),
              weatherEnrichment: {
                city: "Roma",
                date: today,
                tempMin: 17,
                tempMax: 22,
                condition: "chuva",
                conditionEn: "Rain",
                source: "wttr.in",
                fetchedAt: new Date().toISOString(),
              },
            }
          : item
      );
      return persisted;
    });

    const response = await arrival;
    const body = await response.json() as Record<string, any>;
    assert.equal(response.status, 200);
    assert.equal(body.deliveryCommitted, false);
    const persisted = readMem(userId);
    assert.equal(persisted.proactiveMemories?.[0]?.weatherEnrichment?.conditionEn, "Rain");
    assert.equal(persisted.lastWorkoutPlan == null, true);
    assert.equal(persisted.hasSeenChatOpening, false);
  });

  it("mantém a chegada se só o enriquecimento de feriado muda durante a montagem", async () => {
    const userId = "conv-arrival-holiday-enrichment";
    const now = new Date().toISOString();
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Missão pronta sem mudança operacional.",
      acao: "updateWorkout",
      expectedResponse: null,
    };
    brainModelDelayMs = 180;
    seed(userId, {
      trainedToday: false,
      hasSeenChatOpening: false,
      lastWorkoutPlan: undefined,
      weeklyWorkoutPlan: undefined,
      proactiveMemories: [{
        id: "holiday-enrichment",
        userId,
        type: "trip",
        status: "confirmed",
        rawText: "Semana normal de treino.",
        understood: "Sem mudança operacional no treino.",
        createdAt: now,
        updatedAt: now,
        weekKey: "holiday-race",
      }],
      proactiveImpacts: [],
      proactiveSent: {},
    });
    callsByKind = {};
    const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
    const arrival = fetch(`${baseUrl}/guto/proactive?force=1&language=pt-BR`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await waitUntil(() => (callsByKind.brain || 0) >= 1);

    await updateMemoryAtomically<Record<string, any>>(userId, (current) => {
      const persisted = { ...(current as Record<string, any>) };
      persisted.proactiveMemories = (persisted.proactiveMemories || []).map((item: Record<string, any>) =>
        item.id === "holiday-enrichment"
          ? {
              ...item,
              status: "enriched",
              updatedAt: new Date().toISOString(),
              holidayEnrichment: [{
                name: "Republic Day",
                nameLocal: "Festa della Repubblica",
                date: "2026-06-02",
                country: "IT",
              }],
            }
          : item
      );
      return persisted;
    });

    const response = await arrival;
    const body = await response.json() as Record<string, any>;
    assert.equal(response.status, 200);
    assert.equal(body.deliveryCommitted, true);
    assert.ok(body.workoutPlan?.exercises?.length > 0);
    const persisted = readMem(userId);
    assert.equal(persisted.proactiveMemories?.[0]?.holidayEnrichment?.[0]?.country, "IT");
    assert.ok(persisted.lastWorkoutPlan?.exercises?.length > 0);
    assert.equal(persisted.hasSeenChatOpening, true);
  });

  it("scheduler sem requiredAction não executa mutação arbitrária do modelo", async () => {
    const userId = "conv-system-trigger-no-authority";
    seed(userId, {
      dietGenerationStatus: "idle",
      lastWorkoutPlan: undefined,
      proactiveSent: {},
    });
    const memory = readMem(userId);
    const response = await runSovereignBrainTurnForTest({
      memory,
      input: "",
      history: [],
      language: "pt-BR",
      operationalContext: {
        nowIso: new Date().toISOString(),
        date: "2026-07-12",
        time: "10:00",
        hour: 10,
        minute: 0,
        weekday: "domingo",
        timezone: "Europe/Rome",
        dayPeriod: "morning",
      },
      systemTrigger: {
        source: "proactive_scheduler",
        slot: "arrival",
        objective: "scheduled_presence",
      },
      decide: async () => ({
        response: {
          fala: "Vou gerar tua dieta agora.",
          acao: "generateDiet",
          expectedResponse: null,
          memoryPatch: { dietGenerationStatus: "generating" },
        },
        validation: "ok",
        meta: { kind: "model", via: "test" },
      }),
    });
    assert.equal(response.acao, "none");
    assert.equal(response.memoryPatch && Object.keys(response.memoryPatch).length, 0);
    assert.equal(readMem(userId).dietGenerationStatus, "idle");
  });

  it("fala da primeira chegada nunca herda afirmação sem fonte mesmo fora de regex conhecidas", async () => {
    const userId = "conv-new-user-arrival-unbounded-claim";
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Teu médico liberou a lombar e eu removi todos os cuidados do plano.",
      acao: "updateWorkout",
      expectedResponse: null,
    };
    seed(userId, {
      trainingPathology: "lombar",
      trainingLimitations: "lombar",
      trainedToday: false,
      hasSeenChatOpening: false,
      lastWorkoutPlan: undefined,
      weeklyWorkoutPlan: undefined,
      proactiveSent: {},
    });

    const { status, body } = await proactiveArrival(userId);

    assert.equal(status, 200);
    assert.equal(body.deliveryCommitted, true);
    assert.equal(body.fala, "Finalmente, Will. Eu já organizei tua primeira missão com o que você me passou. Bora?");
    assert.doesNotMatch(body.fala, /m[eé]dico|liberou|removi/i);
    assert.match(body.workoutPlan?.summary || "", /lombar|coluna|protegendo|reduzindo/i);
  });

  it("chegada cria a primeira missão mesmo quando o contrato do modelo é inválido", async () => {
    stubPayload = { flag: null, confidence: 0 };
    const cases = [
      { language: "pt-BR", limitation: "lombar", expected: /Finalmente, Will|primeira missão|Bora/i, forbidden: /período fica bloqueado|prefere de manhã|compromisso/i, care: /Protegendo.*lombar|lombar.*reduzindo/i },
      { language: "en-US", limitation: "lower back", expected: /Finally, Will|first mission|Ready/i, forbidden: /window is blocked|morning|commitment/i, care: /Protecting.*lower back|lower back.*reducing/i },
      { language: "it-IT", limitation: "lombare", expected: /Finalmente, Will|prima missione|Partiamo/i, forbidden: /fascia è bloccata|mattina|impegno/i, care: /Proteggo.*lombare|lombare.*riduco/i },
    ] as const;

    for (const testCase of cases) {
      const userId = `conv-new-user-arrival-invalid-model-${testCase.language}`;
      seed(userId, {
        language: testCase.language,
        trainingPathology: testCase.limitation,
        trainingLimitations: testCase.limitation,
        trainedToday: false,
        hasSeenChatOpening: false,
        lastWorkoutPlan: undefined,
        weeklyWorkoutPlan: undefined,
        proactiveMemories: [],
        proactiveImpacts: [],
        proactiveSent: {},
      });

      const { status, body } = await proactiveArrival(userId, testCase.language);

      assert.equal(status, 200);
      assert.equal(body.slot, "arrival");
      assert.equal(body.deliveryCommitted, true);
      assert.equal(body.acao, "updateWorkout");
      assert.ok(body.workoutPlan?.exercises?.length > 0);
      assert.match(body.workoutPlan?.summary || "", testCase.care);
      assert.equal(body.memoryPatch?.dietGenerationStatus, "ready_to_generate");
      assert.match(body.fala, testCase.expected);
      assert.doesNotMatch(body.fala, testCase.forbidden);
      assert.equal(readMem(userId).hasSeenChatOpening, true);
    }
  });

  it("chegada incompleta não é consumida e permanece elegível para nova tentativa", async () => {
    const userId = "conv-new-user-arrival-retry";
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Finalmente, Will. Eu já organizei tua primeira missão com o que você me passou. Bora?",
      acao: "updateWorkout",
      expectedResponse: null,
    };
    seed(userId, {
      trainedToday: false,
      hasSeenChatOpening: false,
      lastWorkoutPlan: undefined,
      weeklyWorkoutPlan: undefined,
      proactiveMemories: [],
      proactiveImpacts: [],
      proactiveSent: {},
      // O gate histórico considera whitespace como campo presente, enquanto o
      // executor soberano o rejeita. A rota deve responder honestamente sem
      // consumir a chegada quando a missão não pôde ser persistida.
      trainingLimitations: "   ",
      trainingPathology: "   ",
    });

    const { status, body } = await proactiveArrival(userId);

    assert.equal(status, 200);
    assert.equal(body.slot, "arrival");
    assert.equal(body.deliveryCommitted, false);
    const persisted = readMem(userId);
    assert.equal(persisted.hasSeenChatOpening, false);
    assert.equal(persisted.lastWorkoutPlan == null, true);
    assert.deepEqual(persisted.proactiveSent || {}, {});
  });

  it("não confirma a chegada quando a missão não consegue ser gravada de forma durável", async () => {
    const userId = "conv-new-user-arrival-persistence-failure";
    stubPayload = {
      flag: null,
      confidence: 0,
      fala: "Eu já deixei tudo resolvido para a próxima semana.",
      acao: "updateWorkout",
      expectedResponse: null,
    };
    seed(userId, {
      trainedToday: false,
      hasSeenChatOpening: false,
      lastWorkoutPlan: undefined,
      weeklyWorkoutPlan: undefined,
      proactiveSent: {},
    });

    chmodSync(file, 0o444);
    try {
      const { status, body } = await proactiveArrival(userId);
      assert.equal(status, 200);
      assert.equal(body.deliveryCommitted, false);
      assert.equal(body.acao, "none");
    } finally {
      chmodSync(file, 0o644);
      clearCache();
    }

    const persisted = readMem(userId);
    assert.equal(persisted.hasSeenChatOpening, false);
    assert.equal(persisted.lastWorkoutPlan == null, true);
    assert.deepEqual(persisted.proactiveSent || {}, {});
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

  it("GET/POST /guto/memory não expõem turnJournal nem expectedResponse interno", async () => {
    const userId = "conv-memory-public-payload";
    seed(userId, {
      turnJournal: [{
        decision: {
          turnId: "turn-private",
          userMessage: "oi",
          previousState: { activeContext: null, stage: "none" },
          activeContext: null,
          intent: "conversation",
          relatedMemoryId: undefined,
          stage: "none",
          nextState: { activeContext: null, stage: "none" },
          effects: [],
          response: {
            fala: "fala interna",
            acao: "none",
            expectedResponse: {
              type: "text",
              instruction: "Evento proativo devido: arrival. Decida a fala e a próxima ação.",
            },
            avatarEmotion: "neutral",
          },
          cards: [],
          memoryPatch: {},
          workoutEffect: "none",
          dietEffect: "none",
          pathEffect: "none",
        },
        responsePayload: {
          fala: "fala interna",
          acao: "none",
          expectedResponse: {
            type: "text",
            instruction: "Não use culpa por streak nem template de agenda.",
          },
        },
        createdAt: new Date().toISOString(),
      }],
    });
    const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);

    for (const request of [
      () => fetch(`${baseUrl}/guto/memory`, { headers: { Authorization: `Bearer ${token}` } }),
      () => fetch(`${baseUrl}/guto/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ language: "pt-BR" }),
      }),
    ]) {
      const response = await request();
      const body = await response.json() as Record<string, any>;
      const serialized = JSON.stringify(body);

      assert.equal(response.status, 200);
      assert.ok(!("turnJournal" in body), "turnJournal é diário interno e não pode ir ao frontend");
      assert.doesNotMatch(serialized, /expectedResponse|responsePayload|memoryPatch|Evento proativo devido|Decida a fala|template de agenda|culpa por streak/i);
    }

    assert.ok(readMem(userId).turnJournal?.length > 0, "turnJournal continua persistido internamente");
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

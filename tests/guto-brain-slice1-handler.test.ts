// Commit 6 — Fatia 1: interceptação única da flag no handler /guto.
// Define o ambiente ANTES de importar server.ts (config lê env no load).
import "./test-env.js";
process.env.GUTO_BRAIN_SLICE1 = "true"; // liga o caminho novo SÓ neste arquivo
process.env.GEMINI_API_KEY = "test-key-brain-slice1"; // habilita callModel/classifyRisk
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
const file = join(dir, "guto-memory.brain-slice1-handler-test.json");

const MARKER = "RESPOSTA_DO_CEREBRO_SOBERANO_FATIA1";

// ─── Stub global de fetch ─────────────────────────────────────────────────────
// Um único JSON serve aos DOIS consumidores: classifyRisk (lê flag/confidence) e
// o cérebro/parseGutoResponse (lê fala/acao). flag:null + input benigno => sem risco.
const originalFetch = globalThis.fetch;
let modelCallCount = 0;
let stubModelPayload: Record<string, unknown> = {
  flag: null,
  confidence: 0,
  fala: MARKER,
  acao: "none",
  expectedResponse: null,
};

function installFetchStub() {
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes("generativelanguage")) {
      modelCallCount++;
      const text = JSON.stringify(stubModelPayload);
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
      } as unknown as Response;
    }
    // Passthrough OBRIGATÓRIO: a requisição do próprio teste ao express também é
    // fetch — só interceptamos o modelo (generativelanguage), o resto vai pra rede.
    return originalFetch(url as RequestInfo, init as RequestInit);
  }) as typeof fetch;
}

let app: { listen: (port: number, host: string, cb?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearCache: () => void = () => {};
let runSovereignBrainSlice1: (params: Record<string, unknown>) => Promise<unknown>;

const BASE = {
  name: "Will",
  language: "pt-BR",
  biologicalSex: "male",
  userAge: 30,
  heightCm: 178,
  weightKg: 80,
  trainingLevel: "consistent",
  trainingStatus: "consistent",
  trainingGoal: "hypertrophy",
  preferredTrainingLocation: "home",
  trainingLocation: "home",
  trainingPathology: "sem dor",
  initialXpGranted: true,
  totalXp: 100,
};

function seed(userId: string, data: Record<string, unknown> = {}) {
  const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  store[userId] = { userId, ...BASE, ...data };
  writeFileSync(file, JSON.stringify(store, null, 2));
  clearCache();
}

async function chat(userId: string, input: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "pt-BR", history: [], input }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

const META_KEYS = ["validation", "meta", "kind", "via", "reasoning", "modelCalled", "persisted"];

describe("Fatia 1 — interceptação da flag no handler /guto", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = file;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({}, null, 2));

    installFetchStub();

    const mod = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      app: typeof app;
      runSovereignBrainSlice1: typeof runSovereignBrainSlice1;
    };
    app = mod.app;
    runSovereignBrainSlice1 = mod.runSovereignBrainSlice1;
    clearCache = ((await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as {
      clearMemoryStoreCache: () => void;
    }).clearMemoryStoreCache;

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  beforeEach(() => {
    modelCallCount = 0;
    stubModelPayload = { flag: null, confidence: 0, fala: MARKER, acao: "none", expectedResponse: null };
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(file, { force: true });
  });

  // ─── Integração: flag ON + turno simples ────────────────────────────────────
  it("flag ON + turno simples → resposta vem do cérebro e meta NÃO vaza no body", async () => {
    seed("brain-simple");
    const { status, body } = await chat("brain-simple", "queria só te agradecer pela parceria, tô feliz demais");

    assert.equal(status, 200);
    assert.equal(body.fala, MARKER, "a fala deve vir da resposta do cérebro");
    assert.equal(body.acao, "none");
    // LEI 11: nenhum marcador interno pode aparecer no payload público.
    for (const k of META_KEYS) {
      assert.ok(!(k in body), `body não pode conter chave interna '${k}'`);
    }
    // Cérebro = classifyRisk (1) + callModel (1) = 2 chamadas. O legado faria MAIS
    // (askGutoModel re-classifica risco + brain + classifyContractIntent). Provar
    // count===2 prova que o cérebro tratou e que o legado (e sua persistência) NÃO
    // rodou → sem persistência duplicada.
    console.log(`[brain-simple] modelCallCount=${modelCallCount}`);
    assert.equal(modelCallCount, 2, "turno simples deve custar exatamente 2 chamadas (risk + brain)");
  });

  // ─── Integração: flag ON + ação complexa → defer cai no legado ───────────────
  it("flag ON + ação complexa → cérebro defere e o legado (askGutoModel) assume", async () => {
    stubModelPayload = { flag: null, confidence: 0, fala: "vou montar", acao: "updateWorkout", expectedResponse: null };
    seed("brain-complex");
    const { status } = await chat("brain-complex", "guto, atualiza meu treino de hoje por favor");

    assert.equal(status, 200);
    // Defer dispara o caminho legado: > 2 chamadas (a do cérebro + as do askGutoModel).
    console.log(`[brain-complex] modelCallCount=${modelCallCount}`);
    assert.ok(modelCallCount > 2, "ação complexa deve cair no legado (mais chamadas que o cérebro puro)");
  });

  // ─── Fatia 2A.2: L3 neutro para acao:"none" ─────────────────────────────────
  it("2A.2: fala do cérebro (acao:none) sai IDÊNTICA mesmo contendo padrão de swap-menu", async () => {
    // Fala que enforceDecisiveSwap/repairInvalid MIRARIAM se rodassem (menu de
    // preferência entre exercícios). Com o guard, a fala do cérebro sai intacta.
    const falaComMenu = "Tamo junto. Se um dia trocar, Supino ou Crucifixo, qual prefere? Hoje seguimos firmes.";
    stubModelPayload = { flag: null, confidence: 0, fala: falaComMenu, acao: "none", expectedResponse: null };
    seed("brain-l3-neutral");
    const { status, body } = await chat("brain-l3-neutral", "valeu guto, parceria firme");

    assert.equal(status, 200);
    assert.equal(body.fala, falaComMenu, "a L3 não pode alterar a fala do cérebro em acao:none");
    assert.equal(body.acao, "none");
    assert.equal(modelCallCount, 2, "turno do cérebro: risk + brain (não cai no legado)");
    for (const k of META_KEYS) {
      assert.ok(!(k in body), `body não pode conter chave interna '${k}'`);
    }
  });

  it("2A.2: turno do cérebro acao:none não dispara applyBackendProactiveAction (sem proactiveMemoryAction)", async () => {
    stubModelPayload = { flag: null, confidence: 0, fala: "Presença total, Will.", acao: "none", expectedResponse: null };
    seed("brain-l3-proactive");
    const { status, body } = await chat("brain-l3-proactive", "só queria te dar um oi");
    assert.equal(status, 200);
    assert.equal(body.fala, "Presença total, Will.");
    assert.equal(body.acao, "none");
    // o atalho 2A.2 entrega direto; nenhum efeito proativo do legado roda
    assert.equal(modelCallCount, 2);
  });

  // ─── Unit: runSovereignBrainSlice1 com deps injetadas (sem modelo real) ──────
  const minimalMemory = () => ({
    userId: "u-unit",
    name: "Will",
    language: "pt-BR",
    trainingGoal: "hypertrophy",
    trainingLocation: "home",
    workoutFeedbackHistory: [],
    lastWorkoutPlan: null,
    weeklyDietPlan: null,
  });

  const okContract = {
    response: { fala: "oi, tudo certo?", acao: "none", expectedResponse: null },
    validation: "ok",
    meta: { kind: "conversational_simple", via: "sovereign_brain_slice1", modelCalled: true, persisted: false },
  };

  function callHelper(over: Record<string, unknown>) {
    return runSovereignBrainSlice1({
      memory: minimalMemory(),
      input: "oi guto, tudo certo por ai?",
      history: [],
      language: "pt-BR",
      expectedResponse: null,
      proactivityContext: null,
      operationalContext: {} as unknown,
      ...over,
    });
  }

  it("risco ativo → defere (retorna null) e decideTurn NÃO é chamado", async () => {
    let decideCalled = false;
    const result = await callHelper({
      classifyRiskFn: async () => ({ flag: "cardio_neuro_acute", confidence: 0.9, reasoning: "x", classifiedAt: "" }),
      decide: async () => {
        decideCalled = true;
        return okContract;
      },
    });
    assert.equal(result, null);
    assert.equal(decideCalled, false, "com risco ativo o cérebro nem decide — defere ao legado");
  });

  it("decideTurn devolve defer → helper retorna null (cai no legado)", async () => {
    const result = await callHelper({
      classifyRiskFn: async () => ({ flag: null, confidence: 0, reasoning: "", classifiedAt: "" }),
      decide: async () => ({ ...okContract, validation: "defer" }),
    });
    assert.equal(result, null);
  });

  it("decideTurn ok → helper retorna SÓ contract.response (sem meta/validation)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedWorldState: any = null;
    const result = (await callHelper({
      classifyRiskFn: async () => ({ flag: null, confidence: 0, reasoning: "", classifiedAt: "" }),
      decide: async (inp: { worldState: Record<string, unknown> }) => {
        capturedWorldState = inp.worldState;
        return okContract;
      },
    })) as Record<string, unknown>;

    // assembleWorldState rodou e foi passado ao decideTurn.
    assert.ok(capturedWorldState, "decideTurn deve receber um worldState");
    assert.equal(capturedWorldState.userId, "u-unit");
    assert.ok("feedbackSignal" in capturedWorldState, "worldState deve ter o shape reduzido");

    // Resposta é exatamente a pública; nada de meta/validation vaza.
    assert.deepEqual(result, okContract.response);
    for (const k of META_KEYS) {
      assert.ok(!(k in result), `response não pode conter chave interna '${k}'`);
    }
  });

  it("persistência: deps.persist aplica o patch na memória (wiring real)", async () => {
    const memory = minimalMemory() as Record<string, unknown>;
    await runSovereignBrainSlice1({
      memory,
      input: "oi guto",
      history: [],
      language: "pt-BR",
      expectedResponse: null,
      proactivityContext: null,
      operationalContext: {} as unknown,
      classifyRiskFn: async () => ({ flag: null, confidence: 0, reasoning: "", classifiedAt: "" }),
      decide: async (_inp: unknown, deps: { persist?: (u: string, p: Record<string, unknown>) => Promise<void> }) => {
        await deps.persist!("u-unit", { trainingLocation: "academia nova" });
        return okContract;
      },
    });
    assert.ok(
      String(memory.trainingLocation || "").includes("academia"),
      "o patch deve ter sido aplicado à memória via applyMemoryPatch"
    );
  });
});

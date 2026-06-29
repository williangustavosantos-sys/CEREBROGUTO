// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN TRANSCRIPTS — Fatia 1 do Cérebro Soberano (fechamento).
//
// Este arquivo NÃO cria arquitetura nova: consolida o CONTRATO ARQUITETURAL da
// Fatia 1 como 4 Golden Transcripts explícitas (GT-1..GT-4). Cada uma trava um
// invariante de comportamento (não um exemplo específico):
//   GT-1  flag OFF → legado intacto, o cérebro NÃO intercepta.
//   GT-2  flag ON + turno simples → assembleWorldState → decideTurn → TurnContract
//         válido; SÓ contract.response é público; meta não vaza; persiste 1x.
//   GT-3  forma inválida / ação complexa → defer → cai no legado; cérebro não persiste.
//   GT-4  workoutFeedbackHistory alimenta o ReducedWorldState (progress/deload).
//
// Infra de teste idêntica à do commit 6: stub de fetch que SÓ intercepta o modelo
// (generativelanguage) e faz passthrough do resto (a própria request ao express).
// ─────────────────────────────────────────────────────────────────────────────
import "./test-env.js";
process.env.GEMINI_API_KEY = "test-key-gt-fatia1"; // habilita callModel/classifyRisk (via stub)
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

// Funções puras da Fatia 1 — testadas aqui em nível de CONTRATO (não de unidade).
import { assembleWorldState } from "../src/brain/assemble-world-state.js";
import { validateContract } from "../src/brain/validate-contract.js";
import type { WorkoutFeedbackRecord } from "../src/workout-progression.js";

const dir = join(process.cwd(), "tmp");
const file = join(dir, "guto-memory.brain-slice1-gt-test.json");

const MARKER = "FALA_DO_CEREBRO_GT";

// ─── Stub global de fetch (só intercepta o modelo) ───────────────────────────
const originalFetch = globalThis.fetch;
let modelCallCount = 0;
let stubPayload: Record<string, unknown> = {
  flag: null, confidence: 0, fala: MARKER, acao: "none", expectedResponse: null,
};
function installFetchStub() {
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes("generativelanguage")) {
      modelCallCount++;
      const text = JSON.stringify(stubPayload);
      return {
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
      } as unknown as Response;
    }
    return originalFetch(url as RequestInfo, init as RequestInit);
  }) as typeof fetch;
}

let app: { listen: (port: number, host: string, cb?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearCache: () => void = () => {};
let setBrainSlice1: (on: boolean) => void;

const BASE = {
  name: "Will", language: "pt-BR", biologicalSex: "male", userAge: 30,
  heightCm: 178, weightKg: 80, trainingLevel: "consistent", trainingStatus: "consistent",
  trainingGoal: "hypertrophy", preferredTrainingLocation: "home", trainingLocation: "home",
  trainingPathology: "sem dor", initialXpGranted: true, totalXp: 100,
};

function seed(userId: string, data: Record<string, unknown> = {}) {
  const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  store[userId] = { userId, ...BASE, ...data };
  writeFileSync(file, JSON.stringify(store, null, 2));
  clearCache();
}

function readMem(userId: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"))[userId] || {};
}

async function chat(userId: string, input: string, turnId?: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "pt-BR", history: [], input, ...(turnId ? { turnId } : {}) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

// Campos internos que NUNCA podem aparecer no payload público (LEI 11).
const META_KEYS = ["validation", "meta", "kind", "via", "reasoning", "modelCalled", "persisted"];
// Campos instáveis a excluir de qualquer snapshot (GT-1).
const UNSTABLE = ["turnId", "turnDecision", "createdAt", "classifiedAt", "lastActiveAt", "updatedAt"];

function stripUnstable(body: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  for (const k of UNSTABLE) delete clone[k];
  return clone;
}

function makeFeedback(
  difficulty: "easy" | "ok" | "hard" | "pain",
  painArea?: string
): WorkoutFeedbackRecord {
  return {
    id: "fb", userId: "u", createdAt: "2026-06-28T10:00:00.000Z",
    workoutFocus: "full_body", workoutLabel: "Treino", locationMode: "gym",
    difficulty, painArea, exerciseIds: [],
  };
}

describe("Golden Transcripts — Fatia 1 do Cérebro Soberano", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = file;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({}, null, 2));

    installFetchStub();

    const mod = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      app: typeof app;
    };
    app = mod.app;
    clearCache = ((await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as {
      clearMemoryStoreCache: () => void;
    }).clearMemoryStoreCache;

    // A flag é lida do config (process.env) no load. Para alternar OFF/ON dentro do
    // MESMO processo, mutamos o objeto config exportado — é a fonte que o handler lê.
    const cfg = ((await import(pathToFileURL(join(process.cwd(), "src/config.ts")).href)) as {
      config: { brainSlice1: boolean };
    }).config;
    setBrainSlice1 = (on: boolean) => { cfg.brainSlice1 = on; };

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  beforeEach(() => {
    modelCallCount = 0;
    stubPayload = { flag: null, confidence: 0, fala: MARKER, acao: "none", expectedResponse: null };
    setBrainSlice1(false); // estado padrão = legado; cada GT liga explicitamente se precisar
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(file, { force: true });
  });

  // ─── GT-1 — Flag OFF mantém o legado ───────────────────────────────────────
  describe("GT-1 — flag OFF mantém o legado", () => {
    it("flag OFF: o cérebro NÃO intercepta — resposta vem do legado (askGutoModel)", async () => {
      setBrainSlice1(false);
      seed("gt1-off");
      const { status, body } = await chat("gt1-off", "queria só te agradecer pela parceria de hoje", "gt1-fixed-turn");

      assert.equal(status, 200);
      // Legado roda o pipeline completo: askGutoModel re-classifica risco + brain +
      // classifyContractIntent. São MAIS chamadas que o cérebro puro (que faria 2).
      assert.ok(modelCallCount > 2, `legado deveria fazer >2 chamadas, fez ${modelCallCount}`);
      // Mesmo no legado, nenhum marcador interno do cérebro pode aparecer.
      for (const k of ["validation", "meta", "via", "modelCalled", "persisted"]) {
        assert.ok(!(k in body), `body legado não pode conter '${k}'`);
      }
    });

    it("flag OFF: snapshot estável (sem campos instáveis) é determinístico turno a turno", async () => {
      setBrainSlice1(false);
      seed("gt1-snap");
      const a = await chat("gt1-snap", "obrigado guto, tô gostando muito da nossa parceria", "gt1-snap-turn");
      seed("gt1-snap"); // reseta o mesmo estado inicial
      const b = await chat("gt1-snap", "obrigado guto, tô gostando muito da nossa parceria", "gt1-snap-turn");

      // turnId fixo + exclusão de createdAt/turnDecision → o legado é estável.
      assert.deepEqual(stripUnstable(a.body), stripUnstable(b.body));
    });
  });

  // ─── GT-2 — Flag ON turno simples ──────────────────────────────────────────
  describe("GT-2 — flag ON + turno simples", () => {
    it("turno simples: assembleWorldState → decideTurn → TurnContract; só response é público", async () => {
      setBrainSlice1(true);
      seed("gt2-simple");
      const { status, body } = await chat("gt2-simple", "valeu demais guto, parceria que vale ouro");

      assert.equal(status, 200);
      assert.equal(body.fala, MARKER, "a fala deve vir de contract.response (cérebro)");
      assert.equal(body.acao, "none");
      // Cérebro = classifyRisk (1) + callModel (1) = 2 chamadas → provou que interceptou.
      assert.equal(modelCallCount, 2, "turno simples deve custar 2 chamadas (risk + brain)");
      // meta/validation NUNCA no payload público.
      for (const k of META_KEYS) {
        assert.ok(!(k in body), `body não pode conter chave interna '${k}'`);
      }
    });

    it("turno simples com memoryPatch: persiste EXATAMENTE uma vez via cérebro", async () => {
      setBrainSlice1(true);
      stubPayload = {
        flag: null, confidence: 0, fala: MARKER, acao: "none", expectedResponse: null,
        memoryPatch: { trainingLocation: "academia central" },
      };
      seed("gt2-persist", { trainingLocation: "home" });
      const { status, body } = await chat("gt2-persist", "fechou guto, mudei de academia, valeu");

      assert.equal(status, 200);
      assert.equal(modelCallCount, 2, "persistência é efeito do cérebro — sem chamada extra de modelo");
      // O patch foi aplicado à memória uma vez (o legado/askGutoModel NÃO rodou).
      const mem = readMem("gt2-persist");
      assert.match(String(mem.trainingLocation || ""), /academia central/i);
      for (const k of META_KEYS) assert.ok(!(k in body), `body não pode conter '${k}'`);
    });
  });

  // ─── GT-3 — Forma inválida / ação complexa → defer ─────────────────────────
  describe("GT-3 — forma inválida / ação complexa → defer", () => {
    it("ação complexa (updateWorkout): cérebro defere e o legado assume", async () => {
      setBrainSlice1(true);
      stubPayload = { flag: null, confidence: 0, fala: "vou montar", acao: "updateWorkout", expectedResponse: null };
      seed("gt3-complex");
      const { status } = await chat("gt3-complex", "guto, atualiza meu treino de hoje");

      assert.equal(status, 200);
      // Defer → cai no askGutoModel legado → MAIS chamadas que o cérebro puro (2).
      assert.ok(modelCallCount > 2, `defer deveria cair no legado (>2 chamadas), fez ${modelCallCount}`);
    });

    it("validateContract: forma inválida (fala vazia) → defer; ação complexa → defer; nunca persiste pelo cérebro", () => {
      // Contrato de FORMA (função pura) — o juiz determinístico do que a Fatia 1 aceita.
      const valida = validateContract({ fala: "bora", acao: "none", expectedResponse: null });
      assert.equal(valida.validation, "ok");

      const falaVazia = validateContract({ fala: "", acao: "none", expectedResponse: null });
      assert.equal(falaVazia.ok, false);
      assert.equal(falaVazia.validation, "defer");

      const complexa = validateContract({ fala: "vou montar", acao: "updateWorkout", expectedResponse: null });
      assert.equal(complexa.validation, "defer");

      const metaLeak = validateContract({ fala: "oi", acao: "none", expectedResponse: null, via: "x" });
      assert.equal(metaLeak.ok, false, "chave de meta no payload reprova (LEI 11)");
    });

    it("forma inválida no fluxo real: modelo devolve fala vazia → cérebro defere ao legado", async () => {
      setBrainSlice1(true);
      stubPayload = { flag: null, confidence: 0, fala: "", acao: "none", expectedResponse: null };
      seed("gt3-invalid");
      const { status } = await chat("gt3-invalid", "guto, e ai, como vai voce hoje");

      assert.equal(status, 200);
      assert.ok(modelCallCount > 2, `forma inválida deveria deferir ao legado (>2 chamadas), fez ${modelCallCount}`);
    });
  });

  // ─── GT-4 — Feedback alimenta o WorldState ─────────────────────────────────
  describe("GT-4 — workoutFeedbackHistory alimenta o ReducedWorldState", () => {
    it("feedback Fácil/Fácil → feedbackSignal='progress' no estado que o cérebro recebe", () => {
      const ws = assembleWorldState({
        userId: "gt4",
        workoutFeedbackHistory: [makeFeedback("easy"), makeFeedback("easy")],
      });
      assert.deepEqual(ws.recentDifficulty, ["easy", "easy"]);
      assert.equal(ws.feedbackSignal, "progress");
    });

    it("feedback com dor → feedbackSignal='deload'", () => {
      const ws = assembleWorldState({
        userId: "gt4",
        workoutFeedbackHistory: [makeFeedback("pain", "ombro")],
      });
      assert.equal(ws.feedbackSignal, "deload");
    });

    it("sem feedback → feedbackSignal=null (ausência honesta, não 'hold' fabricado)", () => {
      const ws = assembleWorldState({ userId: "gt4" });
      assert.equal(ws.feedbackSignal, null);
      assert.deepEqual(ws.recentDifficulty, []);
    });

    it("o estado reduzido carrega o feedback E não inclui campos fora da Fatia 1", () => {
      const ws = assembleWorldState({
        userId: "gt4",
        trainingGoal: "hypertrophy",
        workoutFeedbackHistory: [makeFeedback("easy"), makeFeedback("easy")],
      }) as unknown as Record<string, unknown>;

      // Carrega o que o cérebro precisa…
      assert.ok("recentDifficulty" in ws);
      assert.ok("feedbackSignal" in ws);
      // …e NADA de risco/morte/DuoHealth/Arena/Avatar/XP/Proatividade.
      for (const forbidden of ["duoHealth", "abandonmentRisk", "riskBand", "avatarState", "xp", "arena", "deathSignal"]) {
        assert.ok(!(forbidden in ws), `campo fora da Fatia 1 não pode aparecer: ${forbidden}`);
      }
    });
  });
});

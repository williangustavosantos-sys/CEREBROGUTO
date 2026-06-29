// Commit 5 — Fatia 1: decideTurn — chamada governada própria + persist honesto.
// Deps 100% mockadas: nenhum HTTP real, nenhuma dependência do server.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { decideTurn } from "../src/brain/decide-turn.js";
import type { DecideTurnDeps, ModelCallResult } from "../src/brain/decide-turn.js";
import type { ReducedWorldState } from "../src/brain/types.js";

const here = dirname(fileURLToPath(import.meta.url));

const baseWorldState: ReducedWorldState = {
  userId: "u1",
  language: "pt-BR",
  recentDifficulty: [],
  feedbackSignal: null,
  risk: null,
  missingFields: [],
};

/** Constrói deps mockadas + contadores para asserções. */
function makeDeps(opts: {
  modelResult: ModelCallResult | (() => Promise<ModelCallResult>);
  parsed: unknown;
  persist?: (userId: string, patch: Record<string, unknown>) => Promise<void>;
}) {
  const counters = { build: 0, model: 0, parse: 0, persist: 0 };
  const deps: DecideTurnDeps = {
    buildPrompt: () => {
      counters.build++;
      return "PROMPT";
    },
    callModel: async (_prompt) => {
      counters.model++;
      return typeof opts.modelResult === "function"
        ? await opts.modelResult()
        : opts.modelResult;
    },
    parseResponse: () => {
      counters.parse++;
      return opts.parsed;
    },
    persist: opts.persist
      ? async (userId, patch) => {
          counters.persist++;
          await opts.persist!(userId, patch);
        }
      : undefined,
  };
  return { deps, counters };
}

// ─── Caminho feliz ────────────────────────────────────────────────────────────

test("resposta válida (acao=none) → validation:'ok' + exatamente 1 chamada ao modelo", async () => {
  const { deps, counters } = makeDeps({
    modelResult: { ok: true, rawText: "{}" },
    parsed: { fala: "Bora treinar hoje?", acao: "none", expectedResponse: null },
  });
  const contract = await decideTurn({ worldState: baseWorldState, input: "oi" }, deps);

  assert.equal(contract.validation, "ok");
  assert.equal(contract.response.fala, "Bora treinar hoje?");
  assert.equal(contract.response.acao, "none");
  assert.equal(counters.model, 1, "deve haver EXATAMENTE 1 chamada ao modelo");
  assert.equal(contract.meta.modelCalled, true);
});

test("resposta válida com memoryPatch → persiste exatamente 1x + persisted:true", async () => {
  let persistedPatch: Record<string, unknown> | null = null;
  const { deps, counters } = makeDeps({
    modelResult: { ok: true, rawText: "{}" },
    parsed: {
      fala: "Anotado, campeão.",
      acao: "none",
      expectedResponse: null,
      memoryPatch: { lastMood: "motivado" },
    },
    persist: async (_userId, patch) => {
      persistedPatch = patch;
    },
  });
  const contract = await decideTurn({ worldState: baseWorldState, input: "tô animado" }, deps);

  assert.equal(contract.validation, "ok");
  assert.equal(counters.persist, 1, "persist deve ser chamado EXATAMENTE 1x");
  assert.equal(contract.meta.persisted, true);
  assert.deepEqual(persistedPatch, { lastMood: "motivado" });
  assert.deepEqual(contract.response.memoryPatch, { lastMood: "motivado" });
});

test("resposta válida SEM memoryPatch → não persiste + persisted:false", async () => {
  const { deps, counters } = makeDeps({
    modelResult: { ok: true, rawText: "{}" },
    parsed: { fala: "Tamo junto.", acao: "none", expectedResponse: null },
    persist: async () => {},
  });
  const contract = await decideTurn({ worldState: baseWorldState, input: "valeu" }, deps);

  assert.equal(contract.validation, "ok");
  assert.equal(counters.persist, 0, "sem memoryPatch não deve persistir");
  assert.equal(contract.meta.persisted, false);
});

// ─── Ação complexa → defer ─────────────────────────────────────────────────────

test("ação complexa (updateWorkout) → defer, sem persistir", async () => {
  let persistCalled = false;
  const { deps, counters } = makeDeps({
    modelResult: { ok: true, rawText: "{}" },
    parsed: {
      fala: "Vou montar teu treino.",
      acao: "updateWorkout",
      expectedResponse: null,
      memoryPatch: { x: 1 },
    },
    persist: async () => {
      persistCalled = true;
    },
  });
  const contract = await decideTurn({ worldState: baseWorldState, input: "monta meu treino" }, deps);

  assert.equal(contract.validation, "defer");
  assert.equal(persistCalled, false, "ação complexa NÃO pode persistir");
  assert.equal(counters.persist, 0);
  assert.equal(contract.meta.persisted, false);
  assert.equal(counters.model, 1, "uma chamada para descobrir que é complexa; depois defere");
});

// ─── Resposta inválida → fallback/defer sem persistência ──────────────────────

test("resposta inválida (fala vazia) → defer, sem persistir", async () => {
  let persistCalled = false;
  const { deps } = makeDeps({
    modelResult: { ok: true, rawText: "{}" },
    parsed: { fala: "", acao: "none", expectedResponse: null, memoryPatch: { x: 1 } },
    persist: async () => {
      persistCalled = true;
    },
  });
  const contract = await decideTurn({ worldState: baseWorldState, input: "oi" }, deps);

  assert.equal(contract.validation, "defer");
  assert.equal(persistCalled, false);
  assert.equal(contract.meta.persisted, false);
  // Fala de defer é neutra e honesta (não vazia, não afirma nada salvo).
  assert.ok(contract.response.fala.length > 0);
});

test("callModel retorna ok=false → defer honesto, sem persistir", async () => {
  let persistCalled = false;
  const { deps, counters } = makeDeps({
    modelResult: { ok: false },
    parsed: { fala: "irrelevante", acao: "none", expectedResponse: null },
    persist: async () => {
      persistCalled = true;
    },
  });
  const contract = await decideTurn({ worldState: baseWorldState, input: "oi" }, deps);

  assert.equal(contract.validation, "defer");
  assert.equal(persistCalled, false);
  assert.equal(counters.parse, 0, "não deve nem parsear se a chamada falhou");
  assert.equal(contract.meta.modelCalled, true);
});

test("callModel lança exceção → defer honesto, sem persistir", async () => {
  const { deps } = makeDeps({
    modelResult: async () => {
      throw new Error("timeout");
    },
    parsed: { fala: "x", acao: "none", expectedResponse: null },
  });
  const contract = await decideTurn({ worldState: baseWorldState, input: "oi" }, deps);

  assert.equal(contract.validation, "defer");
  assert.equal(contract.meta.persisted, false);
  assert.equal(contract.meta.modelCalled, true);
});

// ─── Falha de persistência → não afirmar "salvei" ────────────────────────────

test("falha de persistência → validation continua ok, persisted:false, fala não afirma salvar", async () => {
  const { deps, counters } = makeDeps({
    modelResult: { ok: true, rawText: "{}" },
    parsed: {
      fala: "Tamo junto nessa.",
      acao: "none",
      expectedResponse: null,
      memoryPatch: { lastMood: "ok" },
    },
    persist: async () => {
      throw new Error("disco cheio");
    },
  });
  const contract = await decideTurn({ worldState: baseWorldState, input: "oi" }, deps);

  // A decisão do turno é válida; só a gravação falhou.
  assert.equal(contract.validation, "ok");
  assert.equal(contract.meta.persisted, false, "persisted deve refletir a falha REAL");
  assert.equal(counters.persist, 1, "tentou persistir exatamente 1x");
  // A fala é a conversacional do modelo — não inventamos "salvei".
  assert.equal(contract.response.fala, "Tamo junto nessa.");
  assert.ok(!/salv|guard|saved|stored/i.test(contract.response.fala));
});

// ─── meta nunca entra no payload público ─────────────────────────────────────

test("meta interno NÃO aparece em response (LEI 11)", async () => {
  const { deps } = makeDeps({
    modelResult: { ok: true, rawText: "{}" },
    parsed: {
      fala: "Oi!",
      acao: "none",
      expectedResponse: null,
      // Campos de meta que um modelo malicioso/confuso poderia injetar:
      kind: "leak",
      via: "leak",
      reasoning: "leak",
      modelCalled: false,
      persisted: true,
    },
  });
  const contract = await decideTurn({ worldState: baseWorldState, input: "oi" }, deps);

  // Candidato tinha chaves de meta → validateContract reprova → defer (não vaza).
  assert.equal(contract.validation, "defer");
  const responseKeys = Object.keys(contract.response);
  for (const metaKey of ["kind", "via", "reasoning", "modelCalled", "persisted"]) {
    assert.ok(!responseKeys.includes(metaKey), `response não pode conter meta '${metaKey}'`);
  }
});

test("response do caminho ok contém só campos públicos (sem chaves de meta)", async () => {
  const { deps } = makeDeps({
    modelResult: { ok: true, rawText: "{}" },
    parsed: { fala: "Beleza!", acao: "none", expectedResponse: { type: "text", options: ["Ok"] } },
  });
  const contract = await decideTurn({ worldState: baseWorldState, input: "oi" }, deps);

  const allowed = new Set(["fala", "acao", "expectedResponse", "avatarEmotion", "workoutPlan", "memoryPatch"]);
  for (const key of Object.keys(contract.response)) {
    assert.ok(allowed.has(key), `chave inesperada em response: ${key}`);
  }
});

// ─── Garantia estática: askGutoModel não é chamado nem importado ──────────────

test("decide-turn.ts não CHAMA askGutoModel nem importa server.ts", () => {
  const src = readFileSync(resolve(here, "../src/brain/decide-turn.ts"), "utf8");
  const lines = src.split("\n");
  const isComment = (l: string) => l.trim().startsWith("//") || l.trim().startsWith("*");

  // Constraint real: nenhuma INVOCAÇÃO de askGutoModel em linha de código (comentário é ok).
  const callsAsk = lines.some((l) => !isComment(l) && /askGutoModel\s*\(/.test(l));
  assert.ok(!callsAsk, "decide-turn.ts não pode CHAMAR askGutoModel");

  // Nenhuma linha de import (código) pode trazer askGutoModel ou server.ts.
  const importLines = lines.filter((l) => !isComment(l) && /\bimport\b|\brequire\(/.test(l));
  for (const l of importLines) {
    assert.ok(!/askGutoModel/.test(l), `import não pode trazer askGutoModel: ${l.trim()}`);
    assert.ok(!/["'][^"']*server["']/.test(l), `import não pode trazer server.ts: ${l.trim()}`);
  }
});

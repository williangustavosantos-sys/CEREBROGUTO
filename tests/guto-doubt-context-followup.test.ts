import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import {
  classifyShortContextIntent,
  parseDietContext,
  isSubstituteAskMessage,
} from "../src/chat-context-intent.js";
import { resolveFoodIdByName } from "../src/food-catalog.js";
import { suggestFoodSubstitutes } from "../src/food-availability.js";

// BUG 2 (exercício) e BUG 3 (alimento): enquanto o card de contexto está ativo, o
// 2º turno curto ("está ocupado" / "qual?") tem que USAR aquele contexto — nunca
// reperguntar "qual aparelho" nem responder genérico. Princípio 6 do GUTO.

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.doubt-followup-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearMemoryStoreCache: () => void = () => {};
let originalFetch: typeof globalThis.fetch;

function writeUserMemory(userId: string, data: Record<string, any>) {
  const store = existsSync(testMemoryFile)
    ? (JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>)
    : {};
  store[userId] = { userId, name: "Will", language: "pt-BR", ...data };
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2));
}

async function postGuto(userId: string, input: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  const res = await originalFetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "pt-BR", profile: { userId, name: "Will" }, history: [], input }),
  });
  assert.equal(res.status, 200, `POST /guto deveria responder 200, veio ${res.status}`);
  return (await res.json()) as { fala?: string; acao?: string };
}

const RE_ASK_RE = /qual aparelho|qual m[áa]quina|which machine|quale attrezzo/i;
const GENERIC_BREAKFAST_RE = /primeira (alimenta|refei)|sagrad|caf[ée] da manh[ãa] é/i;

describe("BUG 2/3 — contexto de dúvida persiste no 2º turno (puro)", () => {
  it("resolveFoodIdByName('Aveia em flocos') resolve para o id do catálogo (oats)", () => {
    assert.equal(resolveFoodIdByName("Aveia em flocos"), "oats");
    assert.equal(resolveFoodIdByName("aveia"), "oats");
    assert.equal(resolveFoodIdByName("pão integral"), "wholegrain_bread");
    assert.equal(resolveFoodIdByName("alimento que não existe xyz"), undefined);
  });

  it("parseDietContext extrai foodName e mealName do bloco injetado", () => {
    const block = '[DIET CONTEXT — language: pt-BR — nutrition only] Food in question: "Aveia em flocos" (40g, 150 kcal). Meal: "Café da manhã" (08:00). User question: Qual?';
    assert.deepEqual(parseDietContext(block), { foodName: "Aveia em flocos", mealName: "Café da manhã" });
    assert.equal(parseDietContext("sem contexto"), null);
  });

  it("'Qual?' em contexto de alimento → food_substitute_request (não 'none')", () => {
    const block = '[DIET CONTEXT — language: pt-BR — nutrition only] Food in question: "Aveia em flocos" (40g). Meal: "Café da manhã". User question: ';
    assert.equal(classifyShortContextIntent({ rawInput: `${block}Qual?` }).intent, "food_substitute_request");
    assert.equal(classifyShortContextIntent({ rawInput: `${block}qual a troca?` }).intent, "food_substitute_request");
    assert.equal(classifyShortContextIntent({ rawInput: `${block}com o que troco?` }).intent, "food_substitute_request");
    // Regressão: pergunta de caloria NÃO é pedido de substituto (vai pro modelo).
    assert.equal(classifyShortContextIntent({ rawInput: `${block}quantas calorias tem?` }).intent, "none");
  });

  it("isSubstituteAskMessage não casa dentro de 'qualidade'/'qualquer'", () => {
    assert.equal(isSubstituteAskMessage("qual?"), true);
    assert.equal(isSubstituteAskMessage("qualidade do alimento"), false);
    assert.equal(isSubstituteAskMessage("qualquer coisa serve"), false);
  });

  it("suggestFoodSubstitutes entrega substitutos reais e veganos para aveia (BR)", () => {
    const subs = suggestFoodSubstitutes({
      originalFoodId: "oats",
      country: "brazil",
      constraints: { restrictions: ["vegano", "vegan"] },
      useContext: "meal_substitution",
    });
    assert.ok(subs.length > 0, "aveia precisa ter ao menos 1 substituto resolvível");
    assert.ok(
      subs.some((f) => ["wholegrain_bread", "rice_cakes"].includes(f.id)),
      "substitutos esperados (pão integral / biscoito de arroz) devem aparecer"
    );
  });
});

describe("BUG 2/3 — fluxo HTTP determinístico (pré-modelo)", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    mkdirSync(tmpDir, { recursive: true });
    originalFetch = globalThis.fetch.bind(globalThis);
    // Mock do modelo: se chamado (só nos casos NÃO interceptados), responde genérico
    // — qualquer assert de "não genérico" prova que o determinístico interceptou.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("generativelanguage.googleapis.com")) return originalFetch(input as any, init);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ fala: "O café da manhã é a primeira refeição do dia, sagrada.", acao: "none", expectedResponse: null }) }] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof globalThis.fetch;

    const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as { app: typeof app };
    app = serverModule.app;
    const memStore = (await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as {
      clearMemoryStoreCache: () => void;
    };
    clearMemoryStoreCache = memStore.clearMemoryStoreCache;

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind doubt-followup test server.");
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

  // ── BUG 2 — exercício: SEM lastWorkoutPlan, ainda resolve pelo catálogo ──────
  it("contexto de exercício + 'está ocupado' SEM plano persistido → substitui pelo catálogo, nunca 'qual aparelho'", async () => {
    const userId = "ex-busy-no-plan";
    // Repare: NENHUM lastWorkoutPlan — só o card de contexto. Era o cenário do bug.
    writeUserMemory(userId, {
      trainingGoal: "muscle_gain",
      trainingLevel: "consistent",
      preferredTrainingLocation: "gym",
    });
    clearMemoryStoreCache();

    const ctx = '[WORKOUT EXERCISE CONTEXT — language: pt-BR] Exercise: "Supino reto máquina" (canonical PT: Supino reto máquina). Muscle group: peito.';
    const res = await postGuto(userId, `${ctx} User message: está ocupado`);

    assert.equal(res.acao, "none");
    assert.doesNotMatch(res.fala || "", RE_ASK_RE, "não pode reperguntar qual aparelho com o card ativo");
    // Nomeia o exercício do contexto (não responde genérico/vazio).
    assert.match(res.fala || "", /supino|troca por|pula ele|swap/i);
  });

  // ── BUG 3 — alimento: 1º turno acolhe, 2º turno entrega substituto concreto ──
  it("contexto de alimento: 'não tem em casa' → acolhe; 'Qual?' → substituto CONCRETO, não genérico", async () => {
    const userId = "food-followup";
    writeUserMemory(userId, {
      trainingGoal: "muscle_gain",
      trainingLevel: "consistent",
      country: "Brasil",
      countryCode: "BR",
      foodRestrictions: "vegano",
    });
    clearMemoryStoreCache();

    const ctxLines = (msg: string) =>
      [
        "[DIET CONTEXT — language: pt-BR — nutrition only]",
        'Food in question: "Aveia em flocos" (40g, 150 kcal).',
        'Meal: "Café da manhã" (08:00).',
        "Food restrictions (what they avoid eating, incl. intolerances/allergies): vegano.",
        `User question: ${msg}`,
      ].join(" ");

    // Turno 1: acolhe (ack), sem genérico de café da manhã.
    const turn1 = await postGuto(userId, ctxLines("não tem em casa"));
    assert.equal(turn1.acao, "none");
    assert.match(turn1.fala || "", /troco|equivalente|substitu/i);

    // Turno 2: "Qual?" → substituto CONCRETO nomeado, mantendo o contexto.
    const turn2 = await postGuto(userId, ctxLines("Qual?"));
    assert.equal(turn2.acao, "none");
    assert.match(turn2.fala || "", /troca/i);
    // Nomeia um substituto real da aveia (pão integral / biscoito de arroz).
    assert.match(turn2.fala || "", /p[ãa]o integral|biscoito de arroz|rice cake/i);
    // E NÃO cai no texto genérico do modelo (mockado acima).
    assert.doesNotMatch(turn2.fala || "", GENERIC_BREAKFAST_RE, "não pode responder genérico no 2º turno");
  });
});

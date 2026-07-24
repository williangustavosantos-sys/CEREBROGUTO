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
import { getCatalogById } from "../exercise-catalog.js";
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
const INVALID_ARM_SWAP_RE = /troca por\s+b[íi]ceps|b[íi]ceps m[aá]quina|rosca/i;

function captureExerciseSubstitute(text: string) {
  return text.match(/troca por\s+([^:.]+)(?:[:.])/i)?.[1]?.trim() || "";
}

function captureFoodSubstitute(text: string) {
  return text.match(/por\s+([^,.]+)(?:[,.\n]|$)/i)?.[1]?.trim() || "";
}

function catalogExercise(id: string, overrides: Record<string, unknown> = {}) {
  const entry = getCatalogById(id);
  assert.ok(entry, `${id} deve existir no catálogo`);
  return {
    id: entry.id,
    name: entry.canonicalNamePt,
    canonicalNamePt: entry.canonicalNamePt,
    muscleGroup: entry.muscleGroup,
    sets: 3,
    reps: "10-12",
    rest: "60s",
    cue: "Controle a execução.",
    note: "Base do treino.",
    videoUrl: entry.videoUrl,
    videoProvider: "local",
    sourceFileName: entry.sourceFileName,
    ...overrides,
  };
}

function chestTricepsPlan() {
  return {
    title: "Peito, ombro e tríceps",
    focus: "Peito, ombro e tríceps",
    focusKey: "chest_triceps",
    location: "academia",
    locationMode: "gym",
    dateLabel: "Hoje",
    scheduledFor: new Date().toISOString(),
    summary: "Peito, ombro e tríceps.",
    exercises: [
      catalogExercise("supino_reto"),
      catalogExercise("desenvolvimento_sentado"),
      catalogExercise("triceps_polia_alta", { sets: 4, reps: "12", rest: "60s" }),
    ],
  };
}

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
    // Mock do cérebro soberano: estes cenários eram resolvidos por interceptação
    // pré-modelo; agora o modelo decide e os trilhos só informam contexto.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("generativelanguage.googleapis.com")) return originalFetch(input as any, init);
      const body = JSON.parse(String(init?.body || "{}")) as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
      const prompt = body.contents?.[0]?.parts?.[0]?.text || "";
      const message = prompt.split("MENSAGEM DO USUÁRIO:").pop() || prompt;
      let payload = { fala: "O café da manhã é a primeira refeição do dia, sagrada.", acao: "none", expectedResponse: null };
      if (/tr[ií]ceps[\s\S]*b[ií]ceps/i.test(message)) {
        payload = {
          fala: "Boa observação. Você tem razão. Não faz sentido trocar tríceps por bíceps. Troca por Tríceps barra V cabo.",
          acao: "none",
          expectedResponse: null,
        };
      } else if (/tamb[eé]m est[aá] ocupado/i.test(message)) {
        payload = {
          fala: "Tríceps ainda ocupado? Troca por Tríceps francês cabo: mantém séries e descanso.",
          acao: "none",
          expectedResponse: null,
        };
      } else if (/tr[ií]ceps polia alta ocupado/i.test(message)) {
        payload = {
          fala: "Tríceps polia alta ocupado? Troca por Tríceps barra V cabo: mantém 4 séries de 12.",
          acao: "none",
          expectedResponse: null,
        };
      } else if (/supino reto m[aá]quina[\s\S]*est[aá] ocupado/i.test(message)) {
        payload = {
          fala: "Supino reto máquina ocupado? Troca por Supino reto com halteres: mesma missão de peito.",
          acao: "none",
          expectedResponse: null,
        };
      } else if (/n[aã]o tenho tamb[eé]m/i.test(message)) {
        payload = {
          fala: "Troca aveia em flocos por biscoito de arroz, mantendo a energia do Café da manhã.",
          acao: "none",
          expectedResponse: null,
        };
      } else if (/aveia[\s\S]*(n[aã]o tem|n[aã]o tenho|qual\?)/i.test(message)) {
        payload = {
          fala: "Troca aveia em flocos por pão integral, mantendo a energia do Café da manhã.",
          acao: "none",
          expectedResponse: null,
        };
      } else if (/n[aã]o tenho banana/i.test(message)) {
        payload = {
          fala: "Troca banana por maçã. Mesma função no lanche, sem furar a dieta.",
          acao: "none",
          expectedResponse: null,
        };
      }
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
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

  it("mensagem direta 'Tríceps polia alta ocupado' → substituto validado de tríceps, nunca bíceps", async () => {
    const userId = "triceps-busy-direct";
    writeUserMemory(userId, {
      trainingGoal: "muscle_gain",
      trainingLevel: "consistent",
      preferredTrainingLocation: "gym",
      trainingLocation: "academia",
      lastWorkoutPlan: chestTricepsPlan(),
    });
    clearMemoryStoreCache();

    const res = await postGuto(userId, "Tríceps polia alta ocupado");

    assert.equal(res.acao, "none");
    assert.match(res.fala || "", /tr[íi]ceps/i);
    assert.match(res.fala || "", /troca por|pula ele/i);
    assert.doesNotMatch(res.fala || "", INVALID_ARM_SWAP_RE, "não pode trocar tríceps por bíceps/rosca");
    assert.doesNotMatch(res.fala || "", RE_ASK_RE, "não pode perguntar qual aparelho quando o exercício veio no texto");
  });

  it("exercício ocupado → rejeição curta no turno seguinte sugere outro substituto e não repete", async () => {
    const userId = "triceps-busy-reject-next";
    writeUserMemory(userId, {
      trainingGoal: "muscle_gain",
      trainingLevel: "consistent",
      preferredTrainingLocation: "gym",
      trainingLocation: "academia",
      lastWorkoutPlan: chestTricepsPlan(),
    });
    clearMemoryStoreCache();

    const turn1 = await postGuto(userId, "Tríceps polia alta ocupado");
    const firstSubstitute = captureExerciseSubstitute(turn1.fala || "");
    assert.ok(firstSubstitute, `primeira resposta deveria nomear substituto: ${turn1.fala}`);

    const turn2 = await postGuto(userId, "também está ocupado");
    const secondSubstitute = captureExerciseSubstitute(turn2.fala || "");
    assert.equal(turn2.acao, "none");
    assert.match(turn2.fala || "", /tr[íi]ceps/i);
    assert.doesNotMatch(turn2.fala || "", INVALID_ARM_SWAP_RE, "não pode trocar tríceps por bíceps/rosca");
    assert.match(
      turn2.fala || "",
      new RegExp(`${firstSubstitute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ocupado`, "i"),
      "deve nomear literalmente o substituto que acabou de ser rejeitado",
    );
    assert.ok(secondSubstitute, `segunda resposta deveria nomear outro substituto: ${turn2.fala}`);
    assert.notEqual(secondSubstitute.toLocaleLowerCase("pt-BR"), firstSubstitute.toLocaleLowerCase("pt-BR"), "não pode sugerir de novo o substituto rejeitado");
    assert.doesNotMatch(turn2.fala || "", RE_ASK_RE, "não pode perder contexto e perguntar qual aparelho");
  });

  it("objeção 'tríceps por bíceps' → admite erro e corrige, sem continuar perguntando motivo", async () => {
    const userId = "triceps-objection";
    writeUserMemory(userId, {
      trainingGoal: "muscle_gain",
      trainingLevel: "consistent",
      preferredTrainingLocation: "gym",
      trainingLocation: "academia",
      lastWorkoutPlan: chestTricepsPlan(),
    });
    clearMemoryStoreCache();

    const res = await postGuto(userId, "Mas como eu vou trocar o exercício de tríceps por bíceps se o treino é de tríceps?");

    assert.equal(res.acao, "none");
    assert.match(res.fala || "", /voc[êe] tem raz[ãa]o|boa observa/i);
    assert.match(res.fala || "", /n[aã]o faz sentido/i);
    assert.match(res.fala || "", /tr[íi]ceps/i);
    assert.doesNotMatch(res.fala || "", /trocar por qu[êe]|dor, equipamento ocupado|dificuldade de execu/i);
    assert.doesNotMatch(res.fala || "", INVALID_ARM_SWAP_RE, "correção não pode insistir em bíceps/rosca");
  });

  // ── BUG 3 — alimento: 1º turno já entrega substituto concreto ───────────────
  it("contexto de alimento: 'não tem em casa' → substituto CONCRETO imediato, não genérico", async () => {
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

    // Turno 1: já nomeia substituto real, sem postergar para "Qual?".
    const turn1 = await postGuto(userId, ctxLines("não tem em casa"));
    assert.equal(turn1.acao, "none");
    assert.match(turn1.fala || "", /troca/i);
    assert.match(turn1.fala || "", /p[ãa]o integral|biscoito de arroz|rice cake/i);
    assert.doesNotMatch(turn1.fala || "", /posso substituir|posso trocar/i);

    // Turno 2: "Qual?" → substituto CONCRETO nomeado, mantendo o contexto.
    const turn2 = await postGuto(userId, ctxLines("Qual?"));
    assert.equal(turn2.acao, "none");
    assert.match(turn2.fala || "", /troca/i);
    // Nomeia um substituto real da aveia (pão integral / biscoito de arroz).
    assert.match(turn2.fala || "", /p[ãa]o integral|biscoito de arroz|rice cake/i);
    // E NÃO cai no texto genérico do modelo (mockado acima).
    assert.doesNotMatch(turn2.fala || "", GENERIC_BREAKFAST_RE, "não pode responder genérico no 2º turno");
  });

  it("dieta: 'não tenho aveia' → sugestão A; 'não tenho também' → sugestão B ou pergunta disponíveis", async () => {
    const userId = "food-reject-next";
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

    const turn1 = await postGuto(userId, ctxLines("não tenho em casa"));
    const firstSubstitute = captureFoodSubstitute(turn1.fala || "");
    assert.ok(firstSubstitute, `primeira resposta deveria nomear substituto alimentar: ${turn1.fala}`);

    const turn2 = await postGuto(userId, ctxLines("não tenho também"));
    assert.equal(turn2.acao, "none");
    assert.doesNotMatch(turn2.fala || "", GENERIC_BREAKFAST_RE, "não pode cair no texto genérico do modelo");
    assert.match(
      turn2.fala || "",
      new RegExp(firstSubstitute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      "a segunda resposta precisa referenciar a opção que acabou de ser rejeitada",
    );
    const secondSubstitute = captureFoodSubstitute(turn2.fala || "");
    assert.ok(secondSubstitute, `segunda resposta deveria nomear outro substituto: ${turn2.fala}`);
    assert.notEqual(secondSubstitute.toLocaleLowerCase("pt-BR"), firstSubstitute.toLocaleLowerCase("pt-BR"));
    assert.match(turn2.fala || "", /troca|dispon[ií]vel|tem em casa|available/i);
  });

  it("sem contexto explícito: 'não tenho banana' → substituto direto, sem perguntar 'o que?'", async () => {
    const userId = "food-banana-direct";
    writeUserMemory(userId, {
      trainingGoal: "fat_loss",
      trainingLevel: "beginner",
      country: "Brasil",
      countryCode: "BR",
      foodRestrictions: "sem restrição alimentar",
    });
    clearMemoryStoreCache();

    const res = await postGuto(userId, "não tenho banana");

    assert.equal(res.acao, "none");
    assert.match(res.fala || "", /troca/i);
    assert.match(res.fala || "", /ma[çc][aã]|frutas vermelhas/i);
    assert.doesNotMatch(res.fala || "", /Não tem o qu[eê]|alimento ou aparelho|posso substituir/i);
  });
});

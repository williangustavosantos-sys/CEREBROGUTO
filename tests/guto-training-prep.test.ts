import "./test-env.js";
// Força o classificador determinístico (fallback por palavra-chave): sem chave,
// classifyContractIntent usa classifyContractIntentFallback e o caminho de
// resposta resolve a preparação sem depender do modelo.
process.env.GEMINI_API_KEY = "";
process.env.GUTO_GEMINI_MODEL = process.env.GUTO_GEMINI_MODEL || "gemini-3.1-flash-lite";
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";
// O diet-store decide o Redis pelas envs UPSTASH (não pelo flag de teste). Zera
// para o store usar só o cache em memória/arquivo e nunca tocar Redis de produção.
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

const dir = join(process.cwd(), "tmp");
const memFile = join(dir, "guto-memory.prep-test.json");
const dietFile = join(dir, "guto-diet.prep-test.json");

let app: { listen: (port: number, host: string, cb?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearCache: () => void = () => {};
let classifyContractIntentFallback: (input: {
  rawInput: string;
  memory: any;
  previousExpectedResponse?: unknown;
}) => { kind: string };
let saveDietPlan: (plan: any) => Promise<void>;

const BASE = {
  name: "Will", language: "pt-BR", biologicalSex: "male", userAge: 30,
  heightCm: 178, weightKg: 80, trainingLevel: "consistent", trainingStatus: "consistent",
  trainingGoal: "hypertrophy", preferredTrainingLocation: "home", trainingLocation: "home",
  trainingPathology: "sem dor", initialXpGranted: true, totalXp: 100,
  lastWorkoutCompletedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
};

function readStore(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}

function seed(userId: string, data: Record<string, any>) {
  const existing = readStore(memFile);
  existing[userId] = { ...BASE, ...data };
  writeFileSync(memFile, JSON.stringify(existing, null, 2));
  clearCache();
}

async function seedDiet(userId: string) {
  await saveDietPlan({
    userId,
    generatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    country: "Brazil",
    countryCode: "BR",
    macros: { targetKcal: 2200, proteinG: 160, carbsG: 230, fatG: 70 },
    meals: [
      {
        id: "cafe",
        name: "Café da manhã",
        time: "08:00",
        foods: [
          { name: "Ovos mexidos", quantity: "3 unidades", kcal: 220 },
          { name: "Aveia", quantity: "40g", kcal: 150 },
        ],
        totalKcal: 370,
        gutoNote: "Combustível do dia.",
      },
      {
        id: "almoco",
        name: "Almoço",
        time: "13:00",
        foods: [{ name: "Frango", quantity: "180g", kcal: 300 }],
        totalKcal: 600,
        gutoNote: "",
      },
    ],
  });
}

async function chat(userId: string, input: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "pt-BR", profile: { userId, name: "Will" }, history: [], input }),
  });
  return (await r.json()) as { fala?: string; acao?: string };
}

before(async () => {
  process.env.GUTO_MEMORY_FILE = memFile;
  process.env.GUTO_DIET_FILE = dietFile;
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_ALLOW_DEV_ACCESS = "true";
  mkdirSync(dir, { recursive: true });
  writeFileSync(memFile, JSON.stringify({}, null, 2));
  writeFileSync(dietFile, JSON.stringify({}, null, 2));

  const serverMod = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as any;
  app = serverMod.app;
  classifyContractIntentFallback = serverMod.classifyContractIntentFallback;
  clearCache = ((await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as any)
    .clearMemoryStoreCache;
  saveDietPlan = ((await import(pathToFileURL(join(process.cwd(), "src/diet-store.ts")).href)) as any)
    .saveDietPlan;

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

// ─── Nível classificador (piso determinístico) ──────────────────────────────
describe("classifyContractIntentFallback — preparação ≠ recusa", () => {
  const classify = (rawInput: string) =>
    classifyContractIntentFallback({ rawInput, memory: {}, previousExpectedResponse: null });

  for (const msg of [
    "vou tomar café primeiro",
    "vou comer antes",
    "vou beber água antes",
    "vou tomar pré-treino",
    "vou trocar de roupa",
    "vou ao banheiro",
    "vou chegar na academia",
    "estou indo pra academia",
    "deixa eu terminar de comer",
    "espera 10 minutos",
  ]) {
    it(`training_prep: "${msg}"`, () => {
      assert.equal(classify(msg).kind, "training_prep");
    });
  }

  it("recusa real continua recusa (não vira training_prep)", () => {
    assert.notEqual(classify("não vou treinar hoje").kind, "training_prep");
    assert.notEqual(classify("não quero treinar").kind, "training_prep");
    // "vou deixar pra amanhã" continua sendo adiamento (postpone).
    assert.equal(classify("vou deixar pra amanhã").kind, "postpone");
  });

  it("'academia' pura ainda responde o local; quando GUTO pergunta o local, 'vou pra academia' também", () => {
    assert.equal(classify("academia").kind, "location_answer");
    const expectingLocation = { type: "text", context: "training_location" } as const;
    assert.equal(
      classifyContractIntentFallback({ rawInput: "vou pra academia", memory: {}, previousExpectedResponse: expectingLocation }).kind,
      "location_answer",
    );
  });
});

// ─── Comportamento ponta-a-ponta (/guto, sem Gemini → fallback determinístico) ──
describe("GUTO chat — preparação antes do treino mantém treino + dieta", () => {
  const PREP = /come e volta|bebe e volta|se ajeita e volta|te puxo pro treino|continua de pé|continua de pe/i;
  const REFUSAL = /caminhada|ninguém desiste|ninguem desiste|perde xp|perco força|perco forca|streak|pacto/i;

  it("'vou tomar café primeiro' COM dieta → menciona café/refeição e mantém treino", async () => {
    const userId = "prep-cafe-diet";
    seed(userId, {});
    await seedDiet(userId);
    const r = await chat(userId, "vou tomar café primeiro");
    assert.match(r.fala || "", /café|cafe|dieta|refei/i, "deve puxar a refeição da dieta");
    assert.match(r.fala || "", PREP, "deve manter o treino e pedir retorno curto");
    assert.doesNotMatch(r.fala || "", REFUSAL, "NÃO pode tratar como recusa/caminhada");
    assert.notEqual(r.acao, "updateWorkout");
  });

  it("'vou tomar café primeiro' SEM dieta → não inventa dieta, só autoriza pausa curta", async () => {
    const userId = "prep-cafe-nodiet";
    seed(userId, {});
    const r = await chat(userId, "vou tomar café primeiro");
    assert.match(r.fala || "", PREP, "deve manter o treino e pedir retorno curto");
    assert.doesNotMatch(r.fala || "", /dieta/i, "sem dieta cadastrada NÃO pode citar/inventar dieta");
    assert.doesNotMatch(r.fala || "", REFUSAL, "NÃO pode tratar como recusa/caminhada");
    assert.notEqual(r.acao, "updateWorkout");
  });

  it("'vou beber água antes' → hidratação, mantém treino", async () => {
    const userId = "prep-agua";
    seed(userId, {});
    const r = await chat(userId, "vou beber água antes");
    assert.match(r.fala || "", /hidrat|água|agua|bebe/i, "deve reconhecer hidratação");
    assert.match(r.fala || "", PREP, "deve manter o treino");
    assert.doesNotMatch(r.fala || "", REFUSAL);
  });

  it("'vou trocar de roupa' → preparação, mantém treino", async () => {
    const userId = "prep-roupa";
    seed(userId, {});
    const r = await chat(userId, "vou trocar de roupa");
    assert.match(r.fala || "", PREP, "deve manter o treino e pedir retorno curto");
    assert.doesNotMatch(r.fala || "", REFUSAL);
    assert.notEqual(r.acao, "updateWorkout");
  });

  it("'estou indo pra academia' → deslocamento, mantém treino", async () => {
    const userId = "prep-indo";
    seed(userId, {});
    const r = await chat(userId, "estou indo pra academia");
    assert.match(r.fala || "", PREP, "deslocamento mantém o treino");
    assert.doesNotMatch(r.fala || "", REFUSAL);
  });

  it("'vou deixar pra amanhã' → continua sendo recusa real (não vira preparação)", async () => {
    const userId = "prep-recusa";
    seed(userId, {});
    const r = await chat(userId, "vou deixar pra amanhã");
    assert.doesNotMatch(r.fala || "", /te puxo pro treino|hidrata/i, "recusa NÃO pode usar a fala de preparação");
    assert.match(r.fala || "", /amanh|mínimo seguro|minimo seguro|10 minutos/i, "deve tratar como recusa real sem virar preparação");
    assert.doesNotMatch(r.fala || "", REFUSAL, "recusa real não pode usar culpa por XP/streak/vínculo");
  });
});

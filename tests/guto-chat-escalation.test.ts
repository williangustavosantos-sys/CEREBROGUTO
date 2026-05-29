import "./test-env.js";
// Força o classificador determinístico (fallback por palavra-chave): sem chave,
// classifyContractIntent usa classifyContractIntentFallback e o caminho de
// resposta aplica a escada de persistência sem depender do modelo.
process.env.GEMINI_API_KEY = "";
process.env.GUTO_GEMINI_MODEL = process.env.GUTO_GEMINI_MODEL || "gemini-3.1-flash-lite";
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

const dir = join(process.cwd(), "tmp");
const file = join(dir, "guto-memory.escalation-test.json");
const DAY = 24 * 60 * 60 * 1000;

let app: { listen: (port: number, host: string, cb?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearCache: () => void = () => {};

function readMem(userId: string): Record<string, any> | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"))[userId];
}

function seed(userId: string, data: Record<string, any>) {
  const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  store[userId] = { ...store[userId], ...data };
  writeFileSync(file, JSON.stringify(store, null, 2));
  clearCache();
}

const BASE = {
  name: "Will", language: "pt-BR", biologicalSex: "male", userAge: 30,
  heightCm: 178, weightKg: 80, trainingLevel: "consistent", trainingStatus: "consistent",
  trainingGoal: "hypertrophy", preferredTrainingLocation: "home", trainingLocation: "home",
  trainingPathology: "sem dor", initialXpGranted: true, totalXp: 100,
};

async function chat(userId: string, input: string, history: any[] = []) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "pt-BR", profile: { userId, name: "Will" }, history, input }),
  });
  return (await r.json()) as { fala?: string; acao?: string };
}

before(async () => {
  process.env.GUTO_MEMORY_FILE = file;
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_ALLOW_DEV_ACCESS = "true";
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({}, null, 2));

  app = ((await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as any).app;
  clearCache = ((await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as any)
    .clearMemoryStoreCache;

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

describe("Escada de persistência do chat (recusa / luto / dias parados)", () => {
  it("recusa por preguiça escala 1=vínculo → 2=adapta → 3=aceita+XP e PARA", async () => {
    const userId = "esc-lazy";
    seed(userId, { ...BASE, streak: 2, lastWorkoutCompletedAt: new Date(Date.now() - DAY).toISOString() });
    const history: any[] = [];
    const turn = async (input: string) => {
      const r = await chat(userId, input, [...history]);
      history.push({ role: "user", parts: [{ text: input }] });
      history.push({ role: "model", parts: [{ text: r.fala || "" }] });
      return r;
    };
    const t1 = await turn("tô enrolando");
    const t2 = await turn("tô enrolando");
    const t3 = await turn("tô enrolando");
    const t4 = await turn("tô enrolando");

    assert.match(t1.fala || "", /nome|evolu|junto/i, "estágio 1 deve usar o vínculo da dupla");
    assert.match(t2.fala || "", /caminhada|rota|15/i, "estágio 2 deve adaptar a rota");
    assert.match(t3.fala || "", /xp/i, "estágio 3 deve expor a consequência de XP");
    assert.match(t3.fala || "", /amanh/i, "estágio 3 deve manter a porta aberta pra amanhã");
    assert.match(t4.fala || "", /xp/i, "estágio 4 deve manter o aceite (não voltar a martelar)");
    assert.notEqual(t1.fala, t2.fala, "não pode repetir a mesma frase entre estágios");
  });

  it("luto recua com empatia, não força treino e não salva como limitação", async () => {
    const userId = "esc-grief";
    seed(userId, { ...BASE, streak: 3 });
    const r = await chat(userId, "guto minha mãe faleceu ontem, não consigo treinar");
    assert.match(r.fala || "", /sinto muito|cuida|lugar nenhum|teu tempo/i, "deve acolher o luto");
    assert.doesNotMatch(r.fala || "", /20 minutos|treino mínimo|vai leve/i, "não pode empurrar treino no luto");
    const mem = readMem(userId);
    assert.doesNotMatch(String(mem?.trainingLimitations || ""), /faleceu|mãe|mae/i, "luto não vira limitação de treino");
  });

  it("vários dias parado deixa o estágio 1 mais forte (sobrevivência da dupla)", async () => {
    const userId = "esc-days";
    seed(userId, { ...BASE, streak: 0, lastWorkoutCompletedAt: new Date(Date.now() - 6 * DAY).toISOString() });
    const r = await chat(userId, "tô enrolando");
    assert.match(r.fala || "", /sumiu|perco força|perco forca/i, "muitos dias parado deve acionar a alavanca de sobrevivência");
  });
});

import "./test-env.js";
// Força o caminho determinístico sem modelo: o fluxo soberano continua dono da
// fala e só pode usar fallback estruturado sem culpa por streak/vínculo/XP.
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

async function chat(userId: string, input: string, history: any[] = [], language = "pt-BR") {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language, profile: { userId, name: "Will" }, history, input }),
  });
  return (await r.json()) as { fala?: string; acao?: string; workoutPlan?: unknown };
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

describe("Fallback soberano do chat (recusa / luto / dias parados)", () => {
  it("feedback negativo abre ajuste em PT/IT sem substituir o treino persistido", async () => {
    const originalPlan = {
      focus: "Treino original",
      focusKey: "full_body",
      dateLabel: "Hoje",
      scheduledFor: new Date().toISOString(),
      summary: "Plano que não pode ser apagado.",
      exercises: [{ id: "sentinel-original" }],
    };
    const cases = [
      { userId: "esc-feedback-pt", language: "pt-BR", input: "não gostei do treino", expected: /não funcionou|exercícios|intensidade|ajusto/i },
      { userId: "esc-feedback-it", language: "it-IT", input: "non mi è piaciuto l'allenamento", expected: /non ha funzionato|esercizi|intensità|aggiusto/i },
    ] as const;

    for (const testCase of cases) {
      seed(testCase.userId, { ...BASE, language: testCase.language, lastWorkoutPlan: originalPlan });
      const response = await chat(testCase.userId, testCase.input, [], testCase.language);
      assert.equal(response.acao, "none");
      assert.equal(response.workoutPlan, undefined);
      assert.match(response.fala || "", testCase.expected);
      assert.deepEqual(readMem(testCase.userId)?.lastWorkoutPlan, originalPlan);
    }
  });

  it("janela curta com missão ativa permanece em italiano e não troca o plano", async () => {
    const originalPlan = {
      focus: "Corpo intero",
      focusKey: "full_body",
      dateLabel: "Oggi",
      scheduledFor: new Date().toISOString(),
      summary: "Missione originale.",
      exercises: [{ id: "sentinel-short-window" }],
    };
    const userId = "esc-short-window-it";
    seed(userId, { ...BASE, language: "it-IT", lastWorkoutPlan: originalPlan });

    const response = await chat(userId, "ho solo 10 minuti", [], "it-IT");

    assert.equal(response.acao, "none");
    assert.match(response.fala || "", /blocco ridotto|minimo sicuro|missione/i);
    assert.doesNotMatch(response.fala || "", /janela curta|ritmo capito|mandami età/i);
    assert.deepEqual(readMem(userId)?.lastWorkoutPlan, originalPlan);
  });

  it("recusa por preguiça escala 1=passo mínimo → 2=adapta → 3=aceita sem culpa e PARA", async () => {
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

    assert.match(t1.fala || "", /menor passo|10 minutos|adapto/i, "estágio 1 deve reduzir para o passo mínimo");
    assert.doesNotMatch(t1.fala || "", /teu nome|dupla|perco força|perco forca|perde XP|streak|pacto/i, "estágio 1 não pode usar culpa por vínculo/streak");
    assert.match(t2.fala || "", /caminhada|rota|15/i, "estágio 2 deve adaptar a rota");
    assert.doesNotMatch(t3.fala || "", /xp|perde|perco força|perco forca|streak|pacto/i, "estágio 3 não pode ameaçar XP/streak");
    assert.match(t3.fala || "", /amanh|mínimo seguro|minimo seguro|retomo/i, "estágio 3 deve manter a porta aberta pra amanhã");
    assert.doesNotMatch(t4.fala || "", /xp|perde|perco força|perco forca|streak|pacto/i, "estágio 4 deve manter o aceite sem voltar a martelar");
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

  it("vários dias parado reduz para retomada mínima sem chantagem emocional", async () => {
    const userId = "esc-days";
    seed(userId, { ...BASE, streak: 0, lastWorkoutCompletedAt: new Date(Date.now() - 6 * DAY).toISOString() });
    const r = await chat(userId, "tô enrolando");
    assert.match(r.fala || "", /voltou|retomar|10 minutos/i, "muitos dias parado deve virar retomada mínima");
    assert.doesNotMatch(r.fala || "", /sumiu|perco força|perco forca|perde XP|streak|pacto/i, "muitos dias parado não pode acionar chantagem emocional");
  });
});

describe("off_topic não engole pergunta real (anti-chatbot)", () => {
  it("frase real classificada off_topic NÃO recebe brush-off enlatado", async () => {
    const userId = "ot-real";
    seed(userId, { ...BASE });
    // 'piada' faz o fallback classificar off_topic; >=3 palavras → o guard deixa
    // passar pro modelo em vez do enlatado "distração depois" (era o bug: "qual o
    // treino?", "e a dieta?", "calorias?" viravam distração).
    const r = await chat(userId, "me conta uma piada boa agora");
    assert.doesNotMatch(r.fala || "", /distra[cç][aã]o depois|treino primeiro, distra/i, "frase real não pode virar brush-off enlatado");
  });

  it("input curtíssimo de distração ainda é redirecionado", async () => {
    const userId = "ot-short";
    seed(userId, { ...BASE });
    const r = await chat(userId, "piada");
    assert.match(r.fala || "", /distra[cç][aã]o|action now|distrazione/i, "1-2 palavras de distração ainda recebem redirecionamento");
  });
});

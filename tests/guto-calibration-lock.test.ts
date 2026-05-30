import "./test-env.js";
// Sem chave → classificador determinístico (fallback). O gate de calibragem
// (buildTrainingExecutionGate) roda ANTES do modelo, então a decisão de
// "reabrir intake" vs "pronto pra executar" é determinística e testável sem Gemini.
process.env.GEMINI_API_KEY = "";
process.env.GUTO_GEMINI_MODEL = process.env.GUTO_GEMINI_MODEL || "gemini-3.1-flash-lite";
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

const dir = join(process.cwd(), "tmp");
const file = join(dir, "guto-memory.calibration-lock-test.json");

let app: { listen: (port: number, host: string, cb?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearCache: () => void = () => {};

function seed(userId: string, data: Record<string, any>) {
  const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  store[userId] = { ...store[userId], ...data };
  writeFileSync(file, JSON.stringify(store, null, 2));
  clearCache();
}

// Conta saudável calibrada — exatamente o que o front (handleCalibrationComplete)
// persiste: patologia forçada (>=2 chars) gravada em trainingPathology E
// trainingLimitations, com o atalho "Sem dor".
const HEALTHY = {
  name: "Will", language: "pt-BR", biologicalSex: "male", userAge: 30,
  heightCm: 178, weightKg: 80,
  trainingLevel: "consistent", trainingStatus: "consistent",
  trainingGoal: "hypertrophy",
  preferredTrainingLocation: "home", trainingLocation: "home",
  trainingPathology: "sem dor", trainingLimitations: "sem dor",
  foodRestrictions: "nenhuma",
  country: "Brasil", countryCode: "BR", city: "São Paulo",
  initialXpGranted: true, totalXp: 100,
};

const BODY_QUESTION = /tem dor ou limita|último check|ultimo check|any pain or limitation|dolore o limite/i;
const REINTAKE = /onde (você|voce) (vai )?treina|me diz onde|teu ritmo|qual.*ritmo atual|me manda tua idade|give me your age/i;

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

describe("Calibragem trava p/ usuário saudável (CM-1: 'sem dor' não é incompleto)", () => {
  it("usuário saudável calibrado NÃO reabre intake ao pedir treino", async () => {
    seed("cal-healthy", { ...HEALTHY });
    const r = await chat("cal-healthy", "monta meu treino de hoje pra mim");
    // O gate de calibragem é soberano: não pode perguntar dor/idade/local/ritmo de novo.
    assert.doesNotMatch(r.fala || "", BODY_QUESTION, "saudável não pode ser reperguntado sobre dor/limitação");
    assert.doesNotMatch(r.fala || "", REINTAKE, "saudável não pode ter o intake (local/idade/ritmo) reaberto");
  });

  it("conta SEM body context (coach/legado) pergunta dor/limitação 1x (Regra 1)", async () => {
    const noBody = { ...HEALTHY };
    delete (noBody as any).trainingPathology;
    delete (noBody as any).trainingLimitations;
    seed("cal-nobody", noBody);
    const r = await chat("cal-nobody", "monta meu treino de hoje pra mim");
    // Quando GUTO genuinamente não sabe do corpo, ele pergunta uma vez — não chuta.
    assert.match(r.fala || "", BODY_QUESTION, "sem body context deve perguntar dor/limitação antes de gerar");
  });
});

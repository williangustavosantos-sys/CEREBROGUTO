import "./test-env.js";
// Sem chave → classificador determinístico (fallback). O fallback agora detecta
// conclusão de treino (workout_completed) e o gate responde sem reabrir intake.
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
const file = join(dir, "guto-memory.workout-completion-test.json");

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

const BASE = {
  name: "Will", language: "pt-BR", biologicalSex: "male", userAge: 31,
  heightCm: 178, weightKg: 80, trainingLevel: "consistent", trainingStatus: "consistent",
  trainingGoal: "hypertrophy", preferredTrainingLocation: "home", trainingLocation: "home",
  trainingPathology: "sem dor", trainingLimitations: "sem dor", foodRestrictions: "nenhuma",
  initialXpGranted: true, totalXp: 100, streak: 4, lastSuggestedFocus: "chest_triceps",
};

const REASK = /manda idade|sua idade|quantos anos|tem dor|se está sem dor|se esta sem dor|dor ou limita|send age/i;
const ACK = /feito|conta|como foi|sentiu|amanh|sequ[êe]ncia|próxima|proxima|valida/i;

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
  clearCache = ((await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as any).clearMemoryStoreCache;
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

describe("Conclusão de treino (B-3: 'fiz o treino' não re-pergunta idade/dor)", () => {
  for (const [tag, input] of [
    ["fiz o treino agora", "fiz o treino agora, terminei tudo"],
    ["Ja fiz o treino (eval conclusao_treino_01)", "Ja fiz o treino."],
    ["terminei o treino", "terminei o treino"],
  ] as const) {
    it(`${tag} → reconhece e fecha continuidade, sem reabrir intake`, async () => {
      const userId = `done-${tag.slice(0, 6)}`;
      seed(userId, { ...BASE });
      const r = await chat(userId, input);
      assert.doesNotMatch(r.fala || "", REASK, "conclusão não pode re-perguntar idade/dor (Regra 2)");
      assert.match(r.fala || "", ACK, "deve reconhecer execução / fechar continuidade");
      assert.notEqual(r.acao, "updateWorkout", "conclusão não dispara novo treino");
    });
  }
});

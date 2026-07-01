/**
 * Regressão — bugs de experiência encontrados na auditoria de UX
 *
 * BUG 1: applyLevelStructure ausente dos paths de fallback →
 *        difficulty "(não definido)", volume errado para avançado/iniciante
 *
 * BUG 2: nota de sistema "GUTO ajustou este exercício..." vazando para o usuário
 *        em exercícios substituídos por dedupeAndRepairWorkoutPlan
 *
 * BUG 3: isClearNoLimitation fazia match exato → "sem dor sem limitacoes"
 *        (concatenação dos dois campos) não era reconhecido como "sem limitação"
 *        → summary "Protegendo esse ponto" para usuário saudável
 *
 * BUG 4: template hasNoLimitation não reconhecia "sem limitações" / "sem limitacoes"
 *        → template careLine errado para usuários sem limitações físicas
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// ─── BUG 3 — isClearNoLimitation substring match ────────────────────────────

// Acessa as funções internas via importação dinâmica do server
// Alternativa: testar via HTTP (mais realista, menos frágil)

// Testamos via lógica pública: buildPlanLimitationCareSummary não deve
// devolver texto quando o usuário não tem limitação real.

// ─── Helpers compartilhados ─────────────────────────────────────────────────
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import jwt from "jsonwebtoken";
import type { Server } from "node:http";

if (!process.env.GUTO_DISABLE_LISTEN) process.env.GUTO_DISABLE_LISTEN = "1";
if (!process.env.GUTO_ALLOW_DEV_ACCESS) process.env.GUTO_ALLOW_DEV_ACCESS = "true";
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = "test-secret-experience-bugs";
if (!process.env.GUTO_DISABLE_REDIS_FOR_TESTS) process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
process.env.GEMINI_API_KEY = "";

const tmpDir = join(process.cwd(), "tmp");
const memFile = join(tmpDir, "guto-memory.experience-bugs.json");
mkdirSync(tmpDir, { recursive: true });
writeFileSync(memFile, JSON.stringify({}, null, 2));
process.env.GUTO_MEMORY_FILE = memFile;

let _app: any;
let _clear: () => void;
let _server: Server;
let baseUrl: string;
const secret = process.env.JWT_SECRET!;

function seedMemory(userId: string, data: Record<string, unknown>) {
  const store = existsSync(memFile) ? JSON.parse(readFileSync(memFile, "utf8")) : {};
  store[userId] = { userId, ...data };
  writeFileSync(memFile, JSON.stringify(store, null, 2));
  _clear?.();
}

function readMemory(userId: string): Record<string, unknown> {
  const store = existsSync(memFile) ? JSON.parse(readFileSync(memFile, "utf8")) : {};
  return store[userId] || {};
}

async function chatReq(userId: string, input: string, language = "pt-BR"): Promise<any> {
  const token = jwt.sign({ userId, role: "student" }, secret);
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language, profile: { userId }, history: [], input }),
  });
  return r.json();
}

const BASE_CALIBRATED = {
  language: "pt-BR",
  biologicalSex: "male",
  userAge: 28,
  heightCm: 175,
  weightKg: 75,
  trainingLevel: "consistent",
  trainingGoal: "muscle_gain",
  preferredTrainingLocation: "gym",
  trainingLocation: "gym",
  country: "Brasil",
  countryCode: "BR",
  foodRestrictions: "nenhuma",
  initialXpGranted: true,
  totalXp: 100,
  streak: 2,
};

test("setup server", async () => {
  const backendDir = process.cwd();
  const mod = await import(pathToFileURL(join(backendDir, "server.ts")).href) as any;
  _app = mod.app;
  const memMod = await import(pathToFileURL(join(backendDir, "src/memory-store.ts")).href) as any;
  _clear = memMod.clearMemoryStoreCache;

  _server = await new Promise((resolve, reject) => {
    const s = _app.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(_server.address() as any).port}`;
});

// ─── BUG 1: applyLevelStructure ausente dos fallback paths ──────────────────

test("BUG 1 — fallback path: difficulty definido para returning", async () => {
  const uid = "xp-bug1-returning";
  seedMemory(uid, {
    ...BASE_CALIBRATED,
    trainingLevel: "returning",
    trainingStatus: "voltando depois de 2 meses parado",
    trainingPathology: "sem dor",
    trainingLimitations: "sem limitações",
  });

  const res = await chatReq(uid, "quero treinar", "pt-BR");
  const plan = res.workoutPlan;

  assert.ok(plan, "Deve gerar um plano de treino");
  assert.ok(
    plan.difficulty && plan.difficulty !== "",
    `difficulty deve estar definido, recebi: "${plan.difficulty}"`
  );
  assert.equal(plan.difficulty, "returning", `difficulty deve ser "returning", recebi: "${plan.difficulty}"`);
});

test("BUG 1 — fallback path: difficulty definido para advanced", async () => {
  const uid = "xp-bug1-advanced";
  seedMemory(uid, {
    ...BASE_CALIBRATED,
    trainingLevel: "advanced",
    trainingStatus: "treinando há 5 anos",
    trainingPathology: "sem dor",
    trainingLimitations: "sem limitações",
  });

  const res = await chatReq(uid, "bora treinar", "pt-BR");
  const plan = res.workoutPlan;

  assert.ok(plan, "Deve gerar um plano de treino");
  assert.ok(
    plan.difficulty && plan.difficulty !== "",
    `difficulty deve estar definido, recebi: "${plan.difficulty}"`
  );
  assert.equal(plan.difficulty, "advanced", `difficulty deve ser "advanced", recebi: "${plan.difficulty}"`);
});

test("BUG 1 — fallback path: avançado recebe volume extra (≥4 séries no composto)", async () => {
  const uid = "xp-bug1-advanced-volume";
  seedMemory(uid, {
    ...BASE_CALIBRATED,
    trainingLevel: "advanced",
    trainingStatus: "treinando há 5 anos",
    trainingPathology: "sem dor",
    trainingLimitations: "sem limitações",
  });

  const res = await chatReq(uid, "treino agora", "pt-BR");
  const plan = res.workoutPlan;

  assert.ok(plan, "Deve gerar plano");
  const main = (plan.exercises || []).filter((e: any) => e.muscleGroup !== "aquecimento");
  const hasHighVolume = main.some((e: any) => Number(e.sets) >= 4);
  assert.ok(hasHighVolume, `Avançado deve ter pelo menos um exercício com ≥4 séries. Sets: ${main.map((e: any) => e.sets).join(",")}`);
});

// ─── BUG 2: nota de sistema não deve vazar para o usuário ───────────────────

test("BUG 2 — nota 'GUTO ajustou este exercício' nunca aparece nos exercícios", async () => {
  const uid = "xp-bug2-note";
  seedMemory(uid, {
    ...BASE_CALIBRATED,
    trainingLevel: "beginner",
    trainingPathology: "sem dor",
    trainingLimitations: "sem limitações",
  });

  const res = await chatReq(uid, "treino de hoje", "pt-BR");
  const plan = res.workoutPlan;

  assert.ok(plan, "Deve gerar plano");
  const allNotes = (plan.exercises || [])
    .map((e: any) => [e.note, e.cue].filter(Boolean).join(" "))
    .join("\n");

  assert.ok(
    !allNotes.includes("GUTO ajustou este exercício"),
    `Nota de sistema não deve aparecer ao usuário. Encontrado em: "${allNotes.slice(0, 200)}"`
  );
  assert.ok(
    !allNotes.includes("vídeo local"),
    `Mensagem técnica "vídeo local" não deve aparecer. Encontrado em: "${allNotes.slice(0, 200)}"`
  );
  assert.ok(
    !allNotes.includes("sem duplicidade"),
    `Mensagem técnica "sem duplicidade" não deve aparecer. Encontrado em: "${allNotes.slice(0, 200)}"`
  );
});

// ─── BUG 3 + 4: "sem dor" + "sem limitações" → sem care summary ─────────────

test("BUG 3+4 — usuário sem limitação: summary NÃO contém 'Protegendo esse ponto'", async () => {
  const uid = "xp-bug3-no-limitation";
  seedMemory(uid, {
    ...BASE_CALIBRATED,
    trainingPathology: "sem dor",
    trainingLimitations: "sem limitações",
  });

  const res = await chatReq(uid, "bora treinar hoje", "pt-BR");
  const plan = res.workoutPlan;

  assert.ok(plan, "Deve gerar plano");
  const summary = (plan.summary || "").toLowerCase();
  assert.ok(
    !summary.includes("protegendo esse ponto"),
    `Summary não deve conter "Protegendo esse ponto" para usuário sem limitação. Summary: "${plan.summary}"`
  );
  assert.ok(
    !summary.includes("reduzindo a carga"),
    `Summary não deve conter "reduzindo a carga" para usuário muscle_gain sem limitação. Summary: "${plan.summary}"`
  );
});

test("BUG 3+4 — usuário com limitação real mantém care summary", async () => {
  const uid = "xp-bug3-with-limitation";
  seedMemory(uid, {
    ...BASE_CALIBRATED,
    trainingPathology: "dor no joelho direito",
    trainingLimitations: "joelho direito",
  });

  const res = await chatReq(uid, "bora treinar hoje", "pt-BR");
  const plan = res.workoutPlan;

  assert.ok(plan, "Deve gerar plano");
  const summary = (plan.summary || "").toLowerCase();
  // Com limitação real, pode ter cuidado no sumário — não deve estar VAZIO de contexto
  // A principal verificação: não colocar "esse ponto" quando a limitação é específica (joelho)
  assert.ok(
    !summary.includes("esse ponto"),
    `Summary deve ser específico (não "esse ponto") quando há limitação conhecida. Summary: "${plan.summary}"`
  );
});

test("BUG 3+4 — 'sem limitacoes' (sem acento) reconhecido como sem limitação", async () => {
  const uid = "xp-bug3-sem-acento";
  seedMemory(uid, {
    ...BASE_CALIBRATED,
    trainingPathology: "sem dor",
    trainingLimitations: "sem limitacoes",  // sem acento
  });

  const res = await chatReq(uid, "quero treinar", "pt-BR");
  const plan = res.workoutPlan;

  assert.ok(plan, "Deve gerar plano");
  const summary = (plan.summary || "").toLowerCase();
  assert.ok(
    !summary.includes("protegendo"),
    `"sem limitacoes" deve ser reconhecido como sem limitação. Summary: "${plan.summary}"`
  );
});

test("teardown", async () => {
  _server?.close();
});

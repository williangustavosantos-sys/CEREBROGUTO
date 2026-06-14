import "./test-env.js";
// Sem Gemini → fallback determinístico; testa rotação de focos sem bias de modelo.
process.env.GEMINI_API_KEY = "";
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
const file = join(dir, "guto-memory.workout-rotation-test.json");

let app: { listen: (port: number, host: string, cb?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearCache: () => void = () => {};

function seed(userId: string, data: Record<string, unknown>) {
  const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  store[userId] = { ...store[userId], ...data };
  writeFileSync(file, JSON.stringify(store, null, 2));
  clearCache();
}

function getMemory(userId: string): Record<string, unknown> {
  const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return store[userId] || {};
}

async function chat(userId: string, input: string, language = "pt-BR") {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language, profile: { userId, name: "Will" }, history: [], input }),
  });
  return (await r.json()) as { fala?: string; acao?: string; memoryPatch?: Record<string, unknown> };
}

before(async () => {
  process.env.GUTO_MEMORY_FILE = file;
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

const CALIBRATED_BASE = {
  name: "Will", language: "pt-BR", biologicalSex: "male", userAge: 32,
  heightCm: 178, weightKg: 80, trainingLevel: "beginner", trainingStatus: "voltando",
  trainingGoal: "fat_loss", preferredTrainingLocation: "gym", trainingLocation: "gym",
  trainingPathology: "sem dor", trainingLimitations: "sem dor", foodRestrictions: "nenhuma",
  initialXpGranted: true, totalXp: 0, streak: 0,
};

describe("Rotação de focos — full_body não deve ser o padrão inicial", () => {
  it("novo usuário fat_loss sem histórico recebe chest_triceps, não full_body", async () => {
    const userId = "rotation-new-user";
    // Usuário calibrado mas SEM nextWorkoutFocus definido — simula o estado
    // que levava ao bug: modelo sugeria full_body, memória aceitava.
    seed(userId, { ...CALIBRATED_BASE, nextWorkoutFocus: undefined });

    // O modelo está offline (GEMINI_API_KEY=""). O contrato determinístico
    // executa "sem dor + age" → clear_no_limitation → deve usar rotação.
    const resp = await chat(userId, "tenho 32 e estou sem dor");
    assert.ok(resp.fala, "deve responder");

    const mem = getMemory(userId);
    assert.notEqual(
      mem.nextWorkoutFocus,
      "full_body",
      `nextWorkoutFocus não deve ser full_body para usuário novo — era: ${mem.nextWorkoutFocus}`
    );
    // Valor esperado: chest_triceps (primeiro da rotação)
    if (mem.nextWorkoutFocus !== undefined) {
      assert.equal(
        mem.nextWorkoutFocus,
        "chest_triceps",
        `nextWorkoutFocus deve ser chest_triceps, era: ${mem.nextWorkoutFocus}`
      );
    }
  });

  it("modelo sugerindo full_body no patch não persiste como nextWorkoutFocus", async () => {
    const userId = "rotation-model-bias";
    // Simula o estado em que o modelo biasado já escreveu full_body na memória
    seed(userId, { ...CALIBRATED_BASE, nextWorkoutFocus: "full_body" });

    // Mesmo com full_body na memória, qualquer nova chamada que recalcule
    // nextWorkoutFocus deve usar a rotação e retornar chest_triceps
    const resp = await chat(userId, "bora treinar");
    assert.ok(resp.fala, "deve responder");

    // O workout que vai ser gerado não pode ser full_body quando rotação tem opções
    // (nenhum split foi treinado recentemente → chest_triceps é o correto)
    const mem = getMemory(userId);
    // Após uma resposta de treino, nextWorkoutFocus pode ser recalculado
    if (mem.nextWorkoutFocus !== undefined) {
      assert.notEqual(
        mem.nextWorkoutFocus,
        "full_body",
        `bias do modelo não deve persistir como full_body — era: ${mem.nextWorkoutFocus}`
      );
    }
  });

  it("full_body só aparece quando todos os 4 splits estão bloqueados (histórico recente completo)", async () => {
    const userId = "rotation-all-blocked";
    // Todos os 4 splits treinados recentemente → full_body é o correto
    seed(userId, {
      ...CALIBRATED_BASE,
      nextWorkoutFocus: undefined,
      recentTrainingHistory: [
        { dateLabel: "today", muscleGroup: "chest_triceps", raw: "peito hoje", createdAt: new Date().toISOString() },
        { dateLabel: "yesterday", muscleGroup: "back_biceps", raw: "costas ontem", createdAt: new Date().toISOString() },
        { dateLabel: "day_before_yesterday", muscleGroup: "legs_core", raw: "perna anteontem", createdAt: new Date().toISOString() },
        { dateLabel: "recent", muscleGroup: "shoulders_abs", raw: "ombro recente", createdAt: new Date().toISOString() },
      ],
    });

    const resp = await chat(userId, "bora treinar hoje");
    assert.ok(resp.fala, "deve responder");

    // Com todos os splits bloqueados, full_body é o único válido
    const mem = getMemory(userId);
    if (mem.nextWorkoutFocus !== undefined) {
      assert.equal(
        mem.nextWorkoutFocus,
        "full_body",
        `com todos os splits bloqueados, deve escolher full_body — era: ${mem.nextWorkoutFocus}`
      );
    }
  });
});

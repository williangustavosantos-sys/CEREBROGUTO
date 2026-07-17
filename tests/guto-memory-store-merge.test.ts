import "./test-env.js";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  clearMemoryStoreCache,
  flushMemoryStoreWrites,
  mergeFetchedMemoryStoreWithCache,
  persistUserMemory,
  readMemoryStoreSync,
  setMemoryStoreRedisClientForTests,
  writeMemoryStoreSync,
} from "../src/memory-store.js";
import { config } from "../src/config.js";

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.store-merge-test.json");

describe("memory-store — merge anti-clobber por usuário", () => {
  beforeEach(() => {
    process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    config.memoryFile = testMemoryFile;
    mkdirSync(tmpDir, { recursive: true });
    rmSync(testMemoryFile, { force: true });
    clearMemoryStoreCache();
  });

  afterEach(() => {
    setMemoryStoreRedisClientForTests(undefined);
  });

  it("write parcial stale não apaga pacto, XP, evento nem consentimento", async () => {
    const userId = "memory-stale-initial-xp";
    const grantEvent = {
      id: "2026-07-08:grant_initial_xp",
      type: "grant_initial_xp",
      amount: 100,
      date: "2026-07-08",
      createdAt: "2026-07-08T00:00:00.000Z",
    };

    writeMemoryStoreSync({
      [userId]: {
        userId,
        name: "PIETRO",
        language: "pt-BR",
        consentHealthFitness: true,
        acceptedTerms: true,
        consentAcceptedAt: "2026-07-08T00:00:00.000Z",
      initialXpGranted: true,
      initialXpRewardSeen: false,
      totalXp: 100,
      xpEvents: [grantEvent],
      lastWorkoutPlan: { title: "Treino oficial", exercises: [{ id: "ex-1" }] },
      weeklyDietPlan: { meals: [{ name: "Almoço", foods: [{ name: "Tofu" }] }] },
      dietGenerationStatus: "generated",
    },
  });

    await persistUserMemory(userId, {
      userId,
      name: "PIETRO",
      language: "pt-BR",
      consentHealthFitness: false,
      acceptedTerms: false,
      initialXpGranted: false,
      initialXpRewardSeen: true,
      totalXp: 0,
      xpEvents: [],
      lastWorkoutPlan: null,
      weeklyDietPlan: null,
      dietGenerationStatus: "idle",
    });
    await flushMemoryStoreWrites();

    const saved = readMemoryStoreSync()[userId] as Record<string, unknown>;
    assert.equal(saved.consentHealthFitness, true);
    assert.equal(saved.acceptedTerms, true);
    assert.equal(saved.initialXpGranted, true);
    assert.equal(saved.initialXpRewardSeen, true);
    assert.equal(saved.totalXp, 100);
    assert.deepEqual(saved.xpEvents, [grantEvent]);
    assert.equal((saved.lastWorkoutPlan as { title?: string }).title, "Treino oficial");
    assert.equal((saved.weeklyDietPlan as { meals?: unknown[] }).meals?.length, 1);
    assert.equal(saved.dietGenerationStatus, "generated");
  });

  it("write parcial de boot não apaga calibragem completa do usuário", async () => {
    const userId = "memory-stale-calibration";

    writeMemoryStoreSync({
      [userId]: {
        userId,
        name: "PIETRO",
        language: "pt-BR",
        consentHealthFitness: true,
        acceptedTerms: true,
        userAge: 24,
        biologicalSex: "male",
        trainingLevel: "beginner",
        trainingStatus: "beginner",
        trainingGoal: "muscle_gain",
        preferredTrainingLocation: "gym",
        trainingPathology: "lombar",
        trainingLimitations: "lombar",
        country: "Brasil",
        countryCode: "BR",
        city: "Agronômica",
        heightCm: 163,
        weightKg: 64.8,
        foodRestrictions: "vegetariano, sem lactose",
        resolvedFields: { trainingLimitations: { bodyRegion: "lower_back" } },
      },
    });

    await persistUserMemory(userId, {
      userId,
      name: "PIETRO",
      language: "pt-BR",
      resolvedFields: {},
    });
    await flushMemoryStoreWrites();

    const saved = readMemoryStoreSync()[userId] as Record<string, unknown>;
    assert.equal(saved.userAge, 24);
    assert.equal(saved.biologicalSex, "male");
    assert.equal(saved.trainingLevel, "beginner");
    assert.equal(saved.trainingStatus, "beginner");
    assert.equal(saved.trainingGoal, "muscle_gain");
    assert.equal(saved.preferredTrainingLocation, "gym");
    assert.equal(saved.trainingPathology, "lombar");
    assert.equal(saved.trainingLimitations, "lombar");
    assert.equal(saved.country, "Brasil");
    assert.equal(saved.countryCode, "BR");
    assert.equal(saved.city, "Agronômica");
    assert.equal(saved.heightCm, 163);
    assert.equal(saved.weightKg, 64.8);
    assert.equal(saved.foodRestrictions, "vegetariano, sem lactose");
    assert.deepEqual(saved.resolvedFields, { trainingLimitations: { bodyRegion: "lower_back" } });
  });

  it("read stale do Redis não troca cache recém-calibrado por snapshot antigo", () => {
    const userId = "memory-stale-read-after-calibration";
    const cached = {
      [userId]: {
        userId,
        name: "PIETRO",
        language: "pt-BR",
        consentHealthFitness: true,
        acceptedTerms: true,
        consentAcceptedAt: "2026-07-10T14:00:00.000Z",
        userAge: 24,
        biologicalSex: "male",
        trainingLevel: "beginner",
        trainingStatus: "beginner",
        trainingGoal: "muscle_gain",
        preferredTrainingLocation: "gym",
        trainingPathology: "lombar",
        trainingLimitations: "lombar",
        country: "Brasil",
        countryCode: "BR",
        city: "Agronômica",
        heightCm: 163,
        weightKg: 64.8,
        foodRestrictions: "vegetariano, sem lactose",
        initialXpGranted: true,
        totalXp: 100,
        xpEvents: [{
          id: "2026-07-10:grant_initial_xp",
          type: "grant_initial_xp",
          amount: 100,
          date: "2026-07-10",
        }],
      },
    };
    const staleFetched = {
      [userId]: {
        userId,
        name: "PIETRO",
        language: "pt-BR",
        consentHealthFitness: true,
        acceptedTerms: true,
        initialXpGranted: false,
        totalXp: 0,
      },
    };

    const merged = mergeFetchedMemoryStoreWithCache(staleFetched, cached);
    const saved = merged[userId] as Record<string, unknown>;
    assert.equal(saved.userAge, 24);
    assert.equal(saved.biologicalSex, "male");
    assert.equal(saved.trainingGoal, "muscle_gain");
    assert.equal(saved.preferredTrainingLocation, "gym");
    assert.equal(saved.countryCode, "BR");
    assert.equal(saved.heightCm, 163);
    assert.equal(saved.weightKg, 64.8);
    assert.equal(saved.foodRestrictions, "vegetariano, sem lactose");
    assert.equal(saved.initialXpGranted, true);
    assert.equal(saved.totalXp, 100);
  });

  it("write parcial não preserva biologicalSex legado inválido", async () => {
    const userId = "memory-invalid-biological-sex";

    writeMemoryStoreSync({
      [userId]: {
        userId,
        name: "PIETRO",
        language: "pt-BR",
        biologicalSex: "prefer_not_to_say",
      },
    });

    await persistUserMemory(userId, {
      userId,
      name: "PIETRO",
      language: "pt-BR",
      weightKg: 82,
    });
    await flushMemoryStoreWrites();

    const saved = readMemoryStoreSync()[userId] as Record<string, unknown>;
    assert.equal(saved.weightKg, 82);
    assert.equal(Object.prototype.hasOwnProperty.call(saved, "biologicalSex"), false);
  });

  it("write com país alterado não preserva countryCode antigo", async () => {
    const userId = "memory-country-clears-code";

    writeMemoryStoreSync({
      [userId]: {
        userId,
        name: "PIETRO",
        language: "pt-BR",
        country: "Brasil",
        countryCode: "BR",
      },
    });

    await persistUserMemory(userId, {
      userId,
      name: "PIETRO",
      language: "pt-BR",
      country: "Italia",
    });
    await flushMemoryStoreWrites();

    const saved = readMemoryStoreSync()[userId] as Record<string, unknown>;
    assert.equal(saved.country, "Italia");
    assert.equal(Object.prototype.hasOwnProperty.call(saved, "countryCode"), false);
  });

  it("write parcial não reintroduz telefone legado", async () => {
    const userId = "memory-phone-clears-legacy";

    writeMemoryStoreSync({
      [userId]: {
        userId,
        name: "PIETRO",
        language: "pt-BR",
        phone: "+390212345678",
      },
    });

    await persistUserMemory(userId, {
      userId,
      name: "PIETRO",
      language: "pt-BR",
      weightKg: 82,
    });
    await flushMemoryStoreWrites();

    const saved = readMemoryStoreSync()[userId] as Record<string, unknown>;
    assert.equal(saved.weightKg, 82);
    assert.equal(Object.prototype.hasOwnProperty.call(saved, "phone"), false);
  });

  it("permite invalidar treino quando limitação nova limpa lastWorkoutPlan", async () => {
    const userId = "memory-new-pain-clears-workout";

    writeMemoryStoreSync({
      [userId]: {
        userId,
        name: "PIETRO",
        language: "pt-BR",
        trainingLimitations: "sem dor",
        trainingPathology: "sem dor",
        lastWorkoutPlan: {
          focusKey: "legs_core",
          source: "guto_generated",
          lockedByCoach: false,
          exercises: [{ id: "agachamento_livre" }],
        },
      },
    });

    await persistUserMemory(userId, {
      userId,
      name: "PIETRO",
      language: "pt-BR",
      trainingLimitations: "estou com dor no joelho direito",
      trainingPathology: "estou com dor no joelho direito",
      lastWorkoutPlan: null,
    });
    await flushMemoryStoreWrites();

    const saved = readMemoryStoreSync()[userId] as Record<string, unknown>;
    assert.equal(saved.trainingLimitations, "estou com dor no joelho direito");
    assert.equal(saved.lastWorkoutPlan, null);
  });

  it("permite invalidar treino IA quando o peso muda, sem apagar treino travado pelo coach", async () => {
    const aiUserId = "memory-weight-clears-ai-workout";
    const coachUserId = "memory-weight-keeps-coach-workout";

    writeMemoryStoreSync({
      [aiUserId]: {
        userId: aiUserId,
        name: "PIETRO",
        language: "pt-BR",
        weightKg: 80,
        lastWorkoutPlan: {
          title: "Treino IA antigo",
          source: "guto_generated",
          lockedByCoach: false,
          exercises: [{ id: "agachamento_livre" }],
        },
      },
      [coachUserId]: {
        userId: coachUserId,
        name: "MARIA",
        language: "pt-BR",
        weightKg: 60,
        lastWorkoutPlan: {
          title: "Treino oficial do coach",
          source: "coach_override",
          lockedByCoach: true,
          exercises: [{ id: "remada_baixa" }],
        },
      },
    });

    await persistUserMemory(aiUserId, {
      userId: aiUserId,
      name: "PIETRO",
      language: "pt-BR",
      weightKg: 82,
      lastWorkoutPlan: null,
    });
    await persistUserMemory(coachUserId, {
      userId: coachUserId,
      name: "MARIA",
      language: "pt-BR",
      weightKg: 62,
      lastWorkoutPlan: null,
    });
    await flushMemoryStoreWrites();

    const store = readMemoryStoreSync() as Record<string, Record<string, unknown>>;
    assert.equal(store[aiUserId].weightKg, 82);
    assert.equal(store[aiUserId].lastWorkoutPlan, null);
    assert.equal(store[coachUserId].weightKg, 62);
    assert.equal(
      (store[coachUserId].lastWorkoutPlan as { title?: string }).title,
      "Treino oficial do coach"
    );
  });

  it("falha de Redis GET impede SET do store parcial", async () => {
    let memoryStoreSets = 0;
    setMemoryStoreRedisClientForTests({
      get: async () => {
        throw new Error("redis get unavailable");
      },
      set: async (key: string) => {
        if (key === "guto:memory") memoryStoreSets += 1;
        return "OK";
      },
      eval: async () => 1,
    });

    await assert.rejects(
      persistUserMemory("redis-read-failure-user", {
        userId: "redis-read-failure-user",
        name: "PIETRO",
        weightKg: 82,
      }),
      /redis get unavailable/i
    );
    assert.equal(memoryStoreSets, 0, "não pode gravar guto:memory sem hidratação Redis bem-sucedida");
  });

  it("lease expirado não publica snapshot stale e reaplica a escrita no store concorrente", async () => {
    const userId = "redis-expired-lease-user";
    let remoteStore: Record<string, unknown> = {
      [userId]: {
        userId,
        name: "PIETRO",
        consentHealthFitness: true,
        acceptedTerms: true,
        userAge: 24,
      },
    };
    let commitAttempts = 0;

    setMemoryStoreRedisClientForTests({
      get: async (key) => key === "guto:memory" ? structuredClone(remoteStore) : null,
      set: async (key, _value, options) => {
        if (key === "guto:memory:write-lock:v1" && options?.nx) return "OK";
        return null;
      },
      eval: async (_script, keys, args) => {
        if (keys.length === 2 && keys[1] === "guto:memory") {
          commitAttempts += 1;
          if (commitAttempts === 1) {
            remoteStore = {
              ...remoteStore,
              [userId]: {
                ...(remoteStore[userId] as Record<string, unknown>),
                concurrentField: "preserve-me",
              },
            };
            return 0;
          }
          remoteStore = JSON.parse(args[1]) as Record<string, unknown>;
          return 1;
        }
        return 1;
      },
    });

    await persistUserMemory(userId, {
      userId,
      name: "PIETRO",
      initialXpRewardSeen: true,
    });

    const saved = remoteStore[userId] as Record<string, unknown>;
    assert.equal(commitAttempts, 2);
    assert.equal(saved.concurrentField, "preserve-me");
    assert.equal(saved.userAge, 24);
    assert.equal(saved.consentHealthFitness, true);
    assert.equal(saved.initialXpRewardSeen, true);
  });
});

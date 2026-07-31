import "./test-env.js";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { config } from "../src/config.js";
import {
  clearMemoryStoreCache,
  setMemoryStoreRedisClientForTests,
  writeMemoryStoreSync,
} from "../src/memory-store.js";
import {
  appendTrainingHistoryCorrection,
  readTrainingMotorState,
  saveExecutionLog,
  saveOfficialSession,
  saveSessionFeedback,
  TrainingMotorStoreError,
  type SaveExecutionLogCommand,
  type SaveOfficialSessionCommand,
} from "../src/training-motor-store.js";

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.training-motor-v2-block1.json");
const userId = "training-motor-v2-user";
const sessionId = "session-2026-07-31";

function officialCommand(
  overrides: Partial<SaveOfficialSessionCommand> = {}
): SaveOfficialSessionCommand {
  return {
    userId,
    expectedVersion: 0,
    operationId: "op-official-session-v1",
    session: {
      sessionId,
      date: "2026-07-31",
      plannedWorkout: {
        planId: "week-2026-07-27:thursday",
        title: "Peito e tríceps",
        purpose: "Força geral com execução controlada",
        expectedDurationMinutes: 42,
      },
      environment: {
        mode: "gym",
        description: "Academia habitual",
        equipment: ["bench", "dumbbells", "cable"],
      },
      exercises: [
        {
          id: "supino_reto",
          name: "Supino reto",
          sets: 3,
          repetitions: "8-10",
          resistanceGuidance: "autoregulated",
          restSeconds: 90,
        },
        {
          id: "triceps_corda",
          name: "Tríceps na corda",
          sets: 3,
          repetitions: "10-12",
          resistanceGuidance: "autoregulated",
          restSeconds: 60,
        },
      ],
      appliedRestrictions: ["sem dor no ombro"],
      origin: "prescribed",
    },
    ...overrides,
  };
}

function executionCommand(
  overrides: Partial<SaveExecutionLogCommand> = {}
): SaveExecutionLogCommand {
  return {
    userId,
    expectedVersion: 0,
    operationId: "op-execution-v1",
    executionLog: {
      executionLogId: "execution-2026-07-31",
      sessionId,
      officialSessionVersion: 1,
      startedAt: "2026-07-31T17:00:00.000Z",
      performedExercises: [],
      skippedExerciseIds: [],
      substitutions: [],
      durationSeconds: 0,
      finalState: null,
    },
    ...overrides,
  };
}

async function seedOfficialSession(): Promise<void> {
  await saveOfficialSession(officialCommand());
}

async function seedFinalizedExecution(): Promise<void> {
  await seedOfficialSession();
  await saveExecutionLog(executionCommand());
  await saveExecutionLog({
    ...executionCommand(),
    expectedVersion: 1,
    operationId: "op-execution-v2",
    executionLog: {
      ...executionCommand().executionLog,
      endedAt: "2026-07-31T17:36:00.000Z",
      performedExercises: [
        { exerciseId: "supino_halteres", completedSets: 3 },
      ],
      skippedExerciseIds: ["triceps_corda"],
      substitutions: [
        {
          originalExerciseId: "supino_reto",
          replacementExerciseId: "supino_halteres",
          reason: "equipamento ocupado",
          occurredAt: "2026-07-31T17:04:00.000Z",
        },
      ],
      durationSeconds: 2160,
      finalState: "partial",
    },
  });
}

function isStoreError(error: unknown, code: TrainingMotorStoreError["code"]): boolean {
  return error instanceof TrainingMotorStoreError && error.code === code;
}

describe("training motor V2 — BLOCO 1", () => {
  beforeEach(() => {
    process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    config.memoryFile = testMemoryFile;
    mkdirSync(tmpDir, { recursive: true });
    rmSync(testMemoryFile, { force: true });
    clearMemoryStoreCache();
    writeMemoryStoreSync({
      [userId]: {
        userId,
        name: "OPERADOR",
        language: "pt-BR",
      },
    });
  });

  afterEach(() => {
    setMemoryStoreRedisClientForTests(undefined);
    clearMemoryStoreCache();
    rmSync(testMemoryFile, { force: true });
  });

  it("persiste a OfficialSession prescrita como fonte oficial versionada", async () => {
    const command = officialCommand();
    (command.session.exercises[0] as unknown as Record<string, unknown>).loadKg = 80;
    (command.session.exercises[0] as unknown as Record<string, unknown>).previousLoadKg = 75;

    const saved = await saveOfficialSession(command);
    const state = await readTrainingMotorState(userId);

    assert.equal(saved.userId, userId);
    assert.equal(saved.version, 1);
    assert.equal(saved.origin, "prescribed");
    assert.equal(saved.plannedWorkout.expectedDurationMinutes, 42);
    assert.equal(saved.environment.mode, "gym");
    assert.equal(saved.exercises.length, 2);
    assert.equal(saved.exercises[0].resistanceGuidance, "autoregulated");
    assert.equal(state.officialSessions.length, 1);
    assert.equal(state.trainingHistory.version, 1);
    assert.equal(state.trainingHistory.events[0].eventType, "official_session_created");
    assert.equal(JSON.stringify(saved).includes("loadKg"), false);
    assert.equal(JSON.stringify(saved).includes("previousLoadKg"), false);
  });

  it("faz retry idempotente e rejeita versão obsoleta da OfficialSession", async () => {
    const first = await saveOfficialSession(officialCommand());
    const retry = await saveOfficialSession({
      ...officialCommand(),
      session: {
        ...officialCommand().session,
        plannedWorkout: {
          ...officialCommand().session.plannedWorkout,
          title: "Payload divergente de retry",
        },
      },
    });

    assert.deepEqual(retry, first);
    assert.equal((await readTrainingMotorState(userId)).trainingHistory.events.length, 1);

    await assert.rejects(
      saveOfficialSession({
        ...officialCommand(),
        expectedVersion: 0,
        operationId: "op-official-session-stale",
        session: {
          ...officialCommand().session,
          origin: "adapted",
        },
      }),
      (error) => isStoreError(error, "VERSION_CONFLICT")
    );
  });

  it("salva início e encerramento objetivo sem confundir planejado com realizado", async () => {
    await seedFinalizedExecution();
    const state = await readTrainingMotorState(userId);
    const saved = state.executionLogs[0];

    assert.equal(saved.version, 2);
    assert.equal(saved.finalState, "partial");
    assert.equal(saved.durationSeconds, 2160);
    assert.deepEqual(saved.performedExercises, [
      { exerciseId: "supino_halteres", completedSets: 3 },
    ]);
    assert.deepEqual(saved.skippedExerciseIds, ["triceps_corda"]);
    assert.equal(saved.substitutions[0].originalExerciseId, "supino_reto");
    assert.equal(saved.substitutions[0].replacementExerciseId, "supino_halteres");
    assert.equal(
      state.trainingHistory.events.filter((event) => event.eventType === "execution_log_saved").length,
      2
    );
    const initialExecution = state.trainingHistory.events.find(
      (event) => event.operationId === "op-execution-v1"
    );
    assert.equal((initialExecution?.snapshot as { finalState?: unknown }).finalState, null);
  });

  it("vincula ExecutionLog à versão oficial e rejeita sessão inexistente", async () => {
    await seedOfficialSession();

    await assert.rejects(
      saveExecutionLog({
        ...executionCommand(),
        operationId: "op-wrong-session-version",
        executionLog: {
          ...executionCommand().executionLog,
          officialSessionVersion: 2,
        },
      }),
      (error) => isStoreError(error, "VERSION_CONFLICT")
    );

    await assert.rejects(
      saveExecutionLog({
        ...executionCommand(),
        operationId: "op-missing-session",
        executionLog: {
          ...executionCommand().executionLog,
          executionLogId: "execution-missing-session",
          sessionId: "missing-session",
        },
      }),
      (error) => isStoreError(error, "OFFICIAL_SESSION_NOT_FOUND")
    );
  });

  it("aceita somente easy, normal, heavy ou observation, sem questionário oculto", async () => {
    await seedFinalizedExecution();

    const initial = await saveSessionFeedback({
      userId,
      expectedVersion: 0,
      operationId: "op-feedback-v1",
      feedback: {
        feedbackId: "feedback-2026-07-31",
        sessionId,
        value: "easy",
        submittedAt: "2026-07-31T17:37:00.000Z",
        source: "card",
        rpe: 8,
        energy: "low",
        pain: "shoulder",
      } as any,
    });
    const observation = await saveSessionFeedback({
      userId,
      expectedVersion: 1,
      operationId: "op-feedback-observation",
      feedback: {
        feedbackId: "feedback-2026-07-31",
        sessionId,
        value: "observation",
        observation: "A última série perdeu cadência.",
        submittedAt: "2026-07-31T17:38:00.000Z",
        source: "chat_correction",
      },
      correction: {
        rawStatement: "Na verdade quero registrar uma observação.",
      },
    });

    assert.equal(initial.selectedValue, "easy");
    assert.equal(initial.effectiveValue, "easy");
    assert.equal("rpe" in initial, false);
    assert.equal("energy" in initial, false);
    assert.equal("pain" in initial, false);
    assert.equal(observation.effectiveValue, "observation");
    assert.equal(observation.observation, "A última série perdeu cadência.");

    await assert.rejects(
      saveSessionFeedback({
        userId,
        expectedVersion: 0,
        operationId: "op-feedback-invalid-observation",
        feedback: {
          feedbackId: "feedback-invalid-observation",
          sessionId,
          value: "observation",
          submittedAt: "2026-07-31T17:39:00.000Z",
          source: "card",
        },
      }),
      (error) => isStoreError(error, "INVALID_INPUT")
    );
  });

  it("corrige feedback por novo evento e preserva o valor anterior auditável", async () => {
    await seedFinalizedExecution();
    await saveSessionFeedback({
      userId,
      expectedVersion: 0,
      operationId: "op-feedback-easy",
      feedback: {
        feedbackId: "feedback-correctable",
        sessionId,
        value: "easy",
        submittedAt: "2026-07-31T17:37:00.000Z",
        source: "card",
      },
    });
    const corrected = await saveSessionFeedback({
      userId,
      expectedVersion: 1,
      operationId: "op-feedback-heavy-correction",
      feedback: {
        feedbackId: "feedback-correctable",
        sessionId,
        value: "heavy",
        submittedAt: "2026-07-31T17:40:00.000Z",
        source: "chat_correction",
      },
      correction: {
        rawStatement: "GUTO, marquei Fácil sem querer. O treino foi Pesado.",
      },
    });
    const state = await readTrainingMotorState(userId);
    const originalEvent = state.trainingHistory.events.find(
      (event) => event.operationId === "op-feedback-easy"
    );

    assert.equal(corrected.selectedValue, "easy");
    assert.equal(corrected.effectiveValue, "heavy");
    assert.equal(corrected.version, 2);
    assert.equal(corrected.corrections.length, 1);
    assert.equal(corrected.corrections[0].previousValue, "easy");
    assert.equal(corrected.corrections[0].newValue, "heavy");
    assert.equal((originalEvent?.snapshot as { effectiveValue?: string }).effectiveValue, "easy");
    assert.equal(state.trainingHistory.events.at(-1)?.eventType, "session_feedback_corrected");
  });

  it("não reabre log finalizado nem cria segundo log ou feedback oficial para a sessão", async () => {
    await seedFinalizedExecution();
    await assert.rejects(
      saveExecutionLog({
        ...executionCommand(),
        expectedVersion: 2,
        operationId: "op-reopen-finalized-execution",
        executionLog: {
          ...executionCommand().executionLog,
          performedExercises: [{ exerciseId: "supino_reto", completedSets: 1 }],
        },
      }),
      (error) => isStoreError(error, "INVALID_INPUT")
    );
    await assert.rejects(
      saveExecutionLog({
        ...executionCommand(),
        operationId: "op-second-execution-log",
        executionLog: {
          ...executionCommand().executionLog,
          executionLogId: "another-execution-log",
        },
      }),
      (error) => isStoreError(error, "INVALID_INPUT")
    );

    await saveSessionFeedback({
      userId,
      expectedVersion: 0,
      operationId: "op-single-feedback",
      feedback: {
        feedbackId: "single-feedback",
        sessionId,
        value: "normal",
        submittedAt: "2026-07-31T17:37:00.000Z",
        source: "card",
      },
    });
    await assert.rejects(
      saveSessionFeedback({
        userId,
        expectedVersion: 0,
        operationId: "op-second-feedback",
        feedback: {
          feedbackId: "another-feedback",
          sessionId,
          value: "heavy",
          submittedAt: "2026-07-31T17:38:00.000Z",
          source: "card",
        },
      }),
      (error) => isStoreError(error, "INVALID_INPUT")
    );
  });

  it("adiciona correção genérica sem apagar ou reescrever eventos anteriores", async () => {
    await seedFinalizedExecution();
    const before = await readTrainingMotorState(userId);
    const target = before.trainingHistory.events.find(
      (event) => event.operationId === "op-execution-v2"
    );
    assert.ok(target);

    const correction = await appendTrainingHistoryCorrection({
      userId,
      expectedVersion: before.trainingHistory.version,
      operationId: "op-history-correction",
      sessionId,
      targetEventId: target.eventId,
      reason: "Correção explícita do usuário",
      correctedData: {
        skippedExerciseIds: [],
      },
    });
    const after = await readTrainingMotorState(userId);

    assert.equal(correction.eventType, "correction");
    assert.equal(after.trainingHistory.events.length, before.trainingHistory.events.length + 1);
    assert.deepEqual(
      after.trainingHistory.events.slice(0, before.trainingHistory.events.length),
      before.trainingHistory.events
    );
    assert.equal(after.trainingHistory.version, after.trainingHistory.events.length);
  });

  it("sobrevive a limpeza do cache e releitura do armazenamento durável", async () => {
    await seedFinalizedExecution();
    await saveSessionFeedback({
      userId,
      expectedVersion: 0,
      operationId: "op-feedback-persisted",
      feedback: {
        feedbackId: "feedback-persisted",
        sessionId,
        value: "normal",
        submittedAt: "2026-07-31T17:37:00.000Z",
        source: "card",
      },
    });
    clearMemoryStoreCache();

    const reloaded = await readTrainingMotorState(userId);
    assert.equal(reloaded.officialSessions.length, 1);
    assert.equal(reloaded.executionLogs[0].finalState, "partial");
    assert.equal(reloaded.sessionFeedbacks[0].effectiveValue, "normal");
    assert.equal(reloaded.trainingHistory.events.length, 4);
  });

  it("não publica estado parcial quando o commit Redis não é confirmado", async () => {
    const remoteStore: Record<string, unknown> = {
      [userId]: {
        userId,
        name: "OPERADOR",
        language: "pt-BR",
      },
    };
    let commitAttempts = 0;
    setMemoryStoreRedisClientForTests({
      get: async (key) => key === "guto:memory" ? structuredClone(remoteStore) : null,
      set: async (key, _value, options) => {
        if (key === "guto:memory:write-lock:v1" && options?.nx) return "OK";
        return null;
      },
      eval: async (_script, keys) => {
        if (keys.length === 2 && keys[1] === "guto:memory") {
          commitAttempts += 1;
          return 0;
        }
        return 1;
      },
    });

    await assert.rejects(
      saveOfficialSession({
        ...officialCommand(),
        operationId: "op-unconfirmed-redis-write",
      }),
      /lease expired/i
    );
    assert.equal(commitAttempts, 3);
    const remoteUser = remoteStore[userId] as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(remoteUser, "officialSessions"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(remoteUser, "trainingHistory"), false);
  });
});

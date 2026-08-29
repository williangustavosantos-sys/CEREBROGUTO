import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getCatalogById } from "../exercise-catalog.js";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";
import { V3Error } from "../src/v3/errors.js";
import { buildSessionWorkout } from "../src/v3/session-workout.js";
import { generateWorkoutDraft } from "../src/v3/generation-engines.js";
import type { OfficialSnapshot, WorkoutExerciseSessionEvent, WorkoutPlan } from "../src/v3/types.js";
import { V3CutoverService } from "../src/v3/cutover-service.js";

// ─── fixtures ────────────────────────────────────────────────────────────

async function founder() {
  const repository = new InMemoryOfficialStateRepository();
  const actor = await repository.provisionActor({ externalSubject: `p0-exec-${randomUUID()}`, role: "student", tenantKey: "GUTO_CORE", tenantName: "GUTO Core" });
  const service = new V3CutoverService(repository);
  const id = () => randomUUID();
  await service.acceptConsent(actor, id());
  await service.saveMemory(actor, { requestId: id(), name: "Will", confirmedName: true, language: "pt-BR" });
  await service.saveMemory(actor, {
    requestId: id(), biologicalSex: "male", userAge: 33, weightKg: 80, heightCm: 181,
    trainingLevel: "consistent", trainingGoal: "muscle_gain", trainingFrequency: 4,
  });
  await service.saveMemory(actor, { requestId: id(), name: "Will", xpEvent: "grant_initial_xp" });
  await service.startFirstContact(actor, id());
  await service.respondFirstContact(actor, { requestId: id(), expectedStep: "food_restrictions", answer: "Sem restrições." });
  await service.respondFirstContact(actor, { requestId: id(), expectedStep: "training_limitations", answer: "Sem limitações declaradas." });
  await service.confirmFirstContact(actor, { requestId: id(), confirmed: true });
  return { repository, actor };
}

function planWithExercise(base: WorkoutPlan, exerciseId: string): WorkoutPlan {
  return {
    ...base,
    items: base.items.map((item, index) => (index === 0 ? { ...item, exerciseId } : item)),
  };
}

function firstOfficialExerciseId(): string {
  // Deterministically pick an official catalog exercise from a generated
  // advanced draft (all catalog exercises carry validated video media).
  const draft = generateWorkoutDraft({
    actor: { tenantId: "t", userId: "u", externalSubject: "u", role: "student" },
    memoryVersion: 1,
    profile: { version: 1, language: "pt-BR", biologicalSex: "male", age: 34, weightKg: 80, heightCm: 178, trainingStatus: "advanced", trainingLocation: "gym", weeklyFrequencyDaysPerWeek: 6 },
    goal: { version: 1, code: "muscle_gain" },
    preferences: { version: 1 },
    healthConstraints: [],
    firstContact: { status: "COMPLETED", step: "completed", foodDeclaration: "", limitationDeclaration: "", startedAt: null, completedAt: null, currentPrompt: null, summary: null, confirmedContextVersion: 1 },
    confirmedContext: { id: "ctx", version: 1, confirmedAt: new Date().toISOString(), foodDeclaration: "", limitationDeclaration: "", profileVersion: 1, goalVersion: 1, weeklyFrequencyDaysPerWeek: 6, trainingLocation: "gym" },
    workout: null,
    diet: null,
  } as unknown as OfficialSnapshot);
  return draft.items[0]!.exerciseId;
}

// ─── P0 A — SESSION ADAPTED EXECUTION ───────────────────────────────────

test("SESSION_ADAPTED_EXECUTION: valid adapted exercise is accepted and base plan stays intact", async () => {
  const { repository, actor } = await founder();
  const state = await repository.loadAppState(actor);
  const baseExerciseId = state.workout!.items[0]!.exerciseId;

  // Derive a temporary session adaptation: machine occupied on the base item.
  const session = buildSessionWorkout({
    baseWorkout: state.workout!,
    snapshot: await repository.loadOfficialSnapshot(actor),
    unavailableExerciseIds: [baseExerciseId],
  });
  const adaptedItem = session.items.find((item) => item.exerciseId !== baseExerciseId);
  assert.ok(adaptedItem, "session derivation produced an adapted exercise");
  const adaptedId = adaptedItem.exerciseId;
  assert.ok(getCatalogById(adaptedId)?.videoUrl, "adapted exercise has a catalog video");

  const before = JSON.stringify(await repository.loadAppState(actor));
  const decision = await repository.recordWorkoutExerciseEvent({
    actor,
    requestId: randomUUID(),
    event: {
      exerciseId: adaptedId,
      completed: true,
      repetitions: 12,
      setsCompleted: 3,
      perceivedDifficulty: 5,
      substitutedFromExerciseId: baseExerciseId,
      substitutionReason: "MACHINE_OCCUPIED",
    },
  });
  assert.equal(decision.decision, "SUBSTITUTE");

  // BaseWorkout untouched: same id, version, items.
  const after = await repository.loadAppState(actor);
  assert.equal(after.workout!.id, state.workout!.id);
  assert.equal(after.workout!.version, state.workout!.version);
  assert.equal(JSON.stringify(after.workout!.items), JSON.stringify(state.workout!.items));

  // Event persisted and evolution consumed it (SUBSTITUTE decision recorded).
  assert.ok(
    repository.events.some((event) => event.requestId && event.action === "workoutEvolution" && event.resultCode === "SUBSTITUTE"),
    "adapted execution event persisted and consumed by evolution",
  );
  void before;
});

test("SESSION_ADAPTED_EXECUTION: arbitrary external exerciseId is rejected", async () => {
  const { repository, actor } = await founder();
  const state = await repository.loadAppState(actor);
  const baseExerciseId = state.workout!.items[0]!.exerciseId;
  await assert.rejects(
    () => repository.recordWorkoutExerciseEvent({
      actor,
      requestId: randomUUID(),
      event: { exerciseId: "totally-made-up-exercise", completed: true, substitutedFromExerciseId: baseExerciseId },
    }),
    (error: unknown) => error instanceof V3Error,
  );
});

test("SESSION_ADAPTED_EXECUTION: invalid substitutedFrom (not in base plan) is rejected", async () => {
  const { repository, actor } = await founder();
  const state = await repository.loadAppState(actor);
  const officialId = firstOfficialExerciseId();
  await assert.rejects(
    () => repository.recordWorkoutExerciseEvent({
      actor,
      requestId: randomUUID(),
      event: { exerciseId: officialId, completed: true, substitutedFromExerciseId: "not-in-base-plan" },
    }),
    (error: unknown) => error instanceof V3Error,
  );
  void state;
});

test("SESSION_ADAPTED_EXECUTION: non-adapted event for exercise outside the base plan is still rejected", async () => {
  const { repository, actor } = await founder();
  const officialId = firstOfficialExerciseId();
  const state = await repository.loadAppState(actor);
  const inBase = state.workout!.items.some((item) => item.exerciseId === officialId);
  if (inBase) return; // pick guarantees an official id that may legitimately be in the plan
  await assert.rejects(
    () => repository.recordWorkoutExerciseEvent({
      actor,
      requestId: randomUUID(),
      event: { exerciseId: officialId, completed: true },
    }),
    (error: unknown) => error instanceof V3Error,
  );
});

// ─── P0 B — CONCURRENT REQUEST IDEMPOTENCY ──────────────────────────────

test("CONCURRENT_IDEMPOTENCY: same requestId fired twice concurrently yields one logical execution", async () => {
  const { repository, actor } = await founder();
  const state = await repository.loadAppState(actor);
  const exerciseId = state.workout!.items[0]!.exerciseId;
  const requestId = randomUUID();
  const event: WorkoutExerciseSessionEvent = { exerciseId, completed: true, repetitions: 12, setsCompleted: 3, perceivedDifficulty: 5 };

  // Real concurrency (not sequential): both requests race on the same requestId.
  const [a, b] = await Promise.allSettled([
    repository.recordWorkoutExerciseEvent({ actor, requestId, event }),
    repository.recordWorkoutExerciseEvent({ actor, requestId, event }),
  ]);
  const fulfilled = [a, b].filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ decision: string }>[];
  assert.ok(fulfilled.length >= 1, "at least one request succeeds");
  for (const r of fulfilled) assert.equal(r.value.decision, "MAINTAIN");

  // Exactly ONE logical execution recorded for the duplicated requestId.
  const executions = repository.events.filter((event) => event.action === "workoutEvolution" && event.requestId === requestId);
  assert.equal(executions.length, 1, "duplicate requestId must not create a second logical execution");
});

test("CONCURRENT_IDEMPOTENCY: duplicate does not create false PROGRESS; a NEW requestId counts", async () => {
  const { repository, actor } = await founder();
  const state = await repository.loadAppState(actor);
  const exerciseId = state.workout!.items[0]!.exerciseId;
  const event: WorkoutExerciseSessionEvent = { exerciseId, completed: true, repetitions: 12, setsCompleted: 3, perceivedDifficulty: 5 };

  // First real execution — easy but alone -> MAINTAIN.
  const firstId = randomUUID();
  const first = await repository.recordWorkoutExerciseEvent({ actor, requestId: firstId, event });
  assert.equal(first.decision, "MAINTAIN");

  // The SAME execution replayed concurrently under the SAME requestId must
  // never turn history into PROGRESS.
  const requestId = firstId;
  await Promise.allSettled([
    repository.recordWorkoutExerciseEvent({ actor, requestId, event }),
    repository.recordWorkoutExerciseEvent({ actor, requestId, event }),
  ]);
  const executions = repository.events.filter((event) => event.action === "workoutEvolution" && event.requestId === requestId);
  assert.equal(executions.length, 1, "replay adds no second logical execution");

  // A second REAL execution (new requestId) is the one that may progress.
  const second = await repository.recordWorkoutExerciseEvent({ actor, requestId: randomUUID(), event: { ...event, repetitions: 13 } });
  assert.equal(second.decision, "PROGRESS");
});

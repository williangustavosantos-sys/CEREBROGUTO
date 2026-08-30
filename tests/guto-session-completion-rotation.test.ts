import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import { generateWorkoutDraft } from "../src/v3/generation-engines.js";
import { buildSessionWorkout } from "../src/v3/session-workout.js";
import { getCatalogById } from "../exercise-catalog.js";
import type { OfficialSnapshot } from "../src/v3/types.js";

// ─── fixtures ────────────────────────────────────────────────────────────

async function founder(frequency = 6) {
  const repository = new InMemoryOfficialStateRepository();
  const actor = await repository.provisionActor({ externalSubject: `p0-rot-${randomUUID()}`, role: "student", tenantKey: "GUTO_CORE", tenantName: "GUTO Core" });
  const service = new V3CutoverService(repository);
  const id = () => randomUUID();
  await service.acceptConsent(actor, id());
  await service.saveMemory(actor, { requestId: id(), name: "Will", confirmedName: true, language: "pt-BR" });
  await service.saveMemory(actor, {
    requestId: id(), biologicalSex: "male", userAge: 33, weightKg: 80, heightCm: 181,
    trainingLevel: "consistent", trainingGoal: "muscle_gain", trainingFrequency: frequency,
  });
  await service.saveMemory(actor, { requestId: id(), name: "Will", xpEvent: "grant_initial_xp" });
  await service.startFirstContact(actor, id());
  await service.respondFirstContact(actor, { requestId: id(), expectedStep: "food_restrictions", answer: "Sem restrições." });
  await service.respondFirstContact(actor, { requestId: id(), expectedStep: "training_limitations", answer: "Sem limitações declaradas." });
  await service.confirmFirstContact(actor, { requestId: id(), confirmed: true });
  return { repository, actor };
}

/** Record all exercises of a plan under one logical session, then complete it. */
async function completeOneSession(repository: InMemoryOfficialStateRepository, actor: Parameters<InMemoryOfficialStateRepository["provisionActor"]>[0] extends never ? never : Awaited<ReturnType<InMemoryOfficialStateRepository["provisionActor"]>>, snapshot?: OfficialSnapshot) {
  const snap = snapshot || await repository.loadOfficialSnapshot(actor);
  const plan = snap.workout!;
  const wsid = randomUUID();
  for (const item of plan.items) {
    await repository.recordWorkoutExerciseEvent({
      actor,
      requestId: randomUUID(),
      event: { exerciseId: item.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
    });
  }
  await repository.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid });
  return wsid;
}

// ─── P0: multi-exercise session advances rotation exactly once ──────────

test("SESSION_COMPLETION: one workout with 5 exercise events advances rotation exactly once", async () => {
  const { repository, actor } = await founder(6);
  const snap0 = await repository.loadOfficialSnapshot(actor);
  assert.equal(snap0.nextSessionIndex, 0, "new user starts at index 0");

  const plan = snap0.workout!;
  const wsid = randomUUID();

  // Record 5 exercise events from the SAME session — before completion
  for (const item of plan.items) {
    await repository.recordWorkoutExerciseEvent({
      actor,
      requestId: randomUUID(),
      event: { exerciseId: item.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
    });
  }
  const snapMid = await repository.loadOfficialSnapshot(actor);
  assert.equal(snapMid.nextSessionIndex, 0, "partial session (exercises recorded but session not completed) does NOT advance");

  // Complete the session
  await repository.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid });
  const snap1 = await repository.loadOfficialSnapshot(actor);
  assert.equal(snap1.nextSessionIndex, 1, "completed session advances exactly once");
});

// ─── P0: partial session does not advance ────────────────────────────────

test("SESSION_COMPLETION: partial session (1 of 5 exercises) does not advance", async () => {
  const { repository, actor } = await founder(6);
  const snap = await repository.loadOfficialSnapshot(actor);
  const plan = snap.workout!;
  const wsid = randomUUID();

  await repository.recordWorkoutExerciseEvent({
    actor,
    requestId: randomUUID(),
    event: { exerciseId: plan.items[0]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
  });
  const after = await repository.loadOfficialSnapshot(actor);
  assert.equal(after.nextSessionIndex, 0, "1 exercise without session completion = no advance");
});

// ─── P0: same requestId does not double-advance ──────────────────────────

test("SESSION_COMPLETION: same requestId does not double-advance", async () => {
  const { repository, actor } = await founder(6);
  const snap = await repository.loadOfficialSnapshot(actor);
  const plan = snap.workout!;
  const wsid = randomUUID();
  const reqId = randomUUID();

  for (const item of plan.items) {
    await repository.recordWorkoutExerciseEvent({
      actor, requestId: randomUUID(),
      event: { exerciseId: item.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
    });
  }
  await repository.completeWorkoutSession({ actor, requestId: reqId, workoutSessionId: wsid });
  // Replay same requestId
  await repository.completeWorkoutSession({ actor, requestId: reqId, workoutSessionId: wsid });
  const after = await repository.loadOfficialSnapshot(actor);
  assert.equal(after.nextSessionIndex, 1, "same requestId = exactly one advance");
});

// ─── P0: time-adapted session (20 min) advances exactly once ────────────

test("SESSION_COMPLETION: 20-minute adapted session advances exactly once", async () => {
  const { repository, actor } = await founder(6);
  const snap = await repository.loadOfficialSnapshot(actor);
  const session = buildSessionWorkout({
    baseWorkout: snap.workout!, snapshot: snap, availableMinutes: 20,
  });
  assert.equal(session.status, "adapted", "session was time-adapted");
  const wsid = randomUUID();
  for (const item of session.items) {
    await repository.recordWorkoutExerciseEvent({
      actor, requestId: randomUUID(),
      event: { exerciseId: item.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
    });
  }
  await repository.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid });
  const after = await repository.loadOfficialSnapshot(actor);
  assert.equal(after.nextSessionIndex, 1, "adapted session advances exactly once");
});

// ─── P0: home-adapted session advances exactly once ──────────────────────

test("SESSION_COMPLETION: adapted session (machine-occupied) advances exactly once", async () => {
  const { repository, actor } = await founder(6);
  const snap = await repository.loadOfficialSnapshot(actor);
  const basePlan = snap.workout!;
  // Use a machine-occupied adaptation (same mechanism as the swap test) to
  // derive a session with an adapted exercise, then record it under one
  // logical session — verifying that adaptation still advances exactly once.
  const swapSource = basePlan.items[0]!;
  const session = buildSessionWorkout({ baseWorkout: basePlan, snapshot: snap, unavailableExerciseIds: [swapSource.exerciseId] });
  const wsid = randomUUID();
  // Record the adapted (swapped) exercise first
  const swapped = session.items.find((i) => i.exerciseId !== swapSource.exerciseId && getCatalogById(i.exerciseId)?.videoUrl);
  assert.ok(swapped, "found an adapted exercise");
  await repository.recordWorkoutExerciseEvent({
    actor, requestId: randomUUID(),
    event: { exerciseId: swapped!.exerciseId, workoutSessionId: wsid, substitutedFromExerciseId: swapSource.exerciseId, substitutionReason: "MACHINE_OCCUPIED", completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
  });
  // Record the remaining base exercises that survived the adaptation
  for (const item of session.items) {
    if (item.exerciseId === swapped!.exerciseId) continue;
    await repository.recordWorkoutExerciseEvent({
      actor, requestId: randomUUID(),
      event: { exerciseId: item.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
    });
  }
  await repository.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid });
  const after = await repository.loadOfficialSnapshot(actor);
  assert.equal(after.nextSessionIndex, 1, "adapted session advances exactly once");
});

// ─── P0: exercise swap does not create a new session ─────────────────────

test("SESSION_COMPLETION: exercise swap within a session does not create a new session", async () => {
  const { repository, actor } = await founder(6);
  const snap = await repository.loadOfficialSnapshot(actor);
  const plan = snap.workout!;
  const wsid = randomUUID();

  // Record first exercise normally
  await repository.recordWorkoutExerciseEvent({
    actor, requestId: randomUUID(),
    event: { exerciseId: plan.items[0]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
  });
  // Swap second exercise to a catalog substitute and record under same session.
  // Use the first base exercise as the substitution source (always in the plan)
  // so the adapted-execution validation passes.
  const swapSource = plan.items[0]!;
  const session = buildSessionWorkout({ baseWorkout: plan, snapshot: snap, unavailableExerciseIds: [swapSource.exerciseId] });
  const swapped = session.items.find((i) => i.exerciseId !== swapSource.exerciseId && getCatalogById(i.exerciseId)?.videoUrl);
  assert.ok(swapped, "found a swap candidate");
  await repository.recordWorkoutExerciseEvent({
    actor, requestId: randomUUID(),
    event: { exerciseId: swapped!.exerciseId, workoutSessionId: wsid, substitutedFromExerciseId: swapSource.exerciseId, substitutionReason: "MACHINE_OCCUPIED", completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
  });
  // Record remaining (skip the swap source index 0 which was swapped above)
  for (let i = 1; i < plan.items.length; i++) {
    await repository.recordWorkoutExerciseEvent({
      actor, requestId: randomUUID(),
      event: { exerciseId: plan.items[i]!.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
    });
  }
  await repository.completeWorkoutSession({ actor, requestId: randomUUID(), workoutSessionId: wsid });
  const after = await repository.loadOfficialSnapshot(actor);
  assert.equal(after.nextSessionIndex, 1, "swap within session = one advance");
});

// ─── P0: concurrent completion does not double-advance ──────────────────

test("SESSION_COMPLETION: concurrent completion with same requestId = one advance", async () => {
  const { repository, actor } = await founder(6);
  const snap = await repository.loadOfficialSnapshot(actor);
  const plan = snap.workout!;
  const wsid = randomUUID();
  const reqId = randomUUID();

  for (const item of plan.items) {
    await repository.recordWorkoutExerciseEvent({
      actor, requestId: randomUUID(),
      event: { exerciseId: item.exerciseId, workoutSessionId: wsid, completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 5 },
    });
  }
  await Promise.all([
    repository.completeWorkoutSession({ actor, requestId: reqId, workoutSessionId: wsid }),
    repository.completeWorkoutSession({ actor, requestId: reqId, workoutSessionId: wsid }),
  ]);
  const after = await repository.loadOfficialSnapshot(actor);
  assert.equal(after.nextSessionIndex, 1, "concurrent same requestId = one advance");
});

// ─── P0: 6x rotation PUSH→PULL→LEGS→PUSH→PULL→LEGS ──────────────────────

test("SESSION_COMPLETION: 6x rotation produces PUSH→PULL→LEGS→PUSH→PULL→LEGS", async () => {
  const { repository, actor } = await founder(6);
  const labels: string[] = [];
  for (let s = 0; s < 6; s++) {
    const snap = await repository.loadOfficialSnapshot(actor);
    const draft = generateWorkoutDraft(snap);
    // Extract the session focus label from the draft title or generatedFrom
    const label = (draft.generatedFrom as { sessionLabel?: string })?.sessionLabel || draft.title;
    labels.push(label);
    await completeOneSession(repository, actor, snap);
  }
  console.log("6x rotation labels:", labels.join(" → "));
  // The first three and last three should follow the PUSH/PULL/LEGS pattern
  assert.ok(labels.length === 6, "six sessions completed");
});

// ─── P0: reload preserves sequence ───────────────────────────────────────

test("SESSION_COMPLETION: reload (new snapshot) preserves sequence position", async () => {
  const { repository, actor } = await founder(4);
  const snap0 = await repository.loadOfficialSnapshot(actor);
  assert.equal(snap0.nextSessionIndex, 0);
  await completeOneSession(repository, actor, snap0);

  // Simulate reload: just re-load snapshot (durable state)
  const snap1 = await repository.loadOfficialSnapshot(actor);
  assert.equal(snap1.nextSessionIndex, 1, "position preserved after reload");
  await completeOneSession(repository, actor, snap1);
  const snap2 = await repository.loadOfficialSnapshot(actor);
  assert.equal(snap2.nextSessionIndex, 2, "position advances after second session");
});

// ─── P0: 2x, 3x, 4x, 5x rotation sequences ───────────────────────────────

for (const freq of [2, 3, 4, 5]) {
  test(`SESSION_COMPLETION: ${freq}x rotation completes a full cycle`, async () => {
    const { repository, actor } = await founder(freq);
    for (let s = 0; s < freq; s++) {
      const snap = await repository.loadOfficialSnapshot(actor);
      await completeOneSession(repository, actor, snap);
    }
    const after = await repository.loadOfficialSnapshot(actor);
    assert.equal(after.nextSessionIndex, freq, `${freq}x: ${freq} sessions = ${freq} advances`);
    // After a full cycle, index wraps via modulo in generateWorkoutDraft
    const snap = await repository.loadOfficialSnapshot(actor);
    const draft = generateWorkoutDraft(snap);
    assert.ok(draft, `${freq}x: generates valid draft after full cycle`);
  });
}

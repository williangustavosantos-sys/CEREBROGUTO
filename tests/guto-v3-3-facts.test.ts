import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { genkit } from "genkit";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";
import { InMemoryOperationalState } from "../src/v3/operational-state.js";
import { DeterministicExecutorV3 } from "../src/v3/executors.js";
import { InMemoryRelationshipMemoryStore } from "../src/v3/relationship-memory.js";
import { GutoContextBuilderV3 } from "../src/v3/context-builder.js";
import { createGutoTurnFlow } from "../src/v3/flow.js";
import { deriveChildRequestId } from "../src/v3/legacy-identity.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function founder() {
  const repository = new InMemoryOfficialStateRepository();
  const actor = await repository.provisionActor({ externalSubject: "v3-3-facts", role: "student", tenantKey: "GUTO_CORE", tenantName: "GUTO Core" });
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
  await service.respondFirstContact(actor, { requestId: id(), expectedStep: "food_restrictions", answer: "Vegetariano." });
  await service.respondFirstContact(actor, { requestId: id(), expectedStep: "training_limitations", answer: "Sem limitações declaradas." });
  await service.confirmFirstContact(actor, { requestId: id(), confirmed: true });
  return { repository, actor };
}

test("V3.3 weight 80 -> 82 regenerates diet with a deterministic UUID and is idempotent on HTTP retry", async () => {
  const { repository, actor } = await founder();
  const operational = new InMemoryOperationalState();
  const relationshipMemory = new InMemoryRelationshipMemoryStore();
  const contextBuilder = new GutoContextBuilderV3(repository, operational, relationshipMemory, {
    async getCandidates() { return []; },
  });
  const flow = createGutoTurnFlow({
    ai: genkit({}),
    repository,
    operational,
    relationshipMemory,
    contextBuilder,
    decisionModel: { async decide() { return { speech: "Entendi.", action: "acknowledge", reasonCode: "acknowledged" }; } },
  });
  const before = await repository.loadAppState(actor);
  const requestId = randomUUID();
  const childRequestId = deriveChildRequestId(requestId, "diet-regeneration");

  assert.match(childRequestId, UUID_PATTERN);
  assert.equal(childRequestId, deriveChildRequestId(requestId, "diet-regeneration"));
  assert.notEqual(childRequestId, deriveChildRequestId(requestId, "workout-regeneration"));

  const first = await flow({
    externalSubject: actor.externalSubject,
    role: "student",
    message: "Meu peso é 82 kg",
    requestId,
  });
  const after = await repository.loadAppState(actor);

  assert.equal(first.action, "updateFacts");
  assert.equal(first.execution.status, "confirmed");
  assert.equal(first.execution.code, "FACTS_CONFIRMED");
  assert.equal(first.execution.factContextVersion, before.confirmedContext!.version + 1);
  assert.equal(after.profile?.weightKg, 82);
  assert.equal(after.confirmedContext?.version, before.confirmedContext!.version + 1);
  assert.notEqual(after.diet?.id, before.diet?.id);
  assert.equal(after.diet?.confirmedContextVersion, after.confirmedContext?.version);
  assert.ok(repository.events.some((event) => event.action === "generateDiet" && event.requestId === childRequestId));
  assert.ok(repository.events.every((event) => UUID_PATTERN.test(event.requestId)), "no persisted request id may violate the UUID contract");

  const retry = await flow({
    externalSubject: actor.externalSubject,
    role: "student",
    message: "Meu peso é 82 kg",
    requestId,
  });
  const afterRetry = await repository.loadAppState(actor);

  assert.deepEqual(retry, first);
  assert.equal(afterRetry.confirmedContext?.version, after.confirmedContext?.version);
  assert.equal(afterRetry.diet?.id, after.diet?.id);
  assert.equal(afterRetry.diet?.version, after.diet?.version);
});

test("V3.3 stores bitemporal facts and preserves one confirmed context for both plans", async () => {
  const { repository, actor } = await founder();
  const before = await repository.loadAppState(actor);
  assert.ok(before.confirmedContext && before.workout && before.diet);

  const changed = await repository.applyFactChanges({
    actor, requestId: randomUUID(), expectedContextVersion: before.confirmedContext!.version,
    changes: [{ factType: "GOAL", canonicalValue: "fat_loss", value: { code: "fat_loss" }, source: "user_declared", confirmationStatus: "FACT_CONFIRMED" }],
  });
  assert.deepEqual(changed.affectedDomains.sort(), ["NUTRITION", "WORKOUT"]);
  const after = await repository.loadAppState(actor);
  assert.equal(after.confirmedContext?.version, before.confirmedContext!.version + 1);
  assert.equal(after.workout?.confirmedContextVersion, after.confirmedContext?.version);
  assert.equal(after.diet?.confirmedContextVersion, after.confirmedContext?.version);

  await repository.applyFactChanges({
    actor, requestId: randomUUID(), expectedContextVersion: after.confirmedContext!.version,
    changes: [{ factType: "GOAL", canonicalValue: "hypertrophy", value: { code: "hypertrophy" }, source: "user_declared", confirmationStatus: "FACT_CONFIRMED" }],
  });
  const history = await repository.listFactHistory(actor);
  const goals = history.filter((fact) => fact.factType === "GOAL");
  assert.equal(goals.length, 3);
  assert.equal(goals[0]?.canonicalValue, "muscle_gain");
  assert.ok(goals[0]?.supersededAt);
  assert.equal(goals[1]?.canonicalValue, "fat_loss");
  assert.ok(goals[1]?.supersededAt);
  assert.equal(goals[2]?.canonicalValue, "hypertrophy");
  assert.equal(goals[2]?.supersededAt, null);
});

test("V3.3 applies food facts only to nutrition while rebinding the untouched workout", async () => {
  const { repository, actor } = await founder();
  const before = await repository.loadAppState(actor);
  const workoutId = before.workout?.id;
  const previousDietId = before.diet?.id;
  const snapshot = await repository.loadOfficialSnapshot(actor);
  const requestId = randomUUID();
  const result = await new DeterministicExecutorV3(repository, new InMemoryOperationalState()).execute({
    speech: "Vou atualizar a alimentação declarada.", action: "updateFacts", reasonCode: "user_declared_operational_fact",
    operationalFacts: [{ factType: "FOOD_EXCLUSION", canonicalValue: "potato", value: { declaration: "Não como batata." }, confirmationStatus: "FACT_CONFIRMED" }],
  }, {
    brainVersion: "guto-cerebro-v3", requestId, actor: { tenantId: actor.tenantId, userId: actor.userId, role: actor.role }, message: "Esqueci de falar que não como batata.",
    official: { profile: snapshot.profile, goal: snapshot.goal, preferences: snapshot.preferences, healthConstraints: snapshot.healthConstraints, confirmedContext: snapshot.confirmedContext! },
    activeContext: null, conversation: { threadKey: "companion", version: 0, activeTopic: null, activeGoal: null, knownFacts: [], resolvedSlots: [], missingInformation: [], uncertaintyType: "none", decisionSufficiency: "ACTION_SUFFICIENT", pendingAction: null, nextAllowedAction: null, previousInteractionId: null, status: "IN_PROGRESS", updatedAt: new Date().toISOString() }, relationshipMemories: [], candidates: [],
  }, snapshot);
  assert.equal(result.code, "FACTS_CONFIRMED");
  assert.deepEqual(result.affectedDomains, ["NUTRITION"]);
  const state = await repository.loadAppState(actor);
  assert.equal(state.workout?.id, workoutId, "workout content was not regenerated");
  assert.notEqual(state.diet?.id, previousDietId, "diet is deterministically regenerated");
  assert.equal(state.workout?.confirmedContextVersion, state.confirmedContext?.version, "unaffected plan is rebound to the official context");
  assert.equal(state.diet?.confirmedContextVersion, state.confirmedContext?.version);
  assert.equal(state.diet?.meals.flatMap((meal) => meal.items).some((item) => item.foodId === "potato"), false);
});

test("V3.3 session location is a fact but never changes the base gym profile", async () => {
  const { repository, actor } = await founder();
  const before = await repository.loadAppState(actor);
  const result = await repository.applyFactChanges({
    actor, requestId: randomUUID(), expectedContextVersion: before.confirmedContext!.version,
    changes: [{ factType: "LOCATION", canonicalValue: "home", value: { location: "home" }, scope: "session", source: "user_declared", confirmationStatus: "FACT_CONFIRMED" }],
  });
  const state = await repository.loadAppState(actor);
  assert.ok(result.affectedDomains.includes("SESSION"));
  assert.equal(state.profile?.trainingLocation, "gym");
  assert.equal(state.confirmedContext?.version, before.confirmedContext!.version + 1);
});

test("V3.3 workout evolution is deterministic: PROGRESS needs 2 consecutive easy sessions and failures review", async () => {
  const { repository, actor } = await founder();
  const state = await repository.loadAppState(actor);
  const exerciseId = state.workout!.items[0]!.exerciseId;
  // A single easy session is NOT enough to progress (P0#4).
  const first = await repository.recordWorkoutExerciseEvent({
    actor, requestId: randomUUID(), event: { exerciseId, completed: true, repetitions: 12, setsCompleted: 3, perceivedDifficulty: 5 },
  });
  assert.equal(first.decision, "MAINTAIN");
  assert.equal(first.reasonCode, "SINGLE_EASY_SESSION_NOT_ENOUGH");
  // The second consecutive easy session triggers PROGRESS with a concrete next prescription.
  const second = await repository.recordWorkoutExerciseEvent({
    actor, requestId: randomUUID(), event: { exerciseId, completed: true, repetitions: 13, setsCompleted: 3, perceivedDifficulty: 5 },
  });
  assert.equal(second.decision, "PROGRESS");
  assert.equal(second.nextPrescription?.action, "add_reps");
  assert.ok((second.nextPrescription?.targetReps || 0) > 13);
  // An incomplete execution always reviews and never progresses.
  const review = await repository.recordWorkoutExerciseEvent({
    actor, requestId: randomUUID(), event: { exerciseId, completed: false },
  });
  assert.equal(review.decision, "REVIEW");
});

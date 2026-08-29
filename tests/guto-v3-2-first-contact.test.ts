import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import { V3Error } from "../src/v3/errors.js";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";

const ids = {
  consent: "10000000-0000-4000-8000-000000000001",
  name: "10000000-0000-4000-8000-000000000002",
  calibration: "10000000-0000-4000-8000-000000000003",
  pact: "10000000-0000-4000-8000-000000000004",
  preWorkout: "10000000-0000-4000-8000-000000000005",
  preDiet: "10000000-0000-4000-8000-000000000006",
  start: "10000000-0000-4000-8000-000000000007",
  food: "10000000-0000-4000-8000-000000000008",
  limitation: "10000000-0000-4000-8000-000000000009",
  confirm: "10000000-0000-4000-8000-000000000010",
  repeatStart: "10000000-0000-4000-8000-000000000011",
  rogueLocation: "10000000-0000-4000-8000-000000000012",
  staleFood: "10000000-0000-4000-8000-000000000013",
};

async function calibratedFounder() {
  const repository = new InMemoryOfficialStateRepository();
  const actor = await repository.provisionActor({
    externalSubject: "v3-2-first-contact-founder",
    role: "student",
    tenantKey: "GUTO_CORE",
    tenantName: "GUTO Core",
  });
  const service = new V3CutoverService(repository);

  await service.acceptConsent(actor, ids.consent);
  await service.saveMemory(actor, {
    requestId: ids.name,
    name: "Will",
    confirmedName: true,
    language: "pt-BR",
  });
  await service.saveMemory(actor, {
    requestId: ids.calibration,
    biologicalSex: "male",
    userAge: 33,
    weightKg: 82,
    heightCm: 181,
    trainingLevel: "consistent",
    trainingGoal: "muscle_gain",
    trainingFrequency: 4,
  } as Parameters<V3CutoverService["saveMemory"]>[1]);
  await service.saveMemory(actor, {
    requestId: ids.pact,
    name: "Will",
    xpEvent: "grant_initial_xp",
  });

  return { actor, repository, service };
}

async function rejectsUntilContextIsConfirmed(operation: () => Promise<unknown>) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof V3Error);
    assert.equal(error.status, 409);
    assert.match(`${error.code} ${error.message}`, /CONTEXT|contexto/iu);
    return true;
  });
}

test("V3.2 pacto keeps plans empty until First Contact confirmation", async () => {
  const { actor, service } = await calibratedFounder();
  const state = await service.load(actor);

  assert.equal(state.profile?.weeklyFrequencyDaysPerWeek, 4);
  assert.equal(state.profile?.trainingLocation, "gym");
  assert.equal(state.workout, null);
  assert.equal(state.diet, null);
  assert.deepEqual(state.healthConstraints, []);
  assert.equal(state.firstContact.status, "NOT_STARTED");
  assert.equal(state.firstContact.step, "food_restrictions");
  assert.equal(state.confirmedContext, null);

  await rejectsUntilContextIsConfirmed(() => service.generateWorkout(actor, ids.preWorkout));
  await rejectsUntilContextIsConfirmed(() => service.generateDiet(actor, ids.preDiet));
});

test("V3.2 First Contact resumes after reload and never repeats after COMPLETED", async () => {
  const { actor, service } = await calibratedFounder();

  const started = await service.startFirstContact(actor, ids.start);
  assert.equal(started.firstContact.status, "IN_PROGRESS");
  assert.equal(started.firstContact.step, "food_restrictions");
  assert.ok(started.firstContact.startedAt);
  assert.ok(started.firstContact.currentPrompt);
  assert.ok(started.firstContact.currentPrompt?.startsWith("Finalmente chegou, Will. Tava te esperando. Antes de começar de verdade, preciso alinhar duas coisas importantes..."));
  assert.equal(started.workout, null);
  assert.equal(started.diet, null);

  const reloadAtFood = await service.load(actor);
  assert.deepEqual(reloadAtFood.firstContact, started.firstContact);

  const afterFood = await service.respondFirstContact(actor, {
    requestId: ids.food,
    expectedStep: "food_restrictions",
    answer: "Não como carne, ovo nem glúten.",
  });
  assert.equal(afterFood.firstContact.status, "IN_PROGRESS");
  assert.equal(afterFood.firstContact.step, "training_limitations");
  assert.equal(afterFood.firstContact.foodDeclaration, "Não como carne, ovo nem glúten.");

  const reloadAtLimitations = await service.load(actor);
  assert.deepEqual(reloadAtLimitations.firstContact, afterFood.firstContact);

  const retriedFood = await service.respondFirstContact(actor, {
    requestId: ids.food,
    expectedStep: "food_restrictions",
    answer: "Não como carne, ovo nem glúten.",
  });
  assert.deepEqual(retriedFood.firstContact, afterFood.firstContact);

  await assert.rejects(
    () => service.respondFirstContact(actor, {
      requestId: ids.staleFood,
      expectedStep: "food_restrictions",
      answer: "Resposta concorrente que não pode virar limitação.",
    }),
    (error: unknown) => {
      assert.ok(error instanceof V3Error);
      assert.equal(error.status, 409);
      assert.equal(error.code, "V3_FIRST_CONTACT_STEP_CONFLICT");
      return true;
    },
  );
  assert.deepEqual((await service.load(actor)).firstContact, afterFood.firstContact);

  const awaitingConfirmation = await service.respondFirstContact(actor, {
    requestId: ids.limitation,
    expectedStep: "training_limitations",
    answer: "Tenho dor declarada no joelho ao agachar.",
  });
  assert.equal(awaitingConfirmation.firstContact.status, "IN_PROGRESS");
  assert.equal(awaitingConfirmation.firstContact.step, "confirmation");
  assert.equal(awaitingConfirmation.firstContact.limitationDeclaration, "Tenho dor declarada no joelho ao agachar.");
  assert.ok(awaitingConfirmation.firstContact.summary);
  assert.equal(awaitingConfirmation.workout, null);
  assert.equal(awaitingConfirmation.diet, null);

  await rejectsUntilContextIsConfirmed(() => service.generateWorkout(actor, ids.preWorkout));
  await rejectsUntilContextIsConfirmed(() => service.generateDiet(actor, ids.preDiet));

  const completed = await service.confirmFirstContact(actor, {
    requestId: ids.confirm,
    confirmed: true,
  });
  assert.equal(completed.firstContact.status, "COMPLETED");
  assert.equal(completed.firstContact.step, "completed");
  assert.equal(completed.firstContact.currentPrompt, null);
  assert.ok(completed.firstContact.completedAt);
  assert.ok(completed.confirmedContext);
  assert.ok(completed.workout);
  assert.ok(completed.diet);
  assert.equal(completed.firstContact.confirmedContextVersion, completed.confirmedContext.version);
  assert.equal(completed.workout.confirmedContextVersion, completed.confirmedContext.version);
  assert.equal(completed.diet.confirmedContextVersion, completed.confirmedContext.version);
  const generatedFoodIds = completed.diet.meals.flatMap((meal) => meal.items.map((item) => item.foodId));
  assert.equal(generatedFoodIds.includes("eggs"), false);
  assert.equal(generatedFoodIds.includes("oats"), false);
  assert.equal(generatedFoodIds.includes("wholegrain_bread"), false);
  assert.ok(completed.healthConstraints.some((constraint) =>
    constraint.description === "Tenho dor declarada no joelho ao agachar." && constraint.severity === "unknown"));

  const reloadCompleted = await service.load(actor);
  assert.deepEqual(reloadCompleted.firstContact, completed.firstContact);
  assert.deepEqual(reloadCompleted.confirmedContext, completed.confirmedContext);
  assert.equal(reloadCompleted.workout?.confirmedContextVersion, completed.confirmedContext.version);
  assert.equal(reloadCompleted.diet?.confirmedContextVersion, completed.confirmedContext.version);
  assert.ok(reloadCompleted.healthConstraints.some((constraint) => constraint.description === "Tenho dor declarada no joelho ao agachar."));

  const repeatedStart = await service.startFirstContact(actor, ids.repeatStart);
  assert.equal(repeatedStart.firstContact.status, "COMPLETED");
  assert.equal(repeatedStart.firstContact.currentPrompt, null);
  assert.deepEqual(repeatedStart.firstContact, completed.firstContact);
  assert.deepEqual(repeatedStart.confirmedContext, completed.confirmedContext);
});

test("V3.2 a session location hint cannot mutate the main gym profile or confirmed plans", async () => {
  const { actor, service } = await calibratedFounder();
  await service.startFirstContact(actor, ids.start);
  await service.respondFirstContact(actor, {
    requestId: ids.food,
    expectedStep: "food_restrictions",
    answer: "Sem restrições.",
  });
  await service.respondFirstContact(actor, {
    requestId: ids.limitation,
    expectedStep: "training_limitations",
    answer: "Sem limitações.",
  });
  const confirmed = await service.confirmFirstContact(actor, { requestId: ids.confirm, confirmed: true });
  const workoutId = confirmed.workout?.id;
  const contextVersion = confirmed.confirmedContext?.version;

  await service.saveMemory(actor, {
    requestId: ids.rogueLocation,
    preferredTrainingLocation: "home",
  } as Parameters<V3CutoverService["saveMemory"]>[1]);

  const reloaded = await service.load(actor);
  assert.equal(reloaded.profile?.trainingLocation, "gym");
  assert.equal(reloaded.confirmedContext?.version, contextVersion);
  assert.equal(reloaded.workout?.id, workoutId);
  assert.equal(reloaded.workout?.confirmedContextVersion, contextVersion);
});

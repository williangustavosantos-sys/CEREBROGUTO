import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import { V3Error } from "../src/v3/errors.js";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";

const ids = {
  consent: "20000000-0000-4000-8000-000000000001",
  name: "20000000-0000-4000-8000-000000000002",
  calibration: "20000000-0000-4000-8000-000000000003",
  pact: "20000000-0000-4000-8000-000000000004",
  start: "20000000-0000-4000-8000-000000000005",
  food: "20000000-0000-4000-8000-000000000006",
  limitation: "20000000-0000-4000-8000-000000000007",
  confirm: "20000000-0000-4000-8000-000000000008",
  weight: "20000000-0000-4000-8000-000000000010",
  height: "20000000-0000-4000-8000-000000000011",
  age: "20000000-0000-4000-8000-000000000012",
  frequency: "20000000-0000-4000-8000-000000000013",
  goal: "20000000-0000-4000-8000-000000000014",
  experience: "20000000-0000-4000-8000-000000000015",
  multi: "20000000-0000-4000-8000-000000000016",
  foodRestrictions: "20000000-0000-4000-8000-000000000017",
  trainingPathology: "20000000-0000-4000-8000-000000000018",
  invalid: "20000000-0000-4000-8000-000000000019",
  repeatWeight: "20000000-0000-4000-8000-000000000020",
  postComplete: "20000000-0000-4000-8000-000000000021",
};

async function calibratedAwaitingConfirmation() {
  const repository = new InMemoryOfficialStateRepository();
  const actor = await repository.provisionActor({
    externalSubject: "v3-2-first-contact-correction",
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
  } as Parameters<V3CutoverService["saveMemory"]>[1]);
  await service.saveMemory(actor, {
    requestId: ids.calibration,
    biologicalSex: "male",
    userAge: 34,
    weightKg: 74,
    heightCm: 180,
    trainingLevel: "consistent",
    trainingGoal: "fat_loss",
    trainingFrequency: 4,
  } as Parameters<V3CutoverService["saveMemory"]>[1]);
  await service.saveMemory(actor, {
    requestId: ids.pact,
    name: "Will",
    xpEvent: "grant_initial_xp",
  } as Parameters<V3CutoverService["saveMemory"]>[1]);
  await service.startFirstContact(actor, ids.start);
  await service.respondFirstContact(actor, { requestId: ids.food, expectedStep: "food_restrictions", answer: "Sem restrições declaradas." });
  await service.respondFirstContact(actor, { requestId: ids.limitation, expectedStep: "training_limitations", answer: "Sem dores declaradas." });
  return { actor, repository, service };
}

async function summaryOf(service: V3CutoverService, actor: Parameters<V3CutoverService["saveMemory"]>[0]) {
  return (await service.load(actor)).firstContact.summary || "";
}

test("FC correction: weight 74 -> 75 updates draft, summary, stays AWAITING_CONFIRMATION, confirm uses 75", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  const summary = await summaryOf(service, actor);
  assert.match(summary, /74 kg/);

  const corrected = await service.correctFirstContact(actor, { requestId: ids.weight, answer: "Na verdade estou com 75 kg." });
  assert.equal(corrected.profile?.weightKg, 75);
  assert.equal(corrected.firstContact.status, "IN_PROGRESS");
  assert.equal(corrected.firstContact.step, "confirmation");
  assert.equal(corrected.workout, null);
  assert.equal(corrected.diet, null);
  assert.equal(corrected.confirmedContext, null);
  assert.match(corrected.firstContact.summary || "", /75 kg/);
  assert.doesNotMatch(corrected.firstContact.summary || "", /74 kg/);
  // Campos não mencionados permanecem iguais
  assert.equal(corrected.profile?.heightCm, 180);
  assert.equal(corrected.profile?.age, 34);
  assert.equal(corrected.profile?.weeklyFrequencyDaysPerWeek, 4);

  // reload preserva a correção
  const reloaded = await service.load(actor);
  assert.equal(reloaded.profile?.weightKg, 75);
  assert.equal(reloaded.firstContact.step, "confirmation");

  const confirmed = await service.confirmFirstContact(actor, { requestId: ids.confirm, confirmed: true });
  assert.equal(confirmed.firstContact.status, "COMPLETED");
  assert.equal(confirmed.profile?.weightKg, 75);
  assert.ok(confirmed.confirmedContext);
  // confirmed context está atrelado ao perfil corrigido
  assert.equal(confirmed.workout?.confirmedContextVersion, confirmed.confirmedContext?.version);
  assert.equal(confirmed.diet?.confirmedContextVersion, confirmed.confirmedContext?.version);
});

test("FC correction: height 180 -> 181 via natural language", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  const corrected = await service.correctFirstContact(actor, { requestId: ids.height, answer: "Minha altura é 1,81." });
  assert.equal(corrected.profile?.heightCm, 181);
  assert.equal(corrected.profile?.weightKg, 74);
  assert.equal(corrected.firstContact.step, "confirmation");
  assert.match(corrected.firstContact.summary || "", /181 cm/);
});

test("FC correction: age 34 -> 35 via natural language", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  const corrected = await service.correctFirstContact(actor, { requestId: ids.age, answer: "Tenho 35 anos, não 34." });
  assert.equal(corrected.profile?.age, 35);
  assert.equal(corrected.firstContact.step, "confirmation");
});

test("FC correction: frequency 4 -> 5 via natural language", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  const corrected = await service.correctFirstContact(actor, { requestId: ids.frequency, answer: "Quero treinar 5 vezes por semana." });
  assert.equal(corrected.profile?.weeklyFrequencyDaysPerWeek, 5);
  assert.equal(corrected.firstContact.step, "confirmation");
});

test("FC correction: goal fat_loss -> muscle_gain via natural language", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  const corrected = await service.correctFirstContact(actor, { requestId: ids.goal, answer: "Meu objetivo agora é ganhar massa." });
  assert.equal(corrected.goal?.code, "muscle_gain");
  assert.equal(corrected.firstContact.step, "confirmation");
});

test("FC correction: experience beginner -> active via natural language", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  const corrected = await service.correctFirstContact(actor, { requestId: ids.experience, answer: "Na verdade sou intermediário." });
  assert.equal(corrected.profile?.trainingStatus, "active");
  assert.equal(corrected.firstContact.step, "confirmation");
});

test("FC correction: multi-field 'Na verdade estou com 75 kg e quero treinar 5 vezes.'", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  const corrected = await service.correctFirstContact(actor, { requestId: ids.multi, answer: "Na verdade estou com 75 kg e quero treinar 5 vezes." });
  assert.equal(corrected.profile?.weightKg, 75);
  assert.equal(corrected.profile?.weeklyFrequencyDaysPerWeek, 5);
  // os demais permanecem
  assert.equal(corrected.profile?.age, 34);
  assert.equal(corrected.profile?.heightCm, 180);
  assert.equal(corrected.goal?.code, "fat_loss");
});

test("FC correction: structured field preserves others (correct only weight)", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  const corrected = await service.correctFirstContact(actor, { requestId: ids.weight, weightKg: 75 });
  assert.equal(corrected.profile?.weightKg, 75);
  assert.equal(corrected.profile?.heightCm, 180);
  assert.equal(corrected.profile?.age, 34);
  assert.equal(corrected.profile?.biologicalSex, "male");
  assert.equal(corrected.goal?.code, "fat_loss");
  assert.equal(corrected.profile?.weeklyFrequencyDaysPerWeek, 4);
});

test("FC correction: food restrictions declaration updated, keeps step", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  const corrected = await service.correctFirstContact(actor, { requestId: ids.foodRestrictions, foodRestrictions: "Não como lactose." });
  assert.equal(corrected.firstContact.foodDeclaration, "Não como lactose.");
  assert.equal(corrected.firstContact.limitationDeclaration, "Sem dores declaradas.");
  assert.equal(corrected.firstContact.step, "confirmation");
});

test("FC correction: training limitations declaration updated, keeps step", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  const corrected = await service.correctFirstContact(actor, { requestId: ids.trainingPathology, trainingPathology: "Dor no ombro ao levantar." });
  assert.equal(corrected.firstContact.limitationDeclaration, "Dor no ombro ao levantar.");
  assert.equal(corrected.firstContact.foodDeclaration, "Sem restrições declaradas.");
  assert.equal(corrected.firstContact.step, "confirmation");
});

test("FC correction rejects invalid values (weight 999)", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  await assert.rejects(
    () => service.correctFirstContact(actor, { requestId: ids.invalid, answer: "Na verdade estou com 999 kg." }),
    (error: unknown) => {
      assert.ok(error instanceof V3Error);
      assert.equal(error.status, 422);
      assert.equal(error.code, "V3_FIRST_CONTACT_CORRECTION_UNRECOGNIZED");
      return true;
    },
  );
  const unchanged = await service.load(actor);
  assert.equal(unchanged.profile?.weightKg, 74);
});

test("FC correction rejects invalid structured weight via schema", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  await assert.rejects(
    () => service.correctFirstContact(actor, { requestId: ids.invalid, weightKg: 999 }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(String((error as Error).name), /ZodError/);
      return true;
    },
  );
});

test("FC correction is idempotent on requestId", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  await service.correctFirstContact(actor, { requestId: ids.repeatWeight, answer: "Na verdade estou com 75 kg." });
  const afterOnce = await service.load(actor);
  await service.correctFirstContact(actor, { requestId: ids.repeatWeight, answer: "Na verdade estou com 75 kg." });
  const afterRepeat = await service.load(actor);
  assert.equal(afterOnce.profile?.weightKg, 75);
  assert.equal(afterRepeat.profile?.weightKg, 75);
  // mesmo requestId não duplica: versão não muda entre as duas chamadas idem-potentes
  assert.equal(afterOnce.profile?.version, afterRepeat.profile?.version);
});

test("FC correction is rejected after COMPLETED (no post-FC arbitrary editing)", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  await service.confirmFirstContact(actor, { requestId: ids.confirm, confirmed: true });
  await assert.rejects(
    () => service.correctFirstContact(actor, { requestId: ids.postComplete, answer: "Na verdade estou com 76 kg." }),
    (error: unknown) => {
      assert.ok(error instanceof V3Error);
      assert.equal(error.code, "V3_FIRST_CONTACT_COMPLETED");
      return true;
    },
  );
  const finalState = await service.load(actor);
  assert.equal(finalState.profile?.weightKg, 74);
});

test("FC correction: confirmed context + workout/diet use corrected weight (75, not 74)", async () => {
  const { actor, service } = await calibratedAwaitingConfirmation();
  await service.correctFirstContact(actor, { requestId: ids.weight, answer: "Na verdade estou com 75 kg." });
  const confirmed = await service.confirmFirstContact(actor, { requestId: ids.confirm, confirmed: true });
  assert.equal(confirmed.profile?.weightKg, 75);
  // Perfil corrigido é a fonte do snapshot confirmado (versão do perfil atual)
  assert.equal(confirmed.workout?.confirmedContextVersion, confirmed.confirmedContext?.version);
  assert.equal(confirmed.diet?.confirmedContextVersion, confirmed.confirmedContext?.version);
  // O plano oficial é gerado a partir do contexto confirmado (peso 75) e não do 74
  assert.ok(confirmed.diet && confirmed.diet.totalCalories > 0);
  assert.ok(confirmed.workout && confirmed.workout.items.length > 0);
  // confirmado refere a versão do perfil AUTOINCREMENTADA pela correção (2 => 3)
  assert.equal(confirmed.profile?.weightKg, 75);
});
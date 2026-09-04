import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { GutoContextBuilderV3 } from "../src/v3/context-builder.js";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import { V3Error } from "../src/v3/errors.js";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";
import { InMemoryOperationalState } from "../src/v3/operational-state.js";
import { InMemoryRelationshipMemoryStore } from "../src/v3/relationship-memory.js";
import type { CandidateProvider } from "../src/v3/candidate-provider.js";
import type { ActorContext, CandidateOption } from "../src/v3/types.js";

const ids = {
  consent: "30000000-0000-4000-8000-000000000001",
  name: "30000000-0000-4000-8000-000000000002",
  calibration: "30000000-0000-4000-8000-000000000003",
  pact: "30000000-0000-4000-8000-000000000004",
  start: "30000000-0000-4000-8000-000000000005",
  food: "30000000-0000-4000-8000-000000000006",
  limitation: "30000000-0000-4000-8000-000000000007",
  confirm: "30000000-0000-4000-8000-000000000008",
  postWeight: "30000000-0000-4000-8000-000000000009",
  reconfirm: "30000000-0000-4000-8000-000000000010",
  reconfirmSecond: "30000000-0000-4000-8000-000000000011",
  anotherEdit: "30000000-0000-4000-8000-000000000012",
  workoutGenerate: "30000000-0000-4000-8000-000000000013",
  dietGenerate: "30000000-0000-4000-8000-000000000014",
  chatStale: "30000000-0000-4000-8000-000000000015",
  chatCurrent: "30000000-0000-4000-8000-000000000016",
};

/** Candidate provider vazio: o build do envelope só precisa que a busca de
 * candidatos resolva (vazia é suficiente). */
class NullCandidates implements CandidateProvider {
  async getCandidates(): Promise<CandidateOption[]> {
    return [];
  }
}

function chatBuilder(repository: InMemoryOfficialStateRepository): GutoContextBuilderV3 {
  return new GutoContextBuilderV3(
    repository,
    new InMemoryOperationalState(),
    new InMemoryRelationshipMemoryStore(),
    new NullCandidates(),
  );
}

async function completedUserAt74() {
  const repository = new InMemoryOfficialStateRepository();
  const actor = await repository.provisionActor({
    externalSubject: "v3-context-reconfirm",
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
  const completed = await service.confirmFirstContact(actor, { requestId: ids.confirm, confirmed: true });
  assert.equal(completed.firstContact.status, "COMPLETED");
  assert.equal(completed.confirmedContext?.version, 1);
  assert.equal(completed.workout?.confirmedContextVersion, 1);
  assert.equal(completed.diet?.confirmedContextVersion, 1);
  return { actor, repository, service };
}

async function expectV3Error(promise: Promise<unknown>, code: string): Promise<V3Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof V3Error, `esperado V3Error, recebido ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`esperado V3Error ${code}, nenhum erro lançado`);
}

test("reconfirm A: edição pós-conclusão deixa o contexto stale e o chat rejeita com V3_CONTEXT_RECONFIRMATION_REQUIRED", async () => {
  const { actor, repository, service } = await completedUserAt74();
  await service.saveMemory(actor, { requestId: ids.postWeight, weightKg: 75 } as Parameters<V3CutoverService["saveMemory"]>[1]);

  const state = await service.load(actor);
  assert.equal(state.profile?.version, 2);
  assert.equal(state.confirmedContext?.version, 1);
  assert.equal(state.confirmedContext?.profileVersion, 1);
  assert.equal(state.profile.weightKg, 75);
  assert.notEqual(state.profile.version, state.confirmedContext?.profileVersion);

  const error = await expectV3Error(
    chatBuilder(repository).build(actor, ids.chatStale, "Oi GUTO, qual é a missão de hoje?"),
    "V3_CONTEXT_RECONFIRMATION_REQUIRED",
  );
  assert.match(error.message, /Confirme novamente o contexto/);
});

test("reconfirm B: reconfirm explícito emite contexto v2 no perfil atual e regenera workout+diet atados ao v2", async () => {
  const { actor, service } = await completedUserAt74();
  await service.saveMemory(actor, { requestId: ids.postWeight, weightKg: 75 } as Parameters<V3CutoverService["saveMemory"]>[1]);

  const reconfirmed = await service.reconfirmContext(actor, ids.reconfirm);
  assert.equal(reconfirmed.profile?.weightKg, 75);
  assert.equal(reconfirmed.confirmedContext?.version, 2);
  assert.equal(reconfirmed.confirmedContext?.profileVersion, 2);
  assert.equal(reconfirmed.firstContact.status, "COMPLETED");
  assert.equal(reconfirmed.firstContact.confirmedContextVersion, 2);
  assert.equal(reconfirmed.workout?.confirmedContextVersion, 2);
  assert.equal(reconfirmed.diet?.confirmedContextVersion, 2);
  assert.ok(reconfirmed.workout);
  assert.ok(reconfirmed.diet);
});

test("reconfirm B reload: contexto v2 continua oficial após reload", async () => {
  const { actor, service } = await completedUserAt74();
  await service.saveMemory(actor, { requestId: ids.postWeight, weightKg: 75 } as Parameters<V3CutoverService["saveMemory"]>[1]);
  await service.reconfirmContext(actor, ids.reconfirm);

  const reloaded = await service.load(actor);
  assert.equal(reloaded.confirmedContext?.version, 2);
  assert.equal(reloaded.confirmedContext?.profileVersion, 2);
  assert.equal(reloaded.firstContact.confirmedContextVersion, 2);
  assert.equal(reloaded.workout?.confirmedContextVersion, 2);
  assert.equal(reloaded.diet?.confirmedContextVersion, 2);
});

test("reconfirm: declarações do contexto anterior são carregadas para o v2 (nenhuma restrição nova inventada)", async () => {
  const { actor, service } = await completedUserAt74();
  await service.saveMemory(actor, { requestId: ids.postWeight, weightKg: 75 } as Parameters<V3CutoverService["saveMemory"]>[1]);
  const before = await service.load(actor);
  await service.reconfirmContext(actor, ids.reconfirm);
  const after = await service.load(actor);
  assert.equal(after.confirmedContext?.foodDeclaration, before.confirmedContext?.foodDeclaration);
  assert.equal(after.confirmedContext?.limitationDeclaration, before.confirmedContext?.limitationDeclaration);
});

test("reconfirm C: sem ação explícita o contexto stale NÃO é confirmado (planos antigos permanecem até o usuário confirmar)", async () => {
  const { actor, repository, service } = await completedUserAt74();
  await service.saveMemory(actor, { requestId: ids.postWeight, weightKg: 75 } as Parameters<V3CutoverService["saveMemory"]>[1]);
  const state = await service.load(actor);
  assert.equal(state.confirmedContext?.version, 1);
  assert.equal(state.workout?.confirmedContextVersion, 1);
  assert.equal(state.diet?.confirmedContextVersion, 1);
  await expectV3Error(
    chatBuilder(repository).build(actor, ids.chatStale, "tudo certo"),
    "V3_CONTEXT_RECONFIRMATION_REQUIRED",
  );
});

test("reconfirm D: double confirm não duplica — segundo request (novo requestId) com contexto atual vira V3_CONTEXT_ALREADY_CURRENT", async () => {
  const { actor, service } = await completedUserAt74();
  await service.saveMemory(actor, { requestId: ids.postWeight, weightKg: 75 } as Parameters<V3CutoverService["saveMemory"]>[1]);

  const first = await service.reconfirmContext(actor, ids.reconfirm);
  assert.equal(first.confirmedContext?.version, 2);

  // Segundo CONFIRM (requestId novo) com o contexto já atual: rejeitado na
  // guarda, sem contexto v3 duplicado e sem re-gravação de planos.
  await expectV3Error(service.reconfirmContext(actor, ids.reconfirmSecond), "V3_CONTEXT_ALREADY_CURRENT");
  const after = await service.load(actor);
  assert.equal(after.confirmedContext?.version, 2);
  assert.equal(after.workout?.confirmedContextVersion, 2);
  assert.equal(after.diet?.confirmedContextVersion, 2);

  // Nova edição torna o v2 stale e um novo request cria v3 corretamente.
  await service.saveMemory(actor, { requestId: ids.anotherEdit, weightKg: 76 } as Parameters<V3CutoverService["saveMemory"]>[1]);
  const v3 = await service.reconfirmContext(actor, ids.reconfirmSecond);
  assert.equal(v3.confirmedContext?.version, 3);
  assert.equal(v3.profile?.version, 3);
  assert.equal(v3.workout?.confirmedContextVersion, 3);
  assert.equal(v3.diet?.confirmedContextVersion, 3);
});

test("reconfirm D: idempotência do repositório — mesmo requestId em submissões duplicadas devolve o mesmo contexto (sem v3)", async () => {
  const { actor, repository, service } = await completedUserAt74();
  await service.saveMemory(actor, { requestId: ids.postWeight, weightKg: 75 } as Parameters<V3CutoverService["saveMemory"]>[1]);
  const emptyDraft = { title: "draft", generatedFrom: {}, items: [] };
  const emptyDietDraft = {
    totalCalories: 1,
    proteinGrams: 1,
    carbsGrams: 1,
    fatGrams: 1,
    calculationMethod: "x",
    generatedFrom: {
      confirmedContextId: "30000000-0000-4000-8000-0000000000ee",
      confirmedContextVersion: 2,
      language: "pt-BR",
    },
    meals: [],
  };
  const input = {
    actor,
    requestId: ids.reconfirm,
    contextId: "30000000-0000-4000-8000-0000000000ee",
    contextVersion: 2,
    expectedProfileVersion: 2,
    expectedGoalVersion: 2,
    workoutDraft: emptyDraft,
    dietDraft: emptyDietDraft,
  };
  const first = await repository.reconfirmContext(input);
  const duplicate = await repository.reconfirmContext(input);
  assert.equal(first.version, 2);
  assert.equal(duplicate.version, 2);
  const state = await service.load(actor);
  assert.equal(state.confirmedContext?.version, 2);
});

test("reconfirm D: contexto atual (sem edição pendente) rejeita com V3_CONTEXT_ALREADY_CURRENT", async () => {
  const { actor, service } = await completedUserAt74();
  const error = await expectV3Error(service.reconfirmContext(actor, ids.reconfirm), "V3_CONTEXT_ALREADY_CURRENT");
  assert.match(error.message, /já está na versão oficial atual/);
});

test("reconfirm: First Contact não concluído é rejeitado", async () => {
  const repository = new InMemoryOfficialStateRepository();
  const actor = await repository.provisionActor({
    externalSubject: "v3-reconfirm-not-completed",
    role: "student",
    tenantKey: "GUTO_CORE",
    tenantName: "GUTO Core",
  });
  const service = new V3CutoverService(repository);
  await expectV3Error(service.reconfirmContext(actor, ids.reconfirm), "V3_FIRST_CONTACT_NOT_COMPLETED");
});

test("reconfirm: versões esperadas divergentes são rejeitadas (V3_CONTEXT_SOURCE_CHANGED) — nunca confirma contexto errado", async () => {
  const { actor, repository, service } = await completedUserAt74();
  await service.saveMemory(actor, { requestId: ids.postWeight, weightKg: 75 } as Parameters<V3CutoverService["saveMemory"]>[1]);
  const state = await service.load(actor);
  const emptyDraft = {
    title: "draft",
    generatedFrom: {},
    items: [],
  };
  const emptyDietDraft = {
    totalCalories: 1,
    proteinGrams: 1,
    carbsGrams: 1,
    fatGrams: 1,
    calculationMethod: "x",
    generatedFrom: {},
    meals: [],
  };
  // expectedProfileVersion divergente do perfil atual -> rejeitado na guarda,
  // antes de qualquer escrita de contexto/plano.
  await expectV3Error(
    repository.reconfirmContext({
      actor,
      requestId: ids.reconfirm,
      contextId: "30000000-0000-4000-8000-0000000000ff",
      contextVersion: 2,
      expectedProfileVersion: state.profile!.version + 99,
      expectedGoalVersion: state.goal!.version,
      workoutDraft: emptyDraft,
      dietDraft: emptyDietDraft,
    }),
    "V3_CONTEXT_SOURCE_CHANGED",
  );
  // Nada foi escrito: contexto segue v1, perfil segue v2 (stale, não confirmado errado).
  const untouched = await service.load(actor);
  assert.equal(untouched.confirmedContext?.version, 1);
  assert.equal(untouched.profile?.version, 2);
});

test("reconfirm F: chat volta a funcionar após a re-confirmação (gate de consistência passa)", async () => {
  const { actor, repository, service } = await completedUserAt74();
  await service.saveMemory(actor, { requestId: ids.postWeight, weightKg: 75 } as Parameters<V3CutoverService["saveMemory"]>[1]);
  await service.reconfirmContext(actor, ids.reconfirm);

  const { envelope, snapshot } = await chatBuilder(repository).build(actor, ids.chatCurrent, "Oi GUTO, qual é a missão de hoje?");
  assert.equal(snapshot.profile.version, snapshot.confirmedContext?.profileVersion);
  assert.equal(envelope.official.profile.version, 2);
  assert.equal(envelope.official.confirmedContext.version, 2);
});

test("reconfirm G/H: workout/generate e diet/generate funcionam no contexto v2 pós-re-confirmação", async () => {
  const { actor, service } = await completedUserAt74();
  await service.saveMemory(actor, { requestId: ids.postWeight, weightKg: 75 } as Parameters<V3CutoverService["saveMemory"]>[1]);
  await service.reconfirmContext(actor, ids.reconfirm);

  const workout = await service.generateWorkout(actor, ids.workoutGenerate);
  assert.equal(workout.confirmedContext?.version, 2);
  assert.equal(workout.workout?.confirmedContextVersion, 2);
  assert.equal(workout.workout?.status, "active");

  const diet = await service.generateDiet(actor, ids.dietGenerate);
  assert.equal(diet.confirmedContext?.version, 2);
  assert.equal(diet.diet?.confirmedContextVersion, 2);
  assert.equal(diet.diet?.status, "active");
});

test("reconfirm: /state carrega context v2 com profileVersion/goalVersion iguais ao perfil", async () => {
  const { actor, service } = await completedUserAt74();
  await service.saveMemory(actor, { requestId: ids.postWeight, weightKg: 75 } as Parameters<V3CutoverService["saveMemory"]>[1]);
  await service.reconfirmContext(actor, ids.reconfirm);
  const state = await service.load(actor);
  assert.equal(state.profile?.version, state.confirmedContext?.profileVersion);
  assert.equal(state.goal?.version, state.confirmedContext?.goalVersion);
  assert.equal(state.firstContact.confirmedContextVersion, state.confirmedContext?.version);
});

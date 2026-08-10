import "./test-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { genkit } from "genkit";
import type { DecisionModel } from "../src/v3/ai.js";
import type { CandidateProvider } from "../src/v3/candidate-provider.js";
import type { DecisionEnvelope } from "../src/v3/contracts.js";
import { isLegacyAuthorityPath } from "../src/v3/router.js";
import { GutoContextBuilderV3 } from "../src/v3/context-builder.js";
import { createGutoTurnFlow } from "../src/v3/flow.js";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";
import { applyFoodReplacement, assertNutritionPlanValid, calculateFoodReplacement, validateNutritionPlan } from "../src/v3/nutrition-engine.js";
import { InMemoryOperationalState } from "../src/v3/operational-state.js";
import { InMemoryRelationshipMemoryStore } from "../src/v3/relationship-memory.js";
import type { ActiveContext, CandidateOption, OfficialSnapshot, TurnEnvelope } from "../src/v3/types.js";
import { generateDietDraft, generateWorkoutDraft } from "../src/v3/generation-engines.js";
import { getCatalogById, getExerciseRiskTags } from "../exercise-catalog.js";
import { V3CutoverService } from "../src/v3/cutover-service.js";

const TENANT_A = "10000000-0000-4000-8000-000000000001";

function snapshot(externalSubject: string, userId: string): OfficialSnapshot {
  return {
    actor: { tenantId: TENANT_A, userId, externalSubject, role: "student" },
    memoryVersion: 1,
    profile: {
      version: 1,
      displayName: "Will",
      language: "pt-BR",
      city: "Alberton",
      country: "South Africa",
      biologicalSex: "male",
      age: 20,
      weightKg: 80,
      heightCm: 178,
      trainingStatus: "returning",
      trainingLocation: "gym",
    },
    goal: { version: 1, code: "hypertrophy" },
    preferences: { version: 1, dietStyle: "vegetarian" },
    healthConstraints: [{
      id: "health-knee",
      kind: "limitation",
      bodyRegion: "knee",
      description: "knee limitation",
      severity: "medium",
      confirmed: true,
    }],
    workout: {
      id: "20000000-0000-4000-8000-000000000001",
      version: 1,
      title: "Peito, ombro e tríceps",
      status: "active",
      items: [{
        id: "30000000-0000-4000-8000-000000000001",
        exerciseId: "supino_reto_maquina",
        name: "Supino reto máquina",
        purpose: "horizontal_push",
        muscleGroup: "peito",
        position: 0,
        sets: 3,
        reps: "8-12",
      }],
    },
    diet: {
      id: "40000000-0000-4000-8000-000000000001",
      version: 1,
      status: "active",
      totalCalories: 89,
      proteinGrams: 1.1,
      carbsGrams: 22.8,
      fatGrams: 0.3,
      meals: [{
        id: "50000000-0000-4000-8000-000000000001",
        name: "Café",
        position: 0,
        calories: 89,
        items: [{
          id: "60000000-0000-4000-8000-000000000001",
          foodId: "banana",
          name: "Banana",
          quantityGrams: 100,
          calories: 89,
          proteinGrams: 1.1,
          carbsGrams: 22.8,
          fatGrams: 0.3,
          position: 0,
        }],
      }],
    },
  };
}

class FounderCandidateProvider implements CandidateProvider {
  private readonly exercises = [
    { id: "supino_reto_halter", label: "Supino reto halter" },
    { id: "supino_inclinado_halter", label: "Supino inclinado halter" },
    { id: "flexao", label: "Flexão" },
  ];
  async getCandidates(state: OfficialSnapshot, context: ActiveContext | null, message: string): Promise<CandidateOption[]> {
    if (context?.kind === "workout") {
      const rejected = new Set(context.rejectedCandidateIds || []);
      const current = state.workout?.items.find((item) => item.id === context.itemId)?.exerciseId;
      return this.exercises
        .filter((candidate) => candidate.id !== current && !rejected.has(candidate.id))
        .map((candidate) => ({
          ...candidate,
          kind: "exercise" as const,
          purpose: "horizontal_push",
          metadata: { purpose: "horizontal_push", muscleGroup: "peito", movementPattern: "push" },
        }));
    }
    if (context?.kind === "diet" && /p[aã]o/iu.test(message)) {
      return [{
        id: "wholegrain_bread",
        label: "pão integral",
        kind: "food",
        purpose: "carb",
        metadata: {
          category: "carb",
          caloriesPer100g: 247,
          proteinPer100g: 13,
          carbsPer100g: 41,
          fatPer100g: 4.2,
        },
      }];
    }
    return [];
  }
}

class FounderDecisionModel implements DecisionModel {
  async decide(envelope: TurnEnvelope): Promise<DecisionEnvelope> {
    if (envelope.activeContext?.kind === "workout") {
      return {
        speech: "Vou verificar uma alternativa equivalente.",
        action: "swapExercise",
        reasonCode: "equipment_busy",
        selectedCandidateId: envelope.candidates[0]?.id,
      } as DecisionEnvelope;
    }
    if (envelope.activeContext?.kind === "diet" && envelope.candidates[0]) {
      return {
        speech: "Vou calcular a equivalência.",
        action: "swapFood",
        reasonCode: "food_unavailable",
        selectedCandidateId: envelope.candidates[0].id,
      };
    }
    return { speech: "Entendi.", action: "acknowledge", reasonCode: "acknowledged" };
  }
}

function harness(state: OfficialSnapshot) {
  const ai = genkit({});
  const repository = new InMemoryOfficialStateRepository();
  repository.seed(state);
  const operational = new InMemoryOperationalState();
  const relationshipMemory = new InMemoryRelationshipMemoryStore();
  const candidates = new FounderCandidateProvider();
  const contextBuilder = new GutoContextBuilderV3(repository, operational, relationshipMemory, candidates);
  const flow = createGutoTurnFlow({
    ai,
    repository,
    operational,
    relationshipMemory,
    contextBuilder,
    decisionModel: new FounderDecisionModel(),
  });
  return { repository, operational, flow, actor: state.actor };
}

test("V3 calibration is idempotent and language remains independent from South Africa location", async () => {
  const state = snapshot("founder-calibration", "10000000-0000-4000-8000-000000000010");
  const repository = new InMemoryOfficialStateRepository();
  repository.seed(state);
  const input = {
    requestId: "70000000-0000-4000-8000-000000000001",
    profile: {
      biologicalSex: "male" as const,
      age: 20,
      weightKg: 80,
      heightCm: 178,
      trainingStatus: "returning" as const,
      trainingLocation: "gym",
      city: "Alberton",
      country: "South Africa",
      language: "pt-BR" as const,
    },
    goal: { code: "hypertrophy" },
    preferences: { dietStyle: "vegetarian" },
    healthConstraints: [{ kind: "limitation" as const, bodyRegion: "knee", description: "knee limitation", severity: "medium" as const }],
  };
  const first = await repository.persistCalibration(state.actor, input);
  const second = await repository.persistCalibration(state.actor, input);
  assert.deepEqual(second, first);
  const reloaded = await repository.loadOfficialSnapshot(state.actor);
  assert.equal(reloaded.profile.language, "pt-BR");
  assert.equal(reloaded.profile.city, "Alberton");
  assert.equal(reloaded.profile.country, "South Africa");
  assert.equal(reloaded.profile.version, 2);
});

test("V3 provisions a backend-derived identity before the first idempotent calibration", async () => {
  const repository = new InMemoryOfficialStateRepository();
  const actor = await repository.provisionActor({
    externalSubject: "new-student",
    role: "student",
    tenantKey: "GUTO_CORE",
    tenantName: "GUTO_CORE",
  });
  const input = {
    requestId: "70000000-0000-4000-8000-000000000011",
    profile: {
      biologicalSex: "male" as const, age: 20, weightKg: 80, heightCm: 178,
      trainingStatus: "returning" as const, trainingLocation: "gym",
      city: "Alberton", country: "South Africa", language: "pt-BR" as const,
    },
    goal: { code: "hypertrophy" },
    preferences: { dietStyle: "vegetarian" },
    healthConstraints: [{ kind: "limitation" as const, bodyRegion: "knee", description: "knee limitation", severity: "medium" as const }],
  };
  const first = await repository.persistCalibration(actor, input);
  const second = await repository.persistCalibration(actor, input);
  assert.deepEqual(second, first);
  const reloaded = await repository.loadOfficialSnapshot(actor);
  assert.equal(reloaded.profile.city, "Alberton");
  assert.equal(reloaded.profile.language, "pt-BR");
});

test("V3 generation engines create safe catalog workouts and one-truth vegetarian diets", () => {
  const state = snapshot("founder-generation", "10000000-0000-4000-8000-000000000012");
  const workout = generateWorkoutDraft(state);
  assert.ok(workout.items.length >= 4);
  assert.equal(workout.items.find((item) => item.muscleGroup === "peito")?.exerciseId, "supino_reto_maquina");
  for (const item of workout.items) {
    const exercise = getCatalogById(item.exerciseId);
    assert.ok(exercise);
    assert.equal(getExerciseRiskTags(exercise!).includes("knee"), false);
  }

  const diet = generateDietDraft(state);
  const validation = validateNutritionPlan({
    id: "draft", version: 1, status: "draft",
    totalCalories: diet.totalCalories, proteinGrams: diet.proteinGrams,
    carbsGrams: diet.carbsGrams, fatGrams: diet.fatGrams,
    meals: diet.meals.map((meal, mealIndex) => ({ ...meal, id: `meal-${mealIndex}`, items: meal.items.map((item, itemIndex) => ({ ...item, id: `item-${mealIndex}-${itemIndex}` })) })),
  });
  assert.equal(validation.valid, true, validation.diagnostics.join(","));
  assert.equal(diet.generatedFrom.country, "South Africa");
  assert.equal(diet.generatedFrom.language, "pt-BR");
});

test("V3 workout substitutions persist, update active context, and never repeat rejected exercises", async () => {
  const state = snapshot("founder-workout", "10000000-0000-4000-8000-000000000020");
  const { repository, operational, flow, actor } = harness(state);
  await operational.compareAndSetActiveContext(actor, null, {
    id: "80000000-0000-4000-8000-000000000001",
    version: 1,
    kind: "workout",
    planId: state.workout!.id,
    planVersion: 1,
    itemId: state.workout!.items[0].id,
    itemLabel: state.workout!.items[0].name,
    rejectedCandidateIds: [],
    updatedAt: new Date().toISOString(),
  });
  const requestIds = [
    "90000000-0000-4000-8000-000000000001",
    "90000000-0000-4000-8000-000000000002",
    "90000000-0000-4000-8000-000000000003",
  ];
  const used: string[] = [];
  for (const requestId of requestIds) {
    const response = await flow({ externalSubject: actor.externalSubject, role: "student", message: "Ocupado", requestId });
    assert.equal(response.execution.status, "confirmed");
    const reloaded = await repository.loadOfficialSnapshot(actor);
    used.push(reloaded.workout!.items[0].exerciseId);
    assert.equal((await operational.getActiveContext(actor))!.planVersion, reloaded.workout!.version);
  }
  assert.equal(new Set(used).size, 3);
  assert.deepEqual(used, ["supino_reto_halter", "supino_inclinado_halter", "flexao"]);
});

test("V3 food substitution recalculates bread quantity and preserves one deterministic nutrition truth", async () => {
  const state = snapshot("founder-diet", "10000000-0000-4000-8000-000000000030");
  const { repository, operational, flow, actor } = harness(state);
  await operational.compareAndSetActiveContext(actor, null, {
    id: "80000000-0000-4000-8000-000000000002",
    version: 1,
    kind: "diet",
    planId: state.diet!.id,
    planVersion: 1,
    itemId: state.diet!.meals[0].items[0].id,
    itemLabel: "Banana",
    rejectedCandidateIds: [],
    updatedAt: new Date().toISOString(),
  });
  const response = await flow({
    externalSubject: actor.externalSubject,
    role: "student",
    message: "Não tenho banana. Tenho pão.",
    requestId: "90000000-0000-4000-8000-000000000004",
  });
  assert.equal(response.execution.status, "confirmed");
  const reloaded = await repository.loadOfficialSnapshot(actor);
  const item = reloaded.diet!.meals[0].items[0];
  assert.equal(item.foodId, "wholegrain_bread");
  assert.equal(item.quantityGrams, 36);
  assert.equal(reloaded.diet!.meals[0].calories, reloaded.diet!.totalCalories);
  assert.equal(validateNutritionPlan(reloaded.diet!).valid, true);
});

test("V3 nutrition engine rejects a published plan with divergent meal totals", () => {
  const plan = snapshot("nutrition", "10000000-0000-4000-8000-000000000040").diet!;
  const candidate: CandidateOption = {
    id: "wholegrain_bread",
    label: "pão integral",
    kind: "food",
    purpose: "carb",
    metadata: { caloriesPer100g: 247, proteinPer100g: 13, carbsPer100g: 41, fatPer100g: 4.2 },
  };
  const replacement = calculateFoodReplacement(plan.meals[0].items[0], candidate);
  const valid = applyFoodReplacement(plan, plan.meals[0].items[0].id, replacement);
  assertNutritionPlanValid(valid);
  const macroCalories = Number((replacement.proteinGrams * 4 + replacement.carbsGrams * 4 + replacement.fatGrams * 9).toFixed(2));
  assert.equal(replacement.calories, macroCalories);
  const invalid = structuredClone(valid);
  invalid.meals[0].calories += 10;
  assert.throws(() => assertNutritionPlanValid(invalid), /validação determinística/);
});

test("V3 operational state and official snapshots are isolated between users", async () => {
  const userA = snapshot("user-a", "10000000-0000-4000-8000-000000000050");
  const userB = snapshot("user-b", "10000000-0000-4000-8000-000000000051");
  userB.profile.displayName = "Other";
  const repository = new InMemoryOfficialStateRepository();
  repository.seed(userA);
  repository.seed(userB);
  const operational = new InMemoryOperationalState();
  await operational.compareAndSetActiveContext(userA.actor, null, {
    id: "80000000-0000-4000-8000-000000000003",
    version: 1,
    kind: "workout",
    planId: userA.workout!.id,
    planVersion: 1,
    itemId: userA.workout!.items[0].id,
    itemLabel: "Supino reto máquina",
    updatedAt: new Date().toISOString(),
  });
  assert.equal(await operational.getActiveContext(userB.actor), null);
  assert.equal((await repository.loadOfficialSnapshot(userA.actor)).profile.displayName, "Will");
  assert.equal((await repository.loadOfficialSnapshot(userB.actor)).profile.displayName, "Other");
});

test("V3 idempotency releases a failed request for a safe retry and rejects stale ownership", async () => {
  const operational = new InMemoryOperationalState();
  const actor = snapshot("idem-user", "10000000-0000-4000-8000-000000000099").actor;
  const requestId = "90000000-0000-4000-8000-000000000099";
  const first = await operational.beginRequest(actor, requestId);
  assert.equal(first.state, "started");
  assert.ok(first.requestToken);
  await operational.abortRequest(actor, requestId, first.requestToken!);
  const retry = await operational.beginRequest(actor, requestId);
  assert.equal(retry.state, "started");
  assert.notEqual(retry.requestToken, first.requestToken);
  await assert.rejects(
    operational.completeRequest(actor, requestId, first.requestToken!, {
      speech: "stale", action: "none", requestId, traceId: "trace", brainVersion: "guto-cerebro-v3",
      execution: { status: "not_executed", code: "STALE", message: "stale" },
      versions: { memoryVersion: 1, activeContextVersion: null, planVersion: null },
    }),
    /idempotência/iu,
  );
});

test("V3 new-user cutover persists consent, calibration, pact, workout, diet and XP in one authority", async () => {
  const repository = new InMemoryOfficialStateRepository();
  const service = new V3CutoverService(repository);
  const actor = await repository.provisionActor({
    externalSubject: "cutover-new-user",
    role: "student",
    tenantKey: "GUTO_CORE",
    tenantName: "GUTO_CORE",
  });
  await service.acceptConsent(actor, "91000000-0000-4000-8000-000000000001");
  await service.saveMemory(actor, {
    requestId: "91000000-0000-4000-8000-000000000002",
    name: "Will",
    confirmedName: true,
    language: "pt-BR",
  });
  await service.saveMemory(actor, {
    requestId: "91000000-0000-4000-8000-000000000003",
    language: "pt-BR",
    biologicalSex: "male",
    userAge: 22,
    weightKg: 80,
    heightCm: 178,
    trainingLevel: "returning",
    trainingGoal: "muscle_gain",
    preferredTrainingLocation: "gym",
    trainingPathology: "limitação lombar",
    country: "South Africa",
    city: "Alberton",
    foodRestrictions: "vegetariana",
  });
  const pactRequest = "91000000-0000-4000-8000-000000000004";
  const first = await service.saveMemory(actor, {
    requestId: pactRequest,
    name: "Will",
    language: "pt-BR",
    xpEvent: "grant_initial_xp",
  });
  const repeated = await service.saveMemory(actor, {
    requestId: pactRequest,
    name: "Will",
    language: "pt-BR",
    xpEvent: "grant_initial_xp",
  });
  assert.ok(first.journey.consentAcceptedAt);
  assert.ok(first.journey.sovereignNameConfirmedAt);
  assert.ok(first.journey.pactAcceptedAt);
  assert.ok(first.workout?.items.length);
  assert.ok(first.workout?.items.every((item) => item.videoUrl?.startsWith("/exercise/visuals/")));
  assert.ok(first.diet?.meals.length);
  assert.equal(first.progression.totalXp, 100);
  assert.equal(repeated.progression.totalXp, 100);
  assert.equal(repeated.progression.xpEvents.filter((event) => event.reasonCode === "grant_initial_xp").length, 1);
});

test("V3 simultaneous users keep progression, plans and reload state isolated", async () => {
  const repository = new InMemoryOfficialStateRepository();
  const service = new V3CutoverService(repository);
  const actors = await Promise.all(["sim-a", "sim-b"].map((externalSubject) => repository.provisionActor({
    externalSubject,
    role: "student",
    tenantKey: "GUTO_CORE",
    tenantName: "GUTO_CORE",
  })));
  for (const [index, actor] of actors.entries()) {
    await service.acceptConsent(actor, `92000000-0000-4000-8000-00000000000${index + 1}`);
    await repository.persistCalibration(actor, {
      requestId: `92000000-0000-4000-8000-00000000001${index + 1}`,
      profile: {
        biologicalSex: "male", age: 22, weightKg: 80, heightCm: 178,
        trainingStatus: "returning", trainingLocation: "gym", city: "Alberton",
        country: "South Africa", language: "pt-BR",
      },
      goal: { code: "muscle_gain" },
      preferences: { dietStyle: "vegetarian" },
      healthConstraints: [],
    });
  }
  await Promise.all(actors.map((actor, index) => service.saveMemory(actor, {
    requestId: `92000000-0000-4000-8000-00000000002${index + 1}`,
    name: index === 0 ? "Alpha" : "Beta",
    confirmedName: true,
    xpEvent: "grant_initial_xp",
  })));
  await service.saveMemory(actors[0]!, {
    requestId: "92000000-0000-4000-8000-000000000031",
    xpEvent: "complete_daily_mission",
  });
  const [a, b] = await Promise.all(actors.map((actor) => service.load(actor)));
  assert.equal(a.displayName, "Alpha");
  assert.equal(b.displayName, "Beta");
  assert.equal(a.progression.totalXp, 200);
  assert.equal(b.progression.totalXp, 100);
  assert.notEqual(a.workout?.id, b.workout?.id);
  assert.notEqual(a.diet?.id, b.diet?.id);
});

test("V3 cutover blocks every migrated V2 authority path while preserving non-authoritative routes", () => {
  for (const path of [
    "/guto",
    "/guto/memory",
    "/guto/consent/accept",
    "/guto/validate-workout",
    "/guto/diet/generate",
    "/guto/active-context",
    "/guto/events",
    "/guto/validate-name",
    "/guto/arena/weekly",
    "/guto/proactivity/memories",
    "/guto-audio",
  ]) assert.equal(isLegacyAuthorityPath(path), true, path);

  for (const path of [
    "/guto/v3",
    "/guto/v3/state",
    "/guto/account",
    "/guto/push/subscribe",
    "/guto/billing/checkout",
  ]) assert.equal(isLegacyAuthorityPath(path), false, path);
});

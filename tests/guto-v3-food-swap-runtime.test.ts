import "./test-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { genkit } from "genkit";
import type { DecisionModel } from "../src/v3/ai.js";
import type { CandidateProvider } from "../src/v3/candidate-provider.js";
import type { DecisionEnvelope } from "../src/v3/contracts.js";
import { GutoContextBuilderV3 } from "../src/v3/context-builder.js";
import { createGutoTurnFlow } from "../src/v3/flow.js";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";
import { InMemoryOperationalState } from "../src/v3/operational-state.js";
import { InMemoryRelationshipMemoryStore } from "../src/v3/relationship-memory.js";
import { generateDietDraft } from "../src/v3/generation-engines.js";
import { selectCandidateFoods } from "../src/v3/nutrition/catalog.js";
import { filterFoodsByDeclaration } from "../src/v3/nutrition/restrictions.js";
import { validateNutritionPlan } from "../src/v3/nutrition-engine.js";
import type { ActiveContext, CandidateOption, OfficialSnapshot, TurnEnvelope } from "../src/v3/types.js";

const TENANT_A = "10000000-0000-4000-8000-000000000001";

function baseState(externalSubject: string, userId: string, declaration: string): OfficialSnapshot {
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
      weeklyFrequencyDaysPerWeek: 4,
    },
    goal: { version: 1, code: "hypertrophy" },
    preferences: { version: 1, dietStyle: "vegetarian" },
    healthConstraints: [],
    firstContact: {
      status: "COMPLETED",
      step: "completed",
      foodDeclaration: declaration,
      limitationDeclaration: "",
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      currentPrompt: null,
      summary: "Contexto confirmado.",
      confirmedContextVersion: 1,
    },
    confirmedContext: {
      id: "70000000-0000-4000-8000-000000000001",
      version: 1,
      confirmedAt: new Date(0).toISOString(),
      foodDeclaration: declaration,
      limitationDeclaration: "",
      profileVersion: 1,
      goalVersion: 1,
      weeklyFrequencyDaysPerWeek: 4,
      trainingLocation: "gym",
    },
    workout: null,
    diet: null,
  };
}

// Deterministic same-role candidate provider: proposes the first eligible food
// of the current item's culinary role, never the current food itself.
class SameRoleFoodProvider implements CandidateProvider {
  async getCandidates(state: OfficialSnapshot, context: ActiveContext | null): Promise<CandidateOption[]> {
    if (context?.kind !== "diet" || !state.diet) return [];
    const current = state.diet.meals.flatMap((meal) => meal.items).find((item) => item.id === context.itemId);
    if (!current) return [];
    const currentFood = selectCandidateFoods().find((food) => food.id === current.foodId);
    if (!currentFood) return [];
    const declaration = [state.confirmedContext?.foodDeclaration || "", ...(state.currentFacts || []).map((fact) => String(fact.value.declaration || fact.canonicalValue))].join(" ");
    const candidate = filterFoodsByDeclaration(selectCandidateFoods(), declaration)
      .find((food) => food.role === currentFood.role && food.id !== current.foodId);
    if (!candidate) return [];
    return [{
      id: candidate.id,
      label: candidate.canonicalName,
      kind: "food",
      purpose: candidate.role,
      metadata: { category: candidate.role, caloriesPer100g: candidate.nutritionPer100g.calories, proteinPer100g: candidate.nutritionPer100g.protein, carbsPer100g: candidate.nutritionPer100g.carbs, fatPer100g: candidate.nutritionPer100g.fat },
    }];
  }
}

class SwapDecisionModel implements DecisionModel {
  async decide(envelope: TurnEnvelope): Promise<DecisionEnvelope> {
    if (envelope.activeContext?.kind === "diet" && envelope.candidates[0]) {
      return {
        speech: "Vou reotimizar o plano.",
        action: "swapFood",
        reasonCode: "food_unavailable",
        selectedCandidateId: envelope.candidates[0].id,
      } as DecisionEnvelope;
    }
    return { speech: "Entendi.", action: "acknowledge", reasonCode: "acknowledged" } as DecisionEnvelope;
  }
}

async function harness(state: OfficialSnapshot) {
  const ai = genkit({});
  const repository = new InMemoryOfficialStateRepository();
  // The test must start from a state production could really create: generate
  // the official diet, persist it, then seed the repository with it.
  const draft = await generateDietDraft(state);
  state.diet = {
    id: "40000000-0000-4000-8000-000000000090",
    version: 1,
    status: "active",
    confirmedContextVersion: state.confirmedContext!.version,
    totalCalories: draft.totalCalories,
    proteinGrams: draft.proteinGrams,
    carbsGrams: draft.carbsGrams,
    fatGrams: draft.fatGrams,
    meals: draft.meals.map((meal, mealIndex) => ({
      id: `meal-${mealIndex}`,
      name: meal.name,
      position: meal.position,
      calories: meal.calories,
      items: meal.items.map((item, itemIndex) => ({ ...item, id: `item-${itemIndex}` })),
    })),
  };
  repository.seed(state);
  const operational = new InMemoryOperationalState();
  const relationshipMemory = new InMemoryRelationshipMemoryStore();
  const candidates = new SameRoleFoodProvider();
  const contextBuilder = new GutoContextBuilderV3(repository, operational, relationshipMemory, candidates);
  const flow = createGutoTurnFlow({
    ai,
    repository,
    operational,
    relationshipMemory,
    contextBuilder,
    decisionModel: new SwapDecisionModel(),
  });
  return { repository, operational, flow, actor: state.actor };
}

function dietContext(state: OfficialSnapshot, itemId: string, version = 1): ActiveContext {
  return {
    id: "80000000-0000-4000-8000-000000000090",
    version,
    kind: "diet",
    planId: state.diet!.id,
    planVersion: 1,
    itemId,
    itemLabel: "Banana",
    rejectedCandidateIds: [],
    updatedAt: new Date().toISOString(),
  };
}

test("GATE1J E2E: official diet -> persist -> same-role swap -> LP reoptimize -> validate -> full mutation -> persist -> read back equals validated plan", async () => {
  const state = baseState("e2e-swap", "10000000-0000-4000-8000-000000000091", "Vegetariana.");
  const { repository, operational, flow, actor } = await harness(state);
  const before = await repository.loadOfficialSnapshot(actor);
  assert.ok(before.diet, "official diet must be generated and persisted");
  const carbs = before.diet!.meals.flatMap((meal) => meal.items).filter((item) => {
    const food = selectCandidateFoods().find((f) => f.id === item.foodId);
    return food?.role === "carb_primary";
  });
  assert.ok(carbs.length >= 2, "plan must contain at least two carb_primary items to swap");
  const removed = carbs[0];
  await operational.compareAndSetActiveContext(actor, null, dietContext(before, removed.id));
  const beforeVersion = before.diet!.version;

  const response = await flow({
    externalSubject: actor.externalSubject,
    role: "student",
    message: `Não tenho ${removed.name}.`,
    requestId: "90000000-0000-4000-8000-000000000091",
  });
  assert.equal(response.execution.status, "confirmed");
  assert.equal(response.execution.code, "FOOD_SWAPPED");

  const after = await repository.loadOfficialSnapshot(actor);
  const afterItems = after.diet!.meals.flatMap((meal) => meal.items);
  assert.equal(after.diet!.version, beforeVersion + 1, "version must bump N -> N+1");
  assert.equal(afterItems.some((item) => item.foodId === removed.foodId), false, "unavailable food must be gone");
  const candidateFood = filterFoodsByDeclaration(selectCandidateFoods(), state.confirmedContext!.foodDeclaration)
    .find((food) => food.role === selectCandidateFoods().find((f) => f.id === removed.foodId)!.role && food.id !== removed.foodId);
  assert.ok(candidateFood, "same-role candidate must exist");
  const candidateItem = afterItems.find((item) => item.foodId === candidateFood.id);
  assert.ok(candidateItem, "candidate must be present in the persisted plan");
  // Role preserved: candidate belongs to the same culinary role as the removed food.
  const removedRole = selectCandidateFoods().find((f) => f.id === removed.foodId)!.role;
  const candidateRole = selectCandidateFoods().find((f) => f.id === candidateItem.foodId)!.role;
  assert.equal(candidateRole, removedRole, "culinary role must be preserved");

  // VALIDATED == PERSISTED: the persisted plan passes the deterministic validator,
  // its totals are internally consistent, and meal totals equal plan totals.
  const validation = validateNutritionPlan(after.diet!);
  assert.equal(validation.valid, true, `persisted plan must validate: ${validation.diagnostics.join("; ")}`);
  assert.equal(after.diet!.meals[0].calories, after.diet!.totalCalories);
  const itemCalories = Number(afterItems.reduce((sum, item) => sum + item.calories, 0).toFixed(2));
  assert.equal(itemCalories, after.diet!.totalCalories, "persisted item calories must equal persisted totals");
});

test("GATE1J MULTI_ITEM: one swap can move the replacement AND another food; both persisted on read-back", async () => {
  const state = baseState("e2e-multi", "10000000-0000-4000-8000-000000000092", "Vegetariana.");
  const { repository, operational, flow, actor } = await harness(state);
  const before = await repository.loadOfficialSnapshot(actor);
  const beforeItems = before.diet!.meals.flatMap((meal) => meal.items);
  // Pick the largest carb item (rice in the fixture profile) to force the LP
  // to compensate elsewhere when it is removed.
  const target = beforeItems
    .map((item) => ({ item, food: selectCandidateFoods().find((f) => f.id === item.foodId)! }))
    .filter(({ food }) => food.role === "carb_primary")
    .sort((a, b) => b.item.quantityGrams - a.item.quantityGrams)[0];
  assert.ok(target, "plan must contain a carb_primary item");
  await operational.compareAndSetActiveContext(actor, null, dietContext(before, target.item.id));
  const originalGrams = new Map(beforeItems.map((item) => [item.foodId, item.quantityGrams]));

  const response = await flow({
    externalSubject: actor.externalSubject,
    role: "student",
    message: `Não tenho ${target.item.name}.`,
    requestId: "90000000-0000-4000-8000-000000000092",
  });
  assert.equal(response.execution.status, "confirmed");

  const after = await repository.loadOfficialSnapshot(actor);
  const afterItems = after.diet!.meals.flatMap((meal) => meal.items);
  assert.equal(afterItems.some((item) => item.foodId === target.item.foodId), false, "removed food must be gone");
  const movedOthers = afterItems.filter((item) => item.foodId !== target.item.foodId && Math.abs((originalGrams.get(item.foodId) || 0) - item.quantityGrams) > 0.01);
  assert.ok(movedOthers.length >= 1, `at least one OTHER food must change quantity; moved: ${movedOthers.map((i) => `${i.foodId}:${i.quantityGrams}g`).join(", ")}`);
  for (const item of movedOthers) {
    const persisted = afterItems.find((candidate) => candidate.foodId === item.foodId);
    assert.equal(persisted?.quantityGrams, item.quantityGrams, "quantity change must be persisted on read-back");
  }
  const validation = validateNutritionPlan(after.diet!);
  assert.equal(validation.valid, true, validation.diagnostics.join("; "));
});

test("GATE1J INFEASIBLE: saturated restricted plan keeps old plan, version and totals unchanged", async () => {
  const declaration = "Não como carne, ovo nem glúten.";
  const state = baseState("e2e-infeasible", "10000000-0000-4000-8000-000000000093", declaration);
  const { repository, operational, flow, actor } = await harness(state);
  const before = await repository.loadOfficialSnapshot(actor);
  const beforeItems = before.diet!.meals.flatMap((meal) => meal.items);
  const carbItems = beforeItems.map((item) => ({ item, food: selectCandidateFoods().find((f) => f.id === item.foodId)! })).filter(({ food }) => food.role === "carb_primary");
  assert.ok(carbItems.length >= 1, "restricted plan must contain a carb item");
  const removed = carbItems[0];
  await operational.compareAndSetActiveContext(actor, null, dietContext(before, removed.item.id));
  const beforePlan = structuredClone(before.diet!);

  await assert.rejects(
    flow({
      externalSubject: actor.externalSubject,
      role: "student",
      message: `Não tenho ${removed.item.name}.`,
      requestId: "90000000-0000-4000-8000-000000000093",
    }),
    (error: unknown) => (error as { code?: string }).code === "NUTRITION_PLAN_INFEASIBLE",
  );

  const after = await repository.loadOfficialSnapshot(actor);
  assert.equal(after.diet!.version, beforePlan.version, "version must be preserved on infeasible swap");
  assert.equal(after.diet!.totalCalories, beforePlan.totalCalories, "totals must be preserved");
  assert.equal(after.diet!.proteinGrams, beforePlan.proteinGrams);
  assert.equal(after.diet!.meals[0].items.length, beforePlan.meals[0].items.length, "no partial mutation may be applied");
  const afterItems = after.diet!.meals.flatMap((meal) => meal.items);
  for (const item of afterItems) {
    const original = beforePlan.meals.flatMap((meal) => meal.items).find((candidate) => candidate.id === item.id);
    assert.ok(original, "no item may be added");
    assert.equal(item.foodId, original.foodId);
    assert.equal(item.quantityGrams, original.quantityGrams);
  }
});

test("GATE1J IDEMPOTENCY: repeating the same requestId returns the same response and never mutates again", async () => {
  const state = baseState("e2e-idem", "10000000-0000-4000-8000-000000000094", "Vegetariana.");
  const { repository, operational, flow, actor } = await harness(state);
  const before = await repository.loadOfficialSnapshot(actor);
  const firstItem = before.diet!.meals.flatMap((meal) => meal.items)[0];
  await operational.compareAndSetActiveContext(actor, null, dietContext(before, firstItem.id));
  const requestId = "90000000-0000-4000-8000-000000000094";

  const first = await flow({ externalSubject: actor.externalSubject, role: "student", message: `Não tenho ${firstItem.name}.`, requestId });
  assert.equal(first.execution.status, "confirmed");
  const versionAfterFirst = (await repository.loadOfficialSnapshot(actor)).diet!.version;

  const second = await flow({ externalSubject: actor.externalSubject, role: "student", message: `Não tenho ${firstItem.name}.`, requestId });
  assert.equal(second.execution.code, first.execution.code, "same response for the same requestId");
  const versionAfterSecond = (await repository.loadOfficialSnapshot(actor)).diet!.version;
  assert.equal(versionAfterSecond, versionAfterFirst, "repeating the requestId must not bump the plan version");
});

test("GATE1J FOOD SWAPS: potato, rice, banana and chicken each swap through the shared reoptimizer and validate", async () => {
  const state = baseState("e2e-named-swaps", "10000000-0000-4000-8000-000000000097", "Vegetariana.");
  const { repository, operational, flow, actor } = await harness(state);
  const cases: Array<{ foodId: string; role: string }> = [
    { foodId: "potato", role: "carb_primary" },
    { foodId: "rice", role: "carb_primary" },
    { foodId: "banana", role: "fruit" },
    { foodId: "chicken", role: "protein_primary" },
  ];
  for (const [index, testCase] of cases.entries()) {
    const reloaded = await repository.loadOfficialSnapshot(actor);
    const item = reloaded.diet!.meals.flatMap((meal) => meal.items).find((candidate) => candidate.foodId === testCase.foodId);
    assert.ok(item, `${testCase.foodId} must be present in the official diet`);
    const currentContext = await operational.getActiveContext(actor);
    const expectedVersion = currentContext?.version ?? null;
    const nextVersion = (currentContext?.version ?? 0) + 1;
    await operational.compareAndSetActiveContext(actor, expectedVersion, {
      ...dietContext(reloaded, item.id, nextVersion),
      planVersion: reloaded.diet!.version,
      itemLabel: item.name,
    });
    const response = await flow({
      externalSubject: actor.externalSubject,
      role: "student",
      message: `Não tenho ${item.name}.`,
      requestId: `90000000-0000-4000-8000-0000000000${90 + index}`,
    });
    assert.equal(response.execution.status, "confirmed", `${testCase.foodId} swap must be confirmed (${response.execution.code}: ${response.execution.message})`);
    const after = await repository.loadOfficialSnapshot(actor);
    const afterItems = after.diet!.meals.flatMap((meal) => meal.items);
    assert.equal(afterItems.some((entry) => entry.foodId === testCase.foodId), false, `${testCase.foodId} must be removed`);
    const candidateRole = selectCandidateFoods().find((food) => food.id === testCase.foodId)!.role;
    const replacement = afterItems.find((entry) => selectCandidateFoods().find((food) => food.id === entry.foodId)?.role === candidateRole && entry.foodId !== testCase.foodId);
    assert.ok(replacement, `${testCase.foodId} must be replaced by a same-role candidate`);
    assert.equal(validateNutritionPlan(after.diet!).valid, true);
  }
});

test("GATE1J RESTRICTED PROFILE: heavy lactose+gluten+egg+meat declaration excludes named foods and classifies generation objectively", async () => {
  const declaration = "Não como carne, ovo nem glúten e tenho intolerância à lactose.";
  const state = baseState("e2e-restricted", "10000000-0000-4000-8000-000000000096", declaration);
  // Named/macro exclusions must be honored: oats, bread, pasta, egg, chicken, dairy.
  const eligible = filterFoodsByDeclaration(selectCandidateFoods(), declaration);
  const eligibleIds = new Set(eligible.map((food) => food.id));
  for (const id of ["oats", "wholegrain_bread", "pasta", "eggs", "chicken", "yogurt"]) {
    assert.equal(eligibleIds.has(id), false, `${id} must be excluded`);
  }
  for (const id of ["rice", "potato", "tuna", "beans", "lentils", "banana", "apple", "orange", "olive_oil"]) {
    assert.equal(eligibleIds.has(id), true, `${id} must remain eligible`);
  }
  // Objective cause: even at max grams, the remaining pool cannot reach the
  // hypertrophy calorie/protein envelope -> generation must fail fast with the
  // canonical infeasible error (no relaxed restrictions, no silent fallback).
  const ceiling = eligible.reduce((sum, food) => sum + (food.nutritionPer100g.calories / 100) * food.maxGrams, 0);
  await assert.rejects(
    generateDietDraft(state),
    (error: unknown) => (error as { code?: string }).code === "NUTRITION_PLAN_INFEASIBLE",
  );
  assert.ok(ceiling > 0, "ceiling computed");
});

test("GATE1J STALE VERSION: a second swap started from an old version is rejected without partial effect", async () => {
  const state = baseState("e2e-stale", "10000000-0000-4000-8000-000000000095", "Vegetariana.");
  const { repository, flow, actor } = await harness(state);
  const before = await repository.loadOfficialSnapshot(actor);
  const items = before.diet!.meals.flatMap((meal) => meal.items);
  assert.ok(items.length >= 2, "plan needs at least two items for a stale-version second swap");
  const candidateFood = filterFoodsByDeclaration(selectCandidateFoods(), state.confirmedContext!.foodDeclaration)
    .find((food) => food.role === selectCandidateFoods().find((f) => f.id === items[0].foodId)!.role && food.id !== items[0].foodId);
  assert.ok(candidateFood, "same-role candidate needed");
  const mutation = {
    planId: before.diet!.id,
    expectedPlanVersion: before.diet!.version,
    contextVersion: before.confirmedContext!.version,
    items: items.map((item, position) => ({
      id: item.id,
      foodId: item.foodId,
      name: item.name,
      quantityGrams: item.quantityGrams,
      calories: item.calories,
      proteinGrams: item.proteinGrams,
      carbsGrams: item.carbsGrams,
      fatGrams: item.fatGrams,
      position,
    })),
    totals: { calories: before.diet!.totalCalories, proteinGrams: before.diet!.proteinGrams, carbsGrams: before.diet!.carbsGrams, fatGrams: before.diet!.fatGrams },
    replacement: { previousFoodId: items[0].foodId, candidateId: candidateFood.id },
  };
  // First swap applies on version N -> N+1.
  const first = await repository.swapFood({ actor, requestId: "90000000-0000-4000-8000-000000000095", plan: before.diet!, mutation });
  assert.equal(first.planVersion, before.diet!.version + 1);
  // Second swap still claims expectedPlanVersion N -> must be rejected as stale.
  const stalePlan = structuredClone(before.diet!);
  await assert.rejects(
    repository.swapFood({ actor, requestId: "90000000-0000-4000-8000-000000000096", plan: stalePlan, mutation }),
    /STALE_DIET_VERSION|desatualizada/iu,
  );
  const after = await repository.loadOfficialSnapshot(actor);
  assert.equal(after.diet!.version, before.diet!.version + 1, "stale attempt must not change the version");
});

import type { DecisionEnvelope } from "./contracts.js";
import { V3Error } from "./errors.js";
import { applyFoodReplacement, assertNutritionPlanValid, calculateFoodReplacement } from "./nutrition-engine.js";
import type { OperationalStateStore } from "./operational-state.js";
import type { RelationshipMemoryStore } from "./relationship-memory.js";
import type { OfficialStateRepository } from "./repository.js";
import type {
  ActiveContext,
  ExecutorResult,
  OfficialSnapshot,
  TurnEnvelope,
} from "./types.js";
import { withV3Span } from "./observability/tracing.js";
import { generateDietDraft, generateWorkoutDraft } from "./generation-engines.js";

export class ProfileServiceV3 {
  constructor(private readonly repository: OfficialStateRepository) {}
  getOfficialProfile(snapshot: OfficialSnapshot) { return snapshot.profile; }
  persistCalibration(...args: Parameters<OfficialStateRepository["persistCalibration"]>) {
    return this.repository.persistCalibration(...args);
  }
}

export class WorkoutServiceV3 {
  constructor(private readonly repository: OfficialStateRepository) {}
  getCurrentWorkout(snapshot: OfficialSnapshot) { return snapshot.workout; }
  swapExercise(input: Parameters<OfficialStateRepository["swapExercise"]>[0]) { return this.repository.swapExercise(input); }
  generate(input: Parameters<OfficialStateRepository["replaceWorkoutPlan"]>[0]) { return this.repository.replaceWorkoutPlan(input); }
}

export class DietServiceV3 {
  constructor(private readonly repository: OfficialStateRepository) {}
  getCurrentDiet(snapshot: OfficialSnapshot) { return snapshot.diet; }
  swapFood(input: Parameters<OfficialStateRepository["swapFood"]>[0]) { return this.repository.swapFood(input); }
  generate(input: Parameters<OfficialStateRepository["replaceDietPlan"]>[0]) { return this.repository.replaceDietPlan(input); }
}

export class ActiveContextServiceV3 {
  constructor(private readonly operational: OperationalStateStore) {}
  get(actor: OfficialSnapshot["actor"]) { return this.operational.getActiveContext(actor); }
  update(actor: OfficialSnapshot["actor"], expectedVersion: number | null, next: ActiveContext) {
    return this.operational.compareAndSetActiveContext(actor, expectedVersion, next);
  }
}

export class XpServiceV3 {
  // XP mutations are intentionally absent from the turn decision surface until an explicit executor contract exists.
  assertNoModelOwnedXp(): true { return true; }
}

export class RelationshipMemoryServiceV3 {
  constructor(private readonly memory: RelationshipMemoryStore) {}
  submit(...args: Parameters<RelationshipMemoryStore["submit"]>) { return this.memory.submit(...args); }
}

export class DeterministicExecutorV3 {
  private readonly workout: WorkoutServiceV3;
  private readonly diet: DietServiceV3;
  private readonly activeContext: ActiveContextServiceV3;

  constructor(
    repository: OfficialStateRepository,
    operational: OperationalStateStore,
  ) {
    this.workout = new WorkoutServiceV3(repository);
    this.diet = new DietServiceV3(repository);
    this.activeContext = new ActiveContextServiceV3(operational);
  }

  async execute(decision: DecisionEnvelope, envelope: TurnEnvelope, snapshot: OfficialSnapshot): Promise<ExecutorResult> {
    if (["none", "acknowledge", "askClarification", "callSafetyPath", "startMinimumMission"].includes(decision.action)) {
      return { status: "not_executed", code: "NO_MUTATION_REQUIRED", message: "Nenhuma mutação oficial foi executada." };
    }
    if (decision.action === "swapExercise") return this.swapExercise(decision, envelope, snapshot);
    if (decision.action === "swapFood") return this.swapFood(decision, envelope, snapshot);
    if (decision.action === "generateWorkout") return this.generateWorkout(envelope, snapshot);
    if (decision.action === "generateDiet") return this.generateDiet(envelope, snapshot);
    return {
      status: "rejected",
      code: "EXECUTOR_NOT_AVAILABLE",
      message: `O executor ${decision.action} ainda não está habilitado na V3.`,
    };
  }

  private async generateWorkout(envelope: TurnEnvelope, snapshot: OfficialSnapshot): Promise<ExecutorResult> {
    const draft = generateWorkoutDraft(snapshot);
    const plan = await withV3Span("POSTGRES_TRANSACTION", { "guto.operation": "generate_workout" }, () =>
      this.workout.generate({ actor: snapshot.actor, requestId: envelope.requestId, draft }));
    return {
      status: "confirmed",
      code: "WORKOUT_GENERATED",
      message: "Treino oficial gerado e confirmado.",
      planVersion: plan.version,
    };
  }

  private async generateDiet(envelope: TurnEnvelope, snapshot: OfficialSnapshot): Promise<ExecutorResult> {
    const draft = generateDietDraft(snapshot);
    const validationPlan = {
      id: "draft",
      version: 1,
      status: "draft" as const,
      totalCalories: draft.totalCalories,
      proteinGrams: draft.proteinGrams,
      carbsGrams: draft.carbsGrams,
      fatGrams: draft.fatGrams,
      meals: draft.meals.map((meal, mealIndex) => ({
        ...meal,
        id: `meal-${mealIndex}`,
        items: meal.items.map((item, itemIndex) => ({ ...item, id: `item-${mealIndex}-${itemIndex}` })),
      })),
    };
    assertNutritionPlanValid(validationPlan);
    const plan = await withV3Span("POSTGRES_TRANSACTION", { "guto.operation": "generate_diet" }, () =>
      this.diet.generate({ actor: snapshot.actor, requestId: envelope.requestId, draft }));
    return {
      status: "confirmed",
      code: "DIET_GENERATED",
      message: "Dieta oficial gerada, validada e confirmada.",
      planVersion: plan.version,
    };
  }

  private async swapExercise(decision: DecisionEnvelope, envelope: TurnEnvelope, snapshot: OfficialSnapshot): Promise<ExecutorResult> {
    const context = envelope.activeContext;
    const plan = snapshot.workout;
    const candidate = envelope.candidates.find((item) => item.id === decision.selectedCandidateId);
    if (!context || !plan || !candidate) throw new V3Error("V3_EXECUTOR_INPUT_MISSING", "Contexto de treino incompleto.", 409);
    const current = plan.items.find((item) => item.id === context.itemId);
    if (!current) throw new V3Error("V3_WORKOUT_ITEM_NOT_FOUND", "Exercício oficial não encontrado.", 409);
    const result = await withV3Span("POSTGRES_TRANSACTION", { "guto.operation": "swap_exercise" }, () => this.workout.swapExercise({
      actor: snapshot.actor,
      requestId: envelope.requestId,
      planId: plan.id,
      expectedPlanVersion: plan.version,
      itemId: current.id,
      candidate,
    }));
    const nextContext: ActiveContext = {
      ...context,
      version: context.version + 1,
      planVersion: result.planVersion,
      itemLabel: candidate.label,
      rejectedCandidateIds: [...new Set([...(context.rejectedCandidateIds || []), current.exerciseId])],
      updatedAt: new Date().toISOString(),
    };
    await withV3Span("REDIS_UPDATE", { "guto.operation": "active_context_swap_exercise" }, () =>
      this.activeContext.update(snapshot.actor, context.version, nextContext));
    return {
      status: "confirmed",
      code: "EXERCISE_SWAPPED",
      message: `Troca confirmada para ${candidate.label}.`,
      planVersion: result.planVersion,
      activeContextVersion: nextContext.version,
    };
  }

  private async swapFood(decision: DecisionEnvelope, envelope: TurnEnvelope, snapshot: OfficialSnapshot): Promise<ExecutorResult> {
    const context = envelope.activeContext;
    const plan = snapshot.diet;
    const candidate = envelope.candidates.find((item) => item.id === decision.selectedCandidateId);
    if (!context || !plan || !candidate) throw new V3Error("V3_EXECUTOR_INPUT_MISSING", "Contexto de dieta incompleto.", 409);
    const current = plan.meals.flatMap((meal) => meal.items).find((item) => item.id === context.itemId);
    if (!current) throw new V3Error("V3_DIET_ITEM_NOT_FOUND", "Alimento oficial não encontrado.", 409);
    const replacement = calculateFoodReplacement(current, candidate);
    const nextPlan = applyFoodReplacement(plan, current.id, replacement);
    assertNutritionPlanValid(nextPlan);
    const result = await withV3Span("POSTGRES_TRANSACTION", { "guto.operation": "swap_food" }, () =>
      this.diet.swapFood({ actor: snapshot.actor, requestId: envelope.requestId, plan, itemId: current.id, replacement }));
    const nextContext: ActiveContext = {
      ...context,
      version: context.version + 1,
      planVersion: result.planVersion,
      itemLabel: candidate.label,
      rejectedCandidateIds: [...new Set([...(context.rejectedCandidateIds || []), current.foodId])],
      updatedAt: new Date().toISOString(),
    };
    await withV3Span("REDIS_UPDATE", { "guto.operation": "active_context_swap_food" }, () =>
      this.activeContext.update(snapshot.actor, context.version, nextContext));
    return {
      status: "confirmed",
      code: "FOOD_SWAPPED",
      message: `Troca confirmada para ${replacement.quantityGrams} g de ${candidate.label}.`,
      planVersion: result.planVersion,
      activeContextVersion: nextContext.version,
    };
  }
}

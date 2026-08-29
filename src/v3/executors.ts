import type { DecisionEnvelope } from "./contracts.js";
import { V3Error } from "./errors.js";
import { assertNutritionPlanValid, calculateNutritionPlan } from "./nutrition-engine.js";
import { calculateNutritionTarget } from "./nutrition/target-policy.js";
import { filterFoodsByDeclaration } from "./nutrition/restrictions.js";
import { selectCandidateFoods } from "./nutrition/catalog.js";
import { reoptimizeOfficialNutrition, nutritionTargetFromProfile } from "./nutrition/optimizer.js";
import { validateOfficialNutrition } from "./nutrition/validator.js";
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
import { impactsFor, type FactChange } from "./facts.js";
import { deriveChildRequestId } from "./legacy-identity.js";

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
  private readonly repository: OfficialStateRepository;

  constructor(
    repository: OfficialStateRepository,
    operational: OperationalStateStore,
  ) {
    this.repository = repository;
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
    if (decision.action === "updateFacts") return this.updateFacts(decision, envelope, snapshot);
    return {
      status: "rejected",
      code: "EXECUTOR_NOT_AVAILABLE",
      message: `O executor ${decision.action} ainda não está habilitado na V3.`,
    };
  }

  private async updateFacts(decision: DecisionEnvelope, envelope: TurnEnvelope, snapshot: OfficialSnapshot): Promise<ExecutorResult> {
    if (!snapshot.confirmedContext || !decision.operationalFacts?.length) {
      throw new V3Error("V3_FACT_CONTEXT_REQUIRED", "Contexto confirmado e fatos estruturados são necessários.", 409);
    }
    const changes: FactChange[] = decision.operationalFacts.map((fact) => ({
      ...fact,
      source: "user_declared" as const,
    }));
    const applied = await withV3Span("FACT_EXECUTOR", {
      "guto.fact_count": changes.length,
      "guto.context_version": snapshot.confirmedContext.version,
    }, () => this.repository.applyFactChanges({
      actor: snapshot.actor,
      requestId: envelope.requestId,
      changes,
      expectedContextVersion: snapshot.confirmedContext!.version,
    }));
    const next = await withV3Span("CONTEXT_VERSION", { "guto.context_version": applied.context.version }, () => this.repository.loadOfficialSnapshot(snapshot.actor));
    const impacts = impactsFor(changes);
    let planVersion: number | undefined;
    if (impacts.has("WORKOUT")) {
      const workout = await this.workout.generate({
        actor: next.actor,
        requestId: deriveChildRequestId(envelope.requestId, "workout-regeneration"),
        context: applied.context,
        draft: generateWorkoutDraft(next),
      });
      if (workout.confirmedContextVersion !== applied.context.version) {
        throw new V3Error("V3_PLAN_CONTEXT_MISMATCH", "O treino regenerado não corresponde ao contexto confirmado.", 500);
      }
      planVersion = workout.version;
    }
    if (impacts.has("NUTRITION")) {
      const diet = await this.diet.generate({
        actor: next.actor,
        requestId: deriveChildRequestId(envelope.requestId, "diet-regeneration"),
        context: applied.context,
        draft: await generateDietDraft(next),
      });
      if (diet.confirmedContextVersion !== applied.context.version) {
        throw new V3Error("V3_PLAN_CONTEXT_MISMATCH", "A dieta regenerada não corresponde ao contexto confirmado.", 500);
      }
      planVersion = diet.version;
    }
    return {
      status: "confirmed",
      code: "FACTS_CONFIRMED",
      message: "Atualizei o contexto oficial com o que você declarou.",
      planVersion,
      factContextVersion: applied.context.version,
      affectedDomains: applied.affectedDomains as ExecutorResult["affectedDomains"],
    };
  }

  private async generateWorkout(envelope: TurnEnvelope, snapshot: OfficialSnapshot): Promise<ExecutorResult> {
    if (!snapshot.confirmedContext) throw new V3Error("V3_CONFIRMED_CONTEXT_REQUIRED", "Contexto confirmado necessário.", 409);
    const draft = generateWorkoutDraft(snapshot);
    const plan = await withV3Span("POSTGRES_TRANSACTION", { "guto.operation": "generate_workout" }, () =>
      this.workout.generate({ actor: snapshot.actor, requestId: envelope.requestId, context: snapshot.confirmedContext!, draft }));
    return {
      status: "confirmed",
      code: "WORKOUT_GENERATED",
      message: "Treino oficial gerado e confirmado.",
      planVersion: plan.version,
    };
  }

  private async generateDiet(envelope: TurnEnvelope, snapshot: OfficialSnapshot): Promise<ExecutorResult> {
    if (!snapshot.confirmedContext) throw new V3Error("V3_CONFIRMED_CONTEXT_REQUIRED", "Contexto confirmado necessário.", 409);
    const draft = await generateDietDraft(snapshot);
    const validationPlan = {
      id: "draft",
      version: 1,
      status: "draft" as const,
      confirmedContextVersion: snapshot.confirmedContext.version,
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
      this.diet.generate({ actor: snapshot.actor, requestId: envelope.requestId, context: snapshot.confirmedContext!, draft }));
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
    if (candidate.kind !== "food") throw new V3Error("V3_INVALID_FOOD_CANDIDATE", "Candidato não é alimento.", 409);
    const target = nutritionTargetFromProfile(calculateNutritionTarget(snapshot.profile, snapshot.goal));
    const declaration = [snapshot.confirmedContext?.foodDeclaration || "", ...(snapshot.currentFacts || []).map((fact) => String(fact.value.declaration || fact.canonicalValue))].join(" ");
    const eligible = filterFoodsByDeclaration(selectCandidateFoods(), declaration);
    const excludedIds = selectCandidateFoods().filter((food) => !eligible.some((allowed) => allowed.id === food.id) || food.id === current.foodId).map((food) => food.id);
    const previous = {
      status: "OPTIMAL" as const,
      foods: plan.meals.flatMap((meal) => meal.items).map((item) => ({ foodId: item.foodId, grams: item.quantityGrams })),
      totals: { calories: plan.totalCalories, proteinGrams: plan.proteinGrams, carbsGrams: plan.carbsGrams, fatGrams: plan.fatGrams, fiberGrams: plan.meals.flatMap((meal) => meal.items).reduce((sum, item) => sum + (selectCandidateFoods().find((food) => food.id === item.foodId)?.nutritionPer100g.fiber || 0) * item.quantityGrams / 100, 0) },
      solverMetadata: { durationMs: 0, formulation: "weighted_absolute_deviation_lp" as const },
    };
    const currentFood = selectCandidateFoods().find((food) => food.id === current.foodId);
    const role = currentFood?.role;
    const candidateCatalog = selectCandidateFoods().find((food) => food.id === candidate.id);
    if (role && candidateCatalog && candidateCatalog.role !== role) {
      throw new V3Error("V3_FOOD_ROLE_MISMATCH", "O candidato não pertence à mesma categoria culinária do alimento original.", 409);
    }
    // Only ineligible foods and the replaced (unavailable) item are excluded.
    // Every other food stays free so the LP may adjust quantities elsewhere;
    // role preservation is enforced on the candidate itself, not by freezing
    // the rest of the plan.
    const swapExcludedIds = selectCandidateFoods().filter((food) =>
      !eligible.some((allowed) => allowed.id === food.id) || food.id === current.foodId
    ).map((food) => food.id);
    // The replaced item stays excluded (hard-zeroed) so the unavailable food
    // disappears; only the candidate remains eligible inside the pool.
    const optimized = await reoptimizeOfficialNutrition(previous, target, [...new Set(swapExcludedIds.filter((id) => id !== candidate.id))]);
    validateOfficialNutrition(optimized, target);
    const replacement = optimized.foods.find((food) => food.foodId === candidate.id);
    if (!replacement) throw new V3Error("NUTRITION_PLAN_INFEASIBLE", "O candidato não pertence a uma solução válida.", 409);
    const optimizedItems = optimized.foods.map((food, position) => {
      const existing = plan.meals.flatMap((meal) => meal.items).find((entry) => entry.foodId === food.foodId);
      const catalogFood = selectCandidateFoods().find((entry) => entry.id === food.foodId);
      if (!catalogFood) throw new V3Error("NUTRITION_VALIDATION_FAILED", "Alimento otimizado ausente do catálogo.", 409);
      const factor = food.grams / 100;
      const proteinGrams = Number((catalogFood.nutritionPer100g.protein * factor).toFixed(2));
      const carbsGrams = Number((catalogFood.nutritionPer100g.carbs * factor).toFixed(2));
      const fatGrams = Number((catalogFood.nutritionPer100g.fat * factor).toFixed(2));
      return { id: existing?.id || `item-${food.foodId}`, foodId: food.foodId, name: candidate.id === food.foodId ? candidate.label : catalogFood.canonicalName, quantityGrams: food.grams, calories: Number((proteinGrams * 4 + carbsGrams * 4 + fatGrams * 9).toFixed(2)), proteinGrams, carbsGrams, fatGrams, position };
    });
    const persistedPlan = structuredClone(plan);
    persistedPlan.meals = [{ ...persistedPlan.meals[0], items: optimizedItems.map((entry) => ({ ...entry, id: entry.id })), calories: optimizedItems.reduce((sum, entry) => sum + entry.calories, 0) }];
    const computed = calculateNutritionPlan(persistedPlan);
    persistedPlan.totalCalories = computed.calories;
    persistedPlan.proteinGrams = computed.proteinGrams;
    persistedPlan.carbsGrams = computed.carbsGrams;
    persistedPlan.fatGrams = computed.fatGrams;
    assertNutritionPlanValid(persistedPlan);
    const persisted = await this.diet.swapFood({ actor: snapshot.actor, requestId: envelope.requestId, plan, mutation: { planId: plan.id, expectedPlanVersion: plan.version, contextVersion: snapshot.confirmedContext?.version || 0, items: optimizedItems, totals: { calories: computed.calories, proteinGrams: computed.proteinGrams, carbsGrams: computed.carbsGrams, fatGrams: computed.fatGrams }, replacement: { previousFoodId: current.foodId, candidateId: candidate.id } } });
    const planVersion = persisted.planVersion;
    const nextContext: ActiveContext = {
      ...context,
      version: context.version + 1,
      planVersion,
      itemLabel: candidate.label,
      rejectedCandidateIds: [...new Set([...(context.rejectedCandidateIds || []), current.foodId])],
      updatedAt: new Date().toISOString(),
    };
    await withV3Span("REDIS_UPDATE", { "guto.operation": "active_context_swap_food" }, () =>
      this.activeContext.update(snapshot.actor, context.version, nextContext));
    return {
      status: "confirmed",
      code: "FOOD_SWAPPED",
      message: `Troca confirmada para ${replacement.grams} g de ${candidate.label}.`,
      planVersion,
      activeContextVersion: nextContext.version,
    };
  }
}

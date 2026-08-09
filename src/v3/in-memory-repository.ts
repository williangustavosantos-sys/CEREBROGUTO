import type { CalibrationMutation } from "./contracts.js";
import { randomUUID } from "node:crypto";
import { V3Error } from "./errors.js";
import type { DietPlanDraft, FoodReplacement, OfficialStateRepository, WorkoutPlanDraft } from "./repository.js";
import type { ActorContext, CalibrationResult, CandidateOption, DietPlan, OfficialSnapshot } from "./types.js";

function key(actor: Pick<ActorContext, "tenantId" | "userId">): string { return `${actor.tenantId}:${actor.userId}`; }

export class InMemoryOfficialStateRepository implements OfficialStateRepository {
  private readonly snapshots = new Map<string, OfficialSnapshot>();
  private readonly byExternal = new Map<string, ActorContext>();
  private readonly calibrationResults = new Map<string, CalibrationResult>();
  readonly events: Array<{ requestId: string; action: string; resultCode: string }> = [];

  seed(snapshot: OfficialSnapshot): void {
    this.snapshots.set(key(snapshot.actor), structuredClone(snapshot));
    this.byExternal.set(snapshot.actor.externalSubject, structuredClone(snapshot.actor));
  }

  async health(): Promise<{ ok: boolean; latencyMs: number }> { return { ok: true, latencyMs: 0 }; }
  async resolveActor(externalSubject: string, role: ActorContext["role"]): Promise<ActorContext | null> {
    const actor = this.byExternal.get(externalSubject);
    return actor ? { ...structuredClone(actor), role } : null;
  }
  async provisionActor(input: {
    externalSubject: string;
    role: ActorContext["role"];
    tenantKey: string;
    tenantName: string;
    displayName?: string;
  }): Promise<ActorContext> {
    const existing = await this.resolveActor(input.externalSubject, input.role);
    if (existing) return existing;
    const actor: ActorContext = {
      tenantId: `tenant-${input.tenantKey}`,
      userId: `user-${input.externalSubject}`,
      externalSubject: input.externalSubject,
      role: input.role,
    };
    this.byExternal.set(input.externalSubject, structuredClone(actor));
    return actor;
  }
  async loadOfficialSnapshot(actor: ActorContext): Promise<OfficialSnapshot> {
    const snapshot = this.snapshots.get(key(actor));
    if (!snapshot) throw new V3Error("V3_OFFICIAL_PROFILE_INCOMPLETE", "Perfil oficial ausente.", 409);
    return structuredClone(snapshot);
  }
  async persistCalibration(actor: ActorContext, input: CalibrationMutation): Promise<CalibrationResult> {
    const idempotencyKey = `${key(actor)}:${input.requestId}`;
    const existing = this.calibrationResults.get(idempotencyKey);
    if (existing) return structuredClone(existing);
    const existingSnapshot = this.snapshots.get(key(actor));
    const snapshot: OfficialSnapshot = existingSnapshot ? structuredClone(existingSnapshot) : {
      actor: structuredClone(actor),
      memoryVersion: 0,
      profile: {
        version: 0,
        displayName: undefined,
        language: input.profile.language,
        city: input.profile.city,
        country: input.profile.country,
        biologicalSex: input.profile.biologicalSex,
        age: input.profile.age,
        weightKg: input.profile.weightKg,
        heightCm: input.profile.heightCm,
        trainingStatus: input.profile.trainingStatus,
        trainingLocation: input.profile.trainingLocation,
      },
      goal: { version: 0, code: input.goal.code },
      preferences: { version: 0 },
      healthConstraints: [],
      workout: null,
      diet: null,
    };
    snapshot.profile = {
      ...snapshot.profile,
      version: snapshot.profile.version + 1,
      biologicalSex: input.profile.biologicalSex,
      age: input.profile.age,
      weightKg: input.profile.weightKg,
      heightCm: input.profile.heightCm,
      trainingStatus: input.profile.trainingStatus,
      trainingLocation: input.profile.trainingLocation,
      language: input.profile.language,
      city: input.profile.city,
      country: input.profile.country,
    };
    snapshot.goal = { version: snapshot.goal.version + 1, code: input.goal.code };
    snapshot.preferences = { version: snapshot.preferences.version + 1, dietStyle: input.preferences.dietStyle };
    snapshot.healthConstraints = input.healthConstraints.map((constraint, index) => ({
      id: `health-${index + 1}`,
      ...constraint,
      confirmed: true,
    }));
    snapshot.memoryVersion += 1;
    this.snapshots.set(key(actor), snapshot);
    const result: CalibrationResult = {
      status: "confirmed",
      requestId: input.requestId,
      profileVersion: snapshot.profile.version,
      memoryVersion: snapshot.memoryVersion,
    };
    this.calibrationResults.set(idempotencyKey, result);
    return structuredClone(result);
  }
  async replaceWorkoutPlan(input: { actor: ActorContext; requestId: string; draft: WorkoutPlanDraft }) {
    const snapshot = await this.loadOfficialSnapshot(input.actor);
    const prior = this.events.find((event) => event.requestId === input.requestId && event.action === "generateWorkout");
    if (prior && snapshot.workout) return structuredClone(snapshot.workout);
    const plan = {
      id: randomUUID(), version: (snapshot.workout?.version || 0) + 1, title: input.draft.title,
      status: "active" as const,
      items: input.draft.items.map((item) => ({ ...item, id: randomUUID() })),
    };
    snapshot.workout = plan;
    this.snapshots.set(key(input.actor), snapshot);
    this.events.push({ requestId: input.requestId, action: "generateWorkout", resultCode: "WORKOUT_GENERATED" });
    return structuredClone(plan);
  }
  async replaceDietPlan(input: { actor: ActorContext; requestId: string; draft: DietPlanDraft }) {
    const snapshot = await this.loadOfficialSnapshot(input.actor);
    const prior = this.events.find((event) => event.requestId === input.requestId && event.action === "generateDiet");
    if (prior && snapshot.diet) return structuredClone(snapshot.diet);
    const plan = {
      id: randomUUID(), version: (snapshot.diet?.version || 0) + 1, status: "active" as const,
      totalCalories: input.draft.totalCalories, proteinGrams: input.draft.proteinGrams,
      carbsGrams: input.draft.carbsGrams, fatGrams: input.draft.fatGrams,
      meals: input.draft.meals.map((meal) => ({ ...meal, id: randomUUID(), items: meal.items.map((item) => ({ ...item, id: randomUUID() })) })),
    };
    snapshot.diet = plan;
    this.snapshots.set(key(input.actor), snapshot);
    this.events.push({ requestId: input.requestId, action: "generateDiet", resultCode: "DIET_GENERATED" });
    return structuredClone(plan);
  }
  async swapExercise(input: {
    actor: ActorContext;
    requestId: string;
    planId: string;
    expectedPlanVersion: number;
    itemId: string;
    candidate: CandidateOption;
  }): Promise<{ planVersion: number }> {
    const snapshot = await this.loadOfficialSnapshot(input.actor);
    const plan = snapshot.workout;
    if (!plan || plan.id !== input.planId) throw new V3Error("V3_WORKOUT_NOT_FOUND", "Treino não encontrado.", 409);
    if (plan.version !== input.expectedPlanVersion) throw new V3Error("V3_STALE_WORKOUT_VERSION", "Treino desatualizado.", 409);
    const item = plan.items.find((entry) => entry.id === input.itemId);
    if (!item) throw new V3Error("V3_WORKOUT_ITEM_NOT_FOUND", "Exercício não encontrado.", 409);
    item.exerciseId = input.candidate.id;
    item.name = input.candidate.label;
    item.purpose = String(input.candidate.metadata.purpose || input.candidate.purpose);
    item.muscleGroup = String(input.candidate.metadata.muscleGroup || item.muscleGroup);
    plan.version += 1;
    this.snapshots.set(key(input.actor), snapshot);
    return { planVersion: plan.version };
  }
  async swapFood(input: {
    actor: ActorContext;
    requestId: string;
    plan: DietPlan;
    itemId: string;
    replacement: FoodReplacement;
  }): Promise<{ planVersion: number }> {
    const snapshot = await this.loadOfficialSnapshot(input.actor);
    const plan = snapshot.diet;
    if (!plan || plan.id !== input.plan.id) throw new V3Error("V3_DIET_NOT_FOUND", "Dieta não encontrada.", 409);
    if (plan.version !== input.plan.version) throw new V3Error("V3_STALE_DIET_VERSION", "Dieta desatualizada.", 409);
    const item = plan.meals.flatMap((meal) => meal.items).find((entry) => entry.id === input.itemId);
    if (!item) throw new V3Error("V3_DIET_ITEM_NOT_FOUND", "Alimento não encontrado.", 409);
    Object.assign(item, {
      foodId: input.replacement.candidate.id,
      name: input.replacement.candidate.label,
      quantityGrams: input.replacement.quantityGrams,
      calories: input.replacement.calories,
      proteinGrams: input.replacement.proteinGrams,
      carbsGrams: input.replacement.carbsGrams,
      fatGrams: input.replacement.fatGrams,
    });
    for (const meal of plan.meals) meal.calories = meal.items.reduce((sum, entry) => sum + entry.calories, 0);
    const items = plan.meals.flatMap((meal) => meal.items);
    plan.totalCalories = items.reduce((sum, entry) => sum + entry.calories, 0);
    plan.proteinGrams = items.reduce((sum, entry) => sum + entry.proteinGrams, 0);
    plan.carbsGrams = items.reduce((sum, entry) => sum + entry.carbsGrams, 0);
    plan.fatGrams = items.reduce((sum, entry) => sum + entry.fatGrams, 0);
    plan.version += 1;
    this.snapshots.set(key(input.actor), snapshot);
    return { planVersion: plan.version };
  }
  async recordTurn(input: { actor: ActorContext; requestId: string; action: string; resultCode: string }): Promise<void> {
    if (!this.events.some((event) => event.requestId === input.requestId)) {
      this.events.push({ requestId: input.requestId, action: input.action, resultCode: input.resultCode });
    }
  }
}

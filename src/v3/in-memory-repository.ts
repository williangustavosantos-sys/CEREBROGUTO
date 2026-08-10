import type { CalibrationMutation } from "./contracts.js";
import { randomUUID } from "node:crypto";
import { V3Error } from "./errors.js";
import type { ConversationStateRepository, DietPlanDraft, FoodReplacement, OfficialStateRepository, WorkoutPlanDraft } from "./repository.js";
import { emptyConversationDecisionState, type ConversationDecisionState, type ConversationKnownFact } from "./conversation-state.js";
import type {
  ActorContext,
  CalibrationResult,
  CandidateOption,
  DietPlan,
  JourneyState,
  OfficialSnapshot,
  V3AppState,
  XpLedgerEntry,
  XpReasonCode,
} from "./types.js";

function key(actor: Pick<ActorContext, "tenantId" | "userId">): string { return `${actor.tenantId}:${actor.userId}`; }

export class InMemoryOfficialStateRepository implements OfficialStateRepository, ConversationStateRepository {
  private readonly snapshots = new Map<string, OfficialSnapshot>();
  private readonly byExternal = new Map<string, ActorContext>();
  private readonly calibrationResults = new Map<string, CalibrationResult>();
  private readonly journeys = new Map<string, JourneyState>();
  private readonly xpLedger = new Map<string, XpLedgerEntry[]>();
  private readonly pactRequests = new Set<string>();
  private readonly conversationStates = new Map<string, ConversationDecisionState>();
  readonly events: Array<{ requestId: string; action: string; resultCode: string }> = [];

  seed(snapshot: OfficialSnapshot): void {
    this.snapshots.set(key(snapshot.actor), structuredClone(snapshot));
    this.byExternal.set(snapshot.actor.externalSubject, structuredClone(snapshot.actor));
    this.journeys.set(key(snapshot.actor), {
      preferredLanguage: snapshot.profile.language,
      consentAcceptedAt: new Date().toISOString(),
      sovereignNameConfirmedAt: snapshot.profile.displayName ? new Date().toISOString() : null,
      pactAcceptedAt: null,
      initialXpRewardSeen: false,
    });
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
  async loadAppState(actor: ActorContext): Promise<V3AppState> {
    const snapshot = this.snapshots.get(key(actor));
    const journey = this.journeys.get(key(actor)) || {
      preferredLanguage: snapshot?.profile.language || "pt-BR",
      consentAcceptedAt: null,
      sovereignNameConfirmedAt: null,
      pactAcceptedAt: null,
      initialXpRewardSeen: false,
    };
    const xpEvents = structuredClone(this.xpLedger.get(key(actor)) || []);
    const totalXp = xpEvents.reduce((sum, event) => sum + event.amount, 0);
    const today = new Date().toISOString().slice(0, 10);
    return {
      actor: structuredClone(actor),
      memoryVersion: snapshot?.memoryVersion || 1,
      displayName: snapshot?.profile.displayName || "",
      journey: structuredClone(journey),
      profile: snapshot ? structuredClone(snapshot.profile) : null,
      goal: snapshot ? structuredClone(snapshot.goal) : null,
      preferences: snapshot ? structuredClone(snapshot.preferences) : { version: 1 },
      healthConstraints: snapshot ? structuredClone(snapshot.healthConstraints) : [],
      workout: snapshot?.workout ? structuredClone(snapshot.workout) : null,
      diet: snapshot?.diet ? structuredClone(snapshot.diet) : null,
      progression: {
        totalXp,
        evolutionStage: totalXp >= 12_000 ? "elite" : totalXp >= 5_000 ? "adult" : totalXp >= 1_500 ? "teen" : "baby",
        trainedToday: xpEvents.some((event) => event.reasonCode === "complete_daily_mission" && event.sourceKey === today),
        adaptedMissionToday: xpEvents.some((event) => event.reasonCode === "accept_adapted_mission" && event.sourceKey === today),
        xpEvents,
      },
    };
  }
  async persistJourney(input: {
    actor: ActorContext;
    requestId: string;
    displayName?: string;
    preferredLanguage?: "pt-BR" | "en-US" | "it-IT";
    acceptConsent?: boolean;
    confirmName?: boolean;
    initialXpRewardSeen?: boolean;
  }): Promise<void> {
    const existing = (await this.loadAppState(input.actor)).journey;
    const now = new Date().toISOString();
    this.journeys.set(key(input.actor), {
      ...existing,
      preferredLanguage: input.preferredLanguage || existing.preferredLanguage,
      consentAcceptedAt: input.acceptConsent ? existing.consentAcceptedAt || now : existing.consentAcceptedAt,
      sovereignNameConfirmedAt: input.confirmName ? existing.sovereignNameConfirmedAt || now : existing.sovereignNameConfirmedAt,
      initialXpRewardSeen: input.initialXpRewardSeen ?? existing.initialXpRewardSeen,
    });
    const snapshot = this.snapshots.get(key(input.actor));
    if (snapshot && input.displayName) {
      snapshot.profile.displayName = input.displayName;
      snapshot.memoryVersion += 1;
      this.snapshots.set(key(input.actor), snapshot);
    }
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
  async completePact(input: {
    actor: ActorContext;
    requestId: string;
    displayName: string;
    workoutDraft: WorkoutPlanDraft;
    dietDraft: DietPlanDraft;
  }): Promise<void> {
    const requestKey = `${key(input.actor)}:${input.requestId}`;
    if (this.pactRequests.has(requestKey)) return;
    const snapshot = await this.loadOfficialSnapshot(input.actor);
    snapshot.profile.displayName = input.displayName;
    this.snapshots.set(key(input.actor), snapshot);
    if (!snapshot.workout) await this.replaceWorkoutPlan({ actor: input.actor, requestId: input.requestId, draft: input.workoutDraft });
    if (!snapshot.diet) await this.replaceDietPlan({ actor: input.actor, requestId: input.requestId, draft: input.dietDraft });
    const journey = (await this.loadAppState(input.actor)).journey;
    const now = new Date().toISOString();
    this.journeys.set(key(input.actor), {
      ...journey,
      sovereignNameConfirmedAt: journey.sovereignNameConfirmedAt || now,
      pactAcceptedAt: journey.pactAcceptedAt || now,
    });
    await this.recordXp({ actor: input.actor, requestId: input.requestId, reasonCode: "grant_initial_xp", sourceKey: "lifetime" });
    this.pactRequests.add(requestKey);
  }
  async recordXp(input: {
    actor: ActorContext;
    requestId: string;
    reasonCode: XpReasonCode;
    sourceKey: string;
  }): Promise<void> {
    const entries = this.xpLedger.get(key(input.actor)) || [];
    if (entries.some((entry) => entry.reasonCode === input.reasonCode && entry.sourceKey === input.sourceKey)) return;
    const amount = input.reasonCode === "grant_initial_xp" || input.reasonCode === "complete_daily_mission"
      ? 100
      : input.reasonCode === "accept_adapted_mission"
        ? 50
        : -20;
    entries.push({ id: randomUUID(), reasonCode: input.reasonCode, sourceKey: input.sourceKey, amount, createdAt: new Date().toISOString() });
    this.xpLedger.set(key(input.actor), entries);
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
  async loadConversationDecisionState(actor: ActorContext, threadKey = "companion"): Promise<ConversationDecisionState> {
    return structuredClone(this.conversationStates.get(`${key(actor)}:${threadKey}`) || emptyConversationDecisionState(threadKey));
  }
  async recordConversationDecision(input: {
    actor: ActorContext;
    requestId: string;
    state: ConversationDecisionState;
    interactionId?: string;
    decisionId: string;
    resolvedFacts: ConversationKnownFact[];
  }): Promise<void> {
    const state = structuredClone(input.state);
    state.previousInteractionId = input.interactionId || state.previousInteractionId;
    this.conversationStates.set(`${key(input.actor)}:${state.threadKey}`, state);
  }
}

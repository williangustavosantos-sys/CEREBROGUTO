import type { CalibrationMutation } from "./contracts.js";
import { randomUUID } from "node:crypto";
import { V3Error } from "./errors.js";
import { materializeFirstContact } from "./first-contact.js";
import { assertFactChange, impactsFor, type FactChange, type RecordedFact } from "./facts.js";
import { generateDietDraft, generateWorkoutDraft } from "./generation-engines.js";
import { decideWorkoutEvolution } from "./workout-evolution.js";
import { assertValidAdaptedExecution, resolveSessionEffectiveLocation } from "./session-execution-policy.js";
import type { ConversationStateRepository, DietPlanDraft, FoodReplacement, OfficialStateRepository, WorkoutPlanDraft } from "./repository.js";
import { emptyConversationDecisionState, type ConversationDecisionState, type ConversationKnownFact } from "./conversation-state.js";
import { deriveChildRequestId } from "./legacy-identity.js";
import type {
  ActorContext,
  CalibrationResult,
  CandidateOption,
  ConfirmedUserContext,
  DietPlan,
  FirstContactState,
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
  private readonly firstContacts = new Map<string, FirstContactState>();
  private readonly confirmedContexts = new Map<string, ConfirmedUserContext>();
  private readonly firstContactResponseRequests = new Set<string>();
  private readonly facts = new Map<string, RecordedFact[]>();
  private readonly conversationStates = new Map<string, ConversationDecisionState>();
  private readonly workoutSessionEvents = new Map<string, import("./types.js").WorkoutExerciseSessionEvent[]>();
  private readonly completedSessionIds = new Map<string, Set<string>>();
  private readonly completedSessionRequests = new Set<string>();
  private readonly requestIdDecisions = new Map<string, import("./types.js").WorkoutEvolutionDecision>();
  private readonly requestIdInflight = new Map<string, Promise<import("./types.js").WorkoutEvolutionDecision>>();
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
    this.firstContacts.set(key(snapshot.actor), structuredClone(snapshot.firstContact));
    if (snapshot.confirmedContext) this.confirmedContexts.set(key(snapshot.actor), structuredClone(snapshot.confirmedContext));
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
    const state = await this.loadAppState(actor);
    return {
      ...structuredClone(snapshot),
      firstContact: state.firstContact,
      confirmedContext: structuredClone(this.confirmedContexts.get(key(actor)) || null),
      currentFacts: state.currentFacts,
      nextSessionIndex: await this.countCompletedWorkoutSessions(actor),
    };
  }
  private materializedFirstContact(snapshot: OfficialSnapshot | undefined, displayName: string, profile: OfficialSnapshot["profile"] | null, goal: OfficialSnapshot["goal"] | null): FirstContactState {
    const stored = snapshot ? this.firstContacts.get(key(snapshot.actor)) : undefined;
    return stored
      ? materializeFirstContact({
          status: stored.status,
          step: stored.step,
          foodDeclaration: stored.foodDeclaration,
          limitationDeclaration: stored.limitationDeclaration,
          startedAt: stored.startedAt,
          completedAt: stored.completedAt,
          confirmedContextVersion: stored.confirmedContextVersion,
          displayName,
          profile,
          goal,
        })
      : materializeFirstContact({ displayName, profile, goal });
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
      firstContact: this.materializedFirstContact(snapshot, snapshot?.profile.displayName || "", snapshot?.profile || null, snapshot?.goal || null),
      confirmedContext: this.confirmedContexts.has(key(actor))
        ? (({ id, version, confirmedAt }) => ({ id, version, confirmedAt }))(this.confirmedContexts.get(key(actor))!)
        : null,
      currentFacts: structuredClone((this.facts.get(key(actor)) || []).filter((fact) => fact.supersededAt === null)),
      workout: snapshot?.workout ? structuredClone(snapshot.workout) : null,
      diet: snapshot?.diet ? structuredClone(snapshot.diet) : null,
      nextSessionIndex: await this.countCompletedWorkoutSessions(actor),
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
        language: "pt-BR",
        city: undefined,
        country: undefined,
        biologicalSex: input.profile.biologicalSex,
        age: input.profile.age,
        weightKg: input.profile.weightKg,
        heightCm: input.profile.heightCm,
        trainingStatus: input.profile.trainingStatus,
        trainingLocation: "gym",
        weeklyFrequencyDaysPerWeek: input.profile.weeklyFrequencyDaysPerWeek,
      },
      goal: { version: 0, code: input.goal.code },
      preferences: { version: 0 },
      healthConstraints: [],
      firstContact: materializeFirstContact({ displayName: "", profile: null, goal: null }),
      confirmedContext: null,
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
      trainingLocation: "gym",
      weeklyFrequencyDaysPerWeek: input.profile.weeklyFrequencyDaysPerWeek,
      language: snapshot.profile.language || "pt-BR",
      city: snapshot.profile.city,
      country: snapshot.profile.country,
    };
    snapshot.goal = { version: snapshot.goal.version + 1, code: input.goal.code };
    snapshot.preferences = { version: snapshot.preferences.version + 1 };
    snapshot.healthConstraints = [];
    snapshot.memoryVersion += 1;
    this.snapshots.set(key(actor), snapshot);
    const now = new Date().toISOString();
    const history = this.facts.get(key(actor)) || [];
    const seedFacts: FactChange[] = [
      { factType: "GOAL", canonicalValue: input.goal.code, value: { code: input.goal.code }, source: "system", confirmationStatus: "FACT_CONFIRMED" },
      { factType: "BODY_WEIGHT", canonicalValue: String(input.profile.weightKg), value: { weightKg: input.profile.weightKg }, source: "system", confirmationStatus: "FACT_CONFIRMED" },
      { factType: "TRAINING_FREQUENCY", canonicalValue: String(input.profile.weeklyFrequencyDaysPerWeek), value: { daysPerWeek: input.profile.weeklyFrequencyDaysPerWeek }, source: "system", confirmationStatus: "FACT_CONFIRMED" },
      { factType: "EXPERIENCE_LEVEL", canonicalValue: input.profile.trainingStatus, value: { code: input.profile.trainingStatus }, source: "system", confirmationStatus: "FACT_CONFIRMED" },
    ];
    for (const fact of seedFacts) {
      const prior = history.find((item) => !item.supersededAt && item.factType === fact.factType && item.scope === fact.scope);
      if (prior?.canonicalValue === fact.canonicalValue) continue;
      const next: RecordedFact = { ...fact, id: randomUUID(), validFrom: now, validTo: null, recordedAt: now, supersededAt: null, supersededBy: null };
      if (prior) { prior.validTo = now; prior.supersededAt = now; prior.supersededBy = next.id; }
      history.push(next);
    }
    this.facts.set(key(actor), history);
    const result: CalibrationResult = {
      status: "confirmed",
      requestId: input.requestId,
      profileVersion: snapshot.profile.version,
      memoryVersion: snapshot.memoryVersion,
    };
    this.calibrationResults.set(idempotencyKey, result);
    return structuredClone(result);
  }
  async persistProfileLocation(actor: ActorContext, input: { requestId: string; country?: string; city?: string }): Promise<void> {
    const snapshot = this.snapshots.get(key(actor));
    if (!snapshot?.profile) return; // sem perfil ainda — no-op
    snapshot.profile = {
      ...snapshot.profile,
      country: input.country?.trim() || snapshot.profile.country,
      city: input.city?.trim() || snapshot.profile.city,
    };
    snapshot.memoryVersion += 1;
    this.snapshots.set(key(actor), snapshot);
  }
  async startFirstContact(input: { actor: ActorContext; requestId: string }): Promise<void> {
    const state = await this.loadAppState(input.actor);
    if (!state.profile || !state.goal || state.profile.weeklyFrequencyDaysPerWeek == null) {
      throw new V3Error("V3_CALIBRATION_REQUIRED", "Calibragem objetiva completa necessária antes do First Contact.", 409);
    }
    if (state.firstContact.status !== "NOT_STARTED") return;
    const now = new Date().toISOString();
    this.firstContacts.set(key(input.actor), materializeFirstContact({
      status: "IN_PROGRESS",
      step: "food_restrictions",
      startedAt: now,
      displayName: state.displayName,
      profile: state.profile,
      goal: state.goal,
    }));
  }
  async respondFirstContact(input: { actor: ActorContext; requestId: string; expectedStep: "food_restrictions" | "training_limitations"; answer: string }): Promise<void> {
    const requestKey = `${key(input.actor)}:${input.requestId}`;
    if (this.firstContactResponseRequests.has(requestKey)) return;
    const state = await this.loadAppState(input.actor);
    if (state.firstContact.status === "COMPLETED") return;
    if (state.firstContact.status !== "IN_PROGRESS") {
      throw new V3Error("V3_FIRST_CONTACT_NOT_STARTED", "First Contact ainda não iniciado.", 409);
    }
    if (state.firstContact.step !== input.expectedStep) {
      throw new V3Error("V3_FIRST_CONTACT_STEP_CONFLICT", "A etapa do First Contact mudou. Recarregue o estado oficial.", 409);
    }
    const foodDeclaration = input.expectedStep === "food_restrictions"
      ? input.answer.trim()
      : state.firstContact.foodDeclaration;
    const limitationDeclaration = input.expectedStep === "training_limitations"
      ? input.answer.trim()
      : state.firstContact.limitationDeclaration;
    this.firstContacts.set(key(input.actor), materializeFirstContact({
      status: "IN_PROGRESS",
      step: input.expectedStep === "food_restrictions" ? "training_limitations" : "confirmation",
      foodDeclaration,
      limitationDeclaration,
      startedAt: state.firstContact.startedAt,
      displayName: state.displayName,
      profile: state.profile,
      goal: state.goal,
    }));
    this.firstContactResponseRequests.add(requestKey);
  }
  async updateFirstContactDeclarations(input: {
    actor: ActorContext;
    requestId: string;
    foodDeclaration?: string | null;
    limitationDeclaration?: string | null;
  }): Promise<void> {
    const requestKey = `${key(input.actor)}:${input.requestId}`;
    if (this.firstContactResponseRequests.has(requestKey)) return;
    const state = await this.loadAppState(input.actor);
    if (state.firstContact.status !== "IN_PROGRESS") {
      throw new V3Error("V3_FIRST_CONTACT_NOT_STARTED", "First Contact ainda não iniciado.", 409);
    }
    const stored = this.firstContacts.get(key(input.actor));
    const foodDeclaration = input.foodDeclaration ?? (stored?.foodDeclaration ?? null);
    const limitationDeclaration = input.limitationDeclaration ?? (stored?.limitationDeclaration ?? null);
    this.firstContacts.set(key(input.actor), materializeFirstContact({
      status: stored?.status || "IN_PROGRESS",
      step: stored?.step || "confirmation",
      foodDeclaration,
      limitationDeclaration,
      startedAt: stored?.startedAt ?? state.firstContact.startedAt,
      completedAt: stored?.completedAt ?? null,
      confirmedContextVersion: stored?.confirmedContextVersion ?? null,
      displayName: state.displayName,
      profile: state.profile,
      goal: state.goal,
    }));
    this.firstContactResponseRequests.add(requestKey);
  }
  async confirmFirstContact(input: {
    actor: ActorContext;
    requestId: string;
    contextId: string;
    contextVersion: number;
    expectedProfileVersion: number;
    expectedGoalVersion: number;
    confirmedSnapshot: Record<string, unknown>;
    workoutDraft: WorkoutPlanDraft;
    dietDraft: DietPlanDraft;
  }): Promise<ConfirmedUserContext> {
    const state = await this.loadAppState(input.actor);
    const existingContext = this.confirmedContexts.get(key(input.actor));
    if (state.firstContact.status === "COMPLETED" && existingContext) return structuredClone(existingContext);
    if (state.firstContact.step !== "confirmation" || !state.firstContact.foodDeclaration || !state.firstContact.limitationDeclaration) {
      throw new V3Error("V3_FIRST_CONTACT_INCOMPLETE", "As duas declarações precisam ser confirmadas.", 409);
    }
    if (!state.profile || !state.goal || state.profile.weeklyFrequencyDaysPerWeek == null) {
      throw new V3Error("V3_CALIBRATION_REQUIRED", "Calibragem objetiva completa necessária.", 409);
    }
    if (state.profile.version !== input.expectedProfileVersion || state.goal.version !== input.expectedGoalVersion) {
      throw new V3Error("V3_CONTEXT_SOURCE_CHANGED", "O perfil mudou antes da confirmação.", 409);
    }
    const confirmedAt = new Date().toISOString();
    const context: ConfirmedUserContext = {
      id: input.contextId,
      version: input.contextVersion,
      confirmedAt,
      foodDeclaration: state.firstContact.foodDeclaration,
      limitationDeclaration: state.firstContact.limitationDeclaration,
      profileVersion: state.profile.version,
      goalVersion: state.goal.version,
      weeklyFrequencyDaysPerWeek: state.profile.weeklyFrequencyDaysPerWeek,
      trainingLocation: "gym",
    };
    this.confirmedContexts.set(key(input.actor), context);
    const persistedSnapshot = this.snapshots.get(key(input.actor));
    if (persistedSnapshot) {
      // Mirror the PostgreSQL repository: these are literal user declarations,
      // not inferred clinical diagnoses.  Keeping them in the official
      // snapshot makes reload and safety filtering behave the same in tests.
      persistedSnapshot.healthConstraints = [
        ...persistedSnapshot.healthConstraints.filter((constraint) =>
          constraint.kind !== "food_restriction" && constraint.kind !== "limitation"),
        {
          id: `first-contact-food-${context.id}`,
          kind: "food_restriction",
          description: context.foodDeclaration,
          severity: "unknown",
          confirmed: true,
        },
        {
          id: `first-contact-limitation-${context.id}`,
          kind: "limitation",
          description: context.limitationDeclaration,
          severity: "unknown",
          confirmed: true,
        },
      ];
      this.snapshots.set(key(input.actor), persistedSnapshot);
    }
    this.firstContacts.set(key(input.actor), materializeFirstContact({
      status: "COMPLETED",
      step: "completed",
      foodDeclaration: context.foodDeclaration,
      limitationDeclaration: context.limitationDeclaration,
      startedAt: state.firstContact.startedAt,
      completedAt: confirmedAt,
      confirmedContextVersion: context.version,
      displayName: state.displayName,
      profile: state.profile,
      goal: state.goal,
    }));
    await this.replaceWorkoutPlan({ actor: input.actor, requestId: input.requestId, context, draft: input.workoutDraft });
    await this.replaceDietPlan({ actor: input.actor, requestId: input.requestId, context, draft: input.dietDraft });
    return structuredClone(context);
  }
  async completePact(input: {
    actor: ActorContext;
    requestId: string;
    displayName: string;
  }): Promise<void> {
    const requestKey = `${key(input.actor)}:${input.requestId}`;
    if (this.pactRequests.has(requestKey)) return;
    const snapshot = await this.loadOfficialSnapshot(input.actor);
    snapshot.profile.displayName = input.displayName;
    this.snapshots.set(key(input.actor), snapshot);
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
  async replaceWorkoutPlan(input: { actor: ActorContext; requestId: string; context: ConfirmedUserContext; draft: WorkoutPlanDraft }) {
    const snapshot = await this.loadOfficialSnapshot(input.actor);
    const prior = this.events.find((event) => event.requestId === input.requestId && event.action === "generateWorkout");
    if (prior && snapshot.workout) return structuredClone(snapshot.workout);
    const plan = {
      id: randomUUID(), version: (snapshot.workout?.version || 0) + 1, title: input.draft.title,
      status: "active" as const, confirmedContextVersion: input.context.version,
      items: input.draft.items.map((item) => ({ ...item, id: randomUUID() })),
    };
    snapshot.workout = plan;
    this.snapshots.set(key(input.actor), snapshot);
    this.events.push({ requestId: input.requestId, action: "generateWorkout", resultCode: "WORKOUT_GENERATED" });
    return structuredClone(plan);
  }
  async replaceDietPlan(input: { actor: ActorContext; requestId: string; context: ConfirmedUserContext; draft: DietPlanDraft }) {
    const snapshot = await this.loadOfficialSnapshot(input.actor);
    const prior = this.events.find((event) => event.requestId === input.requestId && event.action === "generateDiet");
    if (prior && snapshot.diet) return structuredClone(snapshot.diet);
    const plan = {
      id: randomUUID(), version: (snapshot.diet?.version || 0) + 1, status: "active" as const,
      confirmedContextVersion: input.context.version,
      totalCalories: input.draft.totalCalories, proteinGrams: input.draft.proteinGrams,
      carbsGrams: input.draft.carbsGrams, fatGrams: input.draft.fatGrams,
      meals: input.draft.meals.map((meal) => ({ ...meal, id: randomUUID(), items: meal.items.map((item) => ({ ...item, id: randomUUID() })) })),
    };
    snapshot.diet = plan;
    this.snapshots.set(key(input.actor), snapshot);
    this.events.push({ requestId: input.requestId, action: "generateDiet", resultCode: "DIET_GENERATED" });
    return structuredClone(plan);
  }
  async applyFactChanges(input: {
    actor: ActorContext;
    requestId: string;
    changes: FactChange[];
    expectedContextVersion: number;
  }): Promise<{ context: ConfirmedUserContext; facts: RecordedFact[]; affectedDomains: string[] }> {
    const state = await this.loadAppState(input.actor);
    const current = this.confirmedContexts.get(key(input.actor));
    if (!current || state.firstContact.status !== "COMPLETED") {
      throw new V3Error("V3_CONFIRMED_CONTEXT_REQUIRED", "Contexto confirmado necessário para registrar um fato.", 409);
    }
    if (current.version !== input.expectedContextVersion) {
      throw new V3Error("V3_CONTEXT_VERSION_CONFLICT", "O contexto mudou; recarregue antes de registrar o fato.", 409);
    }
    const now = new Date().toISOString();
    const history = this.facts.get(key(input.actor)) || [];
    const recorded: RecordedFact[] = [];
    for (const change of input.changes) {
      assertFactChange(change);
      const equivalent = history.find((fact) => !fact.supersededAt && fact.factType === change.factType && fact.canonicalValue === change.canonicalValue && fact.scope === change.scope);
      if (equivalent) { recorded.push(structuredClone(equivalent)); continue; }
      const next: RecordedFact = { ...change, id: randomUUID(), validFrom: now, validTo: null, recordedAt: now, supersededAt: null, supersededBy: null };
      for (const previous of history) {
        if (!previous.supersededAt && previous.factType === change.factType && previous.scope === change.scope) {
          previous.validTo = now;
          previous.supersededAt = now;
          previous.supersededBy = next.id;
        }
      }
      history.push(next);
      recorded.push(structuredClone(next));
    }
    this.facts.set(key(input.actor), history);
    const persisted = this.snapshots.get(key(input.actor));
    const weightChange = input.changes.find((change) => change.factType === "BODY_WEIGHT");
    if (persisted && weightChange) {
      persisted.profile = {
        ...persisted.profile,
        version: persisted.profile.version + 1,
        weightKg: Number(weightChange.value.weightKg),
      };
      this.snapshots.set(key(input.actor), persisted);
    }
    const nextContext: ConfirmedUserContext = {
      ...current,
      id: randomUUID(),
      version: current.version + 1,
      confirmedAt: now,
      profileVersion: persisted?.profile.version ?? current.profileVersion,
      factIds: history.filter((fact) => !fact.supersededAt).map((fact) => fact.id),
    };
    this.confirmedContexts.set(key(input.actor), nextContext);
    if (persisted) {
      persisted.confirmedContext = nextContext;
      persisted.firstContact = { ...persisted.firstContact, confirmedContextVersion: nextContext.version };
      this.snapshots.set(key(input.actor), persisted);
    }
    const impacts = impactsFor(input.changes);
    const snapshot = await this.loadOfficialSnapshot(input.actor);
    // Plans always refer to one context version. Unaffected content is simply
    // reissued against the new context; its engine is not regenerated.
    if (impacts.has("WORKOUT")) {
      await this.replaceWorkoutPlan({ actor: input.actor, requestId: deriveChildRequestId(input.requestId, "workout-regeneration"), context: nextContext, draft: generateWorkoutDraft(snapshot) });
    } else if (snapshot.workout) {
      snapshot.workout.confirmedContextVersion = nextContext.version;
    }
    if (impacts.has("NUTRITION")) {
      await this.replaceDietPlan({ actor: input.actor, requestId: deriveChildRequestId(input.requestId, "diet-regeneration"), context: nextContext, draft: await generateDietDraft(snapshot) });
    } else if (snapshot.diet) {
      snapshot.diet.confirmedContextVersion = nextContext.version;
    }
    const reconciled = await this.loadOfficialSnapshot(input.actor);
    if (!impacts.has("WORKOUT") && reconciled.workout) reconciled.workout.confirmedContextVersion = nextContext.version;
    if (!impacts.has("NUTRITION") && reconciled.diet) reconciled.diet.confirmedContextVersion = nextContext.version;
    this.snapshots.set(key(input.actor), reconciled);
    return { context: structuredClone(nextContext), facts: recorded, affectedDomains: [...impacts] };
  }
  async listFactHistory(actor: ActorContext): Promise<RecordedFact[]> {
    return structuredClone(this.facts.get(key(actor)) || []);
  }
  async recordWorkoutExerciseEvent(input: { actor: ActorContext; requestId: string; event: import("./types.js").WorkoutExerciseSessionEvent }): Promise<import("./types.js").WorkoutEvolutionDecision> {
    // P0 (concurrent idempotency): mirror the durable barrier — dedupe on
    // requestId BEFORE recording, so a duplicated request never becomes a
    // second logical execution or a false progression signal. The reservation
    // below happens SYNCHRONOUSLY (before the first await), closing the
    // check-then-act window: two concurrent requests with the same requestId
    // can no longer both pass the dedupe read.
    const dedupeKey = `${key(input.actor)}::${input.requestId}::workout.evolution_decided`;
    const cached = this.requestIdDecisions.get(dedupeKey);
    if (cached) return structuredClone(cached);
    const inflight = this.requestIdInflight.get(dedupeKey);
    if (inflight) return inflight;
    const execution = this.recordWorkoutExerciseEventReserved(input);
    this.requestIdInflight.set(dedupeKey, execution);
    try {
      const decision = await execution;
      this.requestIdDecisions.set(dedupeKey, structuredClone(decision));
      return decision;
    } finally {
      this.requestIdInflight.delete(dedupeKey);
    }
  }

  private async recordWorkoutExerciseEventReserved(
    input: { actor: ActorContext; requestId: string; event: import("./types.js").WorkoutExerciseSessionEvent },
  ): Promise<import("./types.js").WorkoutEvolutionDecision> {
    const state = await this.loadAppState(input.actor);
    const basePlan = state.workout;
    if (!basePlan) throw new V3Error("V3_WORKOUT_NOT_FOUND", "Treino oficial ativo não encontrado.", 409);
    if (input.event.substitutedFromExerciseId) {
      // P0 (adapted execution): validate adapted exercises deterministically
      // (source in base plan; catalog + video + safety + location for the
      // adapted exercise) instead of rejecting every adapted execution.
      // P0 (session location authority): the session's effectiveLocation takes
      // precedence over the profile default — resolve it from the event
      // context (canonical values only) via the policy helper.
      const snapshot = await this.loadOfficialSnapshot(input.actor);
      const profileLocation = snapshot.confirmedContext?.trainingLocation || snapshot.profile.trainingLocation;
      const effectiveLocation = resolveSessionEffectiveLocation(input.event, undefined, profileLocation);
      assertValidAdaptedExecution({ event: input.event, basePlan, snapshot, effectiveLocation });
    } else if (!basePlan.items.some((item) => item.exerciseId === input.event.exerciseId)) {
      throw new V3Error("V3_WORKOUT_EXERCISE_NOT_ACTIVE", "Exercício não pertence ao treino oficial ativo.", 409);
    }
    // P0#4: decide from the current event plus the recent history of the SAME
    // exercise, so PROGRESS requires 2+ consecutive easy completed sessions.
    const keyed = key(input.actor);
    const prior = this.workoutSessionEvents.get(keyed) || [];
    const history = prior.filter((event) => event.exerciseId === input.event.exerciseId).slice(-4);
    const decision = decideWorkoutEvolution(input.event, history);
    this.workoutSessionEvents.set(keyed, [...prior, input.event]);
    this.events.push({ requestId: input.requestId, action: "workoutEvolution", resultCode: decision.decision });
    return decision;
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
    mutation: import("./repository.js").FullDietPlanMutation;
  }): Promise<{ planVersion: number }> {
    const snapshot = await this.loadOfficialSnapshot(input.actor);
    const plan = snapshot.diet;
    if (!plan || plan.id !== input.plan.id) throw new V3Error("V3_DIET_NOT_FOUND", "Dieta não encontrada.", 409);
    if (plan.version !== input.plan.version) throw new V3Error("V3_STALE_DIET_VERSION", "Dieta desatualizada.", 409);
    if (input.mutation.planId !== plan.id || input.mutation.expectedPlanVersion !== plan.version || input.mutation.contextVersion !== (plan.confirmedContextVersion ?? input.mutation.contextVersion)) throw new V3Error("V3_STALE_DIET_VERSION", "Dieta desatualizada.", 409);
    const mutationIds = new Set(input.mutation.items.map((entry) => entry.id));
    for (const entry of input.mutation.items) {
      if (!Number.isFinite(entry.quantityGrams) || entry.quantityGrams <= 0 || [entry.calories, entry.proteinGrams, entry.carbsGrams, entry.fatGrams].some((value) => !Number.isFinite(value))) throw new V3Error("NUTRITION_VALIDATION_FAILED", "Mutação de dieta inválida.", 409);
    }
    for (const meal of plan.meals) {
      const nextIds = new Set(mutationIds);
      meal.items = meal.items.filter((entry) => nextIds.has(entry.id));
    }
    const byId = new Map(input.mutation.items.map((entry) => [entry.id, entry]));
    const meal = plan.meals[0];
    if (!meal) throw new V3Error("V3_DIET_ITEM_NOT_FOUND", "Alimento oficial não encontrado.", 409);
    for (const entry of meal.items) {
      const next = byId.get(entry.id);
      if (next) Object.assign(entry, next);
    }
    const existingIds = new Set(meal.items.map((entry) => entry.id));
    const added = input.mutation.items.filter((entry) => !existingIds.has(entry.id));
    for (const entry of added) meal.items.push({ ...entry });
    meal.items.sort((a, b) => a.position - b.position);
    meal.calories = Number(meal.items.reduce((sum, entry) => sum + entry.calories, 0).toFixed(2));
    plan.totalCalories = input.mutation.totals.calories;
    plan.proteinGrams = input.mutation.totals.proteinGrams;
    plan.carbsGrams = input.mutation.totals.carbsGrams;
    plan.fatGrams = input.mutation.totals.fatGrams;
    plan.version += 1;
    this.snapshots.set(key(input.actor), snapshot);
    return { planVersion: plan.version };
  }
  async recordTurn(input: { actor: ActorContext; requestId: string; action: string; resultCode: string }): Promise<void> {
    if (!this.events.some((event) => event.requestId === input.requestId)) {
      this.events.push({ requestId: input.requestId, action: input.action, resultCode: input.resultCode });
    }
  }
  /**
   * P0 (session completion): the SOLE authority that flips a logical workout
   * session to completed — mirroring the Postgres semantics. Exercise events
   * only add history under a session; this call is what the rotation counter
   * observes, so the index advances exactly once per real session. Idempotent
   * on requestId.
   */
  async completeWorkoutSession(input: { actor: ActorContext; requestId: string; workoutSessionId: string }): Promise<void> {
    const dedupeKey = `${key(input.actor)}::${input.requestId}::workout.session_completed`;
    if (this.completedSessionRequests.has(dedupeKey)) return;
    this.completedSessionRequests.add(dedupeKey);
    const set = this.completedSessionIds.get(key(input.actor)) || new Set<string>();
    set.add(input.workoutSessionId);
    this.completedSessionIds.set(key(input.actor), set);
    this.events.push({ requestId: input.requestId, action: "workoutSessionCompleted", resultCode: "COMPLETED" });
  }
  /**
   * P0 (session rotation): durable session counter — counts COMPLETED logical
   * sessions (each advanced only by completeWorkoutSession), not exercise
   * events. Mirrors the Postgres workout_sessions status='completed' count.
   */
  async countCompletedWorkoutSessions(actor: ActorContext): Promise<number> {
    return this.completedSessionIds.get(key(actor))?.size ?? 0;
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

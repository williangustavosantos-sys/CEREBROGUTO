import { randomUUID } from "node:crypto";
import type { FirstContactConfirmation, FirstContactResponse, V3MemoryMutation } from "./contracts.js";
import { V3Error } from "./errors.js";
import { generateDietDraft, generateWorkoutDraft } from "./generation-engines.js";
import type { OfficialStateRepository } from "./repository.js";
import type { ActorContext, ConfirmedUserContext, OfficialSnapshot, V3AppState } from "./types.js";

function calibrationSnapshot(state: V3AppState, context: ConfirmedUserContext): OfficialSnapshot {
  if (!state.profile || !state.goal || state.profile.weeklyFrequencyDaysPerWeek == null) {
    throw new V3Error("V3_CALIBRATION_REQUIRED", "Calibragem objetiva completa necessária.", 409);
  }
  return {
    actor: state.actor,
    memoryVersion: state.memoryVersion,
    profile: state.profile,
    goal: state.goal,
    preferences: state.preferences,
    healthConstraints: state.healthConstraints,
    firstContact: state.firstContact,
    confirmedContext: context,
    workout: state.workout,
    diet: state.diet,
  };
}

function hasCalibrationPatch(input: V3MemoryMutation): boolean {
  return [
    input.biologicalSex,
    input.userAge,
    input.weightKg,
    input.heightCm,
    input.trainingLevel,
    input.trainingGoal,
    input.trainingFrequency,
  ].some((value) => value !== undefined);
}

export class V3CutoverService {
  constructor(private readonly repository: OfficialStateRepository) {}

  async load(actor: ActorContext): Promise<V3AppState> {
    return this.repository.loadAppState(actor);
  }

  async acceptConsent(actor: ActorContext, requestId: string): Promise<V3AppState> {
    await this.repository.persistJourney({ actor, requestId, acceptConsent: true });
    return this.load(actor);
  }

  async saveMemory(actor: ActorContext, input: V3MemoryMutation): Promise<V3AppState> {
    if (input.name || input.language || input.confirmedName || input.initialXpRewardSeen !== undefined) {
      await this.repository.persistJourney({
        actor,
        requestId: input.requestId,
        displayName: input.name,
        preferredLanguage: input.language,
        confirmName: input.confirmedName,
        initialXpRewardSeen: input.initialXpRewardSeen,
      });
    }

    if (hasCalibrationPatch(input)) {
      const current = await this.load(actor);
      const currentProfile = current.profile;
      const biologicalSex = input.biologicalSex || currentProfile?.biologicalSex;
      const age = input.userAge ?? currentProfile?.age;
      const weightKg = input.weightKg ?? currentProfile?.weightKg;
      const heightCm = input.heightCm ?? currentProfile?.heightCm;
      const trainingStatus = input.trainingLevel
        ? input.trainingLevel === "consistent" ? "active" : input.trainingLevel
        : currentProfile?.trainingStatus;
      const weeklyFrequencyDaysPerWeek = input.trainingFrequency ?? currentProfile?.weeklyFrequencyDaysPerWeek;
      const goalCode = input.trainingGoal || current.goal?.code;
      if (!biologicalSex || age == null || weightKg == null || heightCm == null || !trainingStatus || weeklyFrequencyDaysPerWeek == null || !goalCode) {
        throw new V3Error("V3_CALIBRATION_INCOMPLETE", "A calibragem V3 precisa de todos os campos obrigatórios.", 400);
      }
      await this.repository.persistCalibration(actor, {
        requestId: input.requestId,
        profile: {
          biologicalSex: biologicalSex as "male" | "female" | "other" | "prefer_not_to_say",
          age,
          weightKg,
          heightCm,
          trainingStatus: trainingStatus as "beginner" | "returning" | "active" | "advanced",
          weeklyFrequencyDaysPerWeek,
        },
        goal: { code: goalCode },
      });
    }

    // País/cidade são campos OFICIAIS de perfil no V3. preferredTrainingLocation
    // NÃO entra aqui: é hint de sessão — o local oficial fica fixado no contexto
    // confirmado ("gym") e nunca é mutado por memory mutation (teste V3.2).
    if (input.country !== undefined || input.city !== undefined) {
      await this.repository.persistProfileLocation(actor, {
        requestId: input.requestId,
        country: input.country,
        city: input.city,
      });
    }

    if (input.xpEvent === "grant_initial_xp") {
      const state = await this.load(actor);
      const displayName = input.name?.trim() || state.displayName.trim();
      if (!displayName) throw new V3Error("V3_NAME_REQUIRED", "Nome confirmado necessário antes do pacto.", 409);
      await this.repository.completePact({
        actor,
        requestId: input.requestId,
        displayName,
      });
    } else if (input.xpEvent) {
      const sourceKey = new Intl.DateTimeFormat("en-CA", {
        timeZone: process.env.GUTO_TIME_ZONE || "Europe/Rome",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      await this.repository.recordXp({ actor, requestId: input.requestId, reasonCode: input.xpEvent, sourceKey });
    }

    return this.load(actor);
  }

  async startFirstContact(actor: ActorContext, requestId: string): Promise<V3AppState> {
    const state = await this.load(actor);
    if (!state.profile || !state.goal || state.profile.weeklyFrequencyDaysPerWeek == null) {
      throw new V3Error("V3_CALIBRATION_REQUIRED", "Calibragem objetiva completa necessária antes do First Contact.", 409);
    }
    await this.repository.startFirstContact({ actor, requestId });
    return this.load(actor);
  }

  async respondFirstContact(actor: ActorContext, input: FirstContactResponse): Promise<V3AppState> {
    await this.repository.respondFirstContact({ actor, requestId: input.requestId, expectedStep: input.expectedStep, answer: input.answer });
    return this.load(actor);
  }

  async confirmFirstContact(actor: ActorContext, input: FirstContactConfirmation): Promise<V3AppState> {
    const state = await this.load(actor);
    if (state.firstContact.status === "COMPLETED") return state;
    if (!state.profile || !state.goal || state.profile.weeklyFrequencyDaysPerWeek == null) {
      throw new V3Error("V3_CALIBRATION_REQUIRED", "Calibragem objetiva completa necessária.", 409);
    }
    if (state.firstContact.step !== "confirmation" || !state.firstContact.foodDeclaration || !state.firstContact.limitationDeclaration) {
      throw new V3Error("V3_FIRST_CONTACT_INCOMPLETE", "Responda às duas perguntas antes de confirmar.", 409);
    }
    const context: ConfirmedUserContext = {
      id: randomUUID(),
      version: (state.confirmedContext?.version || 0) + 1,
      confirmedAt: new Date().toISOString(),
      foodDeclaration: state.firstContact.foodDeclaration,
      limitationDeclaration: state.firstContact.limitationDeclaration,
      profileVersion: state.profile.version,
      goalVersion: state.goal.version,
      weeklyFrequencyDaysPerWeek: state.profile.weeklyFrequencyDaysPerWeek,
      trainingLocation: "gym",
    };
    const snapshot = calibrationSnapshot(state, context);
    await this.repository.confirmFirstContact({
      actor,
      requestId: input.requestId,
      contextId: context.id,
      contextVersion: context.version,
      expectedProfileVersion: state.profile.version,
      expectedGoalVersion: state.goal.version,
      confirmedSnapshot: {
        profile: state.profile,
        goal: state.goal,
        foodDeclaration: context.foodDeclaration,
        limitationDeclaration: context.limitationDeclaration,
        trainingLocation: "gym",
        weeklyFrequencyDaysPerWeek: context.weeklyFrequencyDaysPerWeek,
      },
      workoutDraft: generateWorkoutDraft(snapshot),
      dietDraft: generateDietDraft(snapshot),
    });
    return this.load(actor);
  }

  async generateWorkout(actor: ActorContext, requestId: string): Promise<V3AppState> {
    const snapshot = await this.repository.loadOfficialSnapshot(actor);
    if (!snapshot.confirmedContext || snapshot.firstContact.status !== "COMPLETED") {
      throw new V3Error("V3_CONFIRMED_CONTEXT_REQUIRED", "Confirme o contexto do usuário antes de gerar o treino.", 409);
    }
    await this.repository.replaceWorkoutPlan({ actor, requestId, context: snapshot.confirmedContext, draft: generateWorkoutDraft(snapshot) });
    return this.load(actor);
  }

  async generateDiet(actor: ActorContext, requestId: string): Promise<V3AppState> {
    const snapshot = await this.repository.loadOfficialSnapshot(actor);
    if (!snapshot.confirmedContext || snapshot.firstContact.status !== "COMPLETED") {
      throw new V3Error("V3_CONFIRMED_CONTEXT_REQUIRED", "Confirme o contexto do usuário antes de gerar a dieta.", 409);
    }
    await this.repository.replaceDietPlan({ actor, requestId, context: snapshot.confirmedContext, draft: generateDietDraft(snapshot) });
    return this.load(actor);
  }
}

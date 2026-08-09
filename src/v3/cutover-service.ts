import type { V3MemoryMutation } from "./contracts.js";
import { V3Error } from "./errors.js";
import { generateDietDraft, generateWorkoutDraft } from "./generation-engines.js";
import type { OfficialStateRepository } from "./repository.js";
import type { ActorContext, OfficialSnapshot, V3AppState } from "./types.js";

function toSnapshot(state: V3AppState): OfficialSnapshot {
  if (!state.profile || !state.goal) {
    throw new V3Error("V3_CALIBRATION_REQUIRED", "Calibragem oficial necessária para gerar os planos.", 409);
  }
  return {
    actor: state.actor,
    memoryVersion: state.memoryVersion,
    profile: state.profile,
    goal: state.goal,
    preferences: state.preferences,
    healthConstraints: state.healthConstraints,
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
    input.preferredTrainingLocation,
    input.trainingPathology,
    input.country,
    input.city,
    input.foodRestrictions,
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
      const trainingLocation = input.preferredTrainingLocation || currentProfile?.trainingLocation;
      const city = input.city || currentProfile?.city;
      const country = input.country || currentProfile?.country;
      const language = input.language || currentProfile?.language || current.journey.preferredLanguage;
      const goalCode = input.trainingGoal || current.goal?.code;
      if (!biologicalSex || age == null || weightKg == null || heightCm == null || !trainingStatus || !trainingLocation || !city || !country || !goalCode) {
        throw new V3Error("V3_CALIBRATION_INCOMPLETE", "A calibragem V3 precisa de todos os campos obrigatórios.", 400);
      }
      const preserved = current.healthConstraints.filter((constraint) => !["limitation", "food_restriction"].includes(constraint.kind));
      await this.repository.persistCalibration(actor, {
        requestId: input.requestId,
        profile: {
          biologicalSex: biologicalSex as "male" | "female" | "other" | "prefer_not_to_say",
          age,
          weightKg,
          heightCm,
          trainingStatus: trainingStatus as "beginner" | "returning" | "active" | "advanced",
          trainingLocation,
          city,
          country,
          language,
        },
        goal: { code: goalCode },
        preferences: { dietStyle: current.preferences.dietStyle },
        healthConstraints: [
          ...preserved.map((constraint) => ({
            kind: constraint.kind,
            bodyRegion: constraint.bodyRegion,
            description: constraint.description,
            severity: constraint.severity,
          })),
          ...(input.trainingPathology?.trim()
            ? [{ kind: "limitation" as const, description: input.trainingPathology.trim(), severity: "unknown" as const }]
            : current.healthConstraints.filter((constraint) => constraint.kind === "limitation").map((constraint) => ({
                kind: constraint.kind,
                bodyRegion: constraint.bodyRegion,
                description: constraint.description,
                severity: constraint.severity,
              }))),
          ...(input.foodRestrictions?.trim()
            ? [{ kind: "food_restriction" as const, description: input.foodRestrictions.trim(), severity: "unknown" as const }]
            : current.healthConstraints.filter((constraint) => constraint.kind === "food_restriction").map((constraint) => ({
                kind: constraint.kind,
                bodyRegion: constraint.bodyRegion,
                description: constraint.description,
                severity: constraint.severity,
              }))),
        ],
      });
    }

    if (input.xpEvent === "grant_initial_xp") {
      const state = await this.load(actor);
      const snapshot = toSnapshot(state);
      const displayName = input.name?.trim() || state.displayName.trim();
      if (!displayName) throw new V3Error("V3_NAME_REQUIRED", "Nome confirmado necessário antes do pacto.", 409);
      await this.repository.completePact({
        actor,
        requestId: input.requestId,
        displayName,
        workoutDraft: generateWorkoutDraft(snapshot),
        dietDraft: generateDietDraft(snapshot),
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

  async generateWorkout(actor: ActorContext, requestId: string): Promise<V3AppState> {
    const snapshot = toSnapshot(await this.load(actor));
    await this.repository.replaceWorkoutPlan({ actor, requestId, draft: generateWorkoutDraft(snapshot) });
    return this.load(actor);
  }

  async generateDiet(actor: ActorContext, requestId: string): Promise<V3AppState> {
    const snapshot = toSnapshot(await this.load(actor));
    await this.repository.replaceDietPlan({ actor, requestId, draft: generateDietDraft(snapshot) });
    return this.load(actor);
  }
}

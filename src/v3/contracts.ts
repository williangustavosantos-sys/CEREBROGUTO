import { z } from "genkit";
import { ActionSufficiency, ClinicalCertainty, ConversationFactStatus, ConversationStatus } from "./conversation-state.js";

export const BrainVersion = "guto-cerebro-v3" as const;

export const V3ActionSchema = z.enum([
  "none",
  "askClarification",
  "swapExercise",
  "swapFood",
  "generateWorkout",
  "generateDiet",
  "updateFacts",
  "startMinimumMission",
  "acknowledge",
  "callSafetyPath",
]);

export const DecisionEnvelopeSchema = z
  .object({
    speech: z.string().trim().min(1).max(1_500),
    action: V3ActionSchema,
    reasonCode: z.string().trim().min(1).max(80),
    selectedCandidateId: z.string().trim().min(1).max(160).optional(),
    operationalFacts: z.array(z.object({
      factType: z.enum(["GOAL", "BODY_WEIGHT", "TRAINING_FREQUENCY", "EXPERIENCE_LEVEL", "FOOD_CONSTRAINT", "FOOD_EXCLUSION", "PHYSICAL_CONSTRAINT", "LOCATION", "BEHAVIORAL_PREFERENCE"]),
      canonicalValue: z.string().trim().min(1).max(500),
      value: z.record(z.string(), z.unknown()),
      confirmationStatus: z.enum(["FACT_CONFIRMED", "FACT_UNKNOWN"]),
      scope: z.enum(["profile", "session"]).optional(),
    })).max(4).optional(),
    factsToPropose: z
      .array(
        z.object({
          classification: z.literal("RELATIONSHIP"),
          fact: z.string().trim().min(1).max(500),
          evidence: z.string().trim().min(1).max(500),
        }),
      )
      .max(5)
      .optional(),
    clarificationQuestion: z.string().trim().min(1).max(300).optional(),
    certainty: z.object({
      factCertainty: z.enum(ConversationFactStatus),
      actionSufficiency: z.enum(ActionSufficiency),
      clinicalCertainty: z.enum(ClinicalCertainty),
    }).optional(),
    clarification: z.object({
      required: z.boolean(),
      reason: z.string().trim().min(1).max(240).optional(),
      missingInformation: z.array(z.object({
        key: z.string().trim().min(1).max(120),
        reason: z.string().trim().min(1).max(240),
        expectedDecisionImpact: z.string().trim().min(1).max(240),
      })).max(8).optional(),
      expectedDecisionImpact: z.string().trim().min(1).max(240).optional(),
    }).optional(),
    conversation: z.object({
      topic: z.string().trim().min(1).max(120).optional(),
      resolvedFacts: z.array(z.object({
        key: z.string().trim().min(1).max(120),
        value: z.unknown(),
        certainty: z.enum(ConversationFactStatus),
        source: z.enum(["user_declared", "derived", "system"]).optional(),
      })).max(12).optional(),
      unresolvedFacts: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
    }).optional(),
    actionProposal: z.object({
      proposed: V3ActionSchema,
      requiresMoreInformation: z.boolean(),
    }).optional(),
    conversationStatus: z.enum(ConversationStatus).optional(),
  })
  .superRefine((decision, ctx) => {
    const needsCandidate = decision.action === "swapExercise" || decision.action === "swapFood";
    if (needsCandidate && !decision.selectedCandidateId) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedCandidateId"],
        message: `${decision.action} requires a selected candidate`,
      });
    }
    if (decision.action === "askClarification" && !decision.clarificationQuestion) {
      ctx.addIssue({
        code: "custom",
        path: ["clarificationQuestion"],
        message: "askClarification requires one concise question",
      });
    }
    if (decision.action === "updateFacts" && !decision.operationalFacts?.length) {
      ctx.addIssue({ code: "custom", path: ["operationalFacts"], message: "updateFacts requires operationalFacts" });
    }
  });

export type V3Action = z.infer<typeof V3ActionSchema>;
export type DecisionEnvelope = z.infer<typeof DecisionEnvelopeSchema>;

export const V3TurnRequestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  requestId: z.string().uuid(),
  uiContextId: z.string().trim().min(1).max(160).optional(),
});

export type V3TurnRequest = z.infer<typeof V3TurnRequestSchema>;

export const CalibrationMutationSchema = z.object({
  requestId: z.string().uuid(),
  profile: z.object({
    biologicalSex: z.enum(["male", "female", "other", "prefer_not_to_say"]),
    age: z.number().int().min(13).max(120),
    weightKg: z.number().positive().max(500),
    heightCm: z.number().min(100).max(250),
    trainingStatus: z.enum(["beginner", "returning", "active", "advanced"]),
    weeklyFrequencyDaysPerWeek: z.number().int().min(1).max(7),
  }).strict(),
  goal: z.object({
    code: z.string().trim().min(1).max(80),
  }).strict(),
}).strict();

export type CalibrationMutation = z.infer<typeof CalibrationMutationSchema>;

export const V3MemoryMutationSchema = z.object({
  requestId: z.string().uuid(),
  name: z.string().trim().min(1).max(80).optional(),
  confirmedName: z.boolean().optional(),
  language: z.enum(["pt-BR", "en-US", "it-IT"]).optional(),
  initialXpRewardSeen: z.boolean().optional(),
  xpEvent: z.enum([
    "grant_initial_xp",
    "complete_daily_mission",
    "accept_adapted_mission",
    "apply_daily_miss_penalty",
  ]).optional(),
  biologicalSex: z.enum(["female", "male"]).optional(),
  userAge: z.number().int().min(13).max(120).optional(),
  weightKg: z.number().positive().max(500).optional(),
  heightCm: z.number().min(100).max(250).optional(),
  trainingLevel: z.enum(["beginner", "returning", "consistent", "advanced"]).optional(),
  trainingGoal: z.enum(["consistency", "fat_loss", "muscle_gain", "conditioning", "mobility_health"]).optional(),
  trainingFrequency: z.number().int().min(1).max(7).optional(),
  preferredTrainingLocation: z.enum(["gym", "home", "park", "mixed"]).optional(),
  trainingPathology: z.string().trim().max(500).optional(),
  foodRestrictions: z.string().trim().max(500).optional(),
  country: z.string().trim().max(160).optional(),
  city: z.string().trim().max(160).optional(),
});

export type V3MemoryMutation = z.infer<typeof V3MemoryMutationSchema>;

export const FirstContactResponseSchema = z.object({
  requestId: z.string().uuid(),
  expectedStep: z.enum(["food_restrictions", "training_limitations"]),
  answer: z.string().trim().min(1).max(2_000),
}).strict();

export const FirstContactConfirmationSchema = z.object({
  requestId: z.string().uuid(),
  confirmed: z.literal(true),
}).strict();

export type FirstContactResponse = z.infer<typeof FirstContactResponseSchema>;
export type FirstContactConfirmation = z.infer<typeof FirstContactConfirmationSchema>;

export const NutritionToleranceSchema = z.object({
  mealToPlanKcal: z.number().nonnegative().default(2),
  macroToPlanKcal: z.number().nonnegative().default(20),
});

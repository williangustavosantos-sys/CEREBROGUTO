import { z } from "genkit";

export const BrainVersion = "guto-cerebro-v3" as const;

export const V3ActionSchema = z.enum([
  "none",
  "askClarification",
  "swapExercise",
  "swapFood",
  "generateWorkout",
  "generateDiet",
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
    trainingLocation: z.string().trim().min(1).max(120),
    city: z.string().trim().min(1).max(160),
    country: z.string().trim().min(1).max(160),
    language: z.enum(["pt-BR", "en-US", "it-IT"]),
  }),
  goal: z.object({
    code: z.string().trim().min(1).max(80),
  }),
  preferences: z.object({
    dietStyle: z.string().trim().min(1).max(80).optional(),
  }),
  healthConstraints: z
    .array(
      z.object({
        kind: z.enum(["limitation", "injury", "illness", "allergy", "food_restriction"]),
        bodyRegion: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().min(1).max(500),
        severity: z.enum(["low", "medium", "high", "unknown"]).default("unknown"),
      }),
    )
    .max(30),
});

export type CalibrationMutation = z.infer<typeof CalibrationMutationSchema>;

export const NutritionToleranceSchema = z.object({
  mealToPlanKcal: z.number().nonnegative().default(2),
  macroToPlanKcal: z.number().nonnegative().default(20),
});

import { getCatalogById, getExerciseName, suggestExerciseSubstitutes, type CatalogLanguage } from "../../exercise-catalog.js";
import { getFoodById, type FoodLanguage } from "../food-catalog.js";
import { conflictsWithFoodDeclaration } from "./food-declaration-policy.js";
import { calculateFoodReplacement } from "./nutrition-engine.js";
import type { CandidateOption, DietItem, OfficialSnapshot, WorkoutItem } from "./types.js";

export interface ExerciseSubstitutionDecision {
  kind: "exercise";
  currentExerciseId: string;
  candidates: CandidateOption[];
  reasonCode: "SAME_MOVEMENT_FAMILY" | "CONSTRAINT_SAFE" | "EQUIPMENT_AVAILABLE";
  expectedImpact: { movementPattern: string; muscleGroup: string };
}

export interface FoodSubstitutionDecision {
  kind: "food";
  currentFoodId: string;
  candidates: CandidateOption[];
  reasonCode: "MACRO_EQUIVALENT_AND_RESTRICTION_SAFE";
}

function locale(language: string): CatalogLanguage & FoodLanguage {
  return language === "it-IT" || language === "en-US" ? language : "pt-BR";
}

/** A deterministic domain decision. Gemini may select/explain a listed item only. */
export function decideExerciseSubstitution(input: { snapshot: OfficialSnapshot; current: WorkoutItem; rejectedIds?: string[] }): ExerciseSubstitutionDecision {
  const language = locale(input.snapshot.profile.language);
  const rejected = new Set(input.rejectedIds || []);
  const candidates: CandidateOption[] = suggestExerciseSubstitutes(input.current.exerciseId, {
    location: "gym",
    userBodyRegion: [input.snapshot.confirmedContext?.limitationDeclaration, ...(input.snapshot.currentFacts || [])
      .filter((fact) => fact.factType === "PHYSICAL_CONSTRAINT")
      .map((fact) => String(fact.value.bodyRegion || fact.value.declaration || ""))].join(" "),
  }).filter((id) => !rejected.has(id)).flatMap((id): CandidateOption[] => {
    const exercise = getCatalogById(id);
    if (!exercise) return [];
    return [{
      id,
      label: getExerciseName(id, language),
      kind: "exercise" as const,
      purpose: input.current.purpose,
      metadata: {
        muscleGroup: exercise.muscleGroup,
        movementPattern: exercise.movementPattern || "unknown",
        exerciseFamily: exercise.movementPattern || exercise.muscleGroup,
        canonicalNamePt: exercise.canonicalNamePt,
        videoUrl: exercise.videoUrl,
        sourceFileName: exercise.sourceFileName,
      },
    }];
  });
  return {
    kind: "exercise", currentExerciseId: input.current.exerciseId, candidates,
    reasonCode: candidates.length ? "SAME_MOVEMENT_FAMILY" : "CONSTRAINT_SAFE",
    expectedImpact: { movementPattern: String(candidates[0]?.metadata.movementPattern || input.current.purpose), muscleGroup: input.current.muscleGroup },
  };
}

export function decideFoodSubstitution(input: { snapshot: OfficialSnapshot; current: DietItem; message: string; candidates: CandidateOption[] }): FoodSubstitutionDecision {
  const declaration = [input.snapshot.confirmedContext?.foodDeclaration || "", ...(input.snapshot.currentFacts || [])
    .filter((fact) => fact.factType === "FOOD_CONSTRAINT" || fact.factType === "FOOD_EXCLUSION")
    .map((fact) => String(fact.value.declaration || fact.canonicalValue))].join(" ");
  const safe = input.candidates.filter((candidate) => candidate.kind === "food" && !conflictsWithFoodDeclaration(candidate.id, declaration));
  return { kind: "food", currentFoodId: input.current.foodId, candidates: safe, reasonCode: "MACRO_EQUIVALENT_AND_RESTRICTION_SAFE" };
}

export function calculateAuthorizedFoodSubstitution(current: DietItem, selected: CandidateOption) {
  // Keep macro arithmetic inside the Nutrition Engine; this module only
  // constrains the candidate domain.
  if (!getFoodById(selected.id)) throw new Error("Unknown canonical food ID");
  return calculateFoodReplacement(current, selected);
}

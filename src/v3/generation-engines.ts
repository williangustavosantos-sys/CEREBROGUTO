import {
  ValidatedExerciseCatalog,
  getExerciseLocations,
  getExerciseName,
  getExerciseRiskTags,
  type CatalogLanguage,
  type CatalogLocation,
  type CatalogMuscleGroup,
} from "../../exercise-catalog.js";
import { getFoodById, type FoodLanguage } from "../food-catalog.js";
import { V3_FOOD_NUTRITION } from "./candidate-provider.js";
import { V3Error } from "./errors.js";
import type { DietPlanDraft, WorkoutPlanDraft } from "./repository.js";
import type { OfficialSnapshot } from "./types.js";

function locale(value: string): CatalogLanguage & FoodLanguage {
  return value === "en-US" || value === "it-IT" ? value : "pt-BR";
}

function trainingLocation(value: string): CatalogLocation {
  const normalized = value.toLowerCase();
  if (normalized.includes("home") || normalized.includes("casa")) return "home";
  if (normalized.includes("park") || normalized.includes("parque")) return "park";
  return "gym";
}

function riskTokens(snapshot: OfficialSnapshot): Set<string> {
  return new Set(snapshot.healthConstraints.flatMap((constraint) => [
    constraint.bodyRegion?.toLowerCase(),
    ...constraint.description.toLowerCase().split(/[^a-z0-9_]+/),
  ]).filter((value): value is string => Boolean(value)));
}

export function generateWorkoutDraft(snapshot: OfficialSnapshot): WorkoutPlanDraft {
  const language = locale(snapshot.profile.language);
  const location = trainingLocation(snapshot.profile.trainingLocation);
  const risks = riskTokens(snapshot);
  const desiredGroups: CatalogMuscleGroup[] = snapshot.goal.code === "conditioning"
    ? ["aquecimento", "pernas", "peito", "costas", "abdomen"]
    : ["aquecimento", "peito", "costas", "pernas", "ombro", "bracos", "abdomen"];
  const selected = desiredGroups.map((group) => ValidatedExerciseCatalog.find((exercise) =>
    exercise.muscleGroup === group &&
    getExerciseLocations(exercise).includes(location) &&
    !getExerciseRiskTags(exercise).some((risk) => risks.has(risk)),
  )).filter((exercise): exercise is (typeof ValidatedExerciseCatalog)[number] => Boolean(exercise));
  if (selected.length < 4) {
    throw new V3Error("V3_WORKOUT_CATALOG_INSUFFICIENT", "Catálogo seguro insuficiente para gerar o treino.", 409);
  }
  const returning = snapshot.profile.trainingStatus === "beginner" || snapshot.profile.trainingStatus === "returning";
  return {
    title: snapshot.goal.code === "hypertrophy" ? "Treino de hipertrofia" : "Treino oficial GUTO",
    generatedFrom: {
      goalCode: snapshot.goal.code,
      profileVersion: snapshot.profile.version,
      location,
      healthConstraintIds: snapshot.healthConstraints.map((constraint) => constraint.id),
      method: "catalog_rules_v1",
    },
    items: selected.map((exercise, position) => ({
      exerciseId: exercise.id,
      name: getExerciseName(exercise.id, language),
      purpose: exercise.movementPattern || exercise.muscleGroup,
      muscleGroup: exercise.muscleGroup,
      position,
      sets: position === 0 ? 1 : returning ? 3 : 4,
      reps: position === 0 ? "5-8 min" : snapshot.goal.code === "hypertrophy" ? "8-12" : "10-15",
    })),
  };
}

interface FoodSeed { foodId: string; grams: number }

function foodItem(foodId: string, grams: number, position: number, language: FoodLanguage) {
  const food = getFoodById(foodId);
  const nutrition = V3_FOOD_NUTRITION[foodId];
  if (!food || !nutrition) throw new V3Error("V3_DIET_CATALOG_INCOMPLETE", `Alimento sem dados V3: ${foodId}.`, 409);
  const factor = grams / 100;
  const proteinGrams = Number((nutrition.proteinPer100g * factor).toFixed(2));
  const carbsGrams = Number((nutrition.carbsPer100g * factor).toFixed(2));
  const fatGrams = Number((nutrition.fatPer100g * factor).toFixed(2));
  const calories = Number((proteinGrams * 4 + carbsGrams * 4 + fatGrams * 9).toFixed(2));
  return {
    foodId,
    name: food.names[language] || food.names["en-US"],
    quantityGrams: grams,
    calories,
    proteinGrams,
    carbsGrams,
    fatGrams,
    position,
  };
}

export function generateDietDraft(snapshot: OfficialSnapshot): DietPlanDraft {
  const language = locale(snapshot.profile.language);
  const constraintText = snapshot.healthConstraints.map((constraint) => constraint.description.toLowerCase()).join(" ");
  const vegetarian = /veget|vegan/.test(`${snapshot.preferences.dietStyle || ""} ${constraintText}`.toLowerCase());
  const vegan = /vegan/.test(`${snapshot.preferences.dietStyle || ""} ${constraintText}`.toLowerCase());
  const proteinFood = vegan ? "tofu" : vegetarian ? "eggs" : "eggs";
  const seeds: Array<{ name: string; items: FoodSeed[] }> = [
    { name: language === "pt-BR" ? "Café da manhã" : language === "it-IT" ? "Colazione" : "Breakfast", items: [{ foodId: "oats", grams: 80 }, { foodId: "banana", grams: 100 }] },
    { name: language === "pt-BR" ? "Almoço" : language === "it-IT" ? "Pranzo" : "Lunch", items: [{ foodId: "rice", grams: 220 }, { foodId: proteinFood, grams: vegan ? 220 : 180 }] },
    { name: language === "pt-BR" ? "Lanche" : language === "it-IT" ? "Spuntino" : "Snack", items: [{ foodId: "wholegrain_bread", grams: 80 }, { foodId: "apple", grams: 150 }] },
    { name: language === "pt-BR" ? "Jantar" : language === "it-IT" ? "Cena" : "Dinner", items: [{ foodId: "potato", grams: 300 }, { foodId: proteinFood, grams: vegan ? 200 : 160 }] },
  ];
  const meals = seeds.map((meal, position) => {
    const items = meal.items.map((item, itemPosition) => foodItem(item.foodId, item.grams, itemPosition, language));
    return { name: meal.name, position, calories: Number(items.reduce((sum, item) => sum + item.calories, 0).toFixed(2)), items };
  });
  const items = meals.flatMap((meal) => meal.items);
  const sum = (values: number[]) => Number(values.reduce((total, value) => total + value, 0).toFixed(2));
  return {
    calculationMethod: "item_sum_and_4_4_9_v1",
    generatedFrom: {
      goalCode: snapshot.goal.code,
      profileVersion: snapshot.profile.version,
      country: snapshot.profile.country,
      city: snapshot.profile.city,
      language: snapshot.profile.language,
      dietStyle: snapshot.preferences.dietStyle || null,
      method: "catalog_macros_v1",
    },
    totalCalories: sum(items.map((item) => item.calories)),
    proteinGrams: sum(items.map((item) => item.proteinGrams)),
    carbsGrams: sum(items.map((item) => item.carbsGrams)),
    fatGrams: sum(items.map((item) => item.fatGrams)),
    meals,
  };
}

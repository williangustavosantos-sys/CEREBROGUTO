import type { NutritionGoal } from "../../nutrition.js";
import type { OfficialProfile, OfficialGoal } from "../types.js";

export const NUTRITION_POLICY_VERSION = "guto_nutrition_policy_v2";

export interface NutritionTarget {
  bmr: number;
  activityFactor: number;
  tdee: number;
  goalAdjustmentCalories: number;
  targetCalories: number;
  protein: { min: number; target: number; max: number; gramsPerKg: number };
  fat: { min: number; target: number; max: number; gramsPerKg: number };
  carbs: { min: number; target: number; max: number };
  fiber: { min: number; target: number };
  calculationMethod: "mifflin_st_jeor_frequency_policy_v2";
  policyVersion: string;
}

const ACTIVITY_BY_FREQUENCY: Record<number, number> = { 0: 1.20, 1: 1.35, 2: 1.35, 3: 1.45, 4: 1.55, 5: 1.60, 6: 1.65, 7: 1.70 };

function bmr(profile: OfficialProfile): number {
  const base = 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * profile.age;
  return Math.round(base + (profile.biologicalSex.toLowerCase() === "female" ? -161 : 5));
}

function factor(frequency: number | null): number {
  const safe = Math.max(0, Math.min(7, Math.round(frequency ?? 0)));
  return ACTIVITY_BY_FREQUENCY[safe] ?? 1.20;
}

function goalCode(goal: OfficialGoal): NutritionGoal | "hypertrophy" {
  return goal.code === "hypertrophy" || goal.code === "muscle_gain" ? "muscle_gain" : goal.code as NutritionGoal;
}

export function calculateNutritionTarget(profile: OfficialProfile, goal: OfficialGoal): NutritionTarget {
  const basal = bmr(profile);
  const activityFactor = factor(profile.weeklyFrequencyDaysPerWeek);
  const tdee = Math.round(basal * activityFactor);
  const selectedGoal = goalCode(goal);
  const adjustmentRate = selectedGoal === "muscle_gain" ? 0.075 : selectedGoal === "fat_loss" ? -0.15 : 0;
  const goalAdjustmentCalories = Math.round(tdee * adjustmentRate);
  const targetCalories = Math.max(profile.biologicalSex.toLowerCase() === "female" ? 1200 : 1500, tdee + goalAdjustmentCalories);
  const proteinTarget = profile.weightKg * (selectedGoal === "muscle_gain" ? 1.8 : selectedGoal === "fat_loss" ? 1.8 : 1.5);
  const protein = { min: Math.round(profile.weightKg * 1.6), target: Math.round(proteinTarget), max: Math.round(profile.weightKg * 2.2), gramsPerKg: Number((proteinTarget / profile.weightKg).toFixed(2)) };
  const fatTarget = profile.weightKg * 0.8;
  const fat = { min: Math.round(profile.weightKg * 0.6), target: Math.round(fatTarget), max: Math.round(profile.weightKg * 1.0), gramsPerKg: 0.8 };
  const carbTarget = Math.max(0, Math.round((targetCalories - protein.target * 4 - fat.target * 9) / 4));
  const carbs = { min: Math.max(0, Math.round(carbTarget * 0.8)), target: carbTarget, max: Math.round(carbTarget * 1.2) };
  const fiberMin = profile.biologicalSex.toLowerCase() === "female" ? 25 : 30;
  return { bmr: basal, activityFactor, tdee, goalAdjustmentCalories, targetCalories, protein, fat, carbs, fiber: { min: fiberMin, target: fiberMin }, calculationMethod: "mifflin_st_jeor_frequency_policy_v2", policyVersion: NUTRITION_POLICY_VERSION };
}

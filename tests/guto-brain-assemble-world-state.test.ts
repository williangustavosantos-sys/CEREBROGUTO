// Commit 4 — Fatia 1: assembleWorldState — função pura, sem I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleWorldState } from "../src/brain/assemble-world-state.js";
import type { WorkoutFeedbackRecord } from "../src/workout-progression.js";

// Helper: cria WorkoutFeedbackRecord mínimo (sem I/O, dados sintéticos).
function makeFeedback(
  difficulty: "easy" | "ok" | "hard" | "pain",
  energy?: "low" | "normal" | "high",
  painArea?: string
): WorkoutFeedbackRecord {
  return {
    id: "fake-id",
    userId: "u1",
    createdAt: "2026-06-28T10:00:00.000Z",
    workoutFocus: "full_body",
    workoutLabel: "Treino GUTO",
    locationMode: "gym",
    difficulty,
    energy,
    painArea,
    exerciseIds: [],
  };
}

// ─── Feedback e feedbackSignal ───────────────────────────────────────────────

test("[easy, easy] → feedbackSignal='progress'", () => {
  const r = assembleWorldState({
    userId: "u1",
    workoutFeedbackHistory: [makeFeedback("easy"), makeFeedback("easy")],
  });
  assert.equal(r.feedbackSignal, "progress");
  assert.deepEqual(r.recentDifficulty, ["easy", "easy"]);
});

test("[pain] → feedbackSignal='deload'", () => {
  const r = assembleWorldState({
    userId: "u1",
    workoutFeedbackHistory: [makeFeedback("pain")],
  });
  assert.equal(r.feedbackSignal, "deload");
  assert.deepEqual(r.recentDifficulty, ["pain"]);
});

test("[hard, hard] → feedbackSignal='deload'", () => {
  const r = assembleWorldState({
    userId: "u1",
    workoutFeedbackHistory: [makeFeedback("hard"), makeFeedback("hard")],
  });
  assert.equal(r.feedbackSignal, "deload");
});

test("sem feedback → feedbackSignal=null (ausência honesta de sinal)", () => {
  const r = assembleWorldState({ userId: "u1" });
  assert.equal(r.feedbackSignal, null);
  assert.deepEqual(r.recentDifficulty, []);
});

test("histórico vazio explícito → feedbackSignal=null", () => {
  const r = assembleWorldState({ userId: "u1", workoutFeedbackHistory: [] });
  assert.equal(r.feedbackSignal, null);
});

test("[ok, ok] → feedbackSignal='hold' (neutro — não progride, não decarrega)", () => {
  const r = assembleWorldState({
    userId: "u1",
    workoutFeedbackHistory: [makeFeedback("ok"), makeFeedback("ok")],
  });
  assert.equal(r.feedbackSignal, "hold");
});

// ─── Identidade e idioma ─────────────────────────────────────────────────────

test("estado válido com perfil completo", () => {
  const r = assembleWorldState({
    userId: "u1",
    name: "Willian",
    language: "pt-BR",
    country: "Brazil",
    city: "São Paulo",
    trainingGoal: "emagrecer",
    trainingLimitations: "joelho direito",
    trainingStatus: "intermediário",
    trainingLocation: "academia",
  });
  assert.equal(r.userId, "u1");
  assert.equal(r.name, "Willian");
  assert.equal(r.language, "pt-BR");
  assert.equal(r.country, "Brazil");
  assert.equal(r.city, "São Paulo");
  assert.equal(r.trainingGoal, "emagrecer");
  assert.equal(r.trainingLimitations, "joelho direito");
  assert.equal(r.trainingStatus, "intermediário");
  assert.equal(r.trainingLocation, "academia");
});

test("idioma desconhecido → normaliza para pt-BR", () => {
  const r = assembleWorldState({ userId: "u1", language: "fr-FR" });
  assert.equal(r.language, "pt-BR");
});

test("idioma ausente → pt-BR", () => {
  const r = assembleWorldState({ userId: "u1" });
  assert.equal(r.language, "pt-BR");
});

test("idiomas válidos são preservados", () => {
  for (const lang of ["pt-BR", "en-US", "it-IT"] as const) {
    const r = assembleWorldState({ userId: "u1", language: lang });
    assert.equal(r.language, lang, `idioma ${lang} deve ser preservado`);
  }
});

// ─── Treino e dieta ──────────────────────────────────────────────────────────

test("lastWorkoutPlan presente → todayWorkout preenchido", () => {
  const r = assembleWorldState({
    userId: "u1",
    lastWorkoutPlan: { focus: "chest_triceps", title: "Treino A", scheduledFor: "2026-06-28" },
  });
  assert.ok(r.todayWorkout !== undefined);
  assert.equal(r.todayWorkout?.focus, "chest_triceps");
  assert.equal(r.todayWorkout?.title, "Treino A");
  assert.equal(r.todayWorkout?.scheduledFor, "2026-06-28");
});

test("lastWorkoutPlan null → todayWorkout null (sem plano)", () => {
  const r = assembleWorldState({ userId: "u1", lastWorkoutPlan: null });
  assert.equal(r.todayWorkout, null);
});

test("lastWorkoutPlan ausente → todayWorkout undefined", () => {
  const r = assembleWorldState({ userId: "u1" });
  assert.equal(r.todayWorkout, undefined);
});

test("weeklyDietPlan presente → hasDietPlan=true", () => {
  const r = assembleWorldState({ userId: "u1", weeklyDietPlan: { days: [] } });
  assert.equal(r.hasDietPlan, true);
});

test("weeklyDietPlan null → hasDietPlan=false", () => {
  const r = assembleWorldState({ userId: "u1", weeklyDietPlan: null });
  assert.equal(r.hasDietPlan, false);
});

test("weeklyDietPlan ausente → hasDietPlan undefined", () => {
  const r = assembleWorldState({ userId: "u1" });
  assert.equal(r.hasDietPlan, undefined);
});

// ─── Campos fora do escopo NÃO aparecem ─────────────────────────────────────

test("campos fora do escopo da Fatia 1 não aparecem no resultado", () => {
  const r = assembleWorldState({
    userId: "u1",
    workoutFeedbackHistory: [makeFeedback("easy")],
  });
  const resultKeys = Object.keys(r);

  // Campos da Fatia 2+ que não devem existir aqui
  const outOfScope = [
    "duoHealth",
    "abandonmentRisk",
    "riskBand",
    "avatarState",
    "xp",
    "totalXp",
    "streak",
    "arena",
    "proactiveMemories",
    "proactiveImpacts",
    "deathSignal",
    "initialXpGranted",
    "completedWorkoutDates",
    "trainedToday",
  ];

  for (const field of outOfScope) {
    assert.ok(
      !resultKeys.includes(field),
      `campo '${field}' não deve aparecer no ReducedWorldState da Fatia 1`
    );
  }
});

// ─── Determinismo ────────────────────────────────────────────────────────────

test("mesmo input → mesmo output (função determinística)", () => {
  const input = {
    userId: "u1",
    name: "Willian",
    language: "pt-BR" as const,
    trainingGoal: "ganhar massa",
    workoutFeedbackHistory: [makeFeedback("easy"), makeFeedback("easy")],
  };
  const r1 = assembleWorldState(input);
  const r2 = assembleWorldState(input);
  assert.deepEqual(r1, r2);
});

test("inputs diferentes → outputs diferentes", () => {
  const r1 = assembleWorldState({ userId: "u1", workoutFeedbackHistory: [makeFeedback("pain")] });
  const r2 = assembleWorldState({ userId: "u1", workoutFeedbackHistory: [makeFeedback("easy"), makeFeedback("easy")] });
  assert.notEqual(r1.feedbackSignal, r2.feedbackSignal);
});

// ─── Campos obrigatórios sempre presentes ────────────────────────────────────

test("userId e language sempre presentes no resultado", () => {
  const r = assembleWorldState({ userId: "u-xyz" });
  assert.ok("userId" in r);
  assert.ok("language" in r);
  assert.ok("recentDifficulty" in r);
  assert.ok("feedbackSignal" in r);
  assert.equal(r.userId, "u-xyz");
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getCatalogById } from "../exercise-catalog";
import {
  appendWorkoutFeedback,
  applySafeExerciseSubstitutions,
  applyWorkoutProgression,
  getProgressionSignal,
  normalizeWorkoutFeedback,
  type ProgressionWorkoutPlan,
  type WorkoutFeedbackRecord,
} from "../src/workout-progression";

function exercise(id: string, sets = 3) {
  const entry = getCatalogById(id);
  assert.ok(entry, `${id} must exist in catalog`);
  return {
    id: entry.id,
    name: entry.canonicalNamePt,
    canonicalNamePt: entry.canonicalNamePt,
    muscleGroup: entry.muscleGroup,
    sets,
    reps: "10",
    rest: "60s",
    cue: "Controle a execução.",
    note: "Base do treino.",
    videoUrl: entry.videoUrl,
    videoProvider: "local" as const,
    sourceFileName: entry.sourceFileName,
  };
}

function plan(exercises = [exercise("bike_academia", 1), exercise("supino_reto", 3)]): ProgressionWorkoutPlan {
  return {
    focus: "Treino teste",
    focusKey: "chest_triceps",
    dateLabel: "Hoje",
    scheduledFor: new Date().toISOString(),
    summary: "Treino oficial.",
    exercises,
  };
}

function feedback(overrides: Partial<WorkoutFeedbackRecord> = {}): WorkoutFeedbackRecord {
  return {
    id: crypto.randomUUID(),
    userId: "student-1",
    createdAt: new Date().toISOString(),
    workoutFocus: "chest_triceps",
    workoutLabel: "Peito",
    locationMode: "gym",
    difficulty: "ok",
    exerciseIds: ["supino_reto"],
    ...overrides,
  };
}

describe("workout progression feedback", () => {
  it("normalizes and stores compact post-workout feedback", () => {
    const record = normalizeWorkoutFeedback({
      userId: "student-1",
      workoutFocus: "chest_triceps",
      workoutLabel: "Peito",
      locationMode: "gym",
      difficulty: "easy",
      energy: "high",
      note: "sobrou gas",
      exerciseIds: ["supino_reto", "", null],
    });

    assert.ok(record);
    assert.equal(record.difficulty, "easy");
    assert.deepEqual(record.exerciseIds, ["supino_reto"]);

    const history = appendWorkoutFeedback([], record);
    assert.equal(history.length, 1);
  });

  it("progresses volume after two easy sessions", () => {
    const history = [
      feedback({ difficulty: "easy", createdAt: "2026-05-16T10:00:00.000Z" }),
      feedback({ difficulty: "easy", createdAt: "2026-05-17T10:00:00.000Z" }),
    ];

    assert.equal(getProgressionSignal(history), "progress");
    const progressed = applyWorkoutProgression(plan(), history);
    assert.equal(progressed.exercises[1].sets, 4);
    assert.equal(progressed.difficulty, "progressive");
  });

  it("reduces volume when feedback reports pain", () => {
    const history = [feedback({ difficulty: "pain", painArea: "joelho" })];

    assert.equal(getProgressionSignal(history), "deload");
    const deload = applyWorkoutProgression(plan([exercise("bike_academia", 1), exercise("supino_reto", 4)]), history);
    assert.equal(deload.exercises[1].sets, 3);
    assert.equal(deload.difficulty, "conservative");
  });

  it("substitutes unsafe catalog exercises and keeps local videos", () => {
    const unsafePlan = plan([exercise("bike_academia", 1), exercise("agachamento_livre", 3), exercise("prancha_isometrica", 3)]);
    const safePlan = applySafeExerciseSubstitutions(unsafePlan, {
      location: "home",
      userBodyRegion: "knee",
      language: "pt-BR",
    });

    assert.ok(!safePlan.exercises.some((item) => item.id === "agachamento_livre"));
    assert.ok(safePlan.exercises.length >= 2);
    for (const item of safePlan.exercises) {
      assert.equal(item.videoProvider, "local");
      assert.ok(item.videoUrl.startsWith("/exercise/visuals/"));
      assert.ok(getCatalogById(item.id), `${item.id} must remain catalog-backed`);
    }
  });
});

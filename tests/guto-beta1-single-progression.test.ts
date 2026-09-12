import assert from "node:assert/strict";
import test from "node:test";
import { decideDoubleProgression, mapLegacyDifficulty, type ProgressionEvidence } from "../src/v3/beta1-progression.js";
import { decideWorkoutEvolution } from "../src/v3/workout-evolution.js";
import type { WorkoutItem, WorkoutExerciseSessionEvent } from "../src/v3/types.js";

const item: WorkoutItem = { id: "official-item", exerciseId: "supino_reto_maquina", name: "Supino máquina", canonicalNamePt: "Supino máquina", purpose: "push", muscleGroup: "peito", position: 1, reps: "8-10", sets: 3 };
const session = (overrides: Partial<WorkoutExerciseSessionEvent> = {}): WorkoutExerciseSessionEvent => ({ exerciseId: item.exerciseId, completed: true, loadValue: 50, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 8, ...overrides });

for (const [name, events, expected] of [
  ["top range 10, not hardcoded 12", [session(), session()], "PROGRESS"],
  ["single top", [session()], "MAINTAIN"],
  ["high effort", [session({ perceivedDifficulty: 9 })], "REGRESS"],
  ["pain before substitution", [session({ context: { safetyConcern: true }, substitutedFromExerciseId: "old" })], "REVIEW"],
] as const) test(`one progression authority: ${name}`, () => {
  const evidence: ProgressionEvidence = { exerciseId: item.exerciseId, repRangeLow: 8, repRangeHigh: 10, sessions: events.map(event => ({
    loadKg: event.loadValue ?? null, repsPerSet: [10, 10, 10],
    difficultyLabel: mapLegacyDifficulty(event.perceivedDifficulty)!, pain: event.context?.safetyConcern === true, completed: event.completed,
  })) };
  const direct = decideDoubleProgression(evidence, item);
  const compatible = decideWorkoutEvolution(events.at(-1)!, events.slice(0, -1), item, evidence);
  assert.equal(direct.decision, expected);
  if (expected === "PROGRESS") assert.equal(direct.toLoadKg, 55, "machine increment is 5kg, including accented name");
  assert.equal(compatible.decision, direct.decision);
  assert.equal(compatible.reasonCode, direct.reasonCode);
  if (expected === "PROGRESS" || expected === "REGRESS") {
    assert.equal(compatible.nextPrescription?.loadDeltaKg, Number((direct.toLoadKg! - direct.fromLoadKg!).toFixed(1)));
  }
});

test("missing official prescription or load cannot invent a future increase", () => {
  assert.equal(decideWorkoutEvolution(session(), [session()]).decision, "REVIEW");
  assert.notEqual(decideWorkoutEvolution(session({ loadValue: undefined }), [session({ loadValue: undefined })], item).decision, "PROGRESS");
});

test("aggregate best set is never evidence for all work sets", () => {
  assert.equal(decideWorkoutEvolution(session(), [session()], item).decision, "REVIEW");
});

for (const [name, middle, current] of [
  ["interruption breaks streak", { completed: false }, {}],
  ["different load breaks streak", { loadKg: 45 }, {}],
  ["missing sets cannot qualify", {}, { repsPerSet: [10] }],
  ["unknown effort cannot qualify", {}, { difficultyLabel: null }],
  ["unknown load cannot qualify", {}, { loadKg: null }],
] as const) test(name, () => {
  const top = { loadKg: 50, repsPerSet: [10, 10, 10], difficultyLabel: "BOA" as const, pain: false, completed: true };
  const evidence: ProgressionEvidence = { exerciseId: item.exerciseId, repRangeLow: 8, repRangeHigh: 10,
    sessions: [top, { ...top, ...middle }, { ...top, ...current, repsPerSet: [...(current.repsPerSet ?? top.repsPerSet)] }] };
  assert.notEqual(decideDoubleProgression(evidence, item).decision, "PROGRESS");
});

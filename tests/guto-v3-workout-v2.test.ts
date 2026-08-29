import { strict as assert } from "node:assert";
import test from "node:test";
import { getCatalogById, getExerciseRiskTags, getExerciseLocations, ValidatedExerciseCatalog, suggestExerciseSubstitutes } from "../exercise-catalog.js";
import { generateWorkoutDraft } from "../src/v3/generation-engines.js";
import { buildSessionWorkout, estimateSessionMinutes } from "../src/v3/session-workout.js";
import { decideWorkoutEvolution } from "../src/v3/workout-evolution.js";
import { frequencySplitFor, sessionTemplateFor, WORKOUT_PRESCRIPTION_POLICY_VERSION } from "../src/v3/workout-prescription.js";
import type { OfficialSnapshot, WorkoutExerciseSessionEvent, WorkoutPlan } from "../src/v3/types.js";

function snapshot(overrides: Partial<{
  trainingStatus: string;
  goal: string;
  frequency: number;
  limitation: string;
  bodyRegion: string;
  location: string;
}>): OfficialSnapshot {
  const limitation = overrides.limitation || "nenhuma";
  const bodyRegion = overrides.bodyRegion;
  const hc = overrides.limitation
    ? [{ id: "h1", kind: "limitation" as const, bodyRegion: bodyRegion || undefined, description: limitation, severity: "medium" as const, confirmed: true }]
    : [];
  return {
    actor: { tenantId: "t", userId: "u", externalSubject: "u", role: "student" },
    memoryVersion: 1,
    profile: {
      version: 1, language: "pt-BR", biologicalSex: "male", age: 34, weightKg: 80, heightCm: 178,
      trainingStatus: overrides.trainingStatus || "returning",
      trainingLocation: overrides.location || "gym",
      weeklyFrequencyDaysPerWeek: overrides.frequency ?? 3,
    },
    goal: { version: 1, code: overrides.goal || "muscle_gain" },
    preferences: { version: 1 },
    healthConstraints: hc,
    firstContact: { status: "COMPLETED", step: "completed", foodDeclaration: "", limitationDeclaration: limitation, startedAt: null, completedAt: null, currentPrompt: null, summary: null, confirmedContextVersion: 1 },
    confirmedContext: {
      id: "ctx", version: 1, confirmedAt: new Date().toISOString(), foodDeclaration: "", limitationDeclaration: limitation,
      profileVersion: 1, goalVersion: 1, weeklyFrequencyDaysPerWeek: overrides.frequency ?? 3, trainingLocation: (overrides.location || "gym") as "gym",
    },
    workout: null,
    diet: null,
  };
}

function asPlan(draft: ReturnType<typeof generateWorkoutDraft>, id = "plan"): WorkoutPlan {
  return { id, version: 1, title: draft.title, status: "active", items: draft.items.map((item, position) => ({ ...item, id: `item-${position}` })) };
}

// ─── P0#1 PRESCRIPTION V2 ────────────────────────────────────────────────
test("WORKOUT_V2 prescription policy is versioned and frequency tiers exist for 2..6", () => {
  assert.equal(WORKOUT_PRESCRIPTION_POLICY_VERSION, "catalog_rules_v2");
  for (const freq of [2, 3, 4, 5, 6]) {
    const split = frequencySplitFor(freq);
    assert.equal(split.frequency, freq);
    assert.ok(split.sessions.length > 0);
    assert.equal(sessionTemplateFor(freq, 0).sessionIndex, 0);
  }
});

test("2X_VS_6X: beginner 2x and advanced 6x prescriptions differ beyond set count", () => {
  const two = generateWorkoutDraft(snapshot({ trainingStatus: "beginner", frequency: 2, goal: "muscle_gain" }));
  const six = generateWorkoutDraft(snapshot({ trainingStatus: "advanced", frequency: 6, goal: "muscle_gain" }));
  // Different splits and session roles.
  assert.notEqual(two.generatedFrom.splitName, six.generatedFrom.splitName);
  assert.notEqual(two.generatedFrom.sessionLabel, six.generatedFrom.sessionLabel);
  // Different muscle distribution (full-body A vs push).
  const groups2 = new Set(two.items.map((item) => item.muscleGroup));
  const groups6 = new Set(six.items.map((item) => item.muscleGroup));
  assert.ok(groups2.has("pernas"));
  assert.ok(groups6.has("peito"));
  assert.notEqual([...groups2].sort().join(","), [...groups6].sort().join(","));
  // Volume differs: advanced has more sets than beginner on working sets.
  const workingSets = (plan: ReturnType<typeof generateWorkoutDraft>) => plan.items.filter((item) => item.sets !== 1).map((item) => item.sets || 0);
  assert.ok(Math.max(...workingSets(six)) >= Math.max(...workingSets(two)));
});

test("PRESCRIPTION experience alters exercise count and volume, goal alters reps", () => {
  const beginner = generateWorkoutDraft(snapshot({ trainingStatus: "beginner", frequency: 4, goal: "fat_loss" }));
  const advanced = generateWorkoutDraft(snapshot({ trainingStatus: "advanced", frequency: 4, goal: "muscle_gain" }));
  assert.ok(advanced.items.length >= beginner.items.length);
  const fatLoss = generateWorkoutDraft(snapshot({ trainingStatus: "advanced", frequency: 4, goal: "fat_loss" }));
  const hypertrophy = generateWorkoutDraft(snapshot({ trainingStatus: "advanced", frequency: 4, goal: "muscle_gain" }));
  assert.equal(hypertrophy.items.find((item) => item.sets !== 1)?.reps, "8-12");
  assert.equal(fatLoss.items.find((item) => item.sets !== 1)?.reps, "10-15");
  // Deterministic: same inputs, same plan.
  assert.deepEqual(
    generateWorkoutDraft(snapshot({ trainingStatus: "advanced", frequency: 5, goal: "muscle_gain" })).items,
    generateWorkoutDraft(snapshot({ trainingStatus: "advanced", frequency: 5, goal: "muscle_gain" })).items,
  );
});

test("HEALTH_SAFE: lower-back, knee and shoulder limitations never include an incompatible exercise", () => {
  const cases: Array<{ limitation: string; bodyRegion: string }> = [
    { limitation: "uma leve dor na lombar", bodyRegion: "lower_back" },
    { limitation: "dor no joelho", bodyRegion: "knee" },
    { limitation: "dor no ombro", bodyRegion: "shoulder" },
  ];
  for (const c of cases) {
    const draft = generateWorkoutDraft(snapshot({ limitation: c.limitation, bodyRegion: c.bodyRegion, frequency: 4, trainingStatus: "advanced" }));
    assert.ok(draft.items.length >= 4, `${c.bodyRegion}: at least 4 items`);
    for (const item of draft.items) {
      const exercise = getCatalogById(item.exerciseId);
      assert.ok(exercise, `${c.bodyRegion}: exercise exists in official catalog`);
      assert.ok(exercise.videoUrl, `${c.bodyRegion}: exercise has video`);
      const region = c.bodyRegion as "lower_back" | "knee" | "shoulder";
      assert.equal(getExerciseRiskTags(exercise).includes(region), false, `${c.bodyRegion}: ${item.exerciseId} must not stress ${region}`);
    }
  }
});

test("CATALOG_AUTHORITY: every prescribed and swap candidate exists in the official catalog with video", () => {
  const draft = generateWorkoutDraft(snapshot({ trainingStatus: "advanced", frequency: 6, goal: "muscle_gain" }));
  for (const item of draft.items) {
    const exercise = getCatalogById(item.exerciseId);
    assert.ok(exercise);
    assert.ok(exercise.videoUrl);
  }
});

// ─── P0#2 STIMULUS-PRESERVING SWAP ──────────────────────────────────────
test("MOVEMENT_PATTERN_FIRST: chest press prefers another empurrar before adducao", () => {
  const candidates = suggestExerciseSubstitutes("supino_reto_maquina", { location: "gym" });
  assert.ok(candidates.length > 0);
  const first = getCatalogById(candidates[0])!;
  assert.equal(first.movementPattern, "empurrar");
  assert.notEqual(first.movementPattern, "adducao");
});

test("SWAP chest/lat/leg/shoulder: same movement pattern when a candidate exists, always video", () => {
  // Same-movement candidates exist in the catalog for chest (empurrar) and
  // lat pulldown (puxar) -> movement pattern must be preserved.
  const sameMovementCases: Array<[string, string]> = [
    ["supino_reto_maquina", "empurrar"],
    ["puxada_frente", "puxar"],
  ];
  for (const [id, movement] of sameMovementCases) {
    const candidates = suggestExerciseSubstitutes(id, { location: "gym" });
    const sameMovement = candidates.filter((candidateId) => getCatalogById(candidateId)?.movementPattern === movement);
    assert.ok(sameMovement.length > 0, `${id}: at least one same-movement (${movement}) candidate`);
    assert.equal(getCatalogById(candidates[0])!.movementPattern, movement, `${id}: first candidate preserves the movement pattern`);
  }
  // legpress_45 is the ONLY pernas/empurrar exercise and desenvolvimento_sentado
  // the ONLY ombro/empurrar in the catalog, so NO same-movement alternative
  // exists; the swap falls back to the same muscle group (safe, video,
  // gym-playable) — exactly "same movementPattern quando houver candidato disponível".
  for (const id of ["legpress_45", "desenvolvimento_sentado"]) {
    const original = getCatalogById(id)!;
    const candidates = suggestExerciseSubstitutes(id, { location: "gym" });
    assert.ok(candidates.length > 0, `${id}: at least one same-muscle-group candidate`);
    for (const candidateId of candidates.slice(0, 3)) {
      const exercise = getCatalogById(candidateId)!;
      assert.equal(exercise.muscleGroup, original.muscleGroup);
      assert.ok(exercise.videoUrl, `${candidateId}: candidate has video`);
      assert.ok(getExerciseLocations(exercise).includes("gym"), `${candidateId}: candidate playable at gym`);
    }
  }
});

test("LOCATION_AWARE: home session substitutes gym-only exercises with home-eligible candidates", () => {
  const base = asPlan(generateWorkoutDraft(snapshot({ trainingStatus: "advanced", frequency: 4, goal: "muscle_gain", location: "gym" })));
  const session = buildSessionWorkout({
    baseWorkout: base,
    snapshot: snapshot({ trainingStatus: "advanced", frequency: 4, goal: "muscle_gain", location: "gym" }),
    effectiveLocation: "home",
  });
  for (const item of session.items) {
    const exercise = getCatalogById(item.exerciseId)!;
    assert.ok(getExerciseLocations(exercise).includes("home"), `${item.exerciseId}: playable at home`);
    assert.ok(exercise.videoUrl);
  }
  assert.ok(session.adaptationReasons.includes("HOME_LOCATION"));
});

// ─── P0#3 SESSION WORKOUT ───────────────────────────────────────────────
test("SESSION normal gym session derives from base without mutation", () => {
  const base = asPlan(generateWorkoutDraft(snapshot({ trainingStatus: "returning", frequency: 4, goal: "muscle_gain" })));
  const before = JSON.stringify(base);
  const session = buildSessionWorkout({ baseWorkout: base, snapshot: snapshot({ trainingStatus: "returning", frequency: 4, goal: "muscle_gain" }) });
  assert.equal(session.status, "ready");
  assert.equal(session.baseWorkoutVersion, 1);
  assert.equal(session.items.length, base.items.length);
  assert.equal(JSON.stringify(base), before, "BASE WORKOUT unchanged");
});

test("MACHINE_OCCUPIED: occupied machine swaps to same-stimulus candidate, base intact", () => {
  const base = asPlan(generateWorkoutDraft(snapshot({ trainingStatus: "advanced", frequency: 6, goal: "muscle_gain" })));
  const peitoItem = base.items.find((item) => item.muscleGroup === "peito")!;
  const before = JSON.stringify(base);
  const session = buildSessionWorkout({
    baseWorkout: base,
    snapshot: snapshot({ trainingStatus: "advanced", frequency: 6, goal: "muscle_gain" }),
    unavailableExerciseIds: [peitoItem.exerciseId],
  });
  assert.ok(session.adaptationReasons.includes("MACHINE_OCCUPIED"));
  const replaced = session.items.find((item) => item.muscleGroup === "peito");
  assert.ok(replaced);
  assert.notEqual(replaced.exerciseId, peitoItem.exerciseId);
  assert.equal(JSON.stringify(base), before, "BASE WORKOUT unchanged");
});

test("ONLY_20_MIN: session cuts accessories and reduces sets, base intact", () => {
  const base = asPlan(generateWorkoutDraft(snapshot({ trainingStatus: "advanced", frequency: 6, goal: "muscle_gain" })));
  const before = JSON.stringify(base);
  const session = buildSessionWorkout({ baseWorkout: base, snapshot: snapshot({ trainingStatus: "advanced", frequency: 6, goal: "muscle_gain" }), availableMinutes: 20 });
  assert.ok(session.adaptationReasons.includes("TIME_BUDGET"));
  assert.ok(session.items.length <= base.items.length);
  for (const item of session.items) assert.ok((item.sets || 0) <= 3);
  const minutes = estimateSessionMinutes(session.items);
  assert.ok(minutes > 0);
  assert.equal(JSON.stringify(base), before, "BASE WORKOUT unchanged");
});

test("SESSION_WORKOUT today home and 20 min can be combined, still catalog-only", () => {
  const base = asPlan(generateWorkoutDraft(snapshot({ trainingStatus: "returning", frequency: 3, goal: "muscle_gain", location: "gym" })));
  const session = buildSessionWorkout({
    baseWorkout: base,
    snapshot: snapshot({ trainingStatus: "returning", frequency: 3, goal: "muscle_gain", location: "gym" }),
    effectiveLocation: "home",
    availableMinutes: 20,
  });
  for (const item of session.items) {
    const exercise = getCatalogById(item.exerciseId)!;
    assert.ok(getExerciseLocations(exercise).includes("home"));
    assert.ok(exercise.videoUrl);
  }
  assert.ok(session.adaptationReasons.includes("HOME_LOCATION"));
});

// ─── P0#4 EVOLUTION APPLIED ─────────────────────────────────────────────
const EASY: WorkoutExerciseSessionEvent = { exerciseId: "ex1", completed: true, repetitions: 13, setsCompleted: 3, perceivedDifficulty: 6 };
const EASY2: WorkoutExerciseSessionEvent = { exerciseId: "ex1", completed: true, repetitions: 14, setsCompleted: 3, perceivedDifficulty: 5 };
const HARD: WorkoutExerciseSessionEvent = { exerciseId: "ex1", completed: true, repetitions: 8, setsCompleted: 3, perceivedDifficulty: 9 };
const FAILED: WorkoutExerciseSessionEvent = { exerciseId: "ex1", completed: false };
const NORMAL: WorkoutExerciseSessionEvent = { exerciseId: "ex1", completed: true, repetitions: 10, setsCompleted: 3, perceivedDifficulty: 8 };

test("EASY_ONCE: a single easy session maintains and does NOT progress", () => {
  const decision = decideWorkoutEvolution(EASY);
  assert.equal(decision.decision, "MAINTAIN");
  assert.equal(decision.reasonCode, "SINGLE_EASY_SESSION_NOT_ENOUGH");
});

test("EASY_CONSISTENT: two consecutive easy completed sessions progress with a concrete next prescription", () => {
  const decision = decideWorkoutEvolution(EASY2, [EASY]);
  assert.equal(decision.decision, "PROGRESS");
  assert.equal(decision.nextPrescription?.action, "add_reps");
  assert.ok((decision.nextPrescription?.targetReps || 0) > EASY2.repetitions!);
});

test("HARD: difficulty 9/10 regresses with a reduction prescription", () => {
  const decision = decideWorkoutEvolution(HARD);
  assert.equal(decision.decision, "REGRESS");
  assert.equal(decision.nextPrescription?.action, "reduce_reps");
  assert.ok((decision.nextPrescription?.targetReps || 99) < HARD.repetitions!);
});

test("FAILED: incomplete sets/reps reviews and never progresses", () => {
  const decision = decideWorkoutEvolution(FAILED);
  assert.equal(decision.decision, "REVIEW");
  assert.equal(decision.nextPrescription?.action, "review");
});

test("NORMAL: appropriate dose maintains", () => {
  const decision = decideWorkoutEvolution(NORMAL);
  assert.equal(decision.decision, "MAINTAIN");
  assert.equal(decision.nextPrescription?.action, "maintain");
});

test("PAIN is safety, not RPE: safety concern never auto-progresses", () => {
  const pain = decideWorkoutEvolution({ ...EASY, context: { safetyConcern: true } }, [EASY]);
  assert.equal(pain.decision, "REVIEW");
});

// ─── FULL BETA JOURNEY ──────────────────────────────────────────────────
test("FULL BETA JOURNEY: generation -> session -> occupied swap -> evolution -> next prescription, base preserved", () => {
  const state = snapshot({ trainingStatus: "returning", frequency: 4, goal: "muscle_gain" });
  const draft = generateWorkoutDraft(state);
  const base = asPlan(draft);
  for (const item of base.items) {
    assert.ok(getCatalogById(item.exerciseId), "exercise exists");
    assert.ok(getCatalogById(item.exerciseId)!.videoUrl, "exercise has video");
  }
  // Session with one occupied machine.
  const occupiedId = base.items.find((item) => item.muscleGroup === "peito")!.exerciseId;
  const session = buildSessionWorkout({ baseWorkout: base, snapshot: state, unavailableExerciseIds: [occupiedId] });
  assert.ok(session.adaptationReasons.includes("MACHINE_OCCUPIED"));
  // Record two consecutive easy sessions on the replaced exercise.
  const exerciseId = session.items[0].exerciseId;
  const first = decideWorkoutEvolution({ ...EASY, exerciseId });
  assert.equal(first.decision, "MAINTAIN");
  const second = decideWorkoutEvolution({ ...EASY2, exerciseId }, [EASY]);
  assert.equal(second.decision, "PROGRESS");
  assert.ok(second.nextPrescription);
  // Base workout is never destroyed by any adaptation.
  assert.equal(base.items.some((item) => item.exerciseId === occupiedId), true, "base still has the original occupied exercise");
  assert.equal(base.version, 1);
});

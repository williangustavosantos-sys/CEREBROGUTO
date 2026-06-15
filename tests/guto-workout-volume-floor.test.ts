import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enforceMinimumWorkoutVolume } from "../server.js";
import { getCatalogById, getExerciseRiskTags } from "../exercise-catalog.js";

// BUG 4 — usuário "treinando" (consistent) + hipertrofia + academia recebia só 4
// principais (parecia iniciante), e ombro limitado zerava todo o estímulo sem
// repor. O piso de volume recompõe com exercícios SEGUROS do mesmo foco.

function mainEx(id: string) {
  const e = getCatalogById(id);
  if (!e) throw new Error(`catalog id inexistente no teste: ${id}`);
  return {
    id: e.id,
    name: e.canonicalNamePt,
    canonicalNamePt: e.canonicalNamePt,
    muscleGroup: e.muscleGroup,
    sets: 3,
    reps: "10-12",
    rest: "75s",
    cue: "",
    note: "",
    videoUrl: e.videoUrl,
    videoProvider: "local" as const,
    sourceFileName: e.sourceFileName,
  };
}

const WARMUP = {
  id: "bike_academia",
  name: "Bike academia",
  canonicalNamePt: "Bike academia",
  muscleGroup: "aquecimento",
  sets: 1,
  reps: "5 min",
  rest: "0s",
  cue: "",
  note: "",
  videoUrl: "local://bike_academia.mp4",
  videoProvider: "local" as const,
  sourceFileName: "bike_academia.mp4",
};

function buildPlan(ids: string[], withWarmup = true) {
  const exercises = ids.map(mainEx);
  return {
    focus: "Peito e Tríceps",
    focusKey: "chest_triceps",
    dateLabel: "Hoje",
    scheduledFor: new Date().toISOString(),
    summary: "",
    location: "academia",
    exercises: withWarmup ? [WARMUP, ...exercises] : exercises,
  } as any;
}

const FOUR_CHEST_TRI = ["supino_reto", "crucifixo_maquina", "triceps_barra_v_cabo", "triceps_frances_cabo"];
const mainCount = (plan: any) => plan.exercises.filter((e: any) => e.muscleGroup !== "aquecimento").length;

describe("BUG 4 — piso de volume de treino por nível", () => {
  it("consistent ('treinando') + ombro limitado: chega a >=5 principais e NENHUM shoulder-risky", () => {
    const start = buildPlan(FOUR_CHEST_TRI);
    const memory: any = {
      userId: "u-consistent",
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      trainingPathology: "ombro",
      preferredTrainingLocation: "gym",
    };
    const out = enforceMinimumWorkoutVolume(start, {
      focus: "chest_triceps",
      locationMode: "gym",
      language: "pt-BR",
      memory,
    });
    const main = out.exercises.filter((e: any) => e.muscleGroup !== "aquecimento");
    assert.ok(main.length >= 5, `esperava >=5 principais p/ 'treinando', veio ${main.length}`);
    for (const e of main) {
      const entry = getCatalogById(e.id);
      assert.ok(entry, `${e.id} precisa existir no catálogo`);
      assert.ok(
        !getExerciseRiskTags(entry!).includes("shoulder"),
        `${e.id} não pode ser shoulder-risky para usuário com ombro limitado`
      );
    }
    // aquecimento preservado, não duplicado
    assert.equal(out.exercises.filter((e: any) => e.muscleGroup === "aquecimento").length, 1);
  });

  it("advanced eleva o alvo para >=6 principais", () => {
    const start = buildPlan(FOUR_CHEST_TRI);
    const memory: any = { userId: "u-adv", trainingLevel: "advanced", trainingGoal: "muscle_gain", preferredTrainingLocation: "gym" };
    const out = enforceMinimumWorkoutVolume(start, { focus: "chest_triceps", locationMode: "gym", language: "pt-BR", memory });
    assert.ok(mainCount(out) >= 6, `esperava >=6 principais p/ avançado, veio ${mainCount(out)}`);
  });

  it("beginner não infla além de 4 (treino menor para iniciante)", () => {
    const start = buildPlan(FOUR_CHEST_TRI);
    const memory: any = { userId: "u-beg", trainingLevel: "beginner", trainingGoal: "muscle_gain", preferredTrainingLocation: "gym" };
    const out = enforceMinimumWorkoutVolume(start, { focus: "chest_triceps", locationMode: "gym", language: "pt-BR", memory });
    assert.equal(mainCount(out), 4, "iniciante com 4 principais não deve ser inflado");
  });

  it("recompõe a partir de plano gutado (2 principais) sem duplicar id/vídeo", () => {
    const start = buildPlan(["supino_reto", "crucifixo_maquina"]);
    const memory: any = { userId: "u-gutted", trainingLevel: "consistent", trainingGoal: "muscle_gain", preferredTrainingLocation: "gym" };
    const out = enforceMinimumWorkoutVolume(start, { focus: "chest_triceps", locationMode: "gym", language: "pt-BR", memory });
    assert.ok(mainCount(out) >= 5, `esperava recompor p/ >=5, veio ${mainCount(out)}`);
    const ids = out.exercises.map((e: any) => e.id);
    assert.equal(new Set(ids).size, ids.length, "não pode haver id duplicado após recompor");
    const videos = out.exercises.map((e: any) => e.videoUrl);
    assert.equal(new Set(videos).size, videos.length, "não pode haver vídeo duplicado após recompor");
  });
});

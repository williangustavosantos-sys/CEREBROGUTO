import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTrainingLevel,
  applyLevelStructure,
  type LevelWorkoutPlan,
} from "../src/workout-level";

// Fase 3L — o nível de treino vira DOSE real. Estes testes provam, de forma
// determinística, que avançado ≠ iniciante e que o nível altera volume.

function plan(): LevelWorkoutPlan {
  return {
    focus: "Peito e tríceps",
    summary: "Peito e tríceps na academia.",
    exercises: [
      { id: "aquecimento-bike", muscleGroup: "aquecimento", sets: 1, reps: "5min", rest: "0s", note: "" },
      { id: "supino-reto", muscleGroup: "peito", sets: 4, reps: "10", rest: "90s", note: "Base do peito." },
      { id: "supino-inclinado", muscleGroup: "peito", sets: 4, reps: "10", rest: "75s", note: "Parte superior." },
      { id: "triceps-corda", muscleGroup: "bracos", sets: 3, reps: "12", rest: "60s", note: "Isolamento." },
      { id: "triceps-frances", muscleGroup: "bracos", sets: 3, reps: "12", rest: "60s", note: "Cabeça longa." },
    ],
  };
}

function mainSetsOf(p: LevelWorkoutPlan): number {
  // soma das séries dos não-aquecimento
  return p.exercises.filter((e) => e.muscleGroup !== "aquecimento").reduce((s, e) => s + e.sets, 0);
}

describe("resolveTrainingLevel — reconhece os 4 níveis canônicos", () => {
  it("reconhece o enum limpo da calibragem", () => {
    assert.equal(resolveTrainingLevel("advanced"), "advanced");
    assert.equal(resolveTrainingLevel("beginner"), "beginner");
    assert.equal(resolveTrainingLevel("returning"), "returning");
    assert.equal(resolveTrainingLevel("consistent"), "consistent");
  });

  it("reconhece texto livre em pt/it", () => {
    assert.equal(resolveTrainingLevel(undefined, "sou avançado, treino há anos"), "advanced");
    assert.equal(resolveTrainingLevel(undefined, "voltando depois de 2 meses parado"), "returning");
    assert.equal(resolveTrainingLevel(undefined, "principiante"), "beginner");
  });

  it("default seguro = consistent (não rebaixa para iniciante)", () => {
    assert.equal(resolveTrainingLevel(undefined, undefined), "consistent");
    assert.equal(resolveTrainingLevel("", ""), "consistent");
  });
});

describe("applyLevelStructure — nível altera volume/intensidade", () => {
  it("AVANÇADO + academia + hipertrofia gera mais volume que INICIANTE", () => {
    const adv = applyLevelStructure(plan(), { level: "advanced", goal: "muscle_gain", language: "pt-BR" });
    const beg = applyLevelStructure(plan(), { level: "beginner", goal: "muscle_gain", language: "pt-BR" });
    assert.ok(
      mainSetsOf(adv) > mainSetsOf(beg),
      `avançado (${mainSetsOf(adv)}) deve ter mais séries que iniciante (${mainSetsOf(beg)})`
    );
  });

  it("AVANÇADO recebe técnica avançada na nota dos compostos (não é treino fraco)", () => {
    const adv = applyLevelStructure(plan(), { level: "advanced", goal: "muscle_gain", language: "pt-BR" });
    const firstMain = adv.exercises.find((e) => e.muscleGroup !== "aquecimento")!;
    assert.match(firstMain.note, /avançado|rest-pause|falha técnica/i);
    assert.ok(firstMain.sets >= 5, "composto avançado sobe para 5 séries");
    assert.equal(adv.difficulty, "advanced");
  });

  it("INICIANTE não recebe treino avançado: volume limitado a 3 séries", () => {
    const beg = applyLevelStructure(plan(), { level: "beginner", goal: "muscle_gain", language: "pt-BR" });
    for (const ex of beg.exercises.filter((e) => e.muscleGroup !== "aquecimento")) {
      assert.ok(ex.sets <= 3, `iniciante não passa de 3 séries (${ex.id}=${ex.sets})`);
    }
    assert.equal(beg.difficulty, "beginner");
  });

  it("AVANÇADO com dor lombar continua avançado, mas resumo deixa claro que protegeu", () => {
    const adv = applyLevelStructure(plan(), { level: "advanced", goal: "muscle_gain", hasLimitation: true, language: "pt-BR" });
    const beg = applyLevelStructure(plan(), { level: "beginner", goal: "muscle_gain", language: "pt-BR" });
    assert.ok(mainSetsOf(adv) > mainSetsOf(beg), "avançado adaptado ainda tem mais volume que iniciante");
    assert.match(adv.summary, /avançado/i);
    assert.match(adv.summary, /proteg/i);
  });

  it("aquecimento nunca é alterado", () => {
    const adv = applyLevelStructure(plan(), { level: "advanced", goal: "muscle_gain", language: "pt-BR" });
    const warm = adv.exercises.find((e) => e.muscleGroup === "aquecimento")!;
    assert.equal(warm.sets, 1);
    assert.equal(warm.note, "");
  });

  it("consistente mantém o baseline (sem regressão)", () => {
    const con = applyLevelStructure(plan(), { level: "consistent", goal: "muscle_gain", language: "pt-BR" });
    assert.equal(mainSetsOf(con), mainSetsOf(plan()), "consistente = baseline do template");
  });

  it("localiza o descritor de nível (en/it)", () => {
    const en = applyLevelStructure(plan(), { level: "advanced", goal: "muscle_gain", language: "en-US" });
    assert.match(en.summary, /advanced/i);
    const it = applyLevelStructure(plan(), { level: "advanced", goal: "muscle_gain", language: "it-IT" });
    assert.match(it.summary, /avanzato/i);
  });
});

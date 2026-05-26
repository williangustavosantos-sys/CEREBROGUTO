import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  filterExercisesBySafety,
  getExerciseRiskTags,
  getCatalogById,
  toSafetyRegion,
  type CatalogLocation,
} from "../exercise-catalog";
import {
  applySafeExerciseSubstitutions,
  applyWorkoutProgression,
  getProgressionSignal,
  type ProgressionWorkoutPlan,
  type WorkoutFeedbackRecord,
} from "../src/workout-progression";

// Fase 3C — Filtro determinístico de dor / patologia / limitação.
// A raiz (GUTO_SISTEMA_DE_TREINO_E_MISSAO_DETALHADA.md) exige que dor/lesão
// NÃO seja só texto de prompt: exercícios de alto estresse na região lesionada
// precisam ser removidos/substituídos antes do treino final. Estes testes provam
// que a proteção é determinística (não depende do LLM).

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

function plan(ids: string[]): ProgressionWorkoutPlan {
  return {
    focus: "Treino teste",
    focusKey: "legs_core",
    dateLabel: "Hoje",
    scheduledFor: new Date().toISOString(),
    summary: "Treino oficial.",
    exercises: ids.map((id) => exercise(id)),
  } as ProgressionWorkoutPlan;
}

function feedback(overrides: Partial<WorkoutFeedbackRecord> = {}): WorkoutFeedbackRecord {
  return {
    id: "fb-1",
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

function assertNoneRemoved(ids: string[], removed: string[]) {
  const kept = new Set(ids);
  for (const id of removed) assert.ok(!kept.has(id), `${id} deveria ter sido removido`);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Fase 3C — normalização de região (toSafetyRegion)", () => {
  it("mapeia PT/IT/EN e tags _sensitive para a região canônica", () => {
    assert.equal(toSafetyRegion("joelho direito"), "knee");
    assert.equal(toSafetyRegion("knee_sensitive"), "knee");
    assert.equal(toSafetyRegion("ginocchio"), "knee");
    assert.equal(toSafetyRegion("lombar"), "lower_back");
    assert.equal(toSafetyRegion("lower_back"), "lower_back");
    assert.equal(toSafetyRegion("ombro"), "shoulder");
    assert.equal(toSafetyRegion("spalla"), "shoulder");
    assert.equal(toSafetyRegion("punho"), "wrist");
    assert.equal(toSafetyRegion("cotovelo"), "elbow");
    assert.equal(toSafetyRegion("tornozelo"), "ankle");
    assert.equal(toSafetyRegion("quadril"), "hip");
  });

  it("retorna undefined para texto sem região física (limitação genérica)", () => {
    assert.equal(toSafetyRegion("general"), undefined);
    assert.equal(toSafetyRegion("physical_attention"), undefined);
    assert.equal(toSafetyRegion(""), undefined);
  });
});

describe("Fase 3C — getExerciseRiskTags (derivação determinística)", () => {
  it("joelho: agachamento, afundo, búlgaro, leg extension, leg press e impacto", () => {
    assert.ok(getExerciseRiskTags(getCatalogById("agachamento_livre")!).includes("knee"));
    assert.ok(getExerciseRiskTags(getCatalogById("afundo_halter")!).includes("knee"));
    assert.ok(getExerciseRiskTags(getCatalogById("bulgaro_halter")!).includes("knee"));
    assert.ok(getExerciseRiskTags(getCatalogById("cadeira_extensora")!).includes("knee"));
    assert.ok(getExerciseRiskTags(getCatalogById("legpress_45")!).includes("knee"));
    assert.ok(getExerciseRiskTags(getCatalogById("burpee")!).includes("knee"));
    assert.ok(getExerciseRiskTags(getCatalogById("sobe_desce_caixote_unilateral")!).includes("knee"));
  });

  it("lombar: agachamento com barra/smith, remada cavalinho", () => {
    assert.ok(getExerciseRiskTags(getCatalogById("agachamento_smith")!).includes("lower_back"));
    assert.ok(getExerciseRiskTags(getCatalogById("remada_cavalinho")!).includes("lower_back"));
    // goblet com halter não é carga axial alta → não marca lombar
    assert.ok(!getExerciseRiskTags(getCatalogById("agachamento_halter_abaixo")!).includes("lower_back"));
  });

  it("ombro: desenvolvimento (overhead), elevações, remada alta (upright row)", () => {
    assert.ok(getExerciseRiskTags(getCatalogById("desenvolvimento_sentado")!).includes("shoulder"));
    assert.ok(getExerciseRiskTags(getCatalogById("elevacao_lateral_halter_sentado")!).includes("shoulder"));
    assert.ok(getExerciseRiskTags(getCatalogById("remada_alta_guiada")!).includes("shoulder"));
    assert.ok(getExerciseRiskTags(getCatalogById("remada_alta_halter")!).includes("shoulder"));
  });

  it("punho/cotovelo: flexão (push-up), paralelas/dips, tríceps testa", () => {
    const flexao = getExerciseRiskTags(getCatalogById("flexao")!);
    assert.ok(flexao.includes("wrist") && flexao.includes("elbow"));
    const dips = getExerciseRiskTags(getCatalogById("paralelas_gravitron")!);
    assert.ok(dips.includes("wrist") && dips.includes("elbow") && dips.includes("shoulder"));
    assert.ok(getExerciseRiskTags(getCatalogById("triceps_testa_barra")!).includes("elbow"));
  });

  it("alternativas seguras NÃO recebem tags de risco indevidas", () => {
    // hip thrust e glute bridge são alternativas seguras para joelho (raiz)
    assert.ok(!getExerciseRiskTags(getCatalogById("elevacao_quadril_barra_banco")!).includes("knee"));
    assert.ok(!getExerciseRiskTags(getCatalogById("aducao_abducao_elevacao_quadril")!).includes("knee"));
    // hip thrust não é "ombro" só por ter "elevacao" no id
    assert.ok(!getExerciseRiskTags(getCatalogById("elevacao_quadril_barra_banco")!).includes("shoulder"));
    // leg curl é seguro para joelho
    assert.ok(!getExerciseRiskTags(getCatalogById("posterior_maquina")!).includes("knee"));
    // supino em máquina não estressa punho como push-up
    assert.ok(!getExerciseRiskTags(getCatalogById("supino_reto_maquina")!).includes("wrist"));
    // puxada frente (lat pulldown) é puxada controlada → não é risco de ombro
    assert.ok(!getExerciseRiskTags(getCatalogById("puxada_frente")!).includes("shoulder"));
  });
});

describe("Fase 3C — filterExercisesBySafety (remoção por região)", () => {
  it("dor no joelho remove alto estresse de joelho e mantém alternativas seguras", () => {
    const ids = [
      "agachamento_livre", "afundo_halter", "bulgaro_halter", "cadeira_extensora",
      "legpress_45", "burpee",
      "posterior_maquina", "elevacao_quadril_barra_banco", "supino_reto_maquina",
    ];
    const safe = filterExercisesBySafety(ids, { userBodyRegion: "knee" });
    assertNoneRemoved(safe, ["agachamento_livre", "afundo_halter", "bulgaro_halter", "cadeira_extensora", "legpress_45", "burpee"]);
    assert.ok(safe.includes("posterior_maquina"));
    assert.ok(safe.includes("elevacao_quadril_barra_banco"));
    assert.ok(safe.includes("supino_reto_maquina"));
  });

  it("dor lombar remove carga axial alta e mantém máquinas/suportes", () => {
    const ids = ["agachamento_smith", "remada_cavalinho", "remada_neutra_maquina", "posterior_maquina"];
    const safe = filterExercisesBySafety(ids, { userBodyRegion: "lower_back" });
    assertNoneRemoved(safe, ["agachamento_smith", "remada_cavalinho"]);
    assert.ok(safe.includes("remada_neutra_maquina"));
    assert.ok(safe.includes("posterior_maquina"));
  });

  it("dor no ombro remove overhead/elevações/upright e mantém puxada controlada", () => {
    const ids = ["desenvolvimento_sentado", "elevacao_lateral_halter_sentado", "remada_alta_halter", "puxada_frente"];
    const safe = filterExercisesBySafety(ids, { userBodyRegion: "shoulder" });
    assertNoneRemoved(safe, ["desenvolvimento_sentado", "elevacao_lateral_halter_sentado", "remada_alta_halter"]);
    assert.ok(safe.includes("puxada_frente"));
  });

  it("dor no punho remove push-up/dips e mantém supino em máquina", () => {
    const ids = ["flexao", "paralelas_gravitron", "supino_reto_maquina"];
    const safe = filterExercisesBySafety(ids, { userBodyRegion: "wrist" });
    assertNoneRemoved(safe, ["flexao", "paralelas_gravitron"]);
    assert.ok(safe.includes("supino_reto_maquina"));
  });

  it("dor no cotovelo remove tríceps testa/dips e mantém roscas leves", () => {
    const ids = ["triceps_testa_barra", "paralelas_gravitron", "rosca_alternada"];
    const safe = filterExercisesBySafety(ids, { userBodyRegion: "elbow" });
    assertNoneRemoved(safe, ["triceps_testa_barra", "paralelas_gravitron"]);
    assert.ok(safe.includes("rosca_alternada"));
  });

  it("riskTag _sensitive (sem bodyRegion) ainda deriva a região e remove", () => {
    const ids = ["agachamento_livre", "posterior_maquina"];
    const safe = filterExercisesBySafety(ids, { userRiskTags: ["physical_attention", "knee_sensitive", "load_sensitive"] });
    assert.ok(!safe.includes("agachamento_livre"));
    assert.ok(safe.includes("posterior_maquina"));
  });

  it("sem dor/patologia → comportamento normal não quebra (lista intacta)", () => {
    const ids = ["agachamento_livre", "desenvolvimento_sentado", "flexao", "supino_reto"];
    assert.deepEqual(filterExercisesBySafety(ids, {}), ids);
    assert.deepEqual(filterExercisesBySafety(ids, { userBodyRegion: "" }), ids);
  });

  it("id fora do catálogo é mantido (passthrough), não quebra", () => {
    const safe = filterExercisesBySafety(["id_inexistente_xyz", "agachamento_livre"], { userBodyRegion: "knee" });
    assert.ok(safe.includes("id_inexistente_xyz"));
    assert.ok(!safe.includes("agachamento_livre"));
  });
});

describe("Fase 3C — applySafeExerciseSubstitutions (substituição segura)", () => {
  it("usuário home com dor no joelho: substitui mantendo home + vídeo local", () => {
    const unsafe = plan(["bike_academia", "agachamento_livre", "prancha_isometrica"]);
    const safe = applySafeExerciseSubstitutions(unsafe, {
      location: "home" as CatalogLocation,
      userBodyRegion: "knee",
      language: "pt-BR",
    });

    assert.ok(!safe.exercises.some((e) => e.id === "agachamento_livre"));
    assert.ok(safe.exercises.length >= 2);
    for (const item of safe.exercises) {
      // gate de vídeo local continua obrigatório
      assert.equal(item.videoProvider, "local");
      assert.ok(item.videoUrl.startsWith("/exercise/visuals/"));
      const entry = getCatalogById(item.id);
      assert.ok(entry, `${item.id} deve ser do catálogo (com vídeo validado)`);
      // nenhum exercício final pode estressar o joelho
      assert.ok(!getExerciseRiskTags(entry!).includes("knee"), `${item.id} não deveria estressar joelho`);
    }
  });

  it("se o plano inteiro é inseguro, o resultado nunca contém exercício agressivo", () => {
    const unsafe = plan(["agachamento_livre", "afundo_halter", "bulgaro_halter"]);
    const safe = applySafeExerciseSubstitutions(unsafe, {
      location: "gym" as CatalogLocation,
      userBodyRegion: "knee",
      language: "pt-BR",
    });
    for (const item of safe.exercises) {
      const entry = getCatalogById(item.id);
      assert.ok(entry, `${item.id} deve ser do catálogo`);
      assert.ok(!getExerciseRiskTags(entry!).includes("knee"), `${item.id} não pode estressar joelho`);
      assert.equal(item.videoProvider, "local");
    }
  });

  it("dor no ombro: nenhum exercício final estressa o ombro", () => {
    const unsafe = plan(["desenvolvimento_sentado", "elevacao_lateral_halter_sentado", "puxada_frente"]);
    const safe = applySafeExerciseSubstitutions(unsafe, {
      location: "gym" as CatalogLocation,
      userBodyRegion: "shoulder",
      language: "pt-BR",
    });
    for (const item of safe.exercises) {
      const entry = getCatalogById(item.id);
      assert.ok(entry);
      assert.ok(!getExerciseRiskTags(entry!).includes("shoulder"), `${item.id} não pode estressar ombro`);
    }
  });
});

describe("Fase 3C — iniciante com dor entra em modo conservador", () => {
  it("feedback de dor gera deload (sinal conservador)", () => {
    const history = [feedback({ difficulty: "pain", painArea: "joelho" })];
    assert.equal(getProgressionSignal(history), "deload");
    const deload = applyWorkoutProgression(
      plan(["bike_academia", "supino_reto"]),
      history,
    );
    assert.equal(deload.difficulty, "conservative");
  });
});

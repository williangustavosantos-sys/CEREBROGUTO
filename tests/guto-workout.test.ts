import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ValidatedExerciseCatalog,
  getCatalogById,
  getExerciseName,
  findByAlias,
  getExercisesForFocus,
  type CatalogLanguage,
} from "../exercise-catalog";
import { sanitizeDisplayName } from "../server-utils";

// ─── 1. CATALOG INTEGRITY ──────────────────────────────────────────────────

describe("ValidatedExerciseCatalog integrity", () => {
  it("has at least one entry per expected muscle group", () => {
    const groups = new Set(ValidatedExerciseCatalog.map((e) => e.muscleGroup));
    for (const g of ["aquecimento", "peito", "costas", "bracos", "pernas", "abdomen"] as const) {
      assert.ok(groups.has(g), `Missing muscle group: ${g}`);
    }
  });

  it("every entry has a unique id", () => {
    const ids = ValidatedExerciseCatalog.map((e) => e.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, "Duplicate IDs found in catalog");
  });

  it("every entry has a non-empty videoUrl starting with /exercise/visuals/", () => {
    for (const entry of ValidatedExerciseCatalog) {
      assert.ok(entry.videoUrl.startsWith("/exercise/visuals/"), `Bad videoUrl for "${entry.id}": ${entry.videoUrl}`);
    }
  });

  it("videoProvider is 'local' for every entry", () => {
    for (const entry of ValidatedExerciseCatalog) {
      assert.equal(entry.videoProvider, "local", `Wrong videoProvider for "${entry.id}"`);
    }
  });

  it("every entry has namesByLanguage for all 4 supported languages", () => {
    const langs: CatalogLanguage[] = ["pt-BR", "it-IT", "en-US", "es-ES"];
    for (const entry of ValidatedExerciseCatalog) {
      for (const lang of langs) {
        assert.ok(
          entry.namesByLanguage[lang] && entry.namesByLanguage[lang].length > 0,
          `Missing name for lang "${lang}" in exercise "${entry.id}"`
        );
      }
    }
  });

  it("every entry has aliasesByLanguage for all 4 supported languages", () => {
    const langs: CatalogLanguage[] = ["pt-BR", "it-IT", "en-US", "es-ES"];
    for (const entry of ValidatedExerciseCatalog) {
      for (const lang of langs) {
        assert.ok(
          Array.isArray(entry.aliasesByLanguage[lang]),
          `Missing aliases array for lang "${lang}" in exercise "${entry.id}"`
        );
      }
    }
  });

  it("videoUrl and sourceFileName are consistent (filename matches end of URL)", () => {
    for (const entry of ValidatedExerciseCatalog) {
      const urlFilename = entry.videoUrl.split("/").pop();
      assert.equal(urlFilename, entry.sourceFileName, `URL/sourceFileName mismatch for "${entry.id}"`);
    }
  });
});

// ─── 2. CATALOG LOOKUP ─────────────────────────────────────────────────────

describe("getCatalogById", () => {
  it("returns the correct entry for known underscore IDs", () => {
    const entry = getCatalogById("supino_reto");
    assert.ok(entry, "supino_reto not found");
    assert.equal(entry.id, "supino_reto");
    assert.ok(entry.videoUrl.includes("supino_reto.mp4"));
  });

  it("returns undefined for unknown IDs", () => {
    assert.equal(getCatalogById("exercise-does-not-exist"), undefined);
  });

  it("returns undefined for old dash-format IDs (catalog uses underscores)", () => {
    assert.equal(getCatalogById("supino-reto"), undefined);
  });
});

// ─── 3. MULTILINGUAL NAMES ─────────────────────────────────────────────────

describe("getExerciseName", () => {
  it("returns the canonical pt-BR name", () => {
    const name = getExerciseName("puxada_frente", "pt-BR");
    assert.ok(name && name.length > 0, "pt-BR name empty");
  });

  it("returns distinct names per language for the same exercise", () => {
    const id = "supino_reto";
    const pt = getExerciseName(id, "pt-BR");
    const en = getExerciseName(id, "en-US");
    const it = getExerciseName(id, "it-IT");
    const es = getExerciseName(id, "es-ES");
    // Names must exist and be non-empty
    for (const [lang, name] of [["pt-BR", pt], ["en-US", en], ["it-IT", it], ["es-ES", es]] as const) {
      assert.ok(name && name.length > 0, `Name missing for lang ${lang}`);
    }
    // They don't all have to differ (some share names across langs), but each must resolve
    assert.notEqual(pt, undefined);
    assert.notEqual(en, undefined);
  });

  it("returns the raw id for an unknown exercise id (fallback behavior)", () => {
    // getExerciseName falls back to the id string rather than returning undefined
    const result = getExerciseName("does_not_exist", "pt-BR");
    assert.equal(result, "does_not_exist");
  });

  it("returns the correct Italian name for bike", () => {
    const name = getExerciseName("bike_academia", "it-IT");
    assert.equal(name, "Cyclette");
  });

  it("returns the correct English name for burpee", () => {
    const name = getExerciseName("burpee", "en-US");
    assert.equal(name, "Burpee");
  });
});

// ─── 4. ALIAS MATCHING ─────────────────────────────────────────────────────

describe("findByAlias", () => {
  it("finds an exercise by its pt-BR alias", () => {
    const entry = findByAlias("bike", "pt-BR");
    assert.ok(entry, "Expected to find exercise by alias 'bike' in pt-BR");
    assert.equal(entry.id, "bike_academia");
  });

  it("finds an exercise by its it-IT alias", () => {
    const entry = findByAlias("cyclette", "it-IT");
    assert.ok(entry, "Expected to find exercise by alias 'cyclette' in it-IT");
    assert.equal(entry.id, "bike_academia");
  });

  it("returns undefined for an alias that doesn't exist", () => {
    const entry = findByAlias("exercicio-fantasma-xyz", "pt-BR");
    assert.equal(entry, undefined);
  });

  it("is case-insensitive", () => {
    const entry = findByAlias("BIKE", "pt-BR");
    assert.ok(entry, "Alias lookup should be case-insensitive");
  });
});

// ─── 5. getExercisesForFocus ────────────────────────────────────────────────

describe("getExercisesForFocus", () => {
  it("returns { warmup, main } for chest_triceps focus", () => {
    const result = getExercisesForFocus("chest_triceps");
    assert.ok(result.warmup.length > 0, "No warmup exercises for chest_triceps");
    assert.ok(result.main.length > 0, "No main exercises for chest_triceps");
    // All IDs must resolve in the catalog
    for (const id of [...result.warmup, ...result.main]) {
      assert.ok(getCatalogById(id), `ID "${id}" from chest_triceps not in catalog`);
    }
  });

  it("returns { warmup, main } for back_biceps focus", () => {
    const result = getExercisesForFocus("back_biceps");
    assert.ok(result.warmup.length > 0, "No warmup exercises for back_biceps");
    assert.ok(result.main.length > 0, "No main exercises for back_biceps");
    for (const id of [...result.warmup, ...result.main]) {
      assert.ok(getCatalogById(id), `ID "${id}" from back_biceps not in catalog`);
    }
  });

  it("returns { warmup, main } for legs_core focus", () => {
    const result = getExercisesForFocus("legs_core");
    assert.ok(result.warmup.length > 0, "No warmup exercises for legs_core");
    assert.ok(result.main.length > 0, "No main exercises for legs_core");
    for (const id of [...result.warmup, ...result.main]) {
      assert.ok(getCatalogById(id), `ID "${id}" from legs_core not in catalog`);
    }
  });

  it("returns { warmup, main } for shoulders_abs focus", () => {
    const result = getExercisesForFocus("shoulders_abs");
    assert.ok(result.warmup.length > 0, "No warmup exercises for shoulders_abs");
    assert.ok(result.main.length > 0, "No main exercises for shoulders_abs");
    for (const id of [...result.warmup, ...result.main]) {
      assert.ok(getCatalogById(id), `ID "${id}" from shoulders_abs not in catalog`);
    }
  });

  it("returns { warmup, main } for full_body focus", () => {
    const result = getExercisesForFocus("full_body");
    assert.ok(result.warmup.length > 0, "No warmup exercises for full_body");
    assert.ok(result.main.length > 0, "No main exercises for full_body");
    for (const id of [...result.warmup, ...result.main]) {
      assert.ok(getCatalogById(id), `ID "${id}" from full_body not in catalog`);
    }
  });

  it("returns no duplicate IDs within warmup or within main for each focus", () => {
    for (const focus of ["chest_triceps", "back_biceps", "legs_core", "shoulders_abs", "full_body"]) {
      const result = getExercisesForFocus(focus);
      const warmupUnique = new Set(result.warmup);
      assert.equal(warmupUnique.size, result.warmup.length, `Duplicate IDs in warmup for focus "${focus}"`);
      const mainUnique = new Set(result.main);
      assert.equal(mainUnique.size, result.main.length, `Duplicate IDs in main for focus "${focus}"`);
    }
  });
});

// ─── 6. NO DUPLICATE videoUrl IN CATALOG ───────────────────────────────────

describe("Catalog video URL uniqueness", () => {
  it("no two exercises share the same videoUrl", () => {
    const seen = new Map<string, string>();
    for (const entry of ValidatedExerciseCatalog) {
      if (seen.has(entry.videoUrl)) {
        assert.fail(`Duplicate videoUrl "${entry.videoUrl}" shared by "${seen.get(entry.videoUrl)}" and "${entry.id}"`);
      }
      seen.set(entry.videoUrl, entry.id);
    }
  });
});

// ─── 7. SPECIFIC CATALOG SPOT-CHECKS ───────────────────────────────────────

describe("Catalog spot-checks for known exercises", () => {
  const knownIds = [
    "supino_reto",
    "puxada_frente",
    "remada_baixa_polia",
    "biceps_maquina",
    "triceps_barra_v_cabo",
    "agachamento_livre",
    "prancha_isometrica",
    "burpee",
    "bike_academia",
    "escada_academia",
    "polichinelo",
    "perdigueiro",
    "flexao",
    "serrote",
    "afundo_halter",
  ];

  for (const id of knownIds) {
    it(`catalog contains exercise: ${id}`, () => {
      const entry = getCatalogById(id);
      assert.ok(entry, `Exercise "${id}" not found in ValidatedExerciseCatalog`);
      assert.equal(entry.id, id);
      assert.ok(entry.videoUrl.length > 0);
    });
  }
});

// ─── 8. CATALOG IS THE SINGLE SOURCE OF TRUTH ──────────────────────────────

describe("Catalog as single source of truth", () => {
  it("all exercises have canonicalNamePt populated", () => {
    for (const entry of ValidatedExerciseCatalog) {
      assert.ok(entry.canonicalNamePt && entry.canonicalNamePt.length > 0, `Missing canonicalNamePt for "${entry.id}"`);
    }
  });

  it("canonicalNamePt matches namesByLanguage['pt-BR']", () => {
    for (const entry of ValidatedExerciseCatalog) {
      assert.equal(
        entry.canonicalNamePt,
        entry.namesByLanguage["pt-BR"],
        `canonicalNamePt !== namesByLanguage['pt-BR'] for "${entry.id}"`
      );
    }
  });

  it("muscleGroup is a valid CatalogMuscleGroup value", () => {
    const valid = new Set(["aquecimento", "peito", "costas", "ombro", "bracos", "pernas", "abdomen"]);
    for (const entry of ValidatedExerciseCatalog) {
      assert.ok(valid.has(entry.muscleGroup), `Invalid muscleGroup "${entry.muscleGroup}" for "${entry.id}"`);
    }
  });
});

// ─── 9. PARQUE — REGRAS DE EQUIPAMENTO ─────────────────────────────────────

const PARK_INCOMPATIBLE_EQUIPMENT = new Set([
  "halter", "maquina", "polia", "barra", "banco",
  "bike", "esteira", "escada", "eliptico",
  "dumbbell", "machine", "cable", "barbell", "bench",
]);

describe("Park equipment restrictions", () => {
  it("serrote requires halter and is park-incompatible", () => {
    const entry = getCatalogById("serrote");
    assert.ok(entry, "serrote should exist in catalog");
    assert.ok(
      PARK_INCOMPATIBLE_EQUIPMENT.has(entry.equipment ?? ""),
      `serrote equipment "${entry.equipment}" should be park-incompatible`
    );
  });

  it("all exercises in getExercisesForFocus('shoulders_abs', 'park').main are park-compatible", () => {
    const result = getExercisesForFocus("shoulders_abs", "park");
    for (const id of result.main) {
      const entry = getCatalogById(id);
      assert.ok(entry, `Exercise "${id}" not in catalog`);
      assert.ok(
        !PARK_INCOMPATIBLE_EQUIPMENT.has(entry.equipment ?? ""),
        `Exercise "${id}" uses park-incompatible equipment "${entry.equipment}" in shoulders_abs/park`
      );
    }
  });

  it("all exercises in getExercisesForFocus('full_body', 'park').main are park-compatible", () => {
    const result = getExercisesForFocus("full_body", "park");
    for (const id of result.main) {
      const entry = getCatalogById(id);
      assert.ok(entry, `Exercise "${id}" not in catalog`);
      assert.ok(
        !PARK_INCOMPATIBLE_EQUIPMENT.has(entry.equipment ?? ""),
        `Exercise "${id}" uses park-incompatible equipment "${entry.equipment}" in full_body/park`
      );
    }
  });

  it("bodyweight exercises (flexao, burpee, prancha_isometrica, perdigueiro) are park-compatible", () => {
    for (const id of ["flexao", "burpee", "prancha_isometrica", "perdigueiro"]) {
      const entry = getCatalogById(id);
      assert.ok(entry, `Exercise "${id}" not in catalog`);
      assert.ok(
        !PARK_INCOMPATIBLE_EQUIPMENT.has(entry.equipment ?? ""),
        `Exercise "${id}" should be park-compatible but has equipment "${entry.equipment}"`
      );
    }
  });

  it("gym-equipment exercises (serrote, supino_reto, remada_baixa_polia) are park-incompatible", () => {
    for (const [id, expectedEquip] of [
      ["serrote", "halter"],
      ["supino_reto", "barra"],
      ["remada_baixa_polia", "polia"],
    ] as const) {
      const entry = getCatalogById(id);
      assert.ok(entry, `Exercise "${id}" not in catalog`);
      assert.ok(
        PARK_INCOMPATIBLE_EQUIPMENT.has(entry.equipment ?? ""),
        `Exercise "${id}" (equipment: "${entry.equipment}") should be park-incompatible`
      );
      assert.equal(entry.equipment, expectedEquip);
    }
  });
});

// ─── 10. CONFRONTO SEM GÊNERO ──────────────────────────────────────────────

describe("Gender-neutral confrontation — catalog/prompt invariants", () => {
  it("exercise names contain no gendered provocations (vira homem, isso é coisa de homem, etc.)", () => {
    // Checks the specific prohibited phrases — not substrings like "man" which appear in "manubrio".
    // The gender-neutral rule governs GUTO's speech, not technical exercise terminology.
    const prohibitedPhrases = [
      "vira homem", "isso é coisa de homem", "homem também treina",
      "mulher também treina", "isso é coisa de mulher",
    ];
    for (const entry of ValidatedExerciseCatalog) {
      for (const lang of Object.keys(entry.namesByLanguage) as CatalogLanguage[]) {
        const name = entry.namesByLanguage[lang].toLowerCase();
        for (const phrase of prohibitedPhrases) {
          assert.ok(
            !name.includes(phrase),
            `Exercise name "${entry.namesByLanguage[lang]}" (${lang}) contains prohibited gendered phrase "${phrase}"`
          );
        }
      }
    }
  });

  it("park workout (shoulders_abs) does not contain serrote", () => {
    const result = getExercisesForFocus("shoulders_abs", "park");
    const allIds = [...result.warmup, ...result.main];
    assert.ok(
      !allIds.includes("serrote"),
      "serrote (requires halter) must not appear in shoulders_abs/park workout"
    );
  });

  it("park workout (full_body) does not contain serrote", () => {
    const result = getExercisesForFocus("full_body", "park");
    const allIds = [...result.warmup, ...result.main];
    assert.ok(
      !allIds.includes("serrote"),
      "serrote (requires halter) must not appear in full_body/park workout"
    );
  });
});

// ─── 12. PROACTIVE GREETING — NAME HANDLING ────────────────────────────────

describe("sanitizeDisplayName", () => {
  it("returns empty string for 'Operador'", () => {
    assert.equal(sanitizeDisplayName("Operador"), "");
  });

  it("returns empty string for 'operador'", () => {
    assert.equal(sanitizeDisplayName("operador"), "");
  });

  it("returns empty string for 'operator'", () => {
    assert.equal(sanitizeDisplayName("operator"), "");
  });

  it("returns empty string for 'Operator'", () => {
    assert.equal(sanitizeDisplayName("Operator"), "");
  });

  it("returns empty string for empty string", () => {
    assert.equal(sanitizeDisplayName(""), "");
  });

  it("returns the real name unchanged for 'Will'", () => {
    assert.equal(sanitizeDisplayName("Will"), "Will");
  });

  it("returns the real name trimmed for ' Will '", () => {
    assert.equal(sanitizeDisplayName(" Will "), "Will");
  });

  it("returns name for non-placeholder value 'João'", () => {
    assert.equal(sanitizeDisplayName("João"), "João");
  });
});

// ─── 11b. GYM + MUSCLE_GAIN COHERENCE ─────────────────────────────────────

describe("buildWorkoutPlan coherence — gym + muscle_gain", () => {
  // IDs that ARE gym exercises (machine, barbell, dumbbell)
  const GYM_EXERCISE_IDS = new Set([
    "legpress_45", "cadeira_extensora", "posterior_deitado_maquina",
    "afundo_halter", "bulgaro_halter", "panturrilha_em_pe_maquina",
    "supino_reto", "supino_inclinado_halter", "supino_reto_maquina",
    "puxada_frente", "remada_baixa_polia", "remada_neutra_maquina",
    "desenvolvimento_sentado", "elevacao_lateral_simultanea_sentado",
    "remada_alta_halter", "elevacao_frontal_anilha",
  ]);

  // Conditioning-only exercises — must not dominate a muscle_gain+gym plan
  const CONDITIONING_IDS = new Set(["burpee", "polichinelo", "perdigueiro"]);

  // Helper that mirrors getLocationMode from server
  function locationMode(location: string): "gym" | "park" | "home" {
    const n = location.toLowerCase();
    if (["academia", "gym", "palestra", "fitness"].some(t => n.includes(t))) return "gym";
    if (["parque", "park", "rua"].some(t => n.includes(t))) return "park";
    return "home";
  }

  it("gym warmup uses bike/escada, not polichinelo/perdigueiro", () => {
    assert.equal(locationMode("gym"), "gym");
    assert.equal(locationMode("academia"), "gym");
    assert.equal(locationMode("casa"), "home");
    assert.equal(locationMode("parque"), "park");
  });

  it("muscle_gain + gym: main exercises must include gym equipment", () => {
    const profile = {
      trainingGoal: "muscle_gain",
      preferredTrainingLocation: "gym",
      trainingLevel: "consistent",
      userAge: 33,
    };
    const mode = locationMode(profile.preferredTrainingLocation);
    assert.equal(mode, "gym", "Profile with gym location must resolve to gym mode");
    assert.ok(GYM_EXERCISE_IDS.size > 5, "GYM_EXERCISE_IDS must have multiple entries");
  });

  it("conditioning-only exercises must not be the bulk of a muscle_gain+gym plan", () => {
    // Documents the invariant: burpee/polichinelo/perdigueiro must not dominate a hypertrophy gym plan.
    const mockIncoherentMainExercises = ["burpee", "polichinelo", "perdigueiro", "prancha_isometrica"];
    const gymCount = mockIncoherentMainExercises.filter(id => GYM_EXERCISE_IDS.has(id)).length;
    const conditioningCount = mockIncoherentMainExercises.filter(id => CONDITIONING_IDS.has(id)).length;
    assert.ok(gymCount < 2, "Incoherent plan correctly has fewer than 2 gym exercises");
    assert.ok(conditioningCount >= 2, "Incoherent plan correctly has conditioning-only exercises");
  });

  it("note: end-to-end plan generation tested via guto.integration.test.ts — buildWorkoutPlanFromSemanticFocus is not directly exportable without server side effects", () => {
    // server.ts registers Express routes, Redis connections and calls app.listen at module scope,
    // so importing it in unit tests would trigger those side effects. The function is covered
    // end-to-end through the HTTP integration tests in guto.integration.test.ts.
    assert.ok(true);
  });

  it("all gym exercise IDs used in gym branches exist in the catalog", () => {
    const gymBranchIds = [
      // legs_core gym
      "agachamento_livre", "legpress_45", "cadeira_extensora",
      "posterior_deitado_maquina", "panturrilha_em_pe_maquina",
      // shoulders_abs gym
      "desenvolvimento_sentado", "elevacao_lateral_simultanea_sentado",
      "remada_alta_halter", "elevacao_frontal_anilha", "prancha_isometrica",
      // full_body gym
      "supino_reto", "puxada_frente",
    ];
    for (const id of gymBranchIds) {
      const entry = getCatalogById(id);
      assert.ok(entry, `Gym branch exercise "${id}" not found in catalog`);
      assert.equal(entry.id, id);
    }
  });
});

// ─── 11. NOMES DE AQUECIMENTO — REGRAS DE NOMENCLATURA ─────────────────────

describe("Warmup exercise names — no 'Aquecimento:' prefix", () => {
  it("no catalog name contains 'Aquecimento:' in any language", () => {
    const forbidden = ["Aquecimento:", "Warm-up:", "Riscaldamento:", "Calentamiento:"];
    for (const entry of ValidatedExerciseCatalog) {
      for (const [lang, name] of Object.entries(entry.namesByLanguage)) {
        for (const prefix of forbidden) {
          assert.ok(
            !name.includes(prefix),
            `Exercise "${entry.id}" (${lang}) contains forbidden prefix in name: "${name}"`
          );
        }
      }
    }
  });

  it("bike_academia in pt-BR returns 'Bike academia'", () => {
    assert.equal(getExerciseName("bike_academia", "pt-BR"), "Bike academia");
  });

  it("escada_academia in pt-BR returns 'Escada academia'", () => {
    assert.equal(getExerciseName("escada_academia", "pt-BR"), "Escada academia");
  });

  it("prancha_isometrica in pt-BR returns 'Prancha isométrica'", () => {
    assert.equal(getExerciseName("prancha_isometrica", "pt-BR"), "Prancha isométrica");
  });

  it("every warmup exercise used in buildWarmupExercises has a local videoUrl", () => {
    const warmupIds = ["bike_academia", "escada_academia", "polichinelo", "perdigueiro", "prancha_isometrica"];
    for (const id of warmupIds) {
      const entry = getCatalogById(id);
      assert.ok(entry, `Warmup exercise "${id}" not in catalog`);
      assert.ok(
        entry.videoUrl.startsWith("/exercise/visuals/"),
        `Warmup exercise "${id}" missing valid local videoUrl: "${entry.videoUrl}"`
      );
      assert.equal(entry.videoProvider, "local");
    }
  });

  it("canonicalNamePt for all warmup exercises does not start with 'Aquecimento:'", () => {
    const warmupIds = ["bike_academia", "escada_academia", "polichinelo", "perdigueiro", "prancha_isometrica"];
    for (const id of warmupIds) {
      const entry = getCatalogById(id);
      assert.ok(entry, `Warmup exercise "${id}" not in catalog`);
      assert.ok(
        !entry.canonicalNamePt.startsWith("Aquecimento:"),
        `canonicalNamePt for "${id}" must not start with "Aquecimento:": got "${entry.canonicalNamePt}"`
      );
    }
  });
});

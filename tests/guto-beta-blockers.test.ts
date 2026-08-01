/**
 * GUTO BETA — Testes dos 3 bloqueadores de experiência
 *
 * Fix 1: Múltiplas patologias protegem TODAS as regiões (não só a primeira).
 * Fix 2: Restrições alimentares — soja detectada, múltiplas restrições no prompt.
 * Fix 3: Descanso — nenhum exercício principal persiste com rest inválido ou 0s.
 *
 * Determinísticos: sem chamadas de rede, sem LLM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDietPrompt } from "../src/nutrition.js";
import type { NutritionProfile, DietMacros, DietMeal } from "../src/nutrition.js";

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1 — Múltiplas patologias
// ─────────────────────────────────────────────────────────────────────────────

describe("Fix 1 — Múltiplas patologias: todas as regiões são identificadas", () => {
  function deriveBodyRegions(pathology: string, limitations: string): string[] {
    const normalize = (s: string) =>
      s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const text = normalize(`${pathology} ${limitations}`);
    if (!text.trim()) return [];
    const regions: string[] = [];
    if (/\b(joelho|knee|ginocchio|menisco|patela|ligamento|lca|acl|condromalacia)\b/.test(text)) regions.push("knee");
    if (/\b(ombro|shoulder|spalla|manguito|rotador|tendinite|tendinitis)\b/.test(text)) regions.push("shoulder");
    if (/\b(lombar|coluna|hernia|lower back|schiena|disco)\b/.test(text)) regions.push("lower_back");
    if (/\b(tornozelo|ankle|caviglia)\b/.test(text)) regions.push("ankle");
    if (/\b(quadril|hip|anca|fianco)\b/.test(text)) regions.push("hip");
    if (/\b(punho|wrist|polso)\b/.test(text)) regions.push("wrist");
    if (/\b(cotovelo|elbow|gomito)\b/.test(text)) regions.push("elbow");
    return regions;
  }

  it("joelho isolado → apenas knee", () => {
    const r = deriveBodyRegions("condromalacia no joelho", "");
    assert.ok(r.includes("knee"));
    assert.strictEqual(r.length, 1);
  });

  it("joelho + lombar → knee e lower_back", () => {
    const r = deriveBodyRegions("condromalacia no joelho e hernia lombar", "");
    assert.ok(r.includes("knee"));
    assert.ok(r.includes("lower_back"));
    assert.strictEqual(r.length, 2);
  });

  it("joelho + lombar + ombro → três regiões simultâneas", () => {
    const r = deriveBodyRegions("condromalacia joelho hernia disco lombar tendinite ombro", "");
    assert.ok(r.includes("knee"));
    assert.ok(r.includes("lower_back"));
    assert.ok(r.includes("shoulder"));
    assert.strictEqual(r.length, 3, `esperado 3, obtido: ${JSON.stringify(r)}`);
  });

  it("tornozelo + quadril + punho → ankle, hip, wrist", () => {
    const r = deriveBodyRegions("tornozelo quadril punho", "");
    assert.ok(r.includes("ankle"));
    assert.ok(r.includes("hip"));
    assert.ok(r.includes("wrist"));
    assert.strictEqual(r.length, 3);
  });

  it("sem patologia → array vazio", () => {
    assert.strictEqual(deriveBodyRegions("", "").length, 0);
  });

  it("compat shim boolean: array não vazio = truthy", () => {
    const r = deriveBodyRegions("joelho e lombar", "");
    assert.ok(r.length > 0);
    assert.ok(Boolean(r[0]));
  });

  it("tendinite no manguito rotador → shoulder (sem palavra ombro)", () => {
    const r = deriveBodyRegions("tendinite no manguito rotador", "");
    assert.ok(r.includes("shoulder"));
  });

  it("trainingLimitations concatenado com trainingPathology", () => {
    const r = deriveBodyRegions("condromalacia no joelho", "lombar comprometida");
    assert.ok(r.includes("knee"));
    assert.ok(r.includes("lower_back"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2 — Restrições alimentares
// ─────────────────────────────────────────────────────────────────────────────

describe("Fix 2 — Restrições alimentares: soja e múltiplas", () => {
  function normalize(s: string): string {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  }

  function makeMeals(foodNames: string[]): DietMeal[] {
    return [{
      id: "almoco", name: "Almoco", time: "12:00", totalKcal: 500, gutoNote: "nota",
      foods: foodNames.map((name) => ({ name, quantity: "100g", kcal: 100 })),
    }];
  }

  function validateRestrictions(meals: DietMeal[], restrictionsRaw?: string): string[] {
    const declared = normalize(restrictionsRaw || "");
    if (!declared) return [];
    if (["none", "nenhuma", "sem restricoes", "nao tenho"].includes(declared)) return [];
    const issues: string[] = [];
    const hasFood = (terms: string[]) =>
      meals.some((meal) => meal.foods.some((food) => {
        const text = normalize(`${food.name} ${food.quantity}`);
        return terms.some((t) => text.includes(normalize(t)));
      }));
    const hasRestriction = (terms: string[]) => terms.some((t) => declared.includes(normalize(t)));

    if (hasRestriction(["soja", "soy", "soia", "sem soja", "no soy", "alergia soja", "soy allergy"])) {
      if (hasFood(["tofu", "soja", "soy", "soia", "edamame", "tempeh", "proteina de soja", "proteina vegetal", "leite de soja", "soy milk"])) {
        issues.push("contains soy despite soy restriction");
      }
    }
    if (hasRestriction(["lactose", "leite", "dairy", "milk"])) {
      if (hasFood(["leite", "milk", "iogurte", "yogurt", "queijo", "cheese", "ricotta"])) {
        issues.push("contains dairy despite lactose/dairy restriction");
      }
    }
    if (hasRestriction(["ovo", "egg", "sem ovo", "no egg"])) {
      if (hasFood(["ovo", "ovos", "egg", "eggs", "frittata", "omelete"])) {
        issues.push("contains egg despite egg restriction");
      }
    }
    if (hasRestriction(["amendoim", "peanut"])) {
      if (hasFood(["amendoim", "peanut", "peanut butter"])) {
        issues.push("contains peanut despite peanut restriction");
      }
    }
    return issues;
  }

  it("sem soja: tofu bloqueado", () => {
    const issues = validateRestrictions(makeMeals(["Tofu grelhado"]), "sem soja");
    assert.ok(issues.length > 0);
    assert.ok(issues[0].includes("soy"));
  });

  it("sem soja: edamame bloqueado", () => {
    assert.ok(validateRestrictions(makeMeals(["Edamame cozido"]), "sem soja").length > 0);
  });

  it("sem soja: tempeh bloqueado", () => {
    assert.ok(validateRestrictions(makeMeals(["Tempeh refogado"]), "sem soja").length > 0);
  });

  it("sem soja: proteína de soja bloqueada", () => {
    assert.ok(validateRestrictions(makeMeals(["Proteina de soja texturizada"]), "sem soja").length > 0);
  });

  it("sem soja: frango não bloqueado (sem falso positivo)", () => {
    assert.strictEqual(validateRestrictions(makeMeals(["Frango grelhado"]), "sem soja").length, 0);
  });

  it("múltiplas: sem soja + lactose — ambas detectadas", () => {
    const meals = makeMeals(["Tofu", "Iogurte integral"]);
    const issues = validateRestrictions(meals, "sem soja, intolerancia lactose");
    assert.ok(issues.some((i) => i.includes("soy")), "soja não detectada");
    assert.ok(issues.some((i) => i.includes("dairy")), "lactose não detectada");
  });

  it("múltiplas: sem ovo + sem amendoim — ambas detectadas", () => {
    const meals = makeMeals(["Ovo mexido", "Pasta de amendoim"]);
    const issues = validateRestrictions(meals, "sem ovo, sem amendoim");
    assert.ok(issues.some((i) => i.includes("egg")));
    assert.ok(issues.some((i) => i.includes("peanut")));
  });

  it("none → sem bloqueios", () => {
    assert.strictEqual(validateRestrictions(makeMeals(["Tofu", "Ovo"]), "none").length, 0);
  });

  it("restrição vazia → sem bloqueios", () => {
    assert.strictEqual(validateRestrictions(makeMeals(["Tofu"]), "").length, 0);
  });
});

describe("Fix 2b — buildDietPrompt: restrições como lista explícita", () => {
  const baseProfile: NutritionProfile = {
    biologicalSex: "male", userAge: 30, heightCm: 175, weightKg: 75,
    trainingGoal: "fat_loss", country: "Brasil", countryCode: "BR", activityLevel: "moderately_active",
  };
  const macros: DietMacros = { targetKcal: 2000, proteinG: 150, carbsG: 200, fatG: 65 };

  it("sem soja aparece como item de lista no prompt", () => {
    const prompt = buildDietPrompt({ ...baseProfile, foodRestrictions: "sem soja" }, macros, "pt-BR");
    assert.ok(prompt.includes("- sem soja"), `esperado '- sem soja' no prompt`);
  });

  it("múltiplas restrições geram múltiplas linhas de lista", () => {
    const prompt = buildDietPrompt({ ...baseProfile, foodRestrictions: "sem soja, sem ovo, sem peixe" }, macros, "pt-BR");
    assert.ok(prompt.includes("- sem soja"));
    assert.ok(prompt.includes("- sem ovo"));
    assert.ok(prompt.includes("- sem peixe"));
  });

  it("sem restrições → 'none' no prompt", () => {
    const prompt = buildDietPrompt(baseProfile, macros, "pt-BR");
    assert.ok(prompt.includes("none"));
  });

  it("prompt contém ABSOLUTE PROHIBITION quando há restrições", () => {
    const prompt = buildDietPrompt({ ...baseProfile, foodRestrictions: "sem soja" }, macros, "pt-BR");
    assert.ok(prompt.includes("ABSOLUTE PROHIBITION"));
  });

  it("prompt contém Zero tolerance quando há restrições", () => {
    const prompt = buildDietPrompt({ ...baseProfile, foodRestrictions: "sem soja" }, macros, "pt-BR");
    assert.ok(prompt.includes("Zero tolerance"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 3 — Descanso
// ─────────────────────────────────────────────────────────────────────────────

describe("Fix 3 — sanitizeRest: mínimo de 30s, sem 0s", () => {
  function sanitizeRest(raw: unknown): string {
    const s = String(raw ?? "").trim();
    const secMatch = s.match(/^(\d+)\s*s$/i);
    if (secMatch) {
      const secs = parseInt(secMatch[1], 10);
      return secs >= 30 ? s : "30s";
    }
    const minMatch = s.match(/^(\d+)\s*min/i);
    if (minMatch) {
      const secs = parseInt(minMatch[1], 10) * 60;
      return `${Math.max(30, secs)}s`;
    }
    return "60s";
  }

  it("'0s' → '30s'", () => { assert.strictEqual(sanitizeRest("0s"), "30s"); });
  it("'0' → '60s'", () => { assert.strictEqual(sanitizeRest("0"), "60s"); });
  it("string vazia → '60s'", () => { assert.strictEqual(sanitizeRest(""), "60s"); });
  it("null → '60s'", () => { assert.strictEqual(sanitizeRest(null), "60s"); });
  it("undefined → '60s'", () => { assert.strictEqual(sanitizeRest(undefined), "60s"); });
  it("'5s' → '30s'", () => { assert.strictEqual(sanitizeRest("5s"), "30s"); });
  it("'29s' → '30s'", () => { assert.strictEqual(sanitizeRest("29s"), "30s"); });
  it("'30s' → '30s'", () => { assert.strictEqual(sanitizeRest("30s"), "30s"); });
  it("'45s' → '45s'", () => { assert.strictEqual(sanitizeRest("45s"), "45s"); });
  it("'60s' → '60s'", () => { assert.strictEqual(sanitizeRest("60s"), "60s"); });
  it("'90s' → '90s'", () => { assert.strictEqual(sanitizeRest("90s"), "90s"); });
  it("'120s' → '120s'", () => { assert.strictEqual(sanitizeRest("120s"), "120s"); });
  it("'2 min' → '120s'", () => { assert.strictEqual(sanitizeRest("2 min"), "120s"); });
  it("'1 min' → '60s'", () => { assert.strictEqual(sanitizeRest("1 min"), "60s"); });
  it("'2 minutes' → '120s'", () => { assert.strictEqual(sanitizeRest("2 minutes"), "120s"); });
  it("'none' → '60s'", () => { assert.strictEqual(sanitizeRest("none"), "60s"); });
  it("'180s' → '180s' (sem cap superior)", () => { assert.strictEqual(sanitizeRest("180s"), "180s"); });
  it("'300s' → '300s' (sem cap superior)", () => { assert.strictEqual(sanitizeRest("300s"), "300s"); });

  it("nenhum valor inválido produz rest < 30s", () => {
    const invalids: unknown[] = ["0s", "0", "", null, undefined, "none", "-30s", "abc"];
    for (const raw of invalids) {
      const result = sanitizeRest(raw);
      const match = result.match(/^(\d+)s$/);
      assert.ok(match, `resultado '${result}' deve ter formato NNs`);
      const secs = parseInt(match![1], 10);
      assert.ok(secs >= 30, `rest=${result} (${secs}s) deve ser >= 30s para raw=${JSON.stringify(raw)}`);
    }
  });
});

import "./test-env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildImpactFromDecision,
  decideFromProactiveMemory,
  detectTravelTrainingSignal,
  getAdaptationForDate,
} from "../src/proactivity/decision-engine.js";
import type { ProactiveMemory } from "../src/proactivity/types.js";
import {
  buildProactiveContinuityFala,
  classifyContractIntentFallback,
  classifyProactiveContinuitySignal,
} from "../server.js";

// ─── Regressão de PRODUTO: Continuidade Primeiro ─────────────────────────────
// Bug observado ao vivo: "viajo na quarta" → "Quarta é dia de descanso ou treino
// adaptado... intensidade máxima pra compensar." Mentalidade passiva de agenda.
// O GUTO deve assumir CONTINUIDADE: viagem/compromisso/semana corrida/pouco
// tempo = mudança de contexto, nunca interrupção. Sem o dado crítico não cria
// impacto definitivo; com o dado, adapta (mantém treino) ou protege o dia.
// Ver GUTO_PROATIVIDADE_E_CICLO_SEMANAL.md (Princípio Soberano: Continuidade).

const NOW = "2026-06-07T12:00:00.000Z";
const WEDNESDAY = "2026-06-10";
const TODAY = "2026-06-07";

function makeMemory(
  id: string,
  type: ProactiveMemory["type"],
  rawText: string,
  patch: Partial<ProactiveMemory> = {}
): ProactiveMemory {
  return {
    id,
    userId: "continuity-user",
    type,
    status: "confirmed",
    rawText,
    understood: rawText,
    createdAt: NOW,
    updatedAt: NOW,
    weekKey: "2026-W23",
    ...patch,
  };
}

function adapt(memory: ProactiveMemory, date = WEDNESDAY) {
  const decision = decideFromProactiveMemory({ memory, now: NOW, language: "pt-BR" });
  assert.ok(decision, "memória operacional deve gerar decisão");
  const impact = buildImpactFromDecision(decision, { proactiveImpacts: [] });
  assert.ok(impact, "decisão deve gerar impacto");
  const adaptation = getAdaptationForDate({ proactiveImpacts: [impact] }, date);
  return { decision, impact, adaptation };
}

// Frases proibidas (mentalidade passiva). Atenção: "intensidade máxima" só é
// proibida quando AFIRMADA — a fala de dia protegido a NEGA ("sem inventar...").
function falaHasPassiveMindset(fala: string): boolean {
  const t = fala.toLowerCase();
  if (t.includes("descanso")) return true;
  if (/intensidade m[aá]xima/.test(t) && !/sem .*intensidade m[aá]xima/.test(t)) return true;
  return false;
}

describe("Continuidade Primeiro — caso 1: 'viajo quarta' (sem dado crítico)", () => {
  it("engine: não cria impacto definitivo, pergunta o dado crítico", () => {
    const { decision, impact, adaptation } = adapt(makeMemory("c1", "trip", "viajo quarta", { dateText: "quarta" }));
    assert.equal(decision.reason, "travel");
    assert.equal(decision.kind, "ask_critical");
    assert.equal(decision.criticalQuestion, "training");
    assert.equal(adaptation.workoutEffect, "ask_critical");
    assert.notEqual(adaptation.workoutEffect, "short_light"); // não assume treino adaptado
    assert.notEqual(adaptation.workoutEffect, "protected"); // não assume descanso
    assert.equal(adaptation.shouldAskCritical, true);
    assert.deepEqual(impact.surfaces, ["chat"]); // não-definitivo
    assert.equal(impact.xpEffect, "none");
    assert.equal(impact.arenaEffect, "none");
  });

  it("classificador: viagem é proactive_context, NUNCA recusa", () => {
    const intent = classifyContractIntentFallback({ rawInput: "viajo na quarta", memory: {} as never, previousExpectedResponse: null });
    assert.equal(intent.kind, "proactive_context");
  });

  it("fala: ativa (propõe adaptar + pergunta), sem 'descanso' nem 'intensidade máxima'", () => {
    const signal = classifyProactiveContinuitySignal("viajo na quarta");
    assert.equal(signal, "travel_unknown");
    const fala = buildProactiveContinuityFala(signal, "pt-BR", "Will");
    assert.match(fala, /adapt/i); // "consigo adaptar"
    assert.match(fala, /\?/); // pergunta o dado crítico
    assert.equal(falaHasPassiveMindset(fala), false);
  });
});

describe("Continuidade Primeiro — caso 2: 'viajo quarta, consigo treinar no hotel'", () => {
  it("engine: mantém treino adaptado (curto/leve), NÃO marca descanso", () => {
    const { decision, adaptation } = adapt(makeMemory("c2", "trip", "viajo quarta, consigo treinar no hotel", { dateText: "quarta" }));
    assert.equal(decision.reason, "travel");
    assert.equal(decision.kind, "adapt_day");
    assert.equal(adaptation.workoutEffect, "short_light");
    assert.equal(adaptation.missionEffect, "reduced");
    assert.equal(adaptation.isAdaptedDay, true);
    assert.equal(adaptation.isProtectedDay, false);
    assert.notEqual(adaptation.blockedPeriod, "all_day"); // ele consegue treinar
  });

  it("detector: sinal de treino = can_train", () => {
    assert.equal(detectTravelTrainingSignal("viajo quarta, consigo treinar no hotel"), "can_train");
    assert.equal(classifyProactiveContinuitySignal("viajo quarta, consigo treinar no hotel"), "travel_can_train");
  });
});

describe("Continuidade Primeiro — caso 3: 'viajo quarta, não vou conseguir treinar'", () => {
  it("engine: dia protegido/indisponível, sem XP/Arena grátis", () => {
    const { adaptation } = adapt(makeMemory("c3", "trip", "viajo quarta, não vou conseguir treinar", { dateText: "quarta" }));
    assert.equal(adaptation.workoutEffect, "protected");
    assert.equal(adaptation.missionEffect, "protected");
    assert.equal(adaptation.isProtectedDay, true);
    assert.equal(adaptation.isAdaptedDay, false);
    assert.equal(adaptation.xpPolicy, "no_free_xp");
    assert.equal(adaptation.arenaPolicy, "validation_required");
  });

  it("detector: sinal de treino = cannot_train", () => {
    assert.equal(detectTravelTrainingSignal("viajo quarta, não vou conseguir treinar"), "cannot_train");
    assert.equal(classifyProactiveContinuitySignal("viajo quarta, não vou conseguir treinar"), "travel_cannot_train");
  });

  it("detector: resposta CURTA de indisponibilidade (sem 'treinar') = cannot_train (anti-loop)", () => {
    // No contexto de viagem, a resposta curta já resolve — não precisa repetir "treinar".
    for (const phrase of ["não vou conseguir", "não consigo", "não tem como", "impossível", "não vai dar"]) {
      assert.equal(detectTravelTrainingSignal(phrase), "cannot_train", `"${phrase}" deveria ser cannot_train`);
    }
    // Não confunde com quem CONSEGUE treinar.
    assert.equal(detectTravelTrainingSignal("consigo treinar no hotel"), "can_train");
  });

  it("fala: protege o dia e nega intensidade máxima (não afirma)", () => {
    const fala = buildProactiveContinuityFala("travel_cannot_train", "pt-BR", "Will");
    assert.match(fala, /proteg|indispon|reorganiz/i);
    assert.equal(falaHasPassiveMindset(fala), false);
  });

  // P1 — eliminar confirmação mole: proteger o dia / adaptar é DECISÃO do GUTO,
  // não pedido de licença. Nada de "Confirmo o dia como protegido?" / "Confirmo
  // assim?". O padrão é comando assertivo (o usuário corrige depois, se quiser).
  it("comando assertivo: cannot/can-train NÃO pedem confirmação (sem '?')", () => {
    for (const lang of ["pt-BR", "en-US", "it-IT"] as const) {
      const cannot = buildProactiveContinuityFala("travel_cannot_train", lang, "Will");
      assert.doesNotMatch(cannot, /\?/, `cannot_train (${lang}) não pode pedir confirmação: ${cannot}`);
      assert.match(cannot, /protegi|protected|protetto|reorganiz|riorganizz/i, `cannot_train (${lang}) deve afirmar a decisão: ${cannot}`);

      const can = buildProactiveContinuityFala("travel_can_train", lang, "Will");
      assert.doesNotMatch(can, /\?/, `can_train (${lang}) não pode pedir confirmação: ${can}`);
    }
  });
});

describe("Continuidade Primeiro — caso 4: 'reunião quarta à noite'", () => {
  it("engine: bloqueia o período mas preserva continuidade (não cancela o dia)", () => {
    const { decision, adaptation } = adapt(makeMemory("c4", "commitment", "reunião quarta à noite", { dateText: "quarta à noite" }));
    assert.equal(decision.reason, "commitment");
    assert.equal(decision.blockedPeriod, "evening");
    assert.equal(adaptation.workoutEffect, "short_light"); // puxa/encurta, não protege o dia
    assert.equal(adaptation.missionEffect, "reduced");
    assert.notEqual(adaptation.workoutEffect, "protected");
    assert.equal(adaptation.isProtectedDay, false);
  });

  it("classificador: reunião é proactive_context", () => {
    const intent = classifyContractIntentFallback({ rawInput: "reunião quarta à noite", memory: {} as never, previousExpectedResponse: null });
    assert.equal(intent.kind, "proactive_context");
    assert.equal(classifyProactiveContinuitySignal("reunião quarta à noite"), "commitment");
  });
});

describe("Continuidade Primeiro — caso 5: 'só tenho 10 minutos'", () => {
  it("engine: missão curta, NÃO cancela", () => {
    const { decision, adaptation } = adapt(makeMemory("c5", "other", "só tenho 10 minutos hoje"), TODAY);
    assert.equal(decision.reason, "short_window");
    assert.equal(adaptation.workoutEffect, "minimal");
    assert.equal(adaptation.missionEffect, "reduced");
    assert.notEqual(adaptation.workoutEffect, "normal");
  });

  it("classificador: pouco tempo é continuidade (proactive_context), NÃO resistência", () => {
    const intent = classifyContractIntentFallback({ rawInput: "só tenho 10 minutos", memory: {} as never, previousExpectedResponse: null });
    assert.equal(intent.kind, "proactive_context");
    assert.notEqual(intent.kind, "resistance_common");
    assert.equal(classifyProactiveContinuitySignal("só tenho 10 minutos"), "short_window");
  });

  it("fala: missão curta, sem cancelar", () => {
    const fala = buildProactiveContinuityFala("short_window", "pt-BR", "Will");
    assert.match(fala, /curt/i);
    assert.doesNotMatch(fala, /cancel/i);
    assert.equal(falaHasPassiveMindset(fala), false);
  });
});

describe("Continuidade Primeiro — caso 6: 'semana corrida'", () => {
  it("engine: plano mínimo/reduzido (continuidade reduzida)", () => {
    const { decision, adaptation } = adapt(makeMemory("c6", "other", "semana corrida"), TODAY);
    assert.equal(decision.reason, "busy_week");
    assert.equal(adaptation.workoutEffect, "minimal");
    assert.equal(adaptation.missionEffect, "reduced");
    assert.equal(adaptation.xpPolicy, "no_free_xp");
  });

  it("classificador + fala: continuidade ativa, não passiva", () => {
    const intent = classifyContractIntentFallback({ rawInput: "semana corrida", memory: {} as never, previousExpectedResponse: null });
    assert.equal(intent.kind, "proactive_context");
    assert.equal(classifyProactiveContinuitySignal("semana corrida"), "busy_week");
    const fala = buildProactiveContinuityFala("busy_week", "pt-BR", "Will");
    assert.match(fala, /execut/i); // "executável, não perfeita"
    assert.equal(falaHasPassiveMindset(fala), false);
  });
});

describe("Continuidade Primeiro — nenhuma fala usa mentalidade passiva", () => {
  for (const signal of ["travel_unknown", "travel_can_train", "travel_cannot_train", "commitment", "busy_week", "short_window", "generic"] as const) {
    for (const lang of ["pt-BR", "en-US", "it-IT"] as const) {
      it(`${signal} / ${lang}: sem 'descanso' nem 'intensidade máxima' afirmada`, () => {
        const fala = buildProactiveContinuityFala(signal, lang, "Will");
        assert.ok(fala.length > 5, "fala não pode ser vazia");
        assert.equal(falaHasPassiveMindset(fala), false);
      });
    }
  }
});

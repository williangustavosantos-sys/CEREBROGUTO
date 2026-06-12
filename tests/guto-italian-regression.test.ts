import "./test-env.js";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { detectTravelTrainingSignal } from "../src/proactivity/decision-engine.js";

// buildPostConfirmationRedirect é puro (sem servidor) e usa describeLimitationCare,
// o mesmo helper do arrival — então cobre a localização do rótulo de limitação.
let buildPostConfirmationRedirect: (memory: any, language: string, day?: string) => { fala: string };

before(async () => {
  const mod = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    buildPostConfirmationRedirect: typeof buildPostConfirmationRedirect;
  };
  buildPostConfirmationRedirect = mod.buildPostConfirmationRedirect;
});

function memWithMission(extra: Record<string, unknown>) {
  return {
    userId: "it-reg",
    name: "Leandro",
    language: "it-IT",
    trainedToday: false,
    lastWorkoutPlan: {
      title: "Corpo Intero",
      focus: "full_body",
      exercises: [{ id: "x", name: "Squat", sets: 3, reps: 10 }],
    },
    ...extra,
  };
}

describe("it-IT — rótulo de limitação localizado (sem vazar PT, sem typo, sem duplicação)", () => {
  it("ginocchio → 'con attenzione al ginocchio' (nunca 'joelho')", () => {
    const { fala } = buildPostConfirmationRedirect(
      memWithMission({ trainingPathology: "ginocchio", trainingLimitations: "ginocchio" }),
      "it-IT"
    );
    assert.match(fala, /con attenzione al ginocchio/i, "deve localizar o joelho em italiano");
    assert.doesNotMatch(fala, /\bjoelho\b/i, "não pode vazar o rótulo PT 'joelho'");
    assert.doesNotMatch(fala, /\bginoccio\b/i, "não pode conter o typo 'ginoccio'");
  });

  it("patologia+limitação duplicadas ('ginoccio'/'ginoccio') não viram 'ginoccio ginoccio'", () => {
    const { fala } = buildPostConfirmationRedirect(
      memWithMission({ trainingPathology: "ginoccio", trainingLimitations: "ginoccio" }),
      "it-IT"
    );
    // O typo 'ginoccio' é tolerado e mapeado para a região joelho.
    assert.match(fala, /con attenzione al ginocchio/i);
    assert.doesNotMatch(fala, /ginoccio\s+ginoccio/i, "não pode duplicar a limitação");
    assert.doesNotMatch(fala, /\bjoelho\b/i);
  });

  it("pt-BR mantém saída idêntica (sem regressão)", () => {
    const { fala } = buildPostConfirmationRedirect(
      { ...memWithMission({ trainingPathology: "ombro", trainingLimitations: "ombro" }), language: "pt-BR" },
      "pt-BR"
    );
    assert.match(fala, /com cuidado no ombro/i);
  });
});

describe("it-IT — sinal de disponibilidade de viagem (decision-engine)", () => {
  const cannot = ["non riesco ad allenarmi", "non posso allenarmi", "non ce la faccio", "impossibile"];
  const can = ["posso allenarmi", "mi alleno in hotel", "riesco ad allenarmi"];

  for (const phrase of cannot) {
    it(`"${phrase}" → cannot_train`, () => {
      assert.equal(detectTravelTrainingSignal(phrase), "cannot_train");
    });
  }
  for (const phrase of can) {
    it(`"${phrase}" → can_train`, () => {
      assert.equal(detectTravelTrainingSignal(phrase), "can_train");
    });
  }
  it("'non posso allenarmi in hotel' resolve cannot_train (precedência igual ao PT)", () => {
    assert.equal(detectTravelTrainingSignal("non posso allenarmi in hotel"), "cannot_train");
  });
});

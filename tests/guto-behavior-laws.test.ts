import "./test-env.js";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Bateria comportamental das Behavior Laws (GUTO_BEHAVIOR_LAWS.md).
// Esta primeira leva trava a LEI 1 — toda resolução operacional conduz para a
// próxima ação clara — no ponto central `finalizeTurn`. Roda sem modelo.
process.env.GEMINI_API_KEY = "";

type TurnResponse = {
  fala?: string;
  acao?: string;
  expectedResponse?: unknown;
};
type FinalizeCtx = { memory: Record<string, unknown>; language: string; isResolution?: boolean };

let finalizeTurn: (response: TurnResponse, ctx: FinalizeCtx) => TurnResponse;

function memoryWithMission(): Record<string, unknown> {
  return {
    userId: "behavior-law-unit",
    name: "Will",
    language: "pt-BR",
    trainedToday: false,
    lastWorkoutPlan: {
      title: "Peito e Tríceps",
      focus: "Peito e Tríceps",
      focusKey: "chest_triceps",
      dateLabel: "hoje",
      scheduledFor: new Date().toISOString(),
      summary: "",
      exercises: [
        {
          id: "supino_reto",
          name: "Supino reto",
          canonicalNamePt: "Supino reto",
          muscleGroup: "peito",
          sets: 3,
          reps: "10",
          rest: "60s",
          videoUrl: "/exercise/visuals/peito/supino_reto.mp4",
        },
      ],
    },
  };
}

describe("Behavior Law 1 — toda resolução operacional conduz para a próxima ação", () => {
  before(async () => {
    const mod = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      finalizeTurn: (response: TurnResponse, ctx: FinalizeCtx) => TurnResponse;
    };
    finalizeTurn = mod.finalizeTurn;
    assert.equal(typeof finalizeTurn, "function", "finalizeTurn precisa ser exportado pelo server");
  });

  it("LEI 1 — resolução sem próximo passo recebe condução", () => {
    const out = finalizeTurn(
      { fala: "Fechado. Salvei tua viagem.", acao: "none", expectedResponse: null },
      { memory: memoryWithMission(), language: "pt-BR", isResolution: true },
    );
    assert.match(out.fala || "", /Agora volta comigo para hoje/i, "deve reconduzir para hoje");
    assert.match(
      out.fala || "",
      /Pr[oó]xima a[cç][aã]o:|Sua miss[aã]o [ée]|Abre a miss[aã]o/i,
      "deve entregar próxima ação concreta",
    );
  });

  it("LEI 1 — frase morta isolada nunca passa numa resolução", () => {
    for (const dead of ["Ok.", "Perfeito.", "Feito.", "Agora vamos cuidar de hoje."]) {
      const out = finalizeTurn(
        { fala: dead, acao: "none", expectedResponse: null },
        { memory: memoryWithMission(), language: "pt-BR", isResolution: true },
      );
      assert.match(out.fala || "", /Agora volta comigo para hoje/i, `"${dead}" deveria ganhar condução`);
    }
  });

  it("LEI 1 — turno que já pergunta (expectedResponse) não é reconduzido", () => {
    const question: TurnResponse = {
      fala: "Você consegue treinar na viagem?",
      acao: "none",
      expectedResponse: { type: "text", context: "travel_training", instruction: "Responder sim/não." },
    };
    const out = finalizeTurn(question, { memory: memoryWithMission(), language: "pt-BR", isResolution: true });
    assert.equal(out.fala, question.fala, "pergunta já é o próximo passo — não duplica condução");
  });

  it("LEI 1 — updateWorkout (a missão é o próximo passo) não é reconduzido", () => {
    const workout: TurnResponse = { fala: "Treino atualizado.", acao: "updateWorkout", expectedResponse: null };
    const out = finalizeTurn(workout, { memory: memoryWithMission(), language: "pt-BR", isResolution: true });
    assert.equal(out.fala, workout.fala);
  });

  it("LEI 1 — conversa casual (não-resolução) não é forçada a conduzir", () => {
    const casual: TurnResponse = { fala: "Boa, tamo junto nessa.", acao: "none", expectedResponse: null };
    const out = finalizeTurn(casual, { memory: memoryWithMission(), language: "pt-BR", isResolution: false });
    assert.equal(out.fala, casual.fala, "só resolução é conduzida; conversa livre não");
  });
});

import "./test-env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detectImmediateOperationalIntent,
  extractTrainingLocation,
  shouldDeferWeeklyOpeningForTurn,
} from "../src/guto-turn-contract.js";

describe("GUTO turn contract", () => {
  it("detecta intenção operacional curta em PT/EN/IT", () => {
    assert.equal(detectImmediateOperationalIntent("Monta meu treino agora."), "workout");
    assert.equal(detectImmediateOperationalIntent("Gym."), "location");
    assert.equal(detectImmediateOperationalIntent("Pales."), "location");
    assert.equal(detectImmediateOperationalIntent("Meu joelho está doendo."), "pain");
    assert.equal(detectImmediateOperationalIntent("How do I do a push-up?"), "technique");
    assert.equal(detectImmediateOperationalIntent("Qual filme vejo hoje?"), null);
  });

  it("normaliza locais curtos sem virar motor principal de comportamento", () => {
    assert.equal(extractTrainingLocation("Academia."), "gym");
    assert.equal(extractTrainingLocation("Gym."), "gym");
    assert.equal(extractTrainingLocation("Pales."), "gym");
    assert.equal(extractTrainingLocation("Piscina."), "piscina");
    assert.equal(extractTrainingLocation("casa"), "home");
  });

  it("adia abertura semanal quando existe pedido operacional imediato", () => {
    const weekly = "[PROATIVIDADE — ABERTURA SEMANAL]\nEsta semana ainda não foi aberta.";
    assert.equal(shouldDeferWeeklyOpeningForTurn(weekly, "Qual treino hoje?"), true);
    assert.equal(shouldDeferWeeklyOpeningForTurn(weekly, "Gym."), true);
    assert.equal(shouldDeferWeeklyOpeningForTurn(weekly, "E aí, GUTO?"), false);
  });

  it("não adia confirmação ou validação proativa real", () => {
    const blocking =
      "[PROATIVIDADE — ABERTURA SEMANAL]\n" +
      "[PROATIVIDADE — CONFIRMAÇÃO DE DESCARTE]\nRoma descarto?";
    assert.equal(shouldDeferWeeklyOpeningForTurn(blocking, "Qual treino hoje?"), false);
  });
});

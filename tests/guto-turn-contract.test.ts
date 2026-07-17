import "./test-env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detectImmediateOperationalIntent,
  detectTrainingPrep,
  extractTrainingLocation,
  isNegativeWorkoutFeedback,
  isWorkoutExecutionRequest,
  looksLikeWeeklyAnswer,
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

  it("recusa/feedback negativo sobre treino NÃO é pedido de execução (P1: fallback empurrava treino)", () => {
    // Pedidos reais continuam sendo execução.
    assert.equal(isWorkoutExecutionRequest("monta meu treino de hoje"), true);
    assert.equal(isWorkoutExecutionRequest("bora treinar"), true);
    assert.equal(isWorkoutExecutionRequest("treino de hoje"), true);
    assert.equal(isWorkoutExecutionRequest("quero treinar peito"), true);
    // Recusa e feedback negativo NÃO podem virar "vamos treinar" no fallback.
    assert.equal(isWorkoutExecutionRequest("não quero treinar hoje"), false);
    assert.equal(isWorkoutExecutionRequest("não vou treinar"), false);
    assert.equal(isWorkoutExecutionRequest("não vou conseguir treinar"), false);
    assert.equal(isWorkoutExecutionRequest("não consigo treinar sexta"), false);
    assert.equal(isWorkoutExecutionRequest("não gostei do treino de hoje, achei chato"), false);
    assert.equal(isWorkoutExecutionRequest("esse treino tá chato"), false);
    assert.equal(isWorkoutExecutionRequest("I don't want to train today"), false);
    assert.equal(isWorkoutExecutionRequest("non voglio allenarmi"), false);
    // Regressão it-IT (real-user-scenarios): feedback negativo e conclusão de
    // treino contêm "allenamento" mas NÃO são pedido de execução — antes caíam no
    // ramo de execução do fallback e perdiam o ajuste/validação.
    assert.equal(isWorkoutExecutionRequest("non mi è piaciuto l'allenamento"), false);
    assert.equal(isWorkoutExecutionRequest("non mi è piaciuta la scheda"), false);
    assert.equal(isWorkoutExecutionRequest("ho fatto l'allenamento"), false);
    assert.equal(isWorkoutExecutionRequest("allenamento fatto"), false);
    assert.equal(isWorkoutExecutionRequest("fiz o treino"), false);
    // Pedido REAL em italiano continua sendo execução.
    assert.equal(isWorkoutExecutionRequest("prepara il mio allenamento di oggi"), true);
    // E o roteador de intenção operacional não classifica recusa como workout.
    assert.notEqual(detectImmediateOperationalIntent("não quero treinar hoje"), "workout");
    assert.notEqual(detectImmediateOperationalIntent("não gostei do treino"), "workout");
    assert.notEqual(detectImmediateOperationalIntent("non mi è piaciuto l'allenamento"), "workout");
  });

  it("identifica feedback negativo de treino sem confundir opinião fora do treino", () => {
    assert.equal(isNegativeWorkoutFeedback("não gostei do treino"), true);
    assert.equal(isNegativeWorkoutFeedback("I did not like the workout"), true);
    assert.equal(isNegativeWorkoutFeedback("I didn't like the workout"), true);
    assert.equal(isNegativeWorkoutFeedback("non mi è piaciuto l'allenamento"), true);
    assert.equal(isNegativeWorkoutFeedback("não gostei do filme"), false);
    assert.equal(isNegativeWorkoutFeedback("monta meu treino"), false);
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

  it("adia abertura semanal quando o usuário RESPONDE à pergunta da semana (P0)", () => {
    const weekly = "[PROATIVIDADE — ABERTURA SEMANAL]\nEsta semana ainda não foi aberta.";
    // Caso real do bug: resposta de compromisso não pode re-perguntar a semana
    // (antes virava mensagem duplicada → dedupe no front → GUTO mudo).
    assert.equal(shouldDeferWeeklyOpeningForTurn(weekly, "reunião na quarta"), true);
    assert.equal(shouldDeferWeeklyOpeningForTurn(weekly, "vou viajar sexta"), true);
    assert.equal(shouldDeferWeeklyOpeningForTurn(weekly, "semana corrida, trabalho apertado"), true);
    assert.equal(shouldDeferWeeklyOpeningForTurn(weekly, "tudo tranquilo essa semana"), true);
    assert.equal(shouldDeferWeeklyOpeningForTurn(weekly, "nada essa semana"), true);
    // Saudação pura ainda NÃO defere: a abertura semanal deve ser feita.
    assert.equal(shouldDeferWeeklyOpeningForTurn(weekly, "E aí, GUTO?"), false);
    assert.equal(looksLikeWeeklyAnswer("reunião na quarta"), true);
    assert.equal(looksLikeWeeklyAnswer("oi"), false);
  });

  it("preparação curta antes do treino NÃO é recusa (bug: 'vou tomar café' virava caminhada)", () => {
    // Alimentação curta → kind meal (puxa a refeição da dieta quando existir).
    assert.equal(detectTrainingPrep("vou tomar café primeiro")?.kind, "meal");
    assert.equal(detectTrainingPrep("vou comer antes")?.kind, "meal");
    assert.equal(detectTrainingPrep("deixa eu terminar de comer")?.kind, "meal");
    // Hidratação → kind hydration.
    assert.equal(detectTrainingPrep("vou beber água antes")?.kind, "hydration");
    // Preparação genérica → kind generic.
    assert.equal(detectTrainingPrep("vou tomar pré-treino")?.kind, "generic");
    assert.equal(detectTrainingPrep("vou trocar de roupa")?.kind, "generic");
    assert.equal(detectTrainingPrep("vou ao banheiro")?.kind, "generic");
    assert.equal(detectTrainingPrep("vou chegar na academia")?.kind, "generic");
    assert.equal(detectTrainingPrep("estou indo pra academia")?.kind, "generic");
    assert.equal(detectTrainingPrep("espera 10 minutos")?.kind, "generic");
  });

  it("recusa/adiamento real NÃO é preparação (continua recusa)", () => {
    assert.equal(detectTrainingPrep("não vou treinar hoje"), null);
    assert.equal(detectTrainingPrep("não quero treinar"), null);
    assert.equal(detectTrainingPrep("vou deixar pra amanhã"), null);
    assert.equal(detectTrainingPrep("tô cansado demais"), null);
    // Pergunta/pedido operacional também não é preparação.
    assert.equal(detectTrainingPrep("qual o treino de hoje?"), null);
    assert.equal(detectTrainingPrep("monta meu treino"), null);
    // "academia" pura (resposta de local) não é preparação — só o deslocamento é.
    assert.equal(detectTrainingPrep("academia"), null);
  });

  it("não adia confirmação ou validação proativa real", () => {
    const blocking =
      "[PROATIVIDADE — ABERTURA SEMANAL]\n" +
      "[PROATIVIDADE — CONFIRMAÇÃO DE DESCARTE]\nRoma descarto?";
    assert.equal(shouldDeferWeeklyOpeningForTurn(blocking, "Qual treino hoje?"), false);
  });
});

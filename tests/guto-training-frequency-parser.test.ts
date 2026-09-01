import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { assertFactChange, interpretFirstContactCalibrationCorrection, resolveDeclaredOperationalFacts } from "../src/v3/facts.js";
import { V3Error } from "../src/v3/errors.js";

// ─── P0 (TRAINING_FREQUENCY_MULTI_DIGIT) — parser regressions ──────────────
//
// "quero treinar 25 vezes por semana" must NEVER be silently converted to 5
// (the old `(\d)` regex captured the last digit). The parser must read the
// FULL number, respect the valid domain (2..6), and reject out-of-domain
// values instead of persisting a different value.

const VALID_PHRASES: Array<[string, number]> = [
  ["quero treinar 2 vezes por semana", 2],
  ["quero treinar 3 vezes por semana", 3],
  ["quero treinar 4 vezes por semana", 4],
  ["quero treinar 5 vezes por semana", 5],
  ["quero treinar 6 vezes por semana", 6],
  ["treino 5 vezes por semana", 5],
  ["treino 6 vezes", 6],
  ["quero treinar 5x", 5],
];

const INVALID_MULTI_DIGIT_PHRASES = [
  "quero treinar 0 vezes por semana",
  "quero treinar 1 vez por semana",
  "quero treinar 7 vezes por semana",
  "quero treinar 10 vezes por semana",
  "quero treinar 15 vezes por semana",
  "quero treinar 25 vezes por semana",
  "quero treinar 99 vezes por semana",
  "treino 25 vezes por semana",
  "treino 0 vezes",
];

test("FC_FREQ: valid single frequencies 2..6 are recognized by the correction interpreter", () => {
  for (const [phrase, expected] of VALID_PHRASES) {
    const result = interpretFirstContactCalibrationCorrection(phrase);
    assert.equal(result.weeklyFrequencyDaysPerWeek, expected, `phrase: ${phrase}`);
    assert.equal(result.rejectedFrequency, undefined, `no rejection for: ${phrase}`);
  }
});

test("FC_FREQ: valid single frequencies are recognized by the turn-flow fact resolver", () => {
  for (const [phrase, expected] of VALID_PHRASES) {
    const facts = resolveDeclaredOperationalFacts(phrase);
    const freq = facts.find((fact) => fact.factType === "TRAINING_FREQUENCY");
    assert.ok(freq, `fact emitted for: ${phrase}`);
    assert.equal(freq.value.daysPerWeek, expected, `phrase: ${phrase}`);
  }
});

test("FC_FREQ: multi-digit frequency is NEVER converted to its last digit (rejected, not 5)", () => {
  for (const phrase of INVALID_MULTI_DIGIT_PHRASES) {
    const result = interpretFirstContactCalibrationCorrection(phrase);
    assert.equal(result.weeklyFrequencyDaysPerWeek, undefined, `no silent conversion for: ${phrase}`);
    assert.ok(
      result.rejectedFrequency !== undefined && result.rejectedFrequency !== 5,
      `out-of-domain frequency surfaced for: ${phrase} (got ${result.rejectedFrequency})`,
    );
  }
});

test("FC_FREQ: turn-flow fact resolver never emits an out-of-domain frequency", () => {
  for (const phrase of INVALID_MULTI_DIGIT_PHRASES) {
    const facts = resolveDeclaredOperationalFacts(phrase);
    const freq = facts.find((fact) => fact.factType === "TRAINING_FREQUENCY");
    assert.equal(freq, undefined, `no out-of-domain fact for: ${phrase}`);
  }
});

test("FC_FREQ: executor authority rejects an out-of-domain fact even if a model supplies it", () => {
  for (const invalid of [0, 1, 7, 10, 15, 25, 99]) {
    assert.throws(
      () => assertFactChange({
        factType: "TRAINING_FREQUENCY",
        canonicalValue: String(invalid),
        value: { daysPerWeek: invalid },
        source: "user_declared",
        confirmationStatus: "FACT_CONFIRMED",
      }),
      (error: unknown) => error instanceof V3Error && error.code === "V3_TRAINING_FREQUENCY_OUT_OF_DOMAIN",
    );
  }
});

test("FC_FREQ: 'quero treinar vinte e cinco vezes por semana' is not converted (no digits → no match)", () => {
  const result = interpretFirstContactCalibrationCorrection("quero treinar vinte e cinco vezes por semana");
  assert.equal(result.weeklyFrequencyDaysPerWeek, undefined, "word number is not silently converted");
  const facts = resolveDeclaredOperationalFacts("quero treinar vinte e cinco vezes por semana");
  assert.equal(facts.find((fact) => fact.factType === "TRAINING_FREQUENCY"), undefined);
});

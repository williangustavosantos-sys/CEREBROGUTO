// Commit 3 — Fatia 1: validateContract — validação só de forma.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateContract } from "../src/brain/validate-contract.js";

// Base válido — acao="none" + expectedResponse coerente
const valid: Record<string, unknown> = {
  fala: "Bora treinar hoje?",
  acao: "none",
  expectedResponse: { type: "text", options: ["Bora", "Hoje não"] },
};

// ─── Casos válidos ───────────────────────────────────────────────────────────

test("contrato simples válido → ok:true e validation='ok'", () => {
  const r = validateContract(valid);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.validation, "ok");
});

test("expectedResponse null → válido (acao=none sem botões)", () => {
  const r = validateContract({ ...valid, expectedResponse: null });
  assert.equal(r.ok, true);
  assert.equal(r.validation, "ok");
});

test("memoryPatch null → válido", () => {
  const r = validateContract({ ...valid, memoryPatch: null });
  assert.equal(r.ok, true);
  assert.equal(r.validation, "ok");
});

test("memoryPatch objeto simples → válido", () => {
  const r = validateContract({ ...valid, memoryPatch: { streak: 3, lastSeen: "2026-06-28" } });
  assert.equal(r.ok, true);
});

test("options exatamente 4 → válido (no limite)", () => {
  const r = validateContract({
    ...valid,
    expectedResponse: { type: "text", options: ["A", "B", "C", "D"] },
  });
  assert.equal(r.ok, true);
});

test("instruction com 160 chars → válido (no limite)", () => {
  const r = validateContract({
    ...valid,
    expectedResponse: { instruction: "x".repeat(160) },
  });
  assert.equal(r.ok, true);
});

// ─── fala ───────────────────────────────────────────────────────────────────

test("fala vazia → ok:false + defer", () => {
  const r = validateContract({ ...valid, fala: "" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("fala")));
  assert.equal(r.validation, "defer");
});

test("fala só espaços → ok:false", () => {
  const r = validateContract({ ...valid, fala: "   " });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("fala")));
});

test("fala ausente (undefined) → ok:false", () => {
  const { fala: _drop, ...sem } = valid as Record<string, unknown>;
  const r = validateContract(sem);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("fala")));
});

// ─── acao ────────────────────────────────────────────────────────────────────

test("acao='updateWorkout' → defer (Fatia 1 não suporta, shape válido)", () => {
  const r = validateContract({ ...valid, acao: "updateWorkout" });
  assert.equal(r.validation, "defer");
});

test("acao='generateDiet' → defer", () => {
  const r = validateContract({ ...valid, acao: "generateDiet" });
  assert.equal(r.validation, "defer");
});

test("acao fora do enum → ok:false + defer", () => {
  const r = validateContract({ ...valid, acao: "hackTheMainframe" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("acao")));
  assert.equal(r.validation, "defer");
});

test("acao ausente → ok:false + defer", () => {
  const { acao: _drop, ...sem } = valid as Record<string, unknown>;
  const r = validateContract(sem);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("acao")));
  assert.equal(r.validation, "defer");
});

// ─── expectedResponse ────────────────────────────────────────────────────────

test("options > 4 → ok:false", () => {
  const r = validateContract({
    ...valid,
    expectedResponse: { type: "text", options: ["A", "B", "C", "D", "E"] },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("options")));
});

test("instruction > 160 chars → ok:false", () => {
  const r = validateContract({
    ...valid,
    expectedResponse: { instruction: "x".repeat(161) },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("instruction")));
});

test("expectedResponse array → ok:false", () => {
  const r = validateContract({ ...valid, expectedResponse: ["A", "B"] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("expectedResponse")));
});

// ─── memoryPatch ─────────────────────────────────────────────────────────────

test("memoryPatch com referência circular → ok:false", () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular; // JSON.stringify vai lançar TypeError
  const r = validateContract({ ...valid, memoryPatch: circular });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("memoryPatch")));
});

test("memoryPatch array → ok:false (deve ser objeto plano)", () => {
  const r = validateContract({ ...valid, memoryPatch: [1, 2, 3] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("memoryPatch")));
});

// ─── LEI 11 — meta não vaza para response ────────────────────────────────────

test("response com chave 'kind' (meta leak) → ok:false", () => {
  const r = validateContract({ ...valid, kind: "conversational_simple" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("kind")));
});

test("response com chave 'via' (meta leak) → ok:false", () => {
  const r = validateContract({ ...valid, via: "sovereign_brain_slice1" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("via")));
});

test("resultado de validateContract não contém chaves internas de meta", () => {
  const r = validateContract(valid);
  const META_INTERNAL_KEYS = ["kind", "reasoning", "via", "modelCalled", "persisted"];
  for (const key of META_INTERNAL_KEYS) {
    assert.ok(!(key in r), `resultado não deve conter chave de meta '${key}'`);
  }
});

// ─── Inputs inválidos por tipo ────────────────────────────────────────────────

test("raw string → ok:false + defer", () => {
  const r = validateContract("não sou objeto");
  assert.equal(r.ok, false);
  assert.equal(r.validation, "defer");
});

test("raw array → ok:false + defer", () => {
  const r = validateContract([{ fala: "a", acao: "none" }]);
  assert.equal(r.ok, false);
  assert.equal(r.validation, "defer");
});

test("raw null → ok:false + defer", () => {
  const r = validateContract(null);
  assert.equal(r.ok, false);
  assert.equal(r.validation, "defer");
});

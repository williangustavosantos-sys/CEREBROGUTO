// Commit 2 — Fatia 1: tipos narrow (ReducedWorldState, TurnContract, meta separado).
// Combina checagens de COMPILAÇÃO (validadas por `tsc --noEmit`) com asserts de RUNTIME.
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  TurnContract,
  PublicTurnResponse,
} from "../src/brain/types.js";

// ───────────── Checagens de COMPILAÇÃO (só compilam se as invariantes valem) ─────────────

// 1) contract.response é atribuível ao shape mínimo { fala, acao, expectedResponse }.
type MinimalShape = { fala: string; acao: string; expectedResponse: unknown };
type AssertResponseAssignable = PublicTurnResponse extends MinimalShape ? true : never;
const _responseAssignable: AssertResponseAssignable = true; // erro de tipo se NÃO atribuível
void _responseAssignable;

// 2) meta NÃO compartilha nenhuma chave com response (não pode vazar no payload público).
type Overlap = keyof PublicTurnResponse & keyof TurnContract["meta"];
type AssertNoKeyOverlap = [Overlap] extends [never] ? true : never;
const _noKeyOverlap: AssertNoKeyOverlap = true; // erro de tipo se houver chave em comum
void _noKeyOverlap;

// ───────────── Asserts de RUNTIME ─────────────

const sample: TurnContract = {
  response: {
    fala: "Bora, então. Hoje é treino.",
    acao: "none",
    expectedResponse: { type: "text", options: ["Bora"] },
  },
  validation: "ok",
  meta: {
    kind: "conversational_simple",
    via: "sovereign_brain_slice1",
    modelCalled: true,
    persisted: false,
  },
};

test("contract.response contém { fala, acao, expectedResponse }", () => {
  for (const key of ["fala", "acao", "expectedResponse"] as const) {
    assert.ok(key in sample.response, `response deveria conter '${key}'`);
  }
});

test("meta/validation NÃO estão dentro de response (não vazam no payload público)", () => {
  const responseKeys = Object.keys(sample.response);
  assert.ok(!responseKeys.includes("meta"), "response não pode conter 'meta'");
  assert.ok(!responseKeys.includes("validation"), "response não pode conter 'validation'");
  for (const metaKey of Object.keys(sample.meta)) {
    assert.ok(
      !responseKeys.includes(metaKey),
      `chave interna meta.${metaKey} não pode aparecer em response`
    );
  }
});

test("validation é 'ok' ou 'defer'", () => {
  assert.ok(["ok", "defer"].includes(sample.validation));
});

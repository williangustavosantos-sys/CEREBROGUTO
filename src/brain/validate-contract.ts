import type { TurnAcao, TurnValidation } from "./types.js";

const VALID_ACOES = new Set<string>([
  "none",
  "updateWorkout",
  "generateDiet",
  "openProactiveCard",
  "swapExercise",
  "callCoach",
]);

// Chaves internas do TurnMeta + TurnContract que NUNCA devem aparecer em response (LEI 11).
const META_KEYS = new Set([
  "kind",
  "reasoning",
  "via",
  "modelCalled",
  "persisted",
  "validation",
]);

const MAX_OPTIONS = 4;
const MAX_INSTRUCTION_LEN = 160;

export interface ContractValidationResult {
  ok: boolean;
  errors: string[];
  validation: TurnValidation;
}

function isPlainSerializable(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Valida a FORMA do response do modelo e decide se a Fatia 1 suporta o turno.
 *
 * Regras:
 *  - fala: string não-vazia
 *  - acao: pertence ao enum TurnAcao
 *  - Fatia 1 só decide acao="none"; qualquer outra retorna validation:"defer"
 *  - expectedResponse: null ou objeto plano; options ≤ 4; instruction ≤ 160 chars
 *  - memoryPatch: null, ausente, ou objeto plano JSON-serializável
 *  - Nenhuma chave interna de meta pode aparecer em response (LEI 11)
 *
 * Função PURA — sem chamada ao modelo, sem store, sem server.ts.
 */
export function validateContract(raw: unknown): ContractValidationResult {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      errors: ["response: must be a non-null plain object"],
      validation: "defer",
    };
  }

  const r = raw as Record<string, unknown>;

  // fala: string não-vazia
  if (typeof r.fala !== "string" || r.fala.trim().length === 0) {
    errors.push("fala: required non-empty string");
  }

  // acao: pertence ao enum
  if (typeof r.acao !== "string" || !VALID_ACOES.has(r.acao)) {
    errors.push(`acao: must be one of ${[...VALID_ACOES].join(", ")}`);
  }

  // expectedResponse: null ou objeto plano; valida options/instruction quando presente
  if (r.expectedResponse !== null && r.expectedResponse !== undefined) {
    if (typeof r.expectedResponse !== "object" || Array.isArray(r.expectedResponse)) {
      errors.push("expectedResponse: must be null or a plain object");
    } else {
      const er = r.expectedResponse as Record<string, unknown>;

      if (er.options !== undefined) {
        if (!Array.isArray(er.options)) {
          errors.push("expectedResponse.options: must be an array");
        } else if (er.options.length > MAX_OPTIONS) {
          errors.push(
            `expectedResponse.options: at most ${MAX_OPTIONS} items, got ${er.options.length}`
          );
        }
      }

      if (er.instruction !== undefined) {
        if (typeof er.instruction !== "string") {
          errors.push("expectedResponse.instruction: must be a string");
        } else if (er.instruction.length > MAX_INSTRUCTION_LEN) {
          errors.push(
            `expectedResponse.instruction: at most ${MAX_INSTRUCTION_LEN} chars, got ${er.instruction.length}`
          );
        }
      }
    }
  }

  // memoryPatch: null, ausente, ou objeto plano JSON-serializável
  if (r.memoryPatch !== null && r.memoryPatch !== undefined) {
    if (!isPlainSerializable(r.memoryPatch)) {
      errors.push("memoryPatch: must be a plain JSON-serializable object or null");
    }
  }

  // Nenhuma chave interna de meta pode aparecer em response (LEI 11)
  for (const key of Object.keys(r)) {
    if (META_KEYS.has(key)) {
      errors.push(`response contains internal meta key '${key}' — violates LEI 11`);
    }
  }

  const ok = errors.length === 0;
  // Fatia 1: só "none". Fatia 2B: "updateWorkout" também é suportado (execução de
  // treino simples). Demais acoes (swap/diet/proativo/coach) ainda caem no legado.
  const SUPPORTED = new Set<string>(["none", "updateWorkout"]);
  const validation: TurnValidation = ok && SUPPORTED.has(String(r.acao)) ? "ok" : "defer";

  return { ok, errors, validation };
}

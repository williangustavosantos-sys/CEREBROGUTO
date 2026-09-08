import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { asV3Error, isZodLikeError, publicV3ErrorDetails, userFacingV3Message, V3Error } from "../src/v3/errors.js";

test("human fallback keeps provider/internal diagnostics out of the public payload", () => {
  for (const error of [new Error("provider failure"), new Error("invalid model JSON"), new SyntaxError("internal JSON")]) {
    const parsed = asV3Error(error);
    assert.equal(parsed.code, "V3_INTERNAL_ERROR");
    assert.match(userFacingV3Message(parsed, "fallback"), /Falha interna do Cérebro V3\./);
    assert.equal(publicV3ErrorDetails(error, parsed), undefined);
  }
});

test("contract errors are recognized across realms and keep Zod issues in logs only", () => {
  const local = z.object({ expected: z.string() }).safeParse({ expected: 1 }).error!;
  const crossRealm = Object.assign(new Error("contract failed"), { name: "ZodError", issues: local.issues });
  for (const error of [local, crossRealm]) {
    assert.equal(isZodLikeError(error), true);
    const parsed = new V3Error("V3_INVALID_REQUEST", "Contrato de requisição V3 inválido.", 400, { issues: local.issues });
    assert.equal(publicV3ErrorDetails(error, parsed), undefined);
  }
});

test("intentional non-technical domain details remain available", () => {
  const domain = new V3Error("V3_CONTEXT_SOURCE_CHANGED", "O contexto mudou.", 409, { expectedVersion: 2 });
  assert.deepEqual(publicV3ErrorDetails(domain, domain), { expectedVersion: 2 });
});

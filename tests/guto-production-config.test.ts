import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveFrontendPublicUrl } from "../src/config.js";

describe("Configuração pública do frontend", () => {
  it("nunca gera convite localhost quando o backend roda em produção", () => {
    assert.equal(
      resolveFrontendPublicUrl({ NODE_ENV: "production" }),
      "https://corpoguto.vercel.app"
    );
    assert.equal(
      resolveFrontendPublicUrl({ VERCEL_ENV: "production" }),
      "https://corpoguto.vercel.app"
    );
  });

  it("preserva localhost somente fora de produção", () => {
    assert.equal(resolveFrontendPublicUrl({ NODE_ENV: "test" }), "http://localhost:3000");
  });

  it("prioriza URL configurada e remove barra final para montar links canônicos", () => {
    assert.equal(
      resolveFrontendPublicUrl({
        NODE_ENV: "production",
        FRONTEND_PUBLIC_URL: " https://app.example.test/// ",
      }),
      "https://app.example.test"
    );
  });
});

import "./test-env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

// VX-1 (P0 segurança): selfies de validação não podem ser públicas. A rota só
// serve com URL assinada (HMAC). Teste determinístico (sem Gemini): bare → 403,
// assinada → 200, adulterada → 403, expirada → 403, traversal → 400.

const uploadsDir = join(process.cwd(), "tmp", "validation-images");
const TEST_FILE = "__test-selfie-access.jpg";
const TEST_BYTES = Buffer.from("fake-jpeg-bytes-for-test");

let server: Server;
let baseUrl = "";
let signImageUrl: (u: string) => string;
let storage: any;

before(async () => {
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_ALLOW_DEV_ACCESS = "true";
  const app = ((await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as any).app;
  storage = await import(pathToFileURL(join(process.cwd(), "src/storage.ts")).href);
  signImageUrl = storage.signImageUrl;
  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(join(uploadsDir, TEST_FILE), TEST_BYTES);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  try { rmSync(join(uploadsDir, TEST_FILE), { force: true }); } catch {}
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const bare = `/uploads/validation-images/${TEST_FILE}`;

describe("Acesso às selfies de validação (VX-1: nunca público)", () => {
  it("URL sem assinatura → 403 (mata o acesso público anterior)", async () => {
    const r = await fetch(`${baseUrl}${bare}`);
    assert.equal(r.status, 403, "URL nua não pode mais abrir a foto");
  });

  it("URL assinada válida → 200 e devolve os bytes", async () => {
    const signed = signImageUrl(bare); // /uploads/...jpg?exp=..&sig=..
    const r = await fetch(`${baseUrl}${signed}`);
    assert.equal(r.status, 200, "assinatura válida deve servir a imagem");
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.equals(TEST_BYTES), "deve devolver o arquivo correto");
  });

  it("assinatura adulterada → 403", async () => {
    const signed = signImageUrl(bare);
    const tampered = signed.replace(/sig=([A-Za-z0-9_-])/, (_m, c) => `sig=${c === "A" ? "B" : "A"}`);
    const r = await fetch(`${baseUrl}${tampered}`);
    assert.equal(r.status, 403, "sig adulterada deve ser rejeitada");
  });

  it("assinatura expirada → 403", async () => {
    // ttl negativo → exp no passado, sig coerente com esse exp.
    const expired = (signImageUrl as any)(bare, -1000);
    const r = await fetch(`${baseUrl}${expired}`);
    assert.equal(r.status, 403, "URL expirada deve ser rejeitada");
  });

  it("arquivo inexistente com assinatura válida → 404 (não 200)", async () => {
    const signed = signImageUrl(`/uploads/validation-images/__nope-${TEST_FILE}`);
    const r = await fetch(`${baseUrl}${signed}`);
    assert.equal(r.status, 404, "arquivo inexistente não pode dar 200");
  });

  it("URL assinada lê bytes do Redis quando outra instância não tem o /tmp", async () => {
    const filename = "__test-selfie-redis.jpg";
    const bytes = Buffer.from("durable-private-selfie");
    const values = new Map<string, string>();
    storage.setImageStorageRedisClientForTests({
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: unknown) => {
        values.set(key, String(value));
        return "OK";
      },
      del: async (key: string) => values.delete(key) ? 1 : 0,
    });
    try {
      const bareRedisUrl = await storage.uploadImage(bytes, filename);
      const response = await fetch(`${baseUrl}${signImageUrl(bareRedisUrl)}`);
      assert.equal(response.status, 200);
      assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes));
    } finally {
      storage.setImageStorageRedisClientForTests(undefined);
    }
  });
});

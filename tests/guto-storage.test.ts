import "./test-env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// B02: storage persistente das selfies de validação (Cloudinary) com fallback
// local. Teste determinístico SEM rede: o caminho Cloudinary é exercido com o
// uploader monkeypatchado (mesma instância de módulo que o storage usa).
// Cobre: seleção de driver, roundtrip local + assinatura HMAC, upload autenticado,
// FALLBACK SEGURO (falha de upload propaga → rota faz 500, sem XP), delete e
// extração de public_id.

let storage: any;
let cloudinary: any;

before(async () => {
  storage = await import(pathToFileURL(join(process.cwd(), "src/storage.ts")).href);
  cloudinary = ((await import("cloudinary")) as any).v2;
});

const uploadsDir = join(process.cwd(), "tmp", "validation-images");
const LOCAL_FILE = "__test-storage-local.jpg";

function clearCloudinaryEnv(): void {
  delete process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_API_KEY;
  delete process.env.CLOUDINARY_API_SECRET;
  delete process.env.CLOUDINARY_URL;
}

function parseSigned(signed: string): { filename: string; exp: string; sig: string } {
  const [pathPart, query] = signed.split("?");
  const filename = pathPart.replace("/uploads/validation-images/", "");
  const params = new URLSearchParams(query);
  return { filename, exp: params.get("exp") || "", sig: params.get("sig") || "" };
}

describe("storage LOCAL (fallback sem credenciais Cloudinary)", () => {
  before(() => clearCloudinaryEnv());
  after(() => {
    try { rmSync(join(uploadsDir, LOCAL_FILE), { force: true }); } catch {}
  });

  it("isCloudinaryEnabled() = false sem credenciais", () => {
    assert.equal(storage.isCloudinaryEnabled(), false);
  });

  it("uploadImage grava no disco e devolve URL nua", async () => {
    storage.initStorage();
    const url = await storage.uploadImage(Buffer.from("fake-jpeg"), LOCAL_FILE);
    assert.equal(url, `/uploads/validation-images/${LOCAL_FILE}`);
    assert.ok(existsSync(join(uploadsDir, LOCAL_FILE)), "arquivo deve existir no disco");
  });

  it("signImageUrl assina e verifyImageSignature aceita a assinatura válida", () => {
    const signed = storage.signImageUrl(`/uploads/validation-images/${LOCAL_FILE}`);
    const { filename, exp, sig } = parseSigned(signed);
    assert.equal(filename, LOCAL_FILE);
    assert.equal(storage.verifyImageSignature(filename, exp, sig), true);
  });

  it("verifyImageSignature rejeita assinatura adulterada e expirada", () => {
    const signed = storage.signImageUrl(`/uploads/validation-images/${LOCAL_FILE}`);
    const { filename, exp, sig } = parseSigned(signed);
    const tampered = sig.startsWith("A") ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    assert.equal(storage.verifyImageSignature(filename, exp, tampered), false);
    const expired = parseSigned(storage.signImageUrl(`/uploads/validation-images/${LOCAL_FILE}`, -1000));
    assert.equal(storage.verifyImageSignature(expired.filename, expired.exp, expired.sig), false);
  });

  it("deleteImage remove o arquivo local", async () => {
    assert.ok(existsSync(join(uploadsDir, LOCAL_FILE)));
    await storage.deleteImage(`/uploads/validation-images/${LOCAL_FILE}`);
    assert.equal(existsSync(join(uploadsDir, LOCAL_FILE)), false);
  });
});

describe("storage REDIS (persistente em serverless sem Cloudinary)", () => {
  const values = new Map<string, string>();
  const client = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      values.set(key, String(value));
      return "OK";
    },
    del: async (key: string) => values.delete(key) ? 1 : 0,
  };

  before(() => {
    clearCloudinaryEnv();
    storage.setImageStorageRedisClientForTests(client);
  });
  after(() => {
    storage.setImageStorageRedisClientForTests(undefined);
    values.clear();
  });

  it("faz roundtrip durável sem depender do /tmp da instância", async () => {
    const filename = "__test-storage-redis.jpg";
    const bytes = Buffer.from("private-selfie-bytes");
    const url = await storage.uploadImage(bytes, filename);
    assert.equal(url, `/uploads/validation-images/${filename}`);
    assert.deepEqual(await storage.readStoredImage(filename), bytes);
    await storage.deleteImage(url);
    assert.equal(await storage.readStoredImage(filename), null);
  });
});

describe("storage CLOUDINARY (persistente)", () => {
  let origUpload: any;
  let origUrl: any;
  let origDestroy: any;

  before(() => {
    process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
    process.env.CLOUDINARY_API_KEY = "test-key";
    process.env.CLOUDINARY_API_SECRET = "test-secret";
    origUpload = cloudinary.uploader.upload;
    origUrl = cloudinary.url;
    origDestroy = cloudinary.uploader.destroy;
  });
  after(() => {
    cloudinary.uploader.upload = origUpload;
    cloudinary.url = origUrl;
    cloudinary.uploader.destroy = origDestroy;
    clearCloudinaryEnv();
  });

  it("isCloudinaryEnabled() = true com as 3 credenciais", () => {
    assert.equal(storage.isCloudinaryEnabled(), true);
  });

  it("uploadImage sobe como autenticado e devolve URL de entrega assinada", async () => {
    let captured: any = null;
    cloudinary.uploader.upload = async (_data: string, opts: any) => {
      captured = opts;
      return { public_id: opts.public_id };
    };
    cloudinary.url = (publicId: string, _opts: any) =>
      `https://res.cloudinary.com/test-cloud/image/authenticated/s--SIG--/v1/${publicId}.jpg`;

    const url = await storage.uploadImage(Buffer.from("xyz"), "abc123-photo.jpg");
    assert.equal(captured.type, "authenticated", "ativo deve ser privado/autenticado");
    assert.equal(captured.public_id, "guto/validation/abc123-photo");
    assert.equal(
      url,
      "https://res.cloudinary.com/test-cloud/image/authenticated/s--SIG--/v1/guto/validation/abc123-photo.jpg"
    );
  });

  it("FALLBACK SEGURO: falha de upload PROPAGA (rota faria 500, sem creditar XP)", async () => {
    cloudinary.uploader.upload = async () => {
      throw new Error("cloudinary upload 401");
    };
    await assert.rejects(
      () => storage.uploadImage(Buffer.from("xyz"), "fail-photo.jpg"),
      /cloudinary upload 401/
    );
  });

  it("deleteImage destrói o ativo pelo public_id extraído da URL", async () => {
    let destroyed: any = null;
    cloudinary.uploader.destroy = async (publicId: string, opts: any) => {
      destroyed = { publicId, opts };
      return { result: "ok" };
    };
    await storage.deleteImage(
      "https://res.cloudinary.com/test-cloud/image/authenticated/s--SIG--/v1/guto/validation/abc123-photo.jpg"
    );
    assert.equal(destroyed.publicId, "guto/validation/abc123-photo");
    assert.equal(destroyed.opts.type, "authenticated");
  });

  it("signImageUrl passa URL absoluta (Cloudinary) sem re-assinar", () => {
    const u =
      "https://res.cloudinary.com/test-cloud/image/authenticated/s--SIG--/v1/guto/validation/x-photo.jpg";
    assert.equal(storage.signImageUrl(u), u);
  });
});

describe("cloudinaryPublicIdFromUrl", () => {
  it("extrai o public_id removendo assinatura, versão e extensão", () => {
    assert.equal(
      storage.cloudinaryPublicIdFromUrl(
        "https://res.cloudinary.com/c/image/authenticated/s--ABC--/v1700000000/guto/validation/id-poster.jpg"
      ),
      "guto/validation/id-poster"
    );
  });
  it("devolve null para URL que não é do Cloudinary", () => {
    assert.equal(storage.cloudinaryPublicIdFromUrl("https://example.com/foo.jpg"), null);
  });
});

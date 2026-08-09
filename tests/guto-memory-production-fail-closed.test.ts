import "./test-env.js";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { config } from "../src/config.js";
import {
  MemoryStoreUnavailableError,
  clearMemoryStoreCache,
  flushMemoryStoreWrites,
  persistUserMemory,
  readMemoryStoreAsync,
  requiresDurableMemoryStore,
  setMemoryStoreRedisClientForTests,
} from "../src/memory-store.js";

const tmpDir = join(process.cwd(), "tmp");
const memoryFile = join(tmpDir, "guto-memory.production-fail-closed.json");
const originalNodeEnv = process.env.NODE_ENV;

describe("memory-store — production fail-closed", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
    config.memoryFile = memoryFile;
    mkdirSync(tmpDir, { recursive: true });
    rmSync(memoryFile, { force: true });
    clearMemoryStoreCache();
    setMemoryStoreRedisClientForTests(undefined);
  });

  afterEach(() => {
    process.env.NODE_ENV = "test";
    setMemoryStoreRedisClientForTests(undefined);
    clearMemoryStoreCache();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    rmSync(memoryFile, { force: true });
  });

  it("identifica os ambientes que exigem memória durável", () => {
    assert.equal(requiresDurableMemoryStore({ NODE_ENV: "production" }), true);
    assert.equal(requiresDurableMemoryStore({ NODE_ENV: "development", RENDER: "true" }), true);
    assert.equal(requiresDurableMemoryStore({ VERCEL_ENV: "production" }), true);
    assert.equal(requiresDurableMemoryStore({ NODE_ENV: "test" }), false);
  });

  it("sem Redis, recusa leitura e escrita em produção sem criar fallback local", async () => {
    setMemoryStoreRedisClientForTests(null);
    process.env.NODE_ENV = "production";

    assert.throws(
      () => persistUserMemory("prod-no-redis", { userId: "prod-no-redis", name: "Will" }),
      MemoryStoreUnavailableError,
    );
    await assert.rejects(readMemoryStoreAsync(), MemoryStoreUnavailableError);
    assert.equal(existsSync(memoryFile), false);
  });

  it("falha no commit Redis permanece observável e não publica cache/arquivo como sucesso", async () => {
    let commitAttempts = 0;
    setMemoryStoreRedisClientForTests({
      get: async () => ({}),
      set: async (_key, _value, options) => options?.nx ? "OK" : null,
      eval: async (_script, keys) => {
        if (keys.length === 2) {
          commitAttempts += 1;
          throw new Error("redis commit unavailable");
        }
        return 1;
      },
    });
    process.env.NODE_ENV = "production";

    await assert.rejects(
      persistUserMemory("prod-commit-failure", {
        userId: "prod-commit-failure",
        name: "Will",
      }),
      MemoryStoreUnavailableError,
    );
    await assert.rejects(flushMemoryStoreWrites(), MemoryStoreUnavailableError);
    assert.equal(commitAttempts, 1);
    assert.equal(existsSync(memoryFile), false);
  });
});

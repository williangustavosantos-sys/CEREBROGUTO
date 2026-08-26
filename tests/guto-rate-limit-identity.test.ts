import "./test-env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { createRateLimit, resolveRateLimitKey } from "../src/http/rate-limit.js";

function request(userId?: string): Request {
  return {
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    ...(userId ? { gutoUser: { userId, role: "student" } } : {}),
  } as unknown as Request;
}

function v3Request(userId?: string): Request {
  return {
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    originalUrl: "/guto/v3/state",
    ...(userId ? {
      gutoV3Auth: {
        principal: {
          actor: { userId },
        },
      },
    } : {}),
  } as unknown as Request;
}

function response() {
  const state = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(body: unknown) { state.body = body; return this; },
  } as unknown as Response;
  return { res, state };
}

function run(limiter: ReturnType<typeof createRateLimit>, req: Request) {
  const { res, state } = response();
  let passed = false;
  limiter(req, res, (() => { passed = true; }) as NextFunction);
  return { ...state, passed };
}

describe("rate limit por identidade", () => {
  it("separa usuários autenticados no mesmo IP", () => {
    const limiter = createRateLimit({ windowMs: 60_000, maxRequests: 1 });
    assert.equal(run(limiter, request("student-a")).passed, true);
    assert.equal(run(limiter, request("student-a")).status, 429);
    assert.equal(run(limiter, request("student-b")).passed, true);
  });

  it("mantém visitantes sem JWT agrupados por IP", () => {
    const limiter = createRateLimit({ windowMs: 60_000, maxRequests: 1 });
    assert.equal(resolveRateLimitKey(request()), "ip:127.0.0.1");
    assert.equal(run(limiter, request()).passed, true);
    assert.equal(run(limiter, request()).status, 429);
  });

  it("separa sessões V3 pelo userId estável e retorna erro V3 observável", () => {
    const limiter = createRateLimit({ windowMs: 60_000, maxRequests: 1 });
    assert.equal(resolveRateLimitKey(v3Request("v3-a")), "v3-user:v3-a");
    assert.equal(run(limiter, v3Request("v3-a")).passed, true);

    const blocked = run(limiter, v3Request("v3-a"));
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, {
      error: "V3_RATE_LIMITED",
      message: "GUTO recebeu chamadas demais deste cliente. Espera um minuto e volta direto.",
      brainVersion: "guto-cerebro-v3",
    });
    assert.equal(run(limiter, v3Request("v3-b")).passed, true);
  });

  it("mantém request V3 sem sessão no bucket de IP", () => {
    const limiter = createRateLimit({ windowMs: 60_000, maxRequests: 1 });
    assert.equal(resolveRateLimitKey(v3Request()), "ip:127.0.0.1");
    assert.equal(run(limiter, v3Request()).passed, true);
    assert.equal(run(limiter, v3Request()).status, 429);
  });
});

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
});

import "./test-env.js"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { describe, it } from "node:test"

import { requestLog, resolveRequestLogUserId } from "../src/http/request-log.js"

describe("request log", () => {
  it("lê path e userId pela URL WHATWG sem acessar getters legados", () => {
    const req = {
      originalUrl: "/guto/proactive?userId=u-runtime-clean",
      body: {},
      method: "GET",
      get path(): never {
        throw new Error("req.path must not be accessed")
      },
      get query(): never {
        throw new Error("req.query must not be accessed")
      },
    }
    const res = Object.assign(new EventEmitter(), { statusCode: 200 })
    const messages: string[] = []
    const originalLog = console.log
    console.log = (message?: unknown) => messages.push(String(message))

    try {
      let nextCalled = false
      requestLog(req as never, res as never, () => { nextCalled = true })
      res.emit("finish")

      assert.equal(nextCalled, true)
      assert.equal(messages.length, 1)
      assert.equal(JSON.parse(messages[0]).userId, "u-runtime-clean")
      assert.equal(JSON.parse(messages[0]).path, "/guto/proactive")
    } finally {
      console.log = originalLog
    }
  })

  it("mantém o fallback de userId do body quando não há query string", () => {
    assert.equal(
      resolveRequestLogUserId({
        originalUrl: "/guto/memory",
        body: { profile: { userId: "u-body" } },
      }),
      "u-body"
    )
  })

  it("usa a identidade autenticada V3 e ignora userId alegado por query, body ou JWT legado", () => {
    const req = {
      originalUrl: "/guto/v3/state?userId=u-query-forjado",
      body: { userId: "u-body-forjado" },
      method: "GET",
      gutoUser: { userId: "u-jwt-legado-forjado", role: "student" },
      gutoV3Auth: {
        principal: {
          actor: { userId: "u-v3-confirmado" },
        },
      },
    }
    const res = Object.assign(new EventEmitter(), { statusCode: 200 })
    const messages: string[] = []
    const originalLog = console.log
    console.log = (message?: unknown) => messages.push(String(message))

    try {
      requestLog(req as never, res as never, () => undefined)
      res.emit("finish")

      assert.equal(messages.length, 1)
      assert.equal(JSON.parse(messages[0]).userId, "u-v3-confirmado")
    } finally {
      console.log = originalLog
    }
  })

  it("não confia em userId alegado quando uma request V3 ainda não tem sessão", () => {
    const req = {
      originalUrl: "/guto/v3/auth/login?userId=u-query-forjado",
      body: { userId: "u-body-forjado" },
      method: "POST",
    }
    const res = Object.assign(new EventEmitter(), { statusCode: 401 })
    const messages: string[] = []
    const originalLog = console.log
    console.log = (message?: unknown) => messages.push(String(message))

    try {
      requestLog(req as never, res as never, () => undefined)
      res.emit("finish")

      assert.equal(messages.length, 1)
      assert.equal(JSON.parse(messages[0]).userId, undefined)
    } finally {
      console.log = originalLog
    }
  })

  it("aceita mocks mínimos sem originalUrl ou headers", () => {
    const req = { body: {}, method: "GET" }
    const res = Object.assign(new EventEmitter(), { statusCode: 200 })
    const originalLog = console.log
    console.log = () => undefined

    try {
      let nextCalled = false
      requestLog(req as never, res as never, () => { nextCalled = true })
      res.emit("finish")
      assert.equal(nextCalled, true)
    } finally {
      console.log = originalLog
    }
  })
})

import "./test-env.js"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { describe, it } from "node:test"

import { requestLog, resolveRequestLogUserId } from "../src/http/request-log.js"

describe("request log", () => {
  it("lê userId pela URL WHATWG sem acessar o getter req.query", () => {
    const req = {
      originalUrl: "/guto/proactive?userId=u-runtime-clean",
      body: {},
      method: "GET",
      path: "/guto/proactive",
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
})

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseRequestOriginalUrl } from "../src/http/request-url.js"

describe("request original URL", () => {
  it("lê path e query pela API WHATWG", () => {
    const parsed = parseRequestOriginalUrl("/guto/proactive?force=1&language=it-IT")

    assert.equal(parsed.pathname, "/guto/proactive")
    assert.equal(parsed.searchParams.get("force"), "1")
    assert.equal(parsed.searchParams.get("language"), "it-IT")
  })

  it("usa uma URL vazia segura quando o valor é inválido", () => {
    const parsed = parseRequestOriginalUrl("http://[")

    assert.equal(parsed.pathname, "/")
    assert.equal(parsed.search, "")
  })
})

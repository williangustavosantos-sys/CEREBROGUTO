import "./test-env.js"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { verifyDurableCommit } from "../src/durable-commit.js"

describe("durable workout commit", () => {
  it("reaplica o plano quando a primeira escrita some do snapshot persistido", async () => {
    let persisted: { plan: { id: string } | null } = { plan: null }
    let retries = 0

    const result = await verifyDurableCommit({
      readPersisted: async () => structuredClone(persisted),
      selectValue: (snapshot) => snapshot.plan,
      retryCommit: async () => {
        retries += 1
        persisted = { plan: { id: "mission-durable" } }
      },
    })

    assert.equal(retries, 1)
    assert.equal(result?.value.id, "mission-durable")
    assert.equal(result?.retries, 1)
  })

  it("não entrega sucesso quando o plano continua ausente depois dos retries", async () => {
    let retries = 0
    const result = await verifyDurableCommit({
      readPersisted: async () => ({ plan: null as { id: string } | null }),
      selectValue: (snapshot) => snapshot.plan,
      retryCommit: async () => { retries += 1 },
      maxRetries: 2,
    })

    assert.equal(result, null)
    assert.equal(retries, 2)
  })
})

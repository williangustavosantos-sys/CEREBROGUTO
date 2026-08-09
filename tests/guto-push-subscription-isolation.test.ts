import "./test-env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tmpDir = join(process.cwd(), "tmp");
const pushFile = join(tmpDir, "guto-push-subscription-isolation.json");
process.env.PUSH_STORE_FILE = pushFile;

const {
  deleteSubscriptionByEndpoint,
  deleteSubscriptionForUser,
  getSubscriptionsByUser,
  upsertSubscription,
} = await import("../src/push-store.js");

describe("push-store — isolamento de unsubscribe", () => {
  before(() => {
    mkdirSync(tmpDir, { recursive: true });
    rmSync(pushFile, { force: true });
  });

  after(() => {
    rmSync(pushFile, { force: true });
  });

  it("usuário autenticado não remove endpoint pertencente a outro tenant", async () => {
    const endpoint = "https://push.example/subscription-user-a";
    await upsertSubscription({
      userId: "push-user-a",
      endpoint,
      keys: { p256dh: "key-a", auth: "auth-a" },
    });

    assert.equal(await deleteSubscriptionForUser("push-user-b", endpoint), false);
    assert.equal((await getSubscriptionsByUser("push-user-a")).length, 1);

    assert.equal(await deleteSubscriptionForUser("push-user-a", endpoint), true);
    assert.equal((await getSubscriptionsByUser("push-user-a")).length, 0);
  });

  it("limpeza interna ainda pode remover token invalidado pelo provedor", async () => {
    const endpoint = "https://push.example/provider-invalid-token";
    await upsertSubscription({
      userId: "push-user-a",
      endpoint,
      keys: { p256dh: "key-a", auth: "auth-a" },
    });

    assert.equal(await deleteSubscriptionByEndpoint(endpoint), true);
    assert.equal((await getSubscriptionsByUser("push-user-a")).length, 0);
  });
});

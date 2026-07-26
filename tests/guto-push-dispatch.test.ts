import "./test-env.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dispatchExternalPush,
  evaluatePushEligibility,
  getApprovedPushSlot,
  type PushDispatchDependencies,
  type PushEligibilityMemory,
} from "../src/push-dispatch.js";
import {
  hasPushVapidConfiguration,
  resolvePushCronSecret,
} from "../src/config.js";
import type { PushSubscriptionRecord } from "../src/push-store.js";

const NOW = new Date("2026-07-26T16:30:00.000Z");
const TIME_ZONE = "Europe/Rome";

function subscription(
  endpoint: string,
  userId = "push-user",
  patch: Partial<PushSubscriptionRecord> = {}
): PushSubscriptionRecord {
  return {
    userId,
    endpoint,
    keys: { p256dh: "p256dh", auth: "auth" },
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...patch,
  };
}

function eligibleMemory(patch: Partial<PushEligibilityMemory> = {}): PushEligibilityMemory {
  return {
    trainedToday: false,
    completedWorkoutDates: [],
    lastActiveAt: "2026-07-26T12:00:00.000Z",
    ...patch,
  };
}

describe("configuração de push e cron", () => {
  it("só habilita VAPID quando o par público/privado está completo", () => {
    assert.equal(hasPushVapidConfiguration({
      pushVapidPublicKey: "public",
      pushVapidPrivateKey: "",
    }), false);
    assert.equal(hasPushVapidConfiguration({
      pushVapidPublicKey: "public",
      pushVapidPrivateKey: "private",
    }), true);
  });

  it("usa CRON_SECRET oficial da Vercel e preserva fallback legado", () => {
    assert.equal(resolvePushCronSecret({
      CRON_SECRET: "vercel",
      PUSH_CRON_SECRET: "legacy",
    }), "vercel");
    assert.equal(resolvePushCronSecret({
      CRON_SECRET: undefined,
      PUSH_CRON_SECRET: "legacy",
    }), "legacy");
  });

  it("declara um cron diário no mesmo endpoint GET do dispatch", () => {
    const vercelConfig = JSON.parse(
      readFileSync(join(process.cwd(), "vercel.json"), "utf8")
    ) as { crons?: Array<{ path?: string; schedule?: string }> };
    assert.deepEqual(vercelConfig.crons, [{
      path: "/guto/push/dispatch",
      schedule: "0 18 * * *",
    }]);
    const serverSource = readFileSync(join(process.cwd(), "server.ts"), "utf8");
    assert.match(serverSource, /app\.get\("\/guto\/push\/dispatch", handlePushDispatch\)/);
  });
});

describe("elegibilidade e supressão", () => {
  it("respeita as janelas aprovadas de 12h, 18h e 21h", () => {
    assert.equal(getApprovedPushSlot(new Date("2026-07-26T08:00:00.000Z"), TIME_ZONE), null);
    assert.equal(getApprovedPushSlot(new Date("2026-07-26T10:00:00.000Z"), TIME_ZONE), "12");
    assert.equal(getApprovedPushSlot(NOW, TIME_ZONE), "18");
    assert.equal(getApprovedPushSlot(new Date("2026-07-26T19:00:00.000Z"), TIME_ZONE), "21");
  });

  it("aceita usuário ativo, ausente há mais de 2h e com missão pendente", () => {
    const result = evaluatePushEligibility({
      memory: eligibleMemory(),
      activeAccess: true,
      contextSuppressed: false,
      subscription: subscription("https://push.test/eligible"),
      now: NOW,
      timeZone: TIME_ZONE,
    });
    assert.deepEqual(result, {
      eligible: true,
      slot: "18",
      day: "2026-07-26",
    });
  });

  it("suprime ação concluída, contexto protegido e atividade recente", () => {
    const base = {
      activeAccess: true,
      subscription: subscription("https://push.test/suppressed"),
      now: NOW,
      timeZone: TIME_ZONE,
    };
    assert.equal((evaluatePushEligibility({
      ...base,
      memory: eligibleMemory({ completedWorkoutDates: ["2026-07-26"] }),
      contextSuppressed: false,
    }) as { reason: string }).reason, "action_completed");
    assert.equal((evaluatePushEligibility({
      ...base,
      memory: eligibleMemory(),
      contextSuppressed: true,
    }) as { reason: string }).reason, "context_suppressed");
    assert.equal((evaluatePushEligibility({
      ...base,
      memory: eligibleMemory({ lastActiveAt: "2026-07-26T15:45:00.000Z" }),
      contextSuppressed: false,
    }) as { reason: string }).reason, "recent_activity");
  });
});

function dependencies(
  subscriptions: PushSubscriptionRecord[],
  overrides: Partial<PushDispatchDependencies<PushEligibilityMemory, null>> = {}
): PushDispatchDependencies<PushEligibilityMemory, null> {
  return {
    dispatchId: "dispatch-test",
    now: NOW,
    timeZone: TIME_ZONE,
    subscriptions,
    loadCandidate: async () => ({
      memory: eligibleMemory(),
      activeAccess: true,
      contextSuppressed: false,
      context: null,
    }),
    decide: async () => ({
      title: "GUTO",
      body: "Decisão soberana.",
      tag: "guto-18",
      url: "/",
    }),
    send: async () => {},
    recordSuccess: async () => {},
    recordFailure: async () => {},
    deleteSubscription: async () => true,
    subjectRef: () => "subject-ref",
    log: () => {},
    ...overrides,
  };
}

describe("deduplicação e falha isolada", () => {
  it("a segunda execução no mesmo dia não envia de novo", async () => {
    const sub = subscription("https://push.test/dedup");
    let sends = 0;
    const deps = dependencies([sub], {
      send: async () => {
        sends += 1;
      },
      recordSuccess: async (_endpoint, slot, sentAt) => {
        sub.lastSentAt = sentAt.toISOString();
        sub.lastSentSlot = slot;
      },
    });

    const first = await dispatchExternalPush(deps);
    const second = await dispatchExternalPush(deps);
    assert.equal(first.sent, 1);
    assert.equal(second.sent, 0);
    assert.equal(second.suppressions.duplicate, 1);
    assert.equal(sends, 1);
  });

  it("entrega uma única vez quando o mesmo usuário tem dois dispositivos", async () => {
    const firstDevice = subscription("https://push.test/device-a");
    const secondDevice = subscription("https://push.test/device-b");
    let sends = 0;
    const result = await dispatchExternalPush(dependencies([firstDevice, secondDevice], {
      send: async () => {
        sends += 1;
      },
    }));

    assert.equal(result.sent, 1);
    assert.equal(result.suppressions.duplicate, 1);
    assert.equal(sends, 1);
  });

  it("remove assinatura 410 e continua o dispatch dos demais usuários", async () => {
    const invalid = subscription("https://push.test/expired", "expired-user");
    const valid = subscription("https://push.test/valid", "valid-user");
    const deleted: string[] = [];
    const sent: string[] = [];
    const result = await dispatchExternalPush(dependencies([invalid, valid], {
      send: async (sub) => {
        if (sub.endpoint === invalid.endpoint) {
          throw Object.assign(new Error("expired"), { statusCode: 410 });
        }
        sent.push(sub.endpoint);
      },
      deleteSubscription: async (endpoint) => {
        deleted.push(endpoint);
        return true;
      },
    }));

    assert.equal(result.sent, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.invalidSubscriptions, 1);
    assert.deepEqual(deleted, [invalid.endpoint]);
    assert.deepEqual(sent, [valid.endpoint]);
  });

  it("não envia quando o Cérebro Soberano não fecha uma decisão", async () => {
    let sends = 0;
    const result = await dispatchExternalPush(dependencies([
      subscription("https://push.test/no-decision"),
    ], {
      decide: async () => null,
      send: async () => {
        sends += 1;
      },
    }));
    assert.equal(result.sent, 0);
    assert.equal(result.suppressions.decision_unavailable, 1);
    assert.equal(sends, 0);
  });
});

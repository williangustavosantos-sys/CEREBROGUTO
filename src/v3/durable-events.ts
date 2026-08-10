import { Inngest } from "inngest";
import type { ActorContext } from "./types.js";
import type { DecisionEnvelope } from "./contracts.js";
import { Mem0RelationshipMemoryStore } from "./relationship-memory.js";

export type GutoV3InngestEvents = {
  "guto/v3.relationship-memory.sync": {
    data: {
      tenantId: string;
      userId: string;
      correlationId: string;
      facts: NonNullable<DecisionEnvelope["factsToPropose"]>;
    };
  };
  "guto/v3.interactions.cleanup.requested": {
    data: {
      tenantId: string;
      userId: string;
      correlationId: string;
    };
  };
};

export const gutoV3Inngest = new Inngest({
  id: "guto-cerebro-v3",
  eventKey: process.env.INNGEST_EVENT_KEY,
});

export interface DurableEventPublisher {
  enqueueRelationshipMemorySync(input: {
    actor: Pick<ActorContext, "tenantId" | "userId" | "role">;
    correlationId: string;
    facts: NonNullable<DecisionEnvelope["factsToPropose"]>;
  }): Promise<void>;
}

export class InngestDurableEventPublisher implements DurableEventPublisher {
  async enqueueRelationshipMemorySync(input: {
    actor: Pick<ActorContext, "tenantId" | "userId" | "role">;
    correlationId: string;
    facts: NonNullable<DecisionEnvelope["factsToPropose"]>;
  }): Promise<void> {
    if (!process.env.INNGEST_EVENT_KEY) return;
    await gutoV3Inngest.send({
      id: `guto-v3:relationship-memory:${input.actor.tenantId}:${input.actor.userId}:${input.correlationId}`,
      name: "guto/v3.relationship-memory.sync",
      data: {
        tenantId: input.actor.tenantId,
        userId: input.actor.userId,
        correlationId: input.correlationId,
        facts: input.facts,
      },
    });
  }
}

export const syncRelationshipMemory = gutoV3Inngest.createFunction(
  {
    id: "guto-v3-sync-relationship-memory",
    retries: 3,
    idempotency: "event.data.tenantId + ':' + event.data.userId + ':' + event.data.correlationId",
    triggers: [{ event: "guto/v3.relationship-memory.sync" }],
  },
  async ({ event, step }) => step.run("sync-relationship-memory", async () => {
    const data = event.data as GutoV3InngestEvents["guto/v3.relationship-memory.sync"]["data"];
    const actor: ActorContext = {
      tenantId: data.tenantId,
      userId: data.userId,
      externalSubject: "durable-event",
      role: "student",
    };
    await new Mem0RelationshipMemoryStore().submit(actor, data.facts, data.correlationId);
    return { synchronized: data.facts.length };
  }),
);

export const gutoV3InngestFunctions = [syncRelationshipMemory];

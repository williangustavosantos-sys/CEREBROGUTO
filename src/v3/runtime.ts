import { createV3Genkit, GeminiInteractionsDecisionModel } from "./ai.js";
import { ConservativeCatalogCandidateProviderV3 } from "./candidate-provider.js";
import { GutoContextBuilderV3 } from "./context-builder.js";
import { createGutoTurnFlow } from "./flow.js";
import { RedisV3OperationalState } from "./operational-state.js";
import { PostgresOfficialStateRepository, createV3Pool } from "./postgres.js";
import { Mem0RelationshipMemoryStore } from "./relationship-memory.js";
import { registerV3Evaluators } from "./evaluators.js";
import { InngestDurableEventPublisher } from "./durable-events.js";

export function createV3Runtime() {
  const ai = createV3Genkit();
  const behavioralEvaluator = registerV3Evaluators(ai);
  const repository = new PostgresOfficialStateRepository(createV3Pool());
  const operational = RedisV3OperationalState.fromEnvironment();
  const relationshipMemory = new Mem0RelationshipMemoryStore();
  const candidates = new ConservativeCatalogCandidateProviderV3();
  const contextBuilder = new GutoContextBuilderV3(repository, operational, relationshipMemory, candidates);
  const decisionModel = new GeminiInteractionsDecisionModel();
  const durableEvents = new InngestDurableEventPublisher();
  const gutoTurnFlow = createGutoTurnFlow({
    ai,
    repository,
    operational,
    relationshipMemory,
    contextBuilder,
    decisionModel,
    durableEvents,
  });
  return { ai, repository, operational, relationshipMemory, contextBuilder, decisionModel, durableEvents, gutoTurnFlow, behavioralEvaluator };
}

export type V3Runtime = ReturnType<typeof createV3Runtime>;

let runtime: V3Runtime | null = null;

export function getV3Runtime(): V3Runtime {
  runtime ??= createV3Runtime();
  return runtime;
}

export function resetV3RuntimeForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("V3 runtime reset is test-only.");
  runtime = null;
}

# ADR 0002: Cérebro V3.1 conversation, facts, and durable continuity

- Status: accepted for isolated V3 Preview implementation
- Date: 2026-08-10

## Context

The V3 companion already separates model proposals, policy authorization, deterministic execution, and official PostgreSQL state. The founder regression exposed a missing domain layer between a user's declared fact and a concrete action: a model can repeatedly seek diagnostic certainty even when the user has supplied enough reliable information to continue conservatively.

The companion needs a durable, model-independent record of what is known, what remains material to the next action, and why a clarification is or is not allowed. It also needs historical facts rather than overwrite-only profile fields, natural multi-turn continuity without treating a provider conversation as truth, and durable asynchronous foundations without moving the synchronous chat to a workflow engine.

## Decision

### Authority and state

- PostgreSQL `guto_v3` remains the sole authority for official facts, conversation decision state, interaction references, event history, plans, XP, and execution results.
- Redis remains scoped transient infrastructure for locks, CAS, idempotency, and cache. It never owns conversation or fact truth.
- Mem0 remains limited to relationship facts. It is not read as authority for facts, safety, plan, diet, XP, goal, or conversation state.
- Gemini Interactions provides optional conversational continuity only. Each turn re-sends the system instruction, allowed tools, minimum authoritative context, and policy constraints. `previous_interaction_id` never carries authority.

### Conversation Decision State

One user/thread has one versioned `ConversationDecisionState` with:

- `activeTopic`, `activeGoal`, `knownFacts`, resolved slots, missing information, uncertainty type, decision sufficiency, pending action, next allowed action, previous interaction ID, and status;
- explicit values for `FACT_CONFIRMED`, `FACT_UNKNOWN`, `ACTION_SUFFICIENT`, `ACTION_NEEDS_INFORMATION`, `OUT_OF_SCOPE`, `CLINICAL_UNKNOWN`, `ACTION_BLOCKED_FOR_SAFETY`, and `READY_TO_EXECUTE`;
- append-only state events for audit and a version for compare-and-set updates.

The resolver asks a question only when a missing slot changes the next deterministic decision. A resolved slot is not asked again unless a fact is contradicted, explicitly changed, expired, or a distinct decision has a documented dependency on another slot.

### Bi-temporal facts

`guto_v3.user_facts` records declared and derived operational facts with valid time and system time:

- valid time: `valid_from`, `valid_to`;
- system time: `recorded_at`, `superseded_at`, and immutable predecessor linkage;
- typed payload, source, confirmation status, creator, and isolation columns.

Superseding a fact closes the previous row and writes a new row in the same PostgreSQL transaction. Existing V3 goals and health constraints are imported idempotently; no history is deleted. A declared body area is an operational physical constraint, not a clinical diagnosis. Functional limitations are separate facts. Clinical certainty stays `unknown` unless an authorized source says otherwise.

### Gemini Interactions lifecycle

- The Genkit `gutoTurnFlow` remains the runtime boundary and tracing owner.
- Its decision model uses the official `@google/genai` Interactions API with JSON schema output, then validates the result with the V3 Zod contract.
- The completed interaction ID is persisted only under the current tenant/user/thread and becomes the next turn's `previous_interaction_id`.
- Preview uses stored interactions with a seven-day application retention policy. A durable cleanup event deletes expired interaction resources and invalidates their local reference. No raw secret is recorded in traces.
- If Interactions is unavailable, the V3 request fails observably; it does not route to V1/V2 or silently turn Gemini into authority.

### Decision Envelope and policy

The envelope explicitly carries fact, action, and clinical certainty; clarification requirements and decision impact; resolved and unresolved conversation facts; and whether the proposed action needs more information. The model proposes only. The domain resolver and policy gate independently decide whether a clarification is material, whether conservative execution is allowed, or whether safety blocks the action. Executors remain the only mutators.

### Durable events

Inngest is added only for external-to-turn work. Typed events include `tenantId`, `userId`, and `correlationId`; event IDs are deterministic idempotency keys. The minimum real flow is post-turn relationship-memory synchronization and Gemini interaction-expiry cleanup. It uses PostgreSQL outbox records, Inngest steps, retries, and consumer idempotency. The synchronous chat remains outside Inngest.

### Evaluation and observability

DeepEval runs as a separate Python multi-turn suite against the V3 Preview contract. Its permanent golden includes declared lumbar limitation followed by a concrete exercise limitation. Deterministic V3 tests still cover all authorization and executor invariants. Langfuse traces reconstruct input, state load, fact resolution, context build, interaction, validation, policy, execution, persistence, response, correlation ID, interaction ID, and decision ID.

### Mastra

Mastra is not added. It would duplicate Genkit plus Inngest without replacing either responsibility.

## Consequences

The model can no longer make a clinical inquiry loop the default response to a declared operational limitation. The V3 Preview gains more tables and one provider dependency, but every durable transition remains auditable and tenant/user isolated. Existing V3 data remains available through idempotent import and no V1/V2 fallback is introduced.

## Rejected alternatives

- A prompt-only medical clarification rule or a fixed maximum number of questions.
- A new browser/global state store for conversation facts.
- Treating Gemini or Mem0 history as official memory.
- Running ordinary chat turns in Inngest.
- Adding Mastra as a parallel orchestration layer.

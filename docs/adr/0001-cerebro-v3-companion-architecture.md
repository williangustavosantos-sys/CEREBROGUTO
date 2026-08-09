# ADR 0001: CÉREBRO V3 Companion architecture

- Status: accepted for implementation; production cutover pending external validation
- Date: 2026-08-09

## Context

The legacy CÉREBRO stores durable official state in a shared Redis document and combines model reasoning, operational decisions, and persistence. Automated checks passed while founder journeys exposed lost calibration, workout/chat divergence, failed substitutions, and conflicting diet totals.

## Decision

- PostgreSQL owns durable official truth, versions, tenant isolation, events, XP ledger, and plan state.
- Redis owns tenant/user-scoped transient context, locks, cache, and idempotency with bounded TTL and CAS.
- Mem0 receives only backend-scoped `RELATIONSHIP` facts. It never owns official or sensitive truth.
- Genkit orchestrates one `gutoTurnFlow`; Gemini proposes a strict Zod `DecisionEnvelope`.
- A deterministic policy gate authorizes proposals; explicit executors alone mutate state.
- Nutritional arithmetic and plan generation are deterministic. A diet cannot be saved if item, meal, plan, and 4/4/9 invariants diverge beyond documented tolerances.
- OpenTelemetry spans and Langfuse correlate requests through opaque user hashes, request IDs, trace IDs, and state versions.
- The CORPO uses a disabled-by-default feature flag and sends no authoritative state in chat turns.

## Consequences

V2 remains the production authority until database migration, real provider calls, end-to-end traces, exact founder regression, and founder manual acceptance pass. There is no permanent dual-write. V3 fails closed when PostgreSQL or Redis consistency is unavailable.

## Rejected alternatives

- Keeping the global Redis document as durable truth.
- Letting Gemini return or execute arbitrary mutations.
- Treating Mem0 as a user database.
- Switching the CORPO before one complete validated V3 path exists.

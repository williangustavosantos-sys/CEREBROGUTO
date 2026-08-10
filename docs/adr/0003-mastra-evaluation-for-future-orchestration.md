# ADR 0003: Mastra evaluation for future orchestration

- Status: deferred
- Date: 2026-08-10

Mastra is not added to Cérebro V3.1. Genkit owns synchronous model-flow orchestration, PostgreSQL plus the Policy Gate and executors own decisions and mutations, and Inngest owns durable asynchronous work. Introducing Mastra now would create overlapping orchestration authority without replacing a defined component.

A future adoption requires an ADR that identifies the component being replaced, migration and rollback boundaries, authority changes, and a complete V3-only validation plan.

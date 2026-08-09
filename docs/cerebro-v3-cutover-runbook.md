# CÉREBRO V3 cutover and rollback

## Preconditions

All checks are mandatory: migration dry-run has zero invalid subjects; PostgreSQL migration is applied and diagnostics reconcile; Redis scoped-key isolation passes; real Gemini, Mem0, and Langfuse calls are visible; backend typecheck/tests/build and CORPO tests/build pass; exact founder scenarios pass after reload; founder authorizes manual acceptance.

## Cutover

1. Record current frontend/backend production URLs and deployment SHAs.
2. Apply `migrations/v3` with `npm run db:v3:migrate` from the durable deployment environment.
3. Run `npm run db:v3:legacy-dry-run`; archive only counts and opaque diagnostics, never secrets or raw health data.
4. Run the legacy migration with `tsx scripts/migrate-legacy-to-v3.ts --apply`, then rerun the dry-run/reconciliation checks.
5. Configure all V3 environment variables. Enable `GUTO_V3_ENABLED=true` on the backend only.
6. Require `/health/v3` to report `ready: true` and verify one authenticated state read, calibration, workout substitution, diet substitution, reload, isolation, and one Langfuse trace.
7. Enable `NEXT_PUBLIC_GUTO_V3_ENABLED=true` on CORPO and deploy.
8. Repeat the exact production founder journey. Do not label Beta accepted until the founder approves it manually.
9. Only after acceptance, disable legacy chat/memory writes and retain the old store read-only for the agreed rollback window.

## Rollback

1. Set `NEXT_PUBLIC_GUTO_V3_ENABLED=false` and redeploy CORPO to the recorded frontend SHA.
2. Set `GUTO_V3_ENABLED=false` and redeploy the recorded backend SHA.
3. Do not reverse or delete V3 PostgreSQL rows. They are versioned evidence and remain isolated.
4. Re-enable the previous legacy write path only if it was disabled after accepted cutover.
5. Correlate the failed request via `x-guto-trace-id`, request ID, deployment SHA, PostgreSQL event, and scoped Redis key before retrying cutover.

No rollback step drops schemas, deletes legacy state, or silently copies V3 mutations back into V2.

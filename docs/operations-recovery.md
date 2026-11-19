# Operations recovery controls

This repository provides four controls for maintenance and imported data:

- `runResumableRepair` runs an authorized repair in ordered batches. It writes a checkpoint after every batch, supports dry-runs, and resumes after a worker interruption without reprocessing completed records.
  For production data fixes, prefer **repair plans** ([repair-plans.md](repair-plans.md), #1084). A plan stores the reviewed dry-run, applies it with a `planHash`-bound, compare-and-set write per record, and can be rolled back.
- `verifyExternalEvidence` verifies a canonical, domain-separated Ed25519/Ed448 envelope. Imported evidence must include an ID, issuance time, public key, signature, and payload; stale, expired, unsupported, or modified envelopes are rejected.
- `checkMigrationCompatibility` is a preflight gate for the next schema version. A migration must define `up`, `down`, and `validate` functions, and pass representative round-trip samples before deployment.
- `createDeadLetterOperator` wraps inspection and retry operations with an authorization callback and audit callback. Direct queue helpers should not be exposed to HTTP handlers.

Repairs and retries should be run in dry-run mode first, with the returned sample and checkpoint recorded in the deployment change. If a job fails, inspect its checkpoint and error context before retrying it. A rollback is a migration-specific operation; do not delete checkpoints as a substitute for rollback.

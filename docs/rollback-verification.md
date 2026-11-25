# Rollback Verification

Running a rollback is not the same as being back where you started. A rollback can half-apply, run against data the forward step never saw, or leave indexes and checkpoints behind. This feature proves the data is restored after a failed migration or deployment, and refuses to continue when it is not.

Code: `src/lib/migrations/rollbackVerification.js`. CLI: `scripts/verify-rollback.mjs` (`npm run verify:rollback`). Tests: `tests/backend/rollback-verification.test.mjs`. It complements the [Migration Safety Framework](MIGRATION_SAFETY_FRAMEWORK.md) (dry-run, checkpoints, rollback notes) and the pre-release `checkRollbackReadiness` (is a recent backup available?). Those say a way back exists; this proves you used it correctly.

## How it works

1. **Fingerprint** the data the change can touch: per collection the document count, a SHA-256 digest of the documents in `_id` order (key order and `Date`/`ObjectId` representation do not matter), and the index names.
2. **Run** the change (`apply`), then any `postChecks`.
3. If `apply` throws or a post-check fails, **roll back** (`rollback`, retried with backoff).
4. **Verify**: take the fingerprint again and compare it with step 1, then run your `invariants`. Differences in count, content or lost indexes are errors. An index the change added and the rollback left behind is only a warning.

## Using it from code

```js
import { runWithRollbackVerification } from "@/lib/migrations/rollbackVerification";

const result = await runWithRollbackVerification({
  db,
  name: "add-tier-field",
  actor: { id: "ops-1", role: "deployer" },
  targets: ["materials", { collection: "purchases", query: { status: "confirmed" }, ignoreFields: ["lastSeenAt"] }],
  apply: () => migration.execute(),
  rollback: () => migration.rollbackToPreviousShape(), // must be idempotent
  postChecks: [{ name: "no-unmigrated", run: async (db) => ({ ok: (await db.collection("materials").countDocuments({ tier: { $exists: false } })) === 0 }) }],
  invariants: [{ name: "restore-invariants", run: async (db) => ({ ok: (await runRestoreVerification({ db })).ok }) }],
});
```

### Outcomes

| `outcome` | Meaning | System state |
| --------- | ------- | ------------ |
| `succeeded` | Applied and post-checks passed | New version, healthy |
| `rolled_back_verified` | Failed, rolled back, data proven identical to before | Known good |
| `rollback_drift` | Rolled back but the data differs from before (see `verification.differences`) | **Not known good** |
| `rollback_failed` | The rollback itself kept failing | **Partially applied** |
| `unverifiable` | Rolled back but the database could not be read back | **Unknown** |

Only the first two are safe to continue from. Every run is stored in `rollback_verifications` with its fingerprint, verification result and an event history.

## Authorization

`runWithRollbackVerification` and `retryRollbackVerification` require the same operator as a release (`checkDeploymentAuthorization`: role `admin`, `deployer` or `release_engineer`, or permission `system:migrate` / `system:release`). Otherwise they throw `AUTH_FORBIDDEN` before reading or writing anything. They are not exposed over HTTP.

## Failure and retry behavior

- **No rollback, no run.** Starting without a `rollback` function is refused with `VALIDATION_FAILED` (`missing_rollback`); `apply` never runs.
- **Evidence first.** The run record is written before `apply`. If it cannot be written, nothing is applied.
- **Rollback retries.** `rollback` is retried (`rollbackRetries`, default 2, exponential backoff). Write it so it is safe on untouched, half-applied and fully applied data.
- **Read retries.** Verification reads are retried; if the database stays unreadable the result is `unverifiable`, never `verified`. Invariants that throw count as failed.
- **Unresolved runs block.** While a run of a given `name` is `applying`, `rolling_back`, `rollback_failed`, `rollback_drift` or `unverifiable`, starting another run with that name fails with `CONFLICT_STATE` (`unresolved_run`). A unique partial index makes a concurrent start fail with `CONFLICT_IN_PROGRESS`. This stops a second change from being stacked on a bad state.
- **Resume.** `retryRollbackVerification(db, { runId, actor, rollback?, invariants? })`:
  - `rollback_drift` / `unverifiable`: re-verify only (after repairing the data or restoring connectivity).
  - `rollback_failed`, or `applying` / `rolling_back` left behind by a crashed runner: pass `rollback` to run it again, then verify.
  - Already verified: returns the stored result (`replayed: true`). A `succeeded` run is rejected (`not_retryable`).
  A verified result unblocks the name.

## Outside the runner: deployments

Platform deploys are not driven by this module. Use the CLI around them:

```bash
MONGODB_URI=... npm run verify:rollback -- capture --targets=materials,purchases,entitlement_cache --out=pre-deploy.json
# deploy ... it fails ... roll back
MONGODB_URI=... npm run verify:rollback -- verify --before=pre-deploy.json --restore-invariants
```

Exit codes: `0` verified, `1` drift, `2` usage error, `3` could not verify. A non-zero exit means do not reopen traffic or retry the deploy yet.

## Operational edge cases

- **Live traffic.** Writes to a fingerprinted collection between capture and verify look like drift. Scope each target with `query` to the data the change owns, `ignoreFields` for volatile fields (`updatedAt`, `lastSeenAt`), or put the site in maintenance mode for the window. Do not "fix" a false drift by loosening the check after the fact; re-capture next time.
- **Large collections.** Only the first `maxScan` documents (default 10,000, by `_id`) are hashed; the count is always exact. Truncated targets are reported under `warnings` as partial coverage, so changes beyond the scanned prefix are caught by count only. Raise `maxScan` for migrations that touch later documents, or scope with `query`.
- **Fingerprint files** (CLI) hold counts, digests and index names, not document contents, but treat them as internal. Targets with `ObjectId` queries cannot be round-tripped through the file; use the in-process runner for those.
- **Leftover checkpoints.** The Migration Safety Framework can leave a `migration_checkpoints` row open after an abort. Verification warns (it does not fail); close or delete the row before re-running that migration.
- **Leftover indexes** added by the failed change are warnings. Drop them when convenient.
- **Irreversible changes** (data deleted, external side effects like emails or on-chain transactions) cannot be proved reversible by a fingerprint of Mongo. For those, `rollback` should restore from backup, and the verification then tells you whether the restore was complete.

## Recovery playbook

1. `rollback_drift`: read `verification.differences`. Repair the listed collections (re-run an inverse script, or restore the affected documents from the latest backup), then `retryRollbackVerification`.
2. `rollback_failed`: fix the cause (connectivity, locks), then `retryRollbackVerification` with the rollback function.
3. `unverifiable`: restore database connectivity, then `retryRollbackVerification`.
4. If the data cannot be repaired, restore from backup, run `npm run verify:restore`, and record why in the incident notes. The unresolved run keeps blocking its name until a verification passes, so it cannot be forgotten.

## Compatibility and migration

Additive. No existing migration, release-readiness check or script changes. New: the `rollback_verifications` collection and its indexes (created by `ensureIndexes()` through `REQUIRED_INDEXES`), one module, one CLI and the `verify:rollback` npm script. Existing `SafeMigration` subclasses can adopt it by wrapping `execute()` as `apply` and their documented rollback as `rollback`.

Rollback of this feature: stop calling the module. The collection can stay; nothing else reads it.

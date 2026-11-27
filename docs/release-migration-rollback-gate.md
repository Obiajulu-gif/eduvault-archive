# Release readiness: migrations and rollback (#1080)

The evidence gate (`release/readiness.json`, see `src/lib/release/readiness.js`) records that each migration had a dry run and a documented rollback. This gate checks the plan behind those flags before a release that changes data.

```bash
npm run release:migrations -- release/migration-plan.json
npm run release:migrations -- release/migration-plan.json --commit "$GITHUB_SHA" --actor=deployer-carol --role=deployer
npm run release:migrations -- release/migration-plan.json --with-db   # also check rollback_verifications
```

Exit code 0 means ready, 1 means blocked. The JSON report lists each blocker with its migration id (`*` means the whole plan). Implementation: `src/lib/release/migrationRollbackGate.js`. Tests: `tests/backend/migration-rollback-gate.test.mjs`. Example plan: `release/migration-plan.example.json`.

## Plan format

Each migration entry needs:

- `id` (unique) and `order` (strictly increasing)
- `dryRun`: `status: "passed"`, `at` (within 7 days, not in the future), optional `attempts` and `commit`
- `idempotent`: `true` if running it twice is safe
- `rollback.strategy`, one of:
  - `down`: `script` plus `rehearsalStatus: "passed"` and `rehearsedAt` within 30 days
  - `restore_snapshot`: `snapshotId`, `snapshotAt` within 24 hours, `snapshotVerified: true`
  - `none`: irreversible. Needs `approvals` from someone with a release role (`admin`, `deployer`, `release_engineer`, or the `system:release` / `system:migrate` permission) who is neither the `author` nor the person running the gate

## Paths covered

| Path | Behavior |
| --- | --- |
| Normal | Every migration has a fresh dry run and a rehearsed rollback, so the release is ready. An empty `migrations` array is an explicit "no migrations". |
| Failure | Missing plan, duplicate ids, out-of-order entries, failed/stale/future dry runs, a dry run against a different commit, missing or unrehearsed rollback, or a stale or unverified snapshot. |
| Retry | A dry run that needed more than one attempt blocks unless the migration is `idempotent`, because a retried production run could apply twice. With `--with-db`, an unresolved `rollback_verifications` run for the same migration (`applying`, `rolling_back`, `rollback_failed`, `rollback_drift`, `unverifiable`) blocks until it is finished with `retryRollbackVerification`. |
| Authorization | The actor running the gate must have a release role. Irreversible migrations need a second, distinct, authorized approver. |

## Edge cases

- If `--with-db` is set and MongoDB cannot be reached, the gate **fails closed**: it cannot prove there is no half-rolled-back run.
- Without `--with-db` the database is not touched, so the gate can run in CI with no services.
- Unresolved runs only block the migration with the same name. Other migrations are unaffected.
- `restore_snapshot` is meant for backfills without a down script (for example `scripts/migrations/backfill-preview-images-v2.mjs`). The snapshot must be restore-verified (`npm run verify:restore`), not just taken.

## Recovery and rollback

The gate never runs migrations or rollbacks. When it blocks:

1. Rerun the dry run (`--dry-run` on the migration script) against the release commit and update `dryRun`.
2. Rehearse the rollback (`--rollback`) on a staging copy and update `rollback.rehearsalStatus` and `rollback.rehearsedAt`, or take and verify a fresh snapshot.
3. Resolve unresolved verification runs with `retryRollbackVerification` (see `src/lib/migrations/rollbackVerification.js`).

## Compatibility

`scripts/release-readiness.mjs` keeps its existing modes (`--evidence` for the workflow, and the live database checks). `--migration-plan` is a new opt-in mode, and `release/readiness.json` keeps its existing format. The release workflow is unchanged. To gate tags on the plan as well, add a step that runs `npm run release:migrations -- release/migration-plan.json --commit "$GITHUB_SHA"` once a real plan is committed.

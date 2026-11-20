# Sensitive Metadata Retention Enforcement (#1077)

Automated verification for `scripts/data-retention-cleanup.mjs` against sensitive metadata collections (`sensitive_access_log`, `download_access_log`) and permanently protected collections (`audit_ledger`, `purchases`, `refund_requests`) lives in `tests/backend/sensitive-metadata-retention-enforcement.test.mjs`.

## Paths Verified

- **Normal**: Records older than the 180-day retention window are flagged `eligible` in `buildPreviewReport` and removed on `cleanupCollection(..., false, now)`; recent records (< 180d) are preserved, and `buildSensitiveAccessEvent` strips raw PII/secret values.
- **Failure & Hold**: Records carrying `legalHold`, `auditHold`, `activeDispute`, or `holdReason` are bucketed as `held`; permanently protected collections are `skipped`; collection-level DB errors are isolated in `buckets.failed`.
- **Retry / Idempotency**: Retrying after a transient DB error succeeds cleanly, and re-running `cleanupCollection` after completion deletes `0` additional records.
- **Authorization & Dry-Run-First**: `parseArgs` defaults to `dryRun: true`, and `--preview` / `--report-json` always override `--execute` to prevent accidental destructive runs.

## Recovery & Rollback

1. Always run `--preview --report-json <path>` and verify `summary.collectionsFailed === 0` before running `--execute`.
2. If a collection fails mid-run, inspect `buckets.failed`, resolve the underlying DB issue, and re-run safely (cleanup is idempotent).
3. Records under `legalHold` / `activeDispute` cannot be deleted until the hold marker is explicitly cleared.

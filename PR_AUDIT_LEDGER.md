# PR: Create a tamper-evident audit ledger

## Summary

Implements #646 by adding a durable, append-only audit ledger for privileged moderation, refund, verification, account-status, and role changes. Each record carries an actor proof, intent hash, target, result, sequence, previous hash, and record hash. Repeated operations are idempotent through a unique operation ID.

## Changes

- Added `src/lib/backend/auditLedger.js` with canonical hashing, filtered reads, and offline verification.
- Added the `audit_ledger` collection and indexes for sequence, operation ID, action, and target lookup.
- Recorded successful and failed moderation actions, refunds, verification decisions, suspensions/reactivations, and role changes.
- Added `GET /api/admin/audit-ledger` for protected bounded exports and complete-chain verification.
- Added `POST /api/admin/audit-ledger` for verified checkpoint creation and optional external anchoring through `AUDIT_CHECKPOINT_URL`.
- Added an admin-only role-change endpoint with role validation and compare-and-set updates.
- Documented PII minimization, key rotation, retention, rollout, and external checkpoint requirements in `docs/audit-ledger.md`.
- Added tests for duplicate insertion, modification, deletion, and reordering detection.

## Compatibility and rollout

Existing console and refund-local audit records remain intact. Deploy the new indexes before enabling writes, then monitor duplicate-key and chain-conflict errors. Historical records are not backfilled because they lack canonical intent and actor-proof fields.

## Validation

- Editor diagnostics: no errors in changed JavaScript files.
- `git diff --check`: passed.
- Focused Vitest run: unavailable in this checkout because dependencies are not installed and registry access is restricted.

## Security notes

The export endpoint requires an admin session and filtered exports are not represented as complete-chain verification. Ledger mutation should be denied to application credentials in MongoDB; retention expiry should happen only after an independently verified export and external checkpoint.

Closes #646
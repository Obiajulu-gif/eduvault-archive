# Retention Holds for Refund and Compliance Investigations

This document describes the retention hold capability for preserving operational records during active **refund** and **compliance** investigations, preventing automated data retention cleanup from purging evidence.

## Architecture & Contracts

- **Domain Module:** `src/lib/privacy/retentionHolds.js`
- **Admin API Route:** `src/app/api/admin/retention-holds/route.js` (`GET`, `POST`, `PATCH`)
- **Cleanup Integration:** `scripts/data-retention-cleanup.mjs`
- **Storage Collections:**
  - `retention_holds` — permanently protected collection (`retentionDays: null, protected: true`) storing hold metadata, lifecycle state, and idempotency fingerprints.
  - `audit_ledger` — immutable audit trail recording `RETENTION_HOLD_CREATED`, `RETENTION_HOLD_RELEASED`, `RETENTION_HOLD_ROLLED_BACK`, and `RETENTION_HOLD_FAILED`.

### Investigation Types & Record Markers

To preserve backward compatibility with `scripts/data-retention-cleanup.mjs` (`RECORD_HOLD_MARKERS` and `resolveHoldReason`), creating a hold stamps standard marker fields directly on target records:

| `investigationType` | Record Markers Applied | Cleanup Preview Reason |
| --- | --- | --- |
| `refund_investigation` | `hold: true`, `refundPending: true`, `retentionHoldIds: [...]` | `pending_refund` |
| `compliance_investigation` | `hold: true`, `legalHold: true`, `auditHold: true`, `retentionHoldIds: [...]` | `legal_hold` / `audit_hold` |

`cleanupCollection` also applies `buildHoldExclusionFilter()` so `--execute` never deletes records carrying any active hold marker.

## API Contract (`/api/admin/retention-holds`)

All endpoints require an authenticated, non-suspended `admin` account (`requirePermission` + defense-in-depth `assertRetentionHoldAuthorized`).

- **`POST /api/admin/retention-holds`** — Create a retention hold.
  - Supports `Idempotency-Key` header or `idempotencyKey` body field.
  - Required body fields: `investigationType`, `targetCollection`, `targetRecordIds` (1–500 IDs), `caseId`, `reason`.
  - Optional body fields: `expiresAt` (future ISO timestamp), `requireAllTargetsExist` (boolean).
  - Status codes: `201` (created), `200` (idempotent replay), `400` (validation error), `401`/`403` (auth error), `404` (strict target missing), `409` (`IDEMPOTENCY_CONFLICT`), `500` (application failure with rollback).
- **`GET /api/admin/retention-holds`** — List holds with optional query filters (`status`, `investigationType`, `caseId`, `targetCollection`).
- **`PATCH /api/admin/retention-holds`** — Release an active hold (`holdId`, `releaseReason`). Idempotent if already released.

## Edge Cases

1. **Overlapping Holds on the Same Record:** A record may be covered by both a `refund_investigation` hold and a `compliance_investigation` hold simultaneously. Releasing one hold recomputes markers from all remaining active, non-expired holds so the record remains protected until every covering hold is released or expired.
2. **Idempotent Retries vs. Conflicting Reuse:** Retrying `POST` with the same `idempotencyKey` and identical payload returns `200` with the existing hold without creating duplicate holds or audit entries. Reusing the same `idempotencyKey` with a different payload fails closed with `409 IDEMPOTENCY_CONFLICT`.
3. **Reserved Collections:** `retention_holds` and `audit_ledger` are permanently protected and rejected as `targetCollection` values (`400 INVALID_TARGET_COLLECTION`).
4. **Missing Target Records:** By default, missing IDs are recorded in `missingRecordIds` while existing targets are held. Setting `requireAllTargetsExist: true` fails with `404 TARGET_RECORDS_NOT_FOUND` and rolls back any already-stamped records.

## Recovery & Rollback Behavior

- **Automatic Mid-Operation Rollback:** If a database write fails while stamping target records, `createRetentionHold` automatically reverts markers on all previously stamped records in the batch (preserving any unrelated active holds), transitions the hold document to `status: "rolled_back"`, and writes a `RETENTION_HOLD_FAILED` entry to `audit_ledger`.
- **Manual Rollback / Release:** Operators can release an erroneous or completed hold via `PATCH /api/admin/retention-holds` with a required `releaseReason`. This is idempotent and audited via `RETENTION_HOLD_RELEASED`.
- **Zero-Downtime Migration:** Existing collections and cleanup scripts require no schema migration. The `retention_holds` collection is created lazily on first write and is permanently protected in `RETENTION_POLICIES`.

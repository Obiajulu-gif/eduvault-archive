# Reliability and Reconciliation Design (#1173-#1176)

## Scope

- **#1173** deterministic entitlement reconciliation after refunds.
- **#1174** resumable large-file uploads with partial-failure recovery.
- **#1175** malware-scan provenance bound to exact content hashes.
- **#1176** creator payout ledger reconciliation against settlement events.

All four use the same baseline: trusted source records, deterministic plans, durable idempotency keys, bounded retries, append-only audit evidence, and fail-closed behavior on mismatch.

## Shared invariants

1. Never derive safety-critical state from untrusted client input alone.
2. Convert monetary values to integer minor units before arithmetic.
3. Write a durable plan before performing side effects.
4. Replaying the same input is a no-op and must not double-post or double-revoke.
5. Missing or conflicting evidence blocks publication/settlement rather than being treated as success.
6. Every side effect carries a stable idempotency key and an authorized principal.
7. Use explicit state transitions and persist failure evidence for operator replay.

## #1173 Refund entitlement reconciliation

- `src/lib/refunds/entitlementReconciliation.js` derives a plan from the purchase and refund records.
- A full refund (`cumulative refunded amount >= paid amount`) requires entitlement revocation.
- A partial refund retains entitlement but still mirrors the refund amount into the purchase.
- `planId` and `idempotencyKey` are SHA-256 digests of canonicalized trusted inputs.
- `entitlement_reconciliations` is written as `pending` before calling `revokeFn`; a crash after that point resumes the same plan.
- `refundWorkflow.finalizeSettlement` injects `revokeEntitlementFn`, preserving existing fault-injection tests.

### Edge cases

| Case | Outcome |
| --- | --- |
| Duplicate webhook / replay | `replayed`, no second revocation or amount increment |
| Revocation throws | plan stays `pending`, chunks/evidence retained, retry calls revoke again |
| Partial refund followed by full refund | cumulative amount triggers exactly one revoke |
| Unauthorized actor | rejected before any write |
| Missing purchase | returns `purchase_not_found`, refund unchanged |

### Migration / rollback

- Backfill `entitlement_reconciliations` from settled refunds before enabling new behavior.
- Existing purchases with `settlementState: "Refunded"` are treated as already reconciled.
- Rollback is code-only: stop invoking the new planner and restore the previous revoke path. Reconciliation rows remain as evidence.

## #1174 Resumable uploads

- `src/lib/storage/resumableUpload.js` stores sessions in `upload_sessions` and chunks in `upload_chunks`.
- Session creation requires an authenticated creator and a SHA-256 `expectedHash` of the complete file.
- Every chunk carries its own SHA-256; mismatches are recorded as `failed` and rejected.
- `getUploadProgress` returns `missingChunks`, so clients resume only what is absent.
- `pause`, `resume`, and `finalize` require both session ID and owner-bound upload token.
- Finalization reassembles bytes, verifies total length and full-file SHA-256, then pins and quarantines.
- Failed finalization retains all verified chunks; operators can fix the adapter and retry.
- `cleanup-expired` is an admin action that removes expired, non-finalized sessions and their chunks.

### Edge cases

| Case | Outcome |
| --- | --- |
| Dropped connection mid-upload | verified chunks remain; client queries progress and re-sends only missing chunks |
| Corrupt chunk | `CHUNK_HASH_MISMATCH`, chunk marked failed, no quarantine record |
| Wrong owner/token | `UNAUTHORIZED_UPLOAD`, no data read or written |
| Finalize with missing chunks | `INCOMPLETE_UPLOAD`, session marked failed, chunks retained |
| Full hash mismatch | `BYTE_HASH_MISMATCH`, nothing pinned or quarantined |
| Pinata or quarantine outage | session marked failed, verified chunks retained for retry |

### Migration / rollback

- Keep `/api/upload/chunked` action names unchanged; require the new `uploadToken` and `expectedHash` fields.
- Old `anonymous` sessions cannot be resumed; they were metadata-only placeholders and contained no file bytes.
- Rollback restores the previous route module while leaving session/chunk collections intact for cleanup.

## #1175 Malware-scan provenance

- `src/lib/publishing/scanProvenance.js` binds `byteHash`, CID, size, scanner identity, signature version, verdict, threats, and timestamp into a deterministic `evidenceId`.
- `verifyScanProvenance` recomputes SHA-256 from supplied bytes and rejects byte, CID, size, scanner, or evidence mismatches.
- Upload routes now compute the exact `byteHash` before pinning and include it in quarantine records and `scan_content` intents.
- `sideEffectWorker.processScanIntent` fetches the exact bytes, verifies them, and records provenance before delivery is marked complete.
- `scanQuarantinedContent` independently verifies fetched bytes against `expectedByteHash` before invoking the local scanner.
- `createIpfsFetchScanner` now returns the observed byte hash and length; `runScanner` rejects artifacts that do not match the quarantine record.

### Edge cases

| Case | Outcome |
| --- | --- |
| CID points to different bytes | `BYTE_HASH_MISMATCH` / `CONTENT_HASH_MISMATCH`, publish stays blocked |
| Size mismatch | `SIZE_MISMATCH` / quarantine rejection |
| Scanner or signature version changes | new evidence ID; stale clean verdicts require rescan |
| Duplicate provenance | `replayed`, no duplicate row |
| Unauthorized actor | rejected before write |

### Migration / rollback

- Backfill `scan_provenance` by re-fetching quarantined CIDs and comparing to `quarantine.byteHash`.
- Quarantine rows without `byteHash` remain fail-closed until explicitly re-scanned with an exact hash.
- Rollback keeps existing quarantine gating; new provenance rows are independent evidence.

## #1176 Payout settlement reconciliation

- `src/lib/payouts/settlementReconciliation.js` normalizes settlement events and derives a deterministic plan keyed by `eventId`.
- `payout_settlement_reconciliations` records the plan, payout snapshot, discrepancies, journal entry, and audit timestamps.
- Replays are no-ops; conflicting events with the same `eventId` create a `DUPLICATE_CONFLICT` record and audit event.
- Amount, asset, creator, network, and tx-hash mismatches are persisted as discrepancies and block posting.
- `appendJournalEntryFn` and `recordAuditFn` are injected so tests and callers use the same code path.
- Admin endpoint: `POST /api/admin/payouts/reconcile`.

### Edge cases

| Case | Outcome |
| --- | --- |
| Duplicate identical settlement event | `replayed`, no second journal entry |
| Same event ID with different fingerprint | `conflict`, no posting |
| Amount mismatch | `discrepancy`, no posting, audit evidence retained |
| Payout not found | `PAYOUT_NOT_FOUND` discrepancy |
| Unauthorized actor | `UNAUTHORIZED_RECONCILIATION` before writes |
| Decimal precision beyond 6 places | `AMOUNT_PRECISION_UNSUPPORTED` |

### Migration / rollback

- Backfill by replaying settlement events through the reconciliation module in dry-run mode.
- Existing payouts remain authoritative; reconciliation never mutates their amounts.
- Rollback disables the admin route and worker hook; reconciliation and audit rows remain as evidence.

## Delivery workflow

1. Feature branch from latest `upstream/main`.
2. Focused commits; no formatting-only churn.
3. `fetch upstream main` + rebase before push.
4. Push to `origin` fork and open one PR to upstream with `Closes #1173` through `Closes #1176`.
5. Run backend tests, frontend tests, and lint before requesting review.

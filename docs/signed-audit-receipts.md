# Signed audit receipts for privileged actions (#1082)

The audit ledger (`src/lib/backend/auditLedger.js`, see [audit-ledger.md](audit-ledger.md)) is a hash chain. A **receipt** is portable, signed proof of one privileged action. It can be given to the affected user, attached to an incident, or checked by a reviewer later, without trusting whoever passes it along.

Implementation: `src/lib/audit/auditReceipts.js`. Tests: `tests/backend/audit-receipts.test.mjs`.

## Receipt format

```json
{
  "version": "audit-receipt.v1",
  "algorithm": "HMAC-SHA256",
  "keyId": "k2",
  "receiptId": "…",
  "operationId": "op-role-1",
  "sequence": 41,
  "recordHash": "<ledger record hash>",
  "action": "user.role_changed",
  "actor": "admin-1",
  "actorRole": "admin",
  "targetHash": "<sha256 of the canonical target>",
  "recordedAt": "2026-11-18T11:59:58.000Z",
  "issuedAt": "2026-11-18T12:00:00.000Z",
  "signature": "<base64url HMAC over the canonical JSON of every other field>"
}
```

- `recordHash` pins the exact ledger record, so a rewritten ledger entry no longer matches its receipt.
- The target is stored only as a hash, so a receipt can be shared without exposing other users' ids. A verifier who has the ledger record can still check it.

## Privileged actions

Receipts are only issued for actions whose names start with: `user.role_changed`, `user.suspend`, `user.reactivate`, `moderation.`, `quota.`, `verification.`, `material.catalog_access_`, `impersonation.`, `refund.`, `payout.`, `config.`. These match the names the admin routes already write to the ledger. Other actions are refused (`not_privileged`).

## Keys and rotation

```bash
AUDIT_RECEIPT_KEYS="k1:<base64>,k2:<base64>"   # each secret ≥ 32 bytes
AUDIT_RECEIPT_ACTIVE_KEY_ID=k2
AUDIT_RECEIPT_REVOKED_KEY_IDS=                 # e.g. "k1" after a key leak
```

- **Rotate:** add a new kid, switch `AUDIT_RECEIPT_ACTIVE_KEY_ID`, and keep the old kid listed so older receipts still verify.
- **Revoke:** add the kid to `AUDIT_RECEIPT_REVOKED_KEY_IDS`. Every receipt signed with it now fails as `key_revoked`, and the key can no longer sign. Then reissue receipts for affected operations with a new active key. The ledger is the source of truth, so nothing is lost.
- Short or malformed keys are rejected when loaded (`weak_key`, `invalid_key_id`).

## Paths covered

| Path | Behavior |
| --- | --- |
| Normal | `issueAuditReceipt` signs. `verifyAuditReceipt` returns `{ valid: true }`, optionally checked against the ledger record. |
| Failure | Tampering returns `bad_signature`. Ledger mismatch returns `record_mismatch`. Unknown or revoked keys return `unknown_key` / `key_revoked`. Bad versions or algorithms are reported, and verification never throws. With no usable signing key, issuing **fails closed** with `SERVICE_UNAVAILABLE`. |
| Retry | `issueOrGetReceipt` stores one receipt per `operationId` in `audit_receipts` (unique index via `ensureAuditReceiptIndexes`). Retries return the stored receipt instead of signing a new one. A concurrent issuer that loses the duplicate-key race returns the winner's receipt. |
| Authorization | Only the operator who performed the action, or an admin, may issue or re-read a receipt (`AUTH_FORBIDDEN` otherwise). Verification needs only the keys. |

## Verifying

```bash
npm run audit:verify-receipt -- receipt.json                # signature only
npm run audit:verify-receipt -- receipt.json --with-ledger  # also match the ledger record
```

Exit codes: 0 valid, 1 invalid, 2 usage or configuration error.

## Edge cases and recovery

- If receipt issuance fails (missing key, database error), the privileged action has **already** been recorded in the ledger. Do not roll the action back. Fix the key and call `issueOrGetReceipt` again for the same `operationId`.
- A receipt stays valid after its key is rotated out of active use, but not after the key is revoked.
- Records without `createdAt` produce `recordedAt: null` rather than an error.

## Compatibility and adoption plan

Additive only: no existing route, ledger record, or response shape changes, and the ledger format is untouched. To adopt in a route, after `appendAuditRecord` succeeds:

1. Run `ensureAuditReceiptIndexes(db)` once (for example from `scripts/setup-db-indexes.js`).
2. Call `issueOrGetReceipt({ db, operationId, requester })` and return the receipt in a new optional `receipt` field. Existing clients ignore the field.
3. Treat a `SERVICE_UNAVAILABLE` from receipt issuance as non-fatal for the action, and log it so the receipt can be issued later.

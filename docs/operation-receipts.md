# Signed Operation Receipts (#1105)

Critical backend operations can emit signed, verifiable receipts for audit and client confirmation.

## API

- `POST /api/receipts` - create/get idempotent receipt for a critical operation.
- `GET /api/receipts/{id}` - fetch receipt; actor or admin/service only. Returns `verified`.

## Receipt fields

- `receiptId`, `version`, `actor`, `operation`, `status`, `timestamp`
- `externalRefs`, `payload`, optional `dedupeKey`
- `payloadHash` (SHA-256 of canonical payload)
- `signature` (HMAC-SHA256 over payloadHash; `RECEIPT_SIGNING_SECRET`)

## Idempotency

If `dedupeKey` is provided, the same key returns the same stored receipt. Otherwise the endpoint derives a key from actor+operation+status+externalRefs.

## Verification

`verifyOperationReceipt()` recomputes canonical payload hash and HMAC signature. Tampering causes verification failure.

## Rollback

Receipt generation is additive. Disable callers/routes if needed; stored receipts remain immutable audit evidence.

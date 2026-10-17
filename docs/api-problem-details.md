# API Problem Details and Error Codes

EduVault error responses use RFC 9457 Problem Details with the media type
`application/problem+json`. The code catalog in
[`src/lib/errors/codes.js`](../src/lib/errors/codes.js) is the source of truth
for stable codes, HTTP status, retryability, safe user-facing messages, and
remediation hints.

## Response contract

```json
{
  "type": "https://eduvault.dev/problems/entitlement_unavailable",
  "title": "Access could not be verified right now.",
  "status": 503,
  "detail": "Wait briefly and check again. Do not repeat a payment while its status is uncertain.",
  "instance": "/api/download",
  "code": "ENTITLEMENT_UNAVAILABLE",
  "retryable": true,
  "recovery": "Wait briefly and check again. Do not repeat a payment while its status is uncertain.",
  "correlationId": "request-reference",
  "error": "Entitlement verification unavailable"
}
```

`error` is a compatibility alias for existing clients and is deprecated; new
clients should branch on `code`, use `retryable` to decide whether to retry,
show `title`/`detail`, and use `correlationId` when contacting support.
`instance` is a path only and must not include query parameters. An optional
`retryAfter` value and `Retry-After` header are returned for rate limits.
Internal exception messages, database details, stack traces, secrets, and
signed download URLs must never be returned in a problem body.

Problem Details are additive on the covered API failure paths: successful
response shapes and request schemas are unchanged. Older clients can continue
reading the `error` string while migrating to the stable fields.

## Stable code catalog

Codes are append-only. Do not rename or reuse one, silently change its status,
or make clients parse prose. A change to an existing code's meaning requires
an explicit API migration/version decision. Tests compare the catalog and both
OpenAPI copies to catch accidental contract drift.

| Code | HTTP | Retryable | Remediation |
| --- | ---: | :---: | --- |
| `VALIDATION_FAILED` | 400 | No | Review the request and correct invalid values. |
| `VALIDATION_FIELD` | 400 | No | Correct the invalid or missing field. |
| `VALIDATION_FILE_TYPE` | 400 | No | Upload a supported file type. |
| `VALIDATION_FILE_SIZE` | 400 | No | Reduce the upload size. |
| `VALIDATION_UPLOAD_TOO_LARGE` | 413 | No | Reduce the upload request size. |
| `VALIDATION_RANGE_TOO_LARGE` | 413 | No | Request a smaller byte range. |
| `AUTH_UNAUTHENTICATED` | 401 | No | Sign in and retry. |
| `AUTH_SESSION_EXPIRED` | 401 | No | Refresh the session or sign in again. |
| `AUTH_FORBIDDEN` | 403 | No | Use an account with the required permission. |
| `AUTH_SUSPENDED` | 403 | No | Contact support to appeal the suspension. |
| `ENTITLEMENT_REQUIRED` | 403 | No | Confirm the purchasing account or acquire access. |
| `ENTITLEMENT_PURCHASE_REQUIRED` | 402 | No | Review the listing and complete checkout. |
| `ENTITLEMENT_UNAVAILABLE` | 503 | Yes | Retry the access check; do not repeat a payment while settlement is uncertain. |
| `MATERIAL_ARCHIVED` | 410 | No | Contact the creator if the listing should be available. |
| `NOT_FOUND` | 404 | No | Check the resource identifier. |
| `CONFLICT_DUPLICATE` | 409 | No | Review the existing record instead of creating another. |
| `CONFLICT_IDEMPOTENCY_KEY` | 409 | No | Reuse the key only for the identical request; otherwise create a new key. |
| `CONFLICT_STATE` | 409 | No | Refresh state and resolve the conflict before resubmitting. |
| `SETTLEMENT_QUOTE_EXPIRED` | 409 | No | Obtain a new quote before paying. |
| `SETTLEMENT_INSUFFICIENT_FUNDS` | 402 | No | Fund the wallet and retry checkout. |
| `SETTLEMENT_TX_FAILED` | 502 | Yes | Check transaction status before retrying. |
| `SETTLEMENT_TIMEOUT` | 504 | Yes | Reconcile transaction history before retrying. |
| `SETTLEMENT_UNAVAILABLE` | 503 | Yes | Retry after the payment service recovers. |
| `PAYOUT_PROFILE_INCOMPLETE` | 400 | No | Add or verify the creator payout wallet. |
| `PAYOUT_UNAVAILABLE` | 503 | Yes | Retry the report and reconcile inconsistent totals. |
| `STORAGE_UPLOAD_FAILED` | 502 | Yes | Retry after checking storage-provider health. |
| `STORAGE_NOT_FOUND` | 404 | No | Verify the stored content and contact support if purchased. |
| `STORAGE_UNAVAILABLE` | 503 | Yes | Retry the download later; do not reuse an expired capability URL. |
| `STORAGE_QUARANTINED` | 403 | No | Wait for review or contact support. |
| `RATE_LIMITED` | 429 | Yes | Wait for `Retry-After` before retrying. |
| `INTERNAL` | 500 | Yes | Retry safely and provide the correlation ID to support. |

The status and remediation values above are public contract. The legacy
`EVT_*` identifiers documented in [API_REFERENCE.md](./API_REFERENCE.md)
belong to the event/integration catalog; they are not aliases for this HTTP
code catalog.

## Covered workflows

The shared API hardening wrapper, purchase, entitlement verification,
protected download, creator payout reporting, and material archive/restore
failures emit the structured contract. Other legacy route handlers are being
migrated incrementally; consumers should retain their existing endpoint
specific handling until that endpoint documents `application/problem+json`.

## Failure handling and recovery

| Failure mode | Safe action |
| --- | --- |
| Entitlement provider or database unavailable | Fail closed for protected delivery. Retry the check later; do not infer ownership or trigger a second payment. |
| Payment request times out or response is lost | Check the transaction hash and canonical settlement/purchase record first. Retry only with the same idempotency context; never assume timeout means payment failed. |
| Quote expired or already consumed | Fetch a new quote. Do not replay the old quote or alter a purchase record by hand. |
| Creator payout report fails | Retry the read-only report. If totals conflict with payout history, stop payout action and reconcile the financial ledger before proceeding. |
| Archive/restore write succeeds but search projection enqueue fails | Treat the material record as authoritative for the archive flag. Inspect the projection/outbox and use the established projection repair/replay tooling; do not bypass archive checks or revoke existing buyer entitlements. |
| Storage content is missing or quarantined | Keep protected download blocked. Verify the CID and quarantine decision, restore only verified content, then recheck entitlement and delivery. |
| Unexpected server error | Use the correlation ID to locate redacted server telemetry. Do not expose raw logs or include student data, credentials, wallet secrets, or signed capability URLs in support tickets. |

## Rollback and compatibility recovery

1. If the release causes a rise in API failures, roll back the application
   deployment; this change does not require a database or on-chain migration.
2. The change is response-only: purchase records, entitlements, creator
   balances, and archive state must not be rolled back as a response to a
   deployment rollback.
3. Before replaying any purchase, payout, or archive side effect, reconcile
   the canonical purchase/ledger/material record and pending outbox or search
   projection work.
4. Keep clients tolerant of the legacy `error` alias during rollout. The
   stable `code` and RFC 9457 fields are additive; do not remove the alias
   without a separately versioned migration.
5. Verify protected downloads remain fail-closed, archived materials remain
   absent from public search, and existing buyer entitlements still work after
   recovery.

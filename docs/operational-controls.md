# Operational controls

## Policy dry-runs

`POST /api/admin/policies/simulate` is read-only. It returns a fingerprinted preview, a bounded `affectedRecords.sample`, the total `affectedRecords.count`, rollback constraints, and `writesPerformed: 0`. A commit must use the fingerprinted preview and the existing severity/approval gate; an expired or changed preview must be regenerated.

## Duplicate delivery suppression

Notifications are unique on `(recipient, dedupeKey)` and webhook/outbox intents use a stable `deliveryId` or `idempotencyKey`. Use `deliveryDedupeKey({ channel, eventType, sourceId, version })` when deriving keys from retried events. A duplicate is a no-op and must not reset a sent notification or create another outbox intent.

## Correlation and redaction

API requests accept `X-Correlation-Id` (or `X-Request-Id`) and generate one when absent. The ID is bound to the async request context, included in structured API logs, and propagated as `X-Correlation-Id` on outbound webhooks. Log fields pass through the existing redaction allow-list; secrets, tokens, cookies, signatures, emails, and private keys must never be added to raw logs.

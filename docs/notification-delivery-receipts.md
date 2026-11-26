# Notification Deduplication and Delivery Receipts (#1105)

This document covers the vertical slice for issue #1105: deduplicated notification creation with delivery receipts.

## Scope

- **Deduplication**: `notify()` inserts once per `(recipient, dedupeKey)`. Retries/replays do not create duplicates or reset delivery state.
- **Delivery receipts**: each recorded delivery attempt persists a deterministic receipt in `notification_delivery_receipts`.
- **Diagnostics**: failed/exhausted deliveries can be inspected by the notification recipient through a scoped API.

## Data model

### `notifications`

Existing fields plus delivery tracking:

- `deliveryStatus`: `pending | sent | failed | exhausted | suppressed`
- `attempts`, `lastAttemptAt`, `lastError`, `sentAt`
- `lastDeliveryReceiptId`: latest persisted delivery receipt

Indexes:

- `notifications_recipient_dedupe_idx`: `{ recipient: 1, dedupeKey: 1 }` unique
- `notifications_inbox_idx`: `{ recipient: 1, read: 1, createdAt: -1 }`
- `notifications_delivery_idx`: `{ recipient: 1, deliveryStatus: 1, lastAttemptAt: -1 }`

### `notification_delivery_receipts`

Receipt fields:

- `receiptId` - SHA-256 of canonical receipt payload
- `notificationId`, `recipient`, `dedupeKey`, `type`
- `status`, `attempt`, `at`, `error`
- `createdAt`

Indexes:

- `notification_delivery_receipts_receipt_idx`: `{ receiptId: 1 }` unique
- `notification_delivery_receipts_recipient_idx`: `{ recipient: 1, notificationId: 1, createdAt: -1 }`

## API

### `GET /api/notifications/delivery-receipts?limit=50`

Auth required. Returns only the current user's delivery diagnostics:

```json
{
  "receipts": [
    {
      "id": "...",
      "type": "import_completed",
      "dedupeKey": "import:batch-1",
      "deliveryStatus": "failed",
      "attempts": 1,
      "lastAttemptAt": "2026-11-22T00:00:00.000Z",
      "lastError": "smtp down",
      "lastDeliveryReceiptId": "<sha256>"
    }
  ]
}
```

## Retry and authorization behavior

- `notify()` dedupe is idempotent by `(recipient, dedupeKey)`.
- `recordDeliveryAttempt()` is recipient-scoped; another user cannot mutate delivery state.
- `retryFailedDelivery()` never re-sends `sent` notifications (`already_sent`, `doubleSendPrevented`).
- `exhausted` notifications are terminal unless explicitly requeued by an operator flow.
- `suppressed` notifications remain audit records and are never delivered.
- Errors are sanitized/capped before storage.

## Verification

- Unit tests: `src/lib/notifications/notifications.test.js` cover dedupe, retry, terminal states, and permission scoping.
- Contract behavior: notification routes remain recipient-scoped and documented in OpenAPI.

## Recovery / rollback

- **Recovery**: inspect `notification_delivery_receipts` and notification delivery fields; retry failed deliveries through `retryFailedDelivery` with a delivery callback.
- **Rollback**: remove delivery-receipt writes and route; existing notifications remain readable. Receipts collection can be retained for audit or dropped after backup.

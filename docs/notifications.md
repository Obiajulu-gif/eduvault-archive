# Notifications

In-app notifications for events a user has to act on or know about. Introduced
in #794 (import events) and extended in #776 to cover critical lifecycle and
recovery events.

## Design

- **Recipient is always the session user id (`sub`).** Every read and write in
  `src/lib/notifications/notifications.js` is filtered by it, so one user can
  never see or flip another user's notifications.
- **Deep links are always internal paths.** A stored `//evil.com` or absolute
  URL would turn a trusted notification into an open redirect, so links are
  validated against a strict internal-path pattern before insert.
- **Deduplication is per `(recipient, dedupeKey)`.** Retried events reuse the
  same `dedupeKey`, so the upsert only inserts the first time. A unique index
  on `(recipient, dedupeKey)` makes this safe under concurrent workers.
- **Read state is per recipient.** `markNotificationsRead` only ever updates the
  caller's own notifications; ids belonging to anyone else simply don't match.

## Delivery tracking and retries

Each notification carries a delivery lifecycle (#834):

| Field | Meaning |
| ----- | ------- |
| `deliveryStatus` | `pending` → `sent` / `failed` → `exhausted` |
| `attempts` | Number of delivery attempts recorded |
| `lastAttemptAt` | Timestamp of the most recent attempt |
| `lastError` | Sanitized (collapsed, ≤200 char) failure reason |
| `sentAt` | Timestamp of the successful attempt, if any |

- New notifications are inserted `pending` with `attempts: 0`. Because `notify`
  only ever `$setOnInsert`s, a retried source event with the same
  `(recipient, dedupeKey)` does not create a second row **and does not reset**
  the existing delivery state.
- `recordDeliveryAttempt(db, id, { recipient, status, error })` advances the
  state and increments `attempts`. It is recipient-scoped, so a caller can
  never flip another user's delivery state, and it refuses to overwrite a
  terminal `sent` notification — a late or racing failure cannot un-send it.
- `retryFailedDelivery(db, id, deliverFn, { recipient, maxAttempts = 3 })`
  invokes `deliverFn` at most once per call with a recipient-scoped public
  payload (no `recipient`/`dedupeKey`). On success it records `sent`; on
  failure it records `failed`, then `exhausted` once `attempts >= maxAttempts`.
  It never re-delivers an `already_sent` notification (returns
  `doubleSendPrevented: true`) and never auto-retries an `exhausted` one.
- `getDeliveryDiagnostics(db, recipient, { limit })` returns the recipient's
  `failed`/`exhausted` notifications with `attempts`, `lastAttemptAt`, and the
  sanitized `lastError` for operator triage. Both the lookup and the returned
  rows are scoped to the recipient.

Delivery state is intentionally **not** exposed on the public inbox payload;
only the internal helpers and diagnostics see it.

No migration step is required: notifications created before #834 simply lack
the delivery fields and are treated as `attempts: 0` on their first tracked
retry. The `notifications_delivery_idx` index is created by the normal
`REQUIRED_INDEXES` startup path.

## Event types

| Type | Severity | Default deep link | Recipient |
| ---- | -------- | ----------------- | --------- |
| `import_completed` | success | `/dashboard/my-materials` | importing user |
| `import_partial_failure` | error | `/dashboard/my-materials` | importing user |
| `purchase_completed` | success | `/dashboard/purchases` | buyer |
| `payment_failed` | error | `/dashboard/purchases` | buyer |
| `refund_requested` | info | `/dashboard/purchases` | buyer |
| `refund_settled` | success | `/dashboard/purchases` | buyer |
| `refund_failed` | error | `/dashboard/purchases` | buyer |
| `entitlement_revoked` | warning | `/dashboard/library` | buyer |
| `payout_processed` | success | `/dashboard/analytics` | creator |
| `account_suspended` | error | `/support` | suspended user |
| `account_reactivated` | info | `/dashboard` | reactivated user |
| `wallet_recovery_completed` | success | `/dashboard/settings` | recovering user |

The `#776` types (everything after the import events) are gated behind the
`CRITICAL_LIFECYCLE_NOTIFICATIONS` feature flag. Import notifications predate the
flag system and always fire.

## Recipient resolution

Backend workflows (refund settlement, payout, suspension) know a **wallet
address**, not a session user id. `notifyWalletRecipient` resolves the address
to the user's MongoDB `_id` (the notification recipient) and applies the
feature-flag gate in one place. If no user record exists for the address, the
notification is skipped — there is no inbox to deliver into.

The admin suspend/reactivate route is the one workflow that already has the
session user id, so it calls `notify` directly.

## API

```
GET    /api/notifications?unread=true&limit=20
PATCH  /api/notifications  { ids: [...] } | { all: true }
```

Both routes are scoped to the authenticated session user. See
[API reference](API_REFERENCE.md) and [openapi.yaml](openapi.yaml).

## Tests

`src/lib/notifications/notifications.test.js` covers:

- targeting — a notification is delivered only to the resolved recipient
- deduplication — retried events with the same `dedupeKey` create exactly one
  notification, even under concurrent delivery
- read state — unread counts and mark-read are scoped per recipient
- feature-flag gating — critical lifecycle notifications are skipped when the
  flag is off (the safe default)
- deep-link validation — non-internal links are rejected
- delivery tracking — a duplicate source event neither duplicates nor resets
  delivery state
- retry — a failed delivery can be retried to `sent`, is never double-sent once
  `sent`, and is marked `exhausted` after `maxAttempts`
- permission safety — another user cannot read, retry, or flip a notification,
  and delivery errors are sanitized

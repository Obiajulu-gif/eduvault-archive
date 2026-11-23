# Webhook Dead-Letter Replay with Idempotency Guards

## Overview

When outbound webhook deliveries exhaust their outbox retry budget, their `side_effect_outbox` records transition to `status: "dead_letter"`. This vertical slice provides a safe, authorized, and idempotent operator workflow to inspect and replay dead-lettered webhook intents without duplicating side effects.

### Components

- **Core service**: [`src/lib/webhooks/deadLetterReplay.js`](../src/lib/webhooks/deadLetterReplay.js)
  - `listDeadLetterWebhooks(db, options)` — lists dead-lettered webhook entries for authorized operators.
  - `replayDeadLetterWebhook(db, options)` — replays a single dead-lettered webhook entry with idempotency, partial-delivery tracking, causal-successor unblocking, and audit logging.
  - `replayDeadLetterWebhooksBatch(db, options)` — replays up to 50 dead-lettered entries with per-entry derived idempotency keys (`<batchKey>:<entryId>`).
- **Admin API route**: [`src/app/api/admin/webhooks/dead-letter/replay/route.js`](../src/app/api/admin/webhooks/dead-letter/replay/route.js)
  - `GET /api/admin/webhooks/dead-letter/replay?limit=25&skip=0`
  - `POST /api/admin/webhooks/dead-letter/replay` (requires `Idempotency-Key` header or `idempotencyKey` body field)

---

## Request & Response Contract

### Single Replay

```http
POST /api/admin/webhooks/dead-letter/replay
Authorization: Bearer <admin-jwt>
Idempotency-Key: dlq-replay-2026-11-23-001
Content-Type: application/json

{
  "entryId": "6741...",
  "reason": "downstream_recovered"
}
```

### Batch Replay

```http
POST /api/admin/webhooks/dead-letter/replay
Authorization: Bearer <admin-jwt>
Idempotency-Key: dlq-batch-2026-11-23-001
Content-Type: application/json

{
  "entryIds": ["6741...", "6742..."],
  "reason": "incident_recovery"
}
```

### Status Codes

| Status | Meaning |
| --- | --- |
| `200` | Replay succeeded (or returned cached result with `replayed: true`). |
| `400` | Missing `Idempotency-Key`, invalid target, non-webhook intent, or batch size > 50. |
| `401` | Caller is not authenticated as an admin. |
| `403` | Actor failed operator authorization guard (`WEBHOOK_REPLAY_FORBIDDEN`). |
| `404` | Outbox entry not found (`WEBHOOK_REPLAY_NOT_FOUND`). |
| `409` | Entry is not in `dead_letter` state, concurrent replay in flight (`CONFLICT_IN_PROGRESS`), or idempotency key reused with a different payload (`CONFLICT_IDEMPOTENCY_KEY`). |
| `502` | One or more webhook destinations failed delivery (`WEBHOOK_REPLAY_DELIVERY_FAILED`); safe to retry with the same `Idempotency-Key`. |

---

## Edge Cases & Guarantees

1. **Duplicate requests after success**: `withIdempotency` caches the completed response under `webhook-dlq-replay:<key>` for 24 hours. Subsequent requests with the same key and payload return `{ ...result, replayed: true }` without invoking `sendWebhookWithRetry`.
2. **Concurrent duplicate requests**: The first caller atomically claims the idempotency record (`status: "in_progress"`). Concurrent callers receive `409 CONFLICT_IN_PROGRESS` instead of double-delivering.
3. **Key reuse with mismatched payload**: Reusing an existing `Idempotency-Key` for a different `entryId`, `deliveryId`, or `reason` fails with `409 CONFLICT_IDEMPOTENCY_KEY`.
4. **Partial multi-URL failure**: If a webhook intent targets multiple URLs and a subset succeeds while another fails, the succeeded URLs are persisted in `replayDeliveredUrls` on the outbox document while `status` remains `dead_letter`. Retrying with the same `Idempotency-Key` only delivers to the remaining undelivered URLs.
5. **Authorization before state mutation**: Authorization is enforced before reading the outbox or claiming an idempotency key, so unauthorized callers cannot pollute or lock idempotency keys.
6. **Causal ordering preservation**: Once a dead-lettered webhook is successfully replayed to `delivered`, any successor outbox entries with `previousDeliveryId === entry.deliveryId` have `predecessorDelivered` updated to `true` so downstream ordered deliveries can resume.
7. **SSRF & signature enforcement**: Delivery delegates to `sendWebhookWithRetry`, preserving delivery-time SSRF validation and HMAC-SHA256 signing.

---

## Recovery & Rollback Behavior

- **Downstream still failing during replay**: The outbox entry stays in `dead_letter` with incremented `replayAttempts`, `lastReplayAt`, `lastReplayBy`, and `lastReplayError`. The idempotency record transitions to `failed`, allowing the operator to retry with the same `Idempotency-Key` once the downstream endpoint recovers.
- **Process crash mid-replay**: If the server crashes while an idempotency claim is `in_progress`, the lock expires after `lockMs` (default 2 minutes), allowing a subsequent retry with the same key to take over safely. Any URLs already recorded in `replayDeliveredUrls` will not be re-sent.
- **Rollback**: This feature is additive and preserves all existing `side_effect_outbox` and `idempotency_keys` contracts. Rolling back requires only removing the new route and replay module; no schema migration or data backfill is required (optional fields `replayAttempts`, `replayDeliveredUrls`, `lastReplayAt`, `lastReplayBy`, `lastReplayError`, `lastReplayKey` are ignored by existing outbox workers).

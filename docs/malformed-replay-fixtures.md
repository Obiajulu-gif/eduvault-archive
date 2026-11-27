# Malformed Payload & Replay Attack Fixtures (#1074)

Adversarial fixture corpora live under `test/fixtures/webhook-adversarial/cases.json` and `test/fixtures/malformed-replay/cases.json`, verified by `tests/backend/malformed-replay-fixtures.test.mjs` and `src/lib/webhooks/adversarial-fixtures.test.js`.

## Covered Paths

- **Normal**: Valid HMAC-SHA256 webhook signatures, valid single-use capability tokens, and clean sanitized inputs.
- **Failure (Malformed Payloads)**: Prototype pollution (`__proto__`, `constructor`), null-byte/control-char injection, malformed email/wallet/URL inputs, CRLF header injection, duplicate `v1=` fields, negative timestamps.
- **Replay & Authorization**: Capability token JTI replay, expired capability tokens, cross-actor capability replay, webhook replay across key rotation grace windows, and idempotency key reuse with mutated payloads (`CONFLICT_IDEMPOTENCY_KEY`).
- **Retry**: Legitimate idempotent retry with identical payload returns `replayed: true` without re-executing side effects.

## Edge Cases & Recovery / Rollback

- **Replay cache recovery**: `clearWebhookReplayCache()` resets in-memory webhook replay tracking in tests; in production, entries expire automatically after `toleranceSeconds` (default 300s) and `createCapabilityNonceStore().prune(now)` evicts expired JTIs.
- **Key rotation rollback**: `verifyWebhookSignatureWithRotation` accepts `previousSecret` during `rotationGraceSeconds` while still enforcing replay protection on every verified signature.

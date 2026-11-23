# Malformed Payload & Replay Attack Fixtures (#1074)

Reusable adversarial corpus for request validation, sanitization, capability token replay protection, and idempotency payload-mutation detection.

- `cases.json` defines:
  - `malformedPayloads`: prototype pollution (`__proto__`, `constructor`), control-char/null-byte injection, invalid email/wallet/URL inputs.
  - `replayAttacks`: single-use capability JTI replay, expired capability token replay, cross-actor capability replay, and idempotency key replay with mutated payload.
- Executed by `tests/backend/malformed-replay-fixtures.test.mjs` alongside `test/fixtures/webhook-adversarial/cases.json`.

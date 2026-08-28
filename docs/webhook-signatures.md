# Creator Webhook Signatures

EduVault signs creator webhooks with `X-EduVault-Signature`.

The header uses the format `t=<unix timestamp>,v1=<hex hmac>`. The HMAC is `HMAC-SHA256` over:

```text
<timestamp>.<raw JSON request body>
```

Use your account's `webhookSigningSecret` to recompute the digest, compare it with a constant-time equality check, and reject requests whose timestamp is outside a short replay window such as five minutes.

## Replay protection (#669)

Receivers should treat each `(timestamp, signature)` pair as single-use within the replay window. EduVault's verification helper keeps an in-memory replay cache keyed by the full signature header and rejects duplicate deliveries during the tolerance window.

## Key rotation (#669)

During rotation, store the previous secret on the creator profile as
`webhookSigningSecretPrevious` alongside `webhookSigningSecretRotatedAt`.
Verification accepts either secret during the grace window (default 24 hours).
After the grace window expires, only the current secret is accepted.

## Verification checklist

1. Parse `t` and `v1` from `X-EduVault-Signature`.
2. Reject timestamps outside the configured skew window.
3. Recompute the HMAC over `<timestamp>.<raw body>` and compare in constant time.
4. Reject replayed signature headers seen within the replay window.
5. During rotation, try the current secret first, then the previous secret if still within grace.

# Adversarial webhook signature fixtures

Golden corpus of malformed and adversarial inbound payloads for
`verifyWebhookSignature` / `verifyWebhookSignatureWithRotation`
(`src/lib/webhooks/sender.js`). Every fixture in `cases.json` MUST be
rejected (verification returns `false`); none of these represent a payload
that should ever be accepted.

Each case has:

- `id` — stable slug, used in test failure messages.
- `description` — the specific malformation or attack this exercises.
- `body` — raw request body string (already serialized; never re-stringify
  it, since that's exactly the canonicalization bug this suite guards
  against).
- `signatureHeader` — the `X-EduVault-Signature` header value to verify.
- `secret` — the signing secret to verify against.
- `verifyAt` — the `now` (unix seconds) to pass as the verification clock,
  so skew/expiry cases are deterministic instead of depending on wall time.
- `category` — one of `invalid-signature`, `missing-field`,
  `oversized-value`, `replay`, `schema-drift`.

Add new adversarial cases here rather than inline in the test file, so the
corpus stays reusable (e.g. for a future fuzzer seed corpus) and the test
file stays a thin runner.

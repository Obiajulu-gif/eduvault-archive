# Webhook Signatures

EduVault delivers outbound webhooks to creator-configured endpoints for
purchase, refund, entitlement, and dispute lifecycle events. Every delivery
is signed so the receiving server can verify the payload was produced by
EduVault and has not been tampered with in transit.

See [`docs/API_REFERENCE.md`](API_REFERENCE.md) for the stable error codes
(`EVT_WEBHOOK_*`) returned when signature verification or delivery fails.

---

## Signing Algorithm

Signatures use **HMAC-SHA256**. The signing input is a deterministic
concatenation of the delivery timestamp and the raw request body:

```
signingInput = timestamp + "." + rawBody
```

where:

- `timestamp` is the Unix epoch seconds value sent in the
  `X-EduVault-Timestamp` header (decimal string, no fractional part).
- `rawBody` is the **exact bytes** of the HTTP request body before any
  parsing.

The HMAC key is the creator's `webhookSigningSecret` stored in the `users`
collection. During secret rotation, both the current secret
(`webhookSigningSecret`) and the previous one (`webhookSigningSecretPrevious`)
are active for a short overlap window; the delivery is accepted if **either**
signature verifies (see [Secret Rotation](#secret-rotation)).

---

## Request Headers

Every webhook delivery includes these headers:

| Header                 | Example              | Description                                                 |
| ---------------------- | -------------------- | ----------------------------------------------------------- |
| `X-EduVault-Signature` | `sha256=a1b2c3...`   | Hex-encoded HMAC-SHA256 signature, prefixed with `sha256=`. |
| `X-EduVault-Timestamp` | `1727222400`         | Unix epoch seconds at delivery time.                        |
| `X-EduVault-Event`     | `purchase.completed` | Event type (matches the `event` field in the payload body). |
| `X-EduVault-Delivery`  | `01j9abc...`         | Globally unique delivery ID for idempotency checks.         |
| `Content-Type`         | `application/json`   | Always JSON.                                                |

---

## Verification Steps

1. **Extract headers** — read `X-EduVault-Timestamp`, `X-EduVault-Signature`,
   and the raw request body before JSON-parsing.

2. **Reject stale timestamps** — if `|now() - timestamp| > 300` seconds
   (5 minutes), reject with HTTP 401 and error code `EVT_WEBHOOK_002`.
   This prevents replay attacks.

3. **Compute expected signature**:

   ```
   signingInput = timestamp + "." + rawBody
   expected = "sha256=" + hex(HMAC-SHA256(signingSecret, signingInput))
   ```

4. **Compare signatures** using a constant-time equality function to prevent
   timing attacks. Do **not** use a naive string equality (`==`).

5. **Accept if either secret matches** during a rotation window (see
   [Secret Rotation](#secret-rotation)).

6. **Return 200** on success. Any non-2xx response is treated as a delivery
   failure and triggers retries with exponential backoff.

### Reference Implementation (Node.js)

```js
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an incoming EduVault webhook request.
 *
 * @param {string}        rawBody     Raw request body string (before JSON.parse).
 * @param {string}        timestamp   Value of X-EduVault-Timestamp header.
 * @param {string}        signature   Value of X-EduVault-Signature header.
 * @param {string}        secret      Creator's current webhookSigningSecret.
 * @param {string | null} prevSecret  Creator's previous secret (during rotation), or null.
 * @param {number}        [toleranceSec=300] Max allowed timestamp drift in seconds.
 * @returns {boolean} true if the signature is valid and the timestamp is fresh.
 */
export function verifyWebhookSignature(
  rawBody,
  timestamp,
  signature,
  secret,
  prevSecret = null,
  toleranceSec = 300,
) {
  // Step 1: Check timestamp freshness.
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) {
    return false;
  }

  // Step 2: Build the signing input.
  const signingInput = `${timestamp}.${rawBody}`;

  // Step 3: Compute expected signature(s).
  function computeSig(key) {
    return (
      "sha256=" + createHmac("sha256", key).update(signingInput).digest("hex")
    );
  }

  // Step 4: Constant-time comparison.
  function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  if (safeEqual(computeSig(secret), signature)) return true;
  if (prevSecret && safeEqual(computeSig(prevSecret), signature)) return true;
  return false;
}
```

### Reference Implementation (Python)

```python
import hashlib
import hmac
import time

def verify_webhook_signature(
    raw_body: bytes,
    timestamp: str,
    signature: str,
    secret: str,
    prev_secret: str | None = None,
    tolerance_sec: int = 300,
) -> bool:
    """Verify an EduVault webhook signature."""
    try:
        ts = int(timestamp)
    except ValueError:
        return False

    if abs(time.time() - ts) > tolerance_sec:
        return False  # EVT_WEBHOOK_002

    signing_input = f"{timestamp}.".encode() + raw_body

    def compute(key: str) -> str:
        mac = hmac.new(key.encode(), signing_input, hashlib.sha256)
        return "sha256=" + mac.hexdigest()

    if hmac.compare_digest(compute(secret), signature):
        return True
    if prev_secret and hmac.compare_digest(compute(prev_secret), signature):
        return True
    return False
```

---

## Payload Shape

All event payloads follow a common envelope:

```json
{
  "event":     "purchase.completed",
  "deliveryId": "01j9abc123...",
  "timestamp":  1727222400,
  "data": { ... }
}
```

| Field        | Type     | Description                                              |
| ------------ | -------- | -------------------------------------------------------- |
| `event`      | `string` | Event type identifier (see [Event Types](#event-types)). |
| `deliveryId` | `string` | Unique delivery ID. Use for idempotency deduplication.   |
| `timestamp`  | `number` | Unix epoch seconds matching `X-EduVault-Timestamp`.      |
| `data`       | `object` | Event-specific payload.                                  |

---

## Event Types

### `purchase.completed`

Fired when a buyer successfully purchases a material.

```json
{
  "event": "purchase.completed",
  "deliveryId": "01j9...",
  "timestamp": 1727222400,
  "data": {
    "purchaseId": "42",
    "materialId": "abc123...",
    "buyerAddress": "GBUY...",
    "sellerAddress": "GSEL...",
    "asset": "GDUSDC...",
    "grossAmount": "1000000",
    "platformFee": "50000",
    "sellerNet": "950000",
    "saleTermsVersion": 1,
    "metadataHash": "0b0b0b...",
    "rightsHash": "1c1c1c...",
    "transactionId": "550e8400-...",
    "entitlementActive": true
  }
}
```

### `purchase.bulk_completed`

Fired when a bulk-license purchase completes.

```json
{
  "event": "purchase.bulk_completed",
  "data": {
    "purchaserId": "GPUR...",
    "materialId": "abc123...",
    "recipientCount": 5,
    "unitPrice": "1000000",
    "totalPaid": "5000000",
    "asset": "GDUSDC...",
    "firstPurchaseId": "10"
  }
}
```

### `purchase.refunded`

Fired when a refund is issued for a purchase.

```json
{
  "event": "purchase.refunded",
  "data": {
    "purchaseId": "42",
    "materialId": "abc123...",
    "buyerAddress": "GBUY...",
    "asset": "GDUSDC...",
    "refundAmount": "950000",
    "entitlementRevoked": true
  }
}
```

### `dispute.opened`

Fired when a buyer opens a dispute on a purchase.

```json
{
  "event": "dispute.opened",
  "data": {
    "purchaseId": "42",
    "materialId": "abc123...",
    "openerAddress": "GBUY...",
    "reason": "Material does not match description.",
    "openedLedger": 12345678
  }
}
```

### `dispute.resolved`

Fired when an admin resolves a dispute.

```json
{
  "event": "dispute.resolved",
  "data": {
    "purchaseId": "42",
    "materialId": "abc123...",
    "resolution": "RefundBuyer",
    "resolvedLedger": 12350000
  }
}
```

### `material.sale_terms_updated`

Fired when a creator updates a material's price or payout configuration.

```json
{
  "event": "material.sale_terms_updated",
  "data": {
    "materialId": "abc123...",
    "creatorAddress": "GCRE...",
    "saleTermsVersion": 2,
    "status": "Active"
  }
}
```

---

## Retry Policy

Failed deliveries (non-2xx response or timeout) are retried with **exponential
backoff**:

| Attempt | Delay     |
| ------- | --------- |
| 1       | immediate |
| 2       | 30 s      |
| 3       | 5 min     |
| 4       | 30 min    |
| 5       | 2 h       |

After 5 failures the delivery is moved to the dead-letter queue and no further
automatic retries are attempted. Creators can inspect and replay dead-lettered
events from the creator dashboard.

Delivery timeout per attempt: **10 seconds**.

---

## Secret Rotation

To rotate a webhook signing secret without a delivery gap:

1. Call `PATCH /api/profile` with `{ "rotateWebhookSecret": true }`.
2. EduVault atomically:
   - moves the current `webhookSigningSecret` to `webhookSigningSecretPrevious`.
   - generates a new `webhookSigningSecret`.
   - records `webhookSigningSecretRotatedAt`.
3. For the next **24 hours**, both secrets are accepted during signature
   verification (code `EVT_WEBHOOK_008` is **not** an error during this
   window — it is informational only).
4. After 24 hours, `webhookSigningSecretPrevious` is cleared and only the new
   secret is accepted.

**Action required:** update your endpoint to use the new secret before the
24-hour overlap window closes.

---

## Error Codes

Webhook-related failure codes from `docs/API_REFERENCE.md`:

| Code              | Condition                                                            |
| ----------------- | -------------------------------------------------------------------- |
| `EVT_WEBHOOK_001` | Signature did not verify.                                            |
| `EVT_WEBHOOK_002` | Timestamp outside the 5-minute replay-prevention window.             |
| `EVT_WEBHOOK_003` | Request body could not be parsed as JSON.                            |
| `EVT_WEBHOOK_004` | `event` field does not match a known event type.                     |
| `EVT_WEBHOOK_005` | Creator endpoint returned non-2xx.                                   |
| `EVT_WEBHOOK_006` | Creator endpoint timed out.                                          |
| `EVT_WEBHOOK_007` | Delivery rate limit exceeded for this endpoint.                      |
| `EVT_WEBHOOK_008` | Both current and previous secrets are active (rotation in progress). |

---

## Security Notes

- **Always verify signatures** before processing webhook data. An endpoint
  that skips verification could be triggered by any HTTP client.
- **Use `rawBody`** — JSON parsers may normalise key order or whitespace,
  producing a different byte sequence than the signed input. Capture the raw
  bytes before parsing.
- **Constant-time comparison** is mandatory. Variable-time string equality
  leaks information about how many bytes matched, enabling timing attacks.
- **Reject stale timestamps** — without the 5-minute window check, an attacker
  who captures a valid delivery can replay it indefinitely.
- Secrets are **never logged** or returned in API responses. If a secret is
  compromised, rotate it immediately using `PATCH /api/profile`.

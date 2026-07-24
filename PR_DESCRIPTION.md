# PR Description: Harden Webhook Registration and Delivery

## Overview
This PR implements critical operational safety, security, and observability features for outbound webhook delivery across the EduVault marketplace. Previously, webhooks were sent in-memory without validation of the destination URL or payload signatures. This PR hardens the egress path to strictly prevent SSRF and DNS rebinding attacks, introduces versioned HMAC payload signatures with overlapping key rotation, and implements a resilient background delivery system with exponential backoff and dead-lettering.

## Key Changes

### 1. SSRF Protection and Strict Egress Controls
**File:** `src/lib/webhooks/dispatcher.js`
- Replaced naive `fetch` wrapper with a highly restrictive custom `dispatcher.js`.
- Enforces `https://` protocol and standard secure ports (443, 8443).
- **DNS Resolution & Filtering:** Manually resolves domain names via DNS and blocks requests to private IPv4 networks (e.g., `10.x`, `192.168.x`), IPv6 local scopes, loopbacks, and reserved subnets to thwart SSRF.
- **DNS Rebinding Prevention:** Directs the HTTP connection directly to the verified IP address, passing the original hostname as the `Host` and SNI headers to guarantee the target IP doesn't shift between resolution and connection (TOCTOU attacks).
- Implements strict 5-second timeouts and a 1MB response size limit.
- Securely limits and validates redirects.

### 2. Versioned HMAC Signatures & Rotating Secrets
**File:** `src/lib/webhooks/signature.js`
- All webhook payloads are now wrapped in a standardized schema containing a stable UUID event `id`, `type`, `created` timestamp, and `data`.
- Generates a `v1` SHA-256 HMAC signature using the raw payload and a timestamp, appended to the `Eduvault-Signature` header (e.g., `t=...,v1=...`).
- **Overlapping Key Rotation:** Supports multiple active signing secrets simultaneously, allowing users to safely rotate secrets without dropping events.
- **Replay Protection:** Verification checks include a 5-minute clock drift tolerance to prevent replay attacks, comparing signatures with `crypto.timingSafeEqual` to avoid timing attacks.

### 3. Resilient Background Delivery & Retries
**Files:** `src/lib/backend/schemaContracts.js`, `src/lib/webhooks/sender.js`, `src/lib/backend/webhookWorker.js`
- **Schema:** Added `webhooks` and `webhook_deliveries` collections to the database.
- Webhook events are no longer sent synchronously. They are enqueued into the `webhook_deliveries` collection as `pending`.
- Created `webhookWorker.js` to poll and process pending deliveries.
- **Bounded Backoff & Jitter:** Automatically retries failed HTTP requests utilizing exponential backoff (e.g., 2s, 4s, 8s) combined with jitter.
- **Dead-Lettering:** Classifies a delivery as `dead_letter` after 5 failed attempts.

### 4. User-Facing Webhook Management APIs
**Files:** `src/app/api/webhooks/...`
- Built full CRUD capabilities for webhook registration and endpoint observability.
- `GET /api/webhooks`: Lists registered endpoints with redacted secrets.
- `POST /api/webhooks`: Registers a new endpoint, revealing the secret only once.
- `DELETE /api/webhooks/[id]`: Soft deletes/disables a webhook.
- `POST /api/webhooks/[id]/rotate`: Facilitates overlapping key rotation by expiring the old secret in 24 hours while generating a new primary secret.
- `GET /api/webhooks/[id]/deliveries`: Inspect deliveries, attempts, and error reasons for troubleshooting.
- `POST /api/webhooks/[id]/deliveries/[deliveryId]/replay`: Manually replay an event without mutating the original payload.

## Security Considerations
- Comprehensive SSRF mitigations prevent the EduVault backend from querying internal network services, databases, or cloud metadata endpoints.
- DNS Rebinding protection ensures DNS cannot shift mid-request.
- Strong timing-safe HMAC cryptography guarantees data integrity and origin authenticity.
- Secrets are securely persisted, redacted in GET endpoints, and rotated gracefully.

## Testing
- Tests implemented in `tests/backend/webhooks.test.mjs`.
- Covers SSRF IP filtering (`127.0.0.1`, `169.254.x.x`, `::1`, `::ffff:127.0.0.1`, etc.).
- Covers signature validation, replay tolerances, and key rotation scenarios.
- All webhook backend tests pass successfully.

## Breaking Changes
- The `webhookUrls` string array on the `users` collection is deprecated. A seamless JIT migration path was introduced in `sender.js` to migrate active legacy URLs into the new `webhooks` collection on-the-fly when events are broadcast.

Closes #<WEBHOOK_ISSUE_NUMBER>

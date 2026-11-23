# Checkout Mutation Rate Limits and Abuse Controls (#1188)

This document describes the rate-limiting and abuse-control layer protecting
checkout mutations in EduVault.

- **Core engine & helpers**: `src/lib/checkout/checkoutAbuseControl.js`
- **Protected checkout routes**:
  - `POST /api/purchase` (`src/app/api/purchase/route.js`)
  - `POST /api/checkout/refund` (`src/app/api/checkout/refund/route.js`)
  - `POST /api/checkout/verify-promo` (`src/app/api/checkout/verify-promo/route.js`)
- **Admin observability & recovery**: `src/app/api/admin/checkout-abuse/route.js`
- **Automated tests**: `tests/backend/checkout-abuse-controls.test.mjs`

---

## Default Policies per Checkout Mutation

| Route | Mutation | Wallet / IP Window | Per-Target Burst | Failure Cooldown Trigger |
| --- | --- | --- | --- | --- |
| `POST /api/purchase` | `purchase` | 10 wallet / 25 IP per 60s | 5 per 60s | 5 consecutive failures (30s–15m) |
| `POST /api/checkout/refund` | `refund` | 5 wallet / 15 IP per 5m | 3 per 5m | 4 consecutive failures (60s–30m) |
| `POST /api/checkout/verify-promo` | `verify_promo` | 10 wallet / 15 IP per 60s | 5 per 60s | 5 consecutive failures (60s–15m) |
| `POST /api/checkout/initiate` | `initiate` | 12 wallet / 30 IP per 60s | 5 per 60s | 5 consecutive failures (30s–15m) |
| `POST /api/checkout/verify` | `verify` | 15 wallet / 30 IP per 60s | 6 per 60s | 4 consecutive failures (60s–15m) |

---

## Error Codes & Headers

Every response emits `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`
(plus `Retry-After` on `429` responses and `X-Checkout-Abuse-Mode: shadow` in shadow mode).

| HTTP | Code | Meaning | Remedy |
| --- | --- | --- | --- |
| `401` | `CHECKOUT_AUTH_REQUIRED` | Missing session when authentication is required | Re-authenticate and retry. Does not consume rate-limit quota. |
| `403` | `CHECKOUT_WALLET_MISMATCH` | Claimed buyer wallet differs from authenticated session wallet | Submit checkout for the authenticated wallet. Does not drain the victim's quota. |
| `429` | `CHECKOUT_RATE_LIMIT_EXCEEDED` | Wallet, IP, target, or idempotent-retry cap exceeded | Wait `Retry-After` seconds. Keep the same `Idempotency-Key` on retries. |
| `429` | `CHECKOUT_COOLDOWN_ACTIVE` | Consecutive failures triggered exponential backoff | Wait `Retry-After` seconds or clear via admin reset. A successful checkout resets the streak. |
| `403` | `CHECKOUT_ABUSE_DETECTED` | IP-to-wallet fan-in exceeded (`maxDistinctWalletsPerIp`) | Wait for window reset or retry from a dedicated network. |
| `403` | `CHECKOUT_SELF_DEALING_BLOCKED` | Buyer wallet matches creator/counterparty wallet | Use a distinct buyer wallet. |
| `403` | `CHECKOUT_TX_REPLAY_DETECTED` | `transactionHash` already submitted by another wallet within `txReplayWindowMs` | Submit a freshly signed transaction from the acting wallet. |

---

## Edge Cases

1. **Idempotent retries (`idempotencyKey` / `Idempotency-Key` / `X-Idempotency-Key`)**:
   - Retries carrying the same key for the same `(mutation, wallet, target)` within the
     active window do **not** double-charge the wallet's rate-limit quota.
   - Retries are still capped at `maxIdempotentRetries` so retry storms cannot bypass limits.
2. **Wallet spoofing / unauthorized probes**:
   - `verifyCheckoutActor` runs **before** rate-limit accounting, preventing attackers
     from exhausting another buyer's quota with mismatched wallet payloads.
3. **Promo-code brute-forcing**:
   - `POST /api/checkout/verify-promo` tracks invalid promo lookups as failed attempts,
     triggering exponential cooldowns against automated enumeration.
4. **Shared NAT / campus IPs**:
   - Per-IP and distinct-wallet fan-in limits are sized above single-user quotas.
   - False positives on shared networks can be cleared immediately via `POST /api/admin/checkout-abuse`.
5. **Bounded memory & privacy**:
   - All in-memory maps enforce FIFO eviction (`MAX_TRACKED_KEYS = 5,000`, `MAX_ABUSE_EVENTS = 500`).
   - Wallet addresses and IPs are SHA-256 hashed before storing in abuse event logs.

---

## Recovery & Rollback

### Rollout Modes (`CHECKOUT_ABUSE_CONTROL_MODE`)

- **`enforce`** (default): Enforces rate limits, cooldowns, and abuse blocks.
- **`shadow`**: Evaluates every check, records events, and sets `X-Checkout-Abuse-Mode: shadow` without blocking traffic.
- **`off`**: **Instant rollback / kill switch** — bypasses all checks immediately with no blocking or state mutation.

### Admin Observability & Recovery (`src/app/api/admin/checkout-abuse/route.js`)

- **Inspect events** (`operations:read`, allows service token):
  ```http
  GET /api/admin/checkout-abuse?mutation=purchase&code=CHECKOUT_COOLDOWN_ACTIVE&limit=50
  ```
- **Clear false positive / reset cooldowns** (`checkout:abuse:manage`, admin-only):
  ```http
  POST /api/admin/checkout-abuse
  Content-Type: application/json

  { "wallet": "G...", "mutation": "purchase" }
  ```
  An empty body `{}` resets all checkout rate-limit windows and cooldowns.

---

## Contract Preservation & Migration Plan

- All existing checkout response shapes, HTTP status codes, and problem-details payloads are preserved.
- `POST /api/purchase`, `POST /api/checkout/refund`, and `POST /api/checkout/verify-promo` only add standard `X-RateLimit-*` headers on normal responses and return `429`/`403` only when limits or abuse rules trigger.
- Rollout can start in `CHECKOUT_ABUSE_CONTROL_MODE=shadow` to baseline traffic, switch to `enforce` in production, and revert to `off` at any time without code changes or schema migrations.

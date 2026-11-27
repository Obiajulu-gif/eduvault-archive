# Signed Download Authorization (Byte & Expiry Limits)

This document describes the signed download authorization mechanism implemented in:
- `src/lib/downloads/signedDownloadAuth.js`
- `src/lib/downloads/capabilityToken.js`
- `src/app/api/download/route.js`

## Overview

Every protected material download is authorized with an HMAC-SHA256 signed capability token bound to:
- **Identity**: `buyer` (normalized wallet address) and `material` (`materialId`).
- **Byte limits**: `byteRangeStart`, `byteRangeEnd` (nullable for open-ended downloads), and `maxBytes` / `byteRangeQuota`. Even open-ended downloads always carry an explicit signed `maxBytes` cap (`<= CAPABILITY_MAX_BYTES`, default 10 MB).
- **Expiry limits**: `iat` and `exp`, bounded by `[CAPABILITY_MIN_TTL_MS, CAPABILITY_MAX_TTL_MS]` (defaults: 1 s min, 15 s default, 5 min max) with clock-skew protection (`60 s`).
- **Replay & retry metadata**: `jti`, `nonce`, `attempt`, `parentJti`, and key ID (`kid`).

## Flows Covered

1. **Normal path**:
   - `GET /api/download` authenticates the buyer, verifies entitlement, validates `range`, `maxBytes`, and `expiresInMs`, and issues a signed capability URL + metadata (`expiresAt`, `maxBytes`, `quotaBytes`, `expiresInMs`).
   - `POST /api/download` (or `authorize()` in `createDownloadAuthorizationService`) verifies the HMAC signature, expiry, identity binding, and requested byte range/size before authorizing delivery.
2. **Failure paths**:
   - Malformed or inverted `range` parameters return `400 VALIDATION_FIELD` (previously malformed ranges were silently ignored).
   - Requests exceeding `CAPABILITY_MAX_BYTES` or `maxBytes` return `416` / `VALIDATION_RANGE_TOO_LARGE`.
   - Tampered payloads, invalid signatures, missing nonces, or unknown `kid` values are rejected with `403`.
   - Expired tokens are rejected with `410`.
3. **Retry paths**:
   - **Idempotent retries**: Re-issuing with the same `idempotencyKey` and identical parameters while the token is still valid returns the existing signed token without inflating byte budgets. Mismatched parameters with the same `idempotencyKey` fail with `idempotency_conflict`.
   - **Bounded partial-transfer retries**: When a transfer fails mid-stream, `recordFailure(jti, { bytesDelivered })` records delivered bytes. Issuing a retry with `retryOf: jti` grants a fresh signed token with `attempt + 1` and `maxBytes = remainingBytes`, capped at `maxRetries` (default `3`).
4. **Authorization paths**:
   - Enforces `buyer_mismatch` and `material_mismatch` checks.
   - Supports immediate revocation (`revoke(jti, reason)`) for refunds, takedowns, or suspected token leakage.

## Edge Cases

- **Open-ended downloads (`range` omitted)**: Previously `byteRangeQuota` was `undefined` in the signed payload. Now `maxBytes` / `byteRangeQuota` is always signed into the token so redemption-time byte checks cannot be bypassed.
- **Clock skew**: Tokens with `iat > now + maxClockSkewMs` are rejected as `future_dated`; tokens with `exp < now` are rejected as `expired`.
- **Byte-range boundary checks**: Redemption-time `requestedRangeStart`/`requestedRangeEnd` must fall strictly inside `[payload.byteRangeStart, payload.byteRangeEnd]` and within `payload.maxBytes`.
- **Replay after completion**: Once `recordCompletion(jti, bytesDelivered)` marks a token `completed`, subsequent `authorize()` calls are rejected with `already_completed`.

## Recovery & Rollback Behavior

- **Zero-downtime secret rotation & rollback**: Tokens include a `kid` (key ID). During rotation, set `DOWNLOAD_CAPABILITY_KEY_ID` to the new key ID and supply the previous key in `previousSecrets`. To roll back, revert `DOWNLOAD_CAPABILITY_KEY_ID` and keep the newer key in `previousSecrets` until its TTL (`<= 5 min`) elapses.
- **Emergency revocation**: Call `revoke(jti, reason)` to invalidate an active token immediately without rotating the signing secret.
- **Backward compatibility / migration plan**:
  - All existing exports (`generateCapabilityToken`, `verifyCapabilityToken`, `CAPABILITY_TTL_MS`, `CAPABILITY_MAX_BYTES`) and `GET /api/download` response fields are preserved.
  - New response fields (`capability.maxBytes`, `capability.expiresAt`) and the `POST /api/download` verification endpoint are strictly additive.
  - No database migration is required; existing clients continue working unchanged.

# Stable Error Codes with Documented Remediation Hints

**Issue #1012** — `src/lib/errors/codes.js`

## Overview

Every failure mode in EduVault maps to a **stable, screaming-snake-case error
code** that is included in every API error response.  Codes are:

- **Stable** — never renamed or removed.  New codes are added; old codes are
  only `deprecated: true` with a `supersededBy` pointer.
- **Explainable** — each code carries a user-safe message, a user-facing
  recovery step, and operator/developer `remediationHints` (server-side only —
  never sent to clients).
- **Typed** — `retryable` is a boolean so clients can implement back-off without
  parsing message strings.

---

## Response Shape (RFC 7807)

```json
{
  "type": "https://eduvault.dev/problems/auth_token_revoked",
  "title": "Your session has been revoked.",
  "status": 401,
  "code": "AUTH_TOKEN_REVOKED",
  "detail": "Sign in again to continue.",
  "retryable": false,
  "correlationId": "3f2a1b...",
  "instance": "/api/purchase"
}
```

`remediationHints` are **never serialized** into the response body — they live
only in `codes.js` and are accessible server-side via `getRemediationHints(code)`.

---

## Complete Error Code Catalogue

### Validation (4xx)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `VALIDATION_FAILED` | 400 | ✗ | The request could not be validated. |
| `VALIDATION_FIELD` | 400 | ✗ | One or more fields are invalid. |
| `VALIDATION_FILE_TYPE` | 400 | ✗ | The uploaded file type is not supported. |
| `VALIDATION_FILE_SIZE` | 400 | ✗ | The uploaded file exceeds the size limit. |
| `VALIDATION_MISSING_FIELD` | 400 | ✗ | A required field is missing from the request. |
| `VALIDATION_PAYLOAD_TOO_LARGE` | 413 | ✗ | The request payload is too large. |

### Authentication & Authorization (401 / 403)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `AUTH_UNAUTHENTICATED` | 401 | ✗ | You must be signed in to perform this action. |
| `AUTH_SESSION_EXPIRED` | 401 | ✗ | Your session has expired. |
| `AUTH_TOKEN_REVOKED` | 401 | ✗ | Your session has been revoked. |
| `AUTH_FORBIDDEN` | 403 | ✗ | You do not have permission to perform this action. |
| `AUTH_SUSPENDED` | 403 | ✗ | Your account has been suspended. |
| `AUTH_WALLET_MISMATCH` | 403 | ✗ | The wallet address does not match your account. |

### Not Found (404)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `NOT_FOUND` | 404 | ✗ | The requested resource could not be found. |
| `NOT_FOUND_MATERIAL` | 404 | ✗ | The learning material could not be found. |
| `NOT_FOUND_PURCHASE` | 404 | ✗ | No purchase record was found for this content. |

### Conflicts (409)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `CONFLICT_DUPLICATE` | 409 | ✗ | A record with these details already exists. |
| `CONFLICT_IN_PROGRESS` | 409 | ✓ | An identical request is already being processed. |
| `CONFLICT_IDEMPOTENCY_KEY` | 409 | ✗ | This idempotency key was used with a different request. |
| `CONFLICT_STATE` | 409 | ✗ | This action cannot be performed in the current state. |
| `CONFLICT_VERSION` | 409 | ✗ | This record was modified by another request. |

### Entitlement & Access (403)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `ENTITLEMENT_NOT_FOUND` | 403 | ✗ | You do not have access to this content. |
| `ENTITLEMENT_REVOKED` | 403 | ✗ | Your access to this content has been revoked. |
| `ENTITLEMENT_EXPIRED` | 403 | ✗ | Your access to this content has expired. |

### Settlement / Payment (402 / 409 / 410 / 502 / 503 / 504)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `SETTLEMENT_INSUFFICIENT_FUNDS` | 402 | ✗ | There are not enough funds to complete this transaction. |
| `SETTLEMENT_TX_FAILED` | 502 | ✓ | The payment transaction failed. |
| `SETTLEMENT_TIMEOUT` | 504 | ✓ | The payment confirmation timed out. |
| `SETTLEMENT_UNAVAILABLE` | 503 | ✓ | The payment service is temporarily unavailable. |
| `SETTLEMENT_QUOTE_EXPIRED` | 410 | ✗ | The checkout quote has expired. |
| `SETTLEMENT_REFUND_WINDOW_CLOSED` | 409 | ✗ | The refund window for this purchase has closed. |

### Storage / Content Delivery (403 / 404 / 502)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `STORAGE_UPLOAD_FAILED` | 502 | ✓ | The file could not be uploaded. |
| `STORAGE_NOT_FOUND` | 404 | ✗ | The stored file could not be found. |
| `STORAGE_QUARANTINED` | 403 | ✗ | This content is under review and temporarily unavailable. |
| `STORAGE_DOWNLOAD_CAPABILITY_INVALID` | 403 | ✗ | The download link is invalid or has expired. |

### Rate Limiting (429)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `RATE_LIMITED` | 429 | ✓ | Too many requests. |
| `RATE_LIMITED_UPLOAD` | 429 | ✓ | You have uploaded too many files recently. |

### Content / Publishing (409 / 502)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `CONTENT_PUBLISHING_FAILED` | 502 | ✓ | Publishing failed. Your content has been saved as a draft. |
| `CONTENT_DUPLICATE_DETECTED` | 409 | ✗ | This content appears to be a duplicate of an existing listing. |

### Blockchain / Wallet (402 / 409 / 503)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `BLOCKCHAIN_RPC_UNAVAILABLE` | 503 | ✓ | The blockchain service is temporarily unavailable. |
| `BLOCKCHAIN_BAD_SEQUENCE` | 409 | ✓ | The transaction could not be submitted due to a sequencing conflict. |
| `BLOCKCHAIN_TRUSTLINE_MISSING` | 402 | ✗ | Your wallet has not set up a trustline for the payment asset. |

### Data Export (202 / 404)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `EXPORT_IN_PROGRESS` | 202 | ✗ | Your data export is being prepared. |
| `EXPORT_NOT_READY` | 404 | ✓ | Your export is not ready yet. |

### Internal (500 / 503)

| Code | Status | Retryable | User message |
|------|--------|-----------|--------------|
| `INTERNAL` | 500 | ✓ | Something went wrong on our end. |
| `SERVICE_UNAVAILABLE` | 503 | ✓ | The service is temporarily unavailable. |

---

## Programmatic Usage

```js
import {
  getErrorCode,
  isKnownErrorCode,
  getErrorCodesByFamily,
  getRemediationHints,
  AppError,
} from "@/lib/errors";

// Throw a typed error
throw new AppError("ENTITLEMENT_NOT_FOUND");

// Look up a definition
const def = getErrorCode("SETTLEMENT_QUOTE_EXPIRED");
// { code, status: 410, retryable: false, userMessage, recovery, remediationHints }

// Check if a string is a registered code
isKnownErrorCode("AUTH_FORBIDDEN"); // true

// Get all 4xx codes
const clientErrors = getErrorCodesByFamily(400);

// Get operator hints (server-side only — never expose to clients)
const hints = getRemediationHints("BLOCKCHAIN_BAD_SEQUENCE");
// ["Stellar returned tx_bad_seq ...", ...]
```

---

## Client Error Handling Pattern

```js
const response = await fetch("/api/purchase", { method: "POST", body: ... });
if (!response.ok) {
  const err = await response.json();
  switch (err.code) {
    case "SETTLEMENT_INSUFFICIENT_FUNDS":
      showFundingPrompt();
      break;
    case "SETTLEMENT_QUOTE_EXPIRED":
      redirectToCheckout();
      break;
    case "AUTH_TOKEN_REVOKED":
    case "AUTH_SESSION_EXPIRED":
      redirectToSignIn();
      break;
    default:
      if (err.retryable) scheduleRetry();
      else showErrorToast(err.detail); // use `detail` (recovery guidance)
  }
}
```

---

## Stability Contract

- Codes are **additive only**.
- Existing codes are **never renamed** (breaking change for all clients).
- To retire a code: add `deprecated: true` and `supersededBy: "NEW_CODE"`.
- The `remediationHints` array may be extended without a breaking change.
- `status`, `retryable`, and the `code` key are **frozen** after first release.

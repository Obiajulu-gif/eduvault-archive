# Buyer-Facing Stale-Quote Detection Before Signing

This document describes the vertical slice that detects expired, drifted, or unauthorized checkout quotes **before** the buyer is prompted to sign a wallet transaction.

## Architecture Overview

The flow spans four focused layers:

1. **Shared Constants (`src/lib/checkout/quoteConstants.js`)** — Zero-dependency definitions for `QUOTE_TTL_MS` (10 min), `QUOTE_SIGNING_BUFFER_MS` (15 s), and `STALE_QUOTE_REASONS`.
2. **Server Freshness Validator (`src/lib/checkout/quotes.js`)** — `validateCheckoutQuote()` performs a **non-consuming** check against `checkout_quotes` and live `materials` records. It validates buyer ownership, material binding, quote status (`open`), TTL plus signing safety buffer, material availability, and live terms (`price`, `asset`, `creatorAddress`, `materialVersion`).
3. **API Pre-Signing Action (`src/app/api/purchase/route.js`)** — Adds `action: "validate_quote"` to `POST /api/purchase` alongside a session-vs-body wallet mismatch guard (`AUTH_WALLET_MISMATCH`).
4. **Client Guard & Checkout Modal (`src/lib/checkout/staleQuoteGuard.js`, `src/services/purchaseService.js`, `src/app/marketplace/[id]/modals/BuyNowModal.jsx`)** — Fetches real server quotes, proactively monitors local expiry, runs `verifyQuoteBeforeSigning()` right before signing, and blocks wallet signing whenever the quote is stale, unauthorized, or unverifiable.

## Contract Preservation

All existing API and library contracts are preserved without breaking changes:

- `createCheckoutQuote()` and `consumeCheckoutQuote()` retain their exact function signatures, return shapes, and error codes (`QUOTE_EXPIRED`, `QUOTE_INVALID`, `MATERIAL_ARCHIVED`, `NOT_FOUND`).
- `POST /api/purchase` with `action: "quote"` continues returning HTTP `201` with `{ quoteId, materialId, price, asset, creatorAddress, materialVersion, expiresAt }` (plus additive `buyerAddress`).
- `POST /api/purchase` with `action: "validate_quote"` is strictly additive:
  - **200 OK**: `{ fresh: true, stale: false, quoteId, materialId, buyerAddress, price, asset, creatorAddress, materialVersion, expiresAt, remainingMs, checkedAt }`
  - **400 Bad Request** (`VALIDATION_FIELD`): missing `materialId` or `quoteId`
  - **401 Unauthorized** (`AUTH_UNAUTHENTICATED`): missing session and buyer address
  - **403 Forbidden** (`AUTH_WALLET_MISMATCH`): session wallet differs from requested `buyerAddress` or quote owner
  - **404 Not Found** (`NOT_FOUND_MATERIAL`): material archived, deleted, or no longer public (`canRefresh: false`)
  - **409 Conflict** (`CONFLICT_STATE`): terms drifted (`TERMS_CHANGED`, including `changedFields`, `quoteTerms`, `currentTerms`), quote consumed, or quote not found
  - **410 Gone** (`SETTLEMENT_QUOTE_EXPIRED`): quote expired or expiring within signing buffer (`canRefresh: true`)
- **No database migration is required.** Existing `checkout_quotes` and `materials` documents work as-is.

## Edge Cases Handled

| Edge Case | Detection Layer | Outcome & Buyer UX |
| --- | --- | --- |
| **Quote expired while modal is open** | Client timer + client pre-check + server `validateCheckoutQuote` | Signing is blocked; buyer sees "Quote expired before signing" with a **Refresh quote** action. |
| **Quote expiring within 15 s safety buffer** | Client pre-check + server `minRemainingMs` (clamped to 60 s) | Prevents starting a wallet signature that would expire mid-approval; prompts **Refresh quote**. |
| **Creator edits price, asset, payout address, or version** | Client `expectedPrice` check + server `compareQuoteTerms()` | Signing is blocked; UI shows old vs. new price (e.g., `10.00 XLM to 14.00 XLM`). Buyer must explicitly refresh and re-review before clicking Pay (never auto-signed). |
| **Buyer switches wallet mid-checkout** | Client `buyerAddress` check + server `BUYER_MISMATCH` / `AUTH_WALLET_MISMATCH` | Signing is blocked; quote bound to the previous wallet cannot be validated or signed. |
| **Session expired or wallet spoofing** | Server `401 AUTH_UNAUTHENTICATED` / `403 AUTH_WALLET_MISMATCH` | Signing is blocked; UI prompts **Reconnect wallet** / re-authentication. |
| **Material archived, deleted, or unpublished** | Server `MATERIAL_ARCHIVED` (410) / `MATERIAL_UNAVAILABLE` (404) | Signing is blocked; `canRefresh: false` hides the refresh button and explains the listing is unavailable. |
| **Already-consumed quote (e.g. duplicate tab)** | Server `QUOTE_CONSUMED` (409) | Signing is blocked; buyer can refresh to obtain a new quote if still unowned. |
| **Transient network / 5xx validation error** | Client `verifyQuoteBeforeSigning` catch block | Fails closed (does not sign); displays **Retry verification** without discarding form inputs. |
| **Race between pre-sign check and settlement** | Server `consumeCheckoutQuote` at confirmation | Settlement still enforces atomic single-use TTL consumption; if a race occurs, `BuyNowModal` surfaces the stale-quote refresh state. |

## Recovery and Rollback Behavior

### Buyer Recovery
- **Stale / Expired / Terms Changed (`canRefresh: true`)**: Clicking **Refresh quote** calls `POST /api/purchase` (`action: "quote"`), replaces the stale snapshot, clears the alert, and displays the updated total so the buyer explicitly confirms before signing.
- **Transient Validation Failure (`kind: "error"`)**: Clicking **Retry verification** re-runs `validate_quote` for the same quote without losing form state.
- **Authorization Failure (`kind: "auth"`)**: Clicking **Reconnect wallet** opens the wallet modal so the buyer can align their connected wallet and session.
- **Non-Refreshable Listing (`canRefresh: false`)**: Signing stays disabled; buyer closes the modal without any partial payment or pending access mutation.

### Rollback Safety
- Because `validateCheckoutQuote` is **read-only and non-consuming**, it never mutates `checkout_quotes`, `purchases`, or `entitlement_cache` state.
- Rolling back this change requires no database rollback or data cleanup:
  - Reverting the frontend reverts `BuyNowModal` to its previous flow while server-side `consumeCheckoutQuote` continues enforcing TTL and single-use guarantees at settlement.
  - Reverting the backend removes `action: "validate_quote"` without affecting existing `action: "quote"` or purchase confirmation callers.

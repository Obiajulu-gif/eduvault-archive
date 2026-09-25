# EduVault API Error Code Reference

This document defines the **stable error-code taxonomy** for every major
failure path in the EduVault system: purchase, entitlement, download,
refund, storage, indexer, and webhook.

Clients and frontends **must** use these codes rather than parsing prose
error messages. Prose descriptions are informational only and may change
without notice; codes are semver-stable within a major version.

---

## Format

Every API error response has the shape:

```json
{
  "error": {
    "code": "EVT_PURCHASE_004",
    "message": "Human-readable description (informational only).",
    "retryable": false,
    "supportAction": "contact_support"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `code` | `string` | Stable machine-readable code. Never changes within a major version. |
| `message` | `string` | Informational prose. May change. Do not parse. |
| `retryable` | `boolean` | `true` when the same request may succeed if retried after a delay. |
| `supportAction` | `string \| null` | Suggested next step. See [Support Actions](#support-actions). |

---

## Namespaces

Codes are prefixed by subsystem:

| Prefix | Subsystem |
|---|---|
| `EVT_PURCHASE_` | Purchase flow |
| `EVT_ENTITLEMENT_` | Entitlement / access-check |
| `EVT_DOWNLOAD_` | Download capability |
| `EVT_REFUND_` | Refund flow |
| `EVT_STORAGE_` | IPFS / Pinata storage |
| `EVT_INDEXER_` | Stellar event indexer |
| `EVT_WEBHOOK_` | Outbound creator webhooks |
| `EVT_AUTH_` | Authentication / authorisation |
| `EVT_CONTRACT_` | On-chain Soroban contract errors |
| `EVT_INPUT_` | Request validation / input errors |

---

## Purchase Errors (`EVT_PURCHASE_`)

| Code | HTTP | Retryable | Description | Support Action |
|---|---|---|---|---|
| `EVT_PURCHASE_001` | 409 | false | Material already owned — buyer already holds an active entitlement for this material. | `none` |
| `EVT_PURCHASE_002` | 402 | false | Price mismatch — the expected amount does not match the current material quote. | `refresh_quote` |
| `EVT_PURCHASE_003` | 404 | false | Material not found — no material exists at the given identifier. | `none` |
| `EVT_PURCHASE_004` | 422 | false | Material not active — the material is paused or archived and cannot be purchased. | `none` |
| `EVT_PURCHASE_005` | 422 | false | Asset not allowed — the payment asset is not on the contract allowlist. | `contact_support` |
| `EVT_PURCHASE_006` | 422 | false | Asset not accepted for material — the asset is globally allowed but not in this material's quotes. | `refresh_quote` |
| `EVT_PURCHASE_007` | 402 | true | Quote expired — the buyer's recorded quote has passed its TTL; re-quote and try again. | `refresh_quote` |
| `EVT_PURCHASE_008` | 409 | false | Stale sale-terms quote — the creator updated sale terms after the buyer's quote was recorded. | `refresh_quote` |
| `EVT_PURCHASE_009` | 409 | false | Stale quote asset — the buyer's recorded asset differs from the asset passed to purchase. | `refresh_quote` |
| `EVT_PURCHASE_010` | 503 | true | Contract paused — the purchase-manager contract is temporarily paused by the platform. | `retry_later` |
| `EVT_PURCHASE_011` | 409 | false | Checkout already pending — a wallet-signing session is already in progress for this buyer + material pair. | `none` |
| `EVT_PURCHASE_012` | 500 | true | Registry call failed — cross-contract call to material-registry returned an error. | `retry_later` |
| `EVT_PURCHASE_013` | 422 | false | Invalid payout shares — material payout-share configuration is malformed on-chain. | `contact_support` |
| `EVT_PURCHASE_014` | 422 | false | Arithmetic overflow — total cost overflowed i128 (bulk purchase too large). | `reduce_quantity` |
| `EVT_PURCHASE_015` | 400 | false | Empty recipient list — bulk purchase requires at least one recipient. | `none` |
| `EVT_PURCHASE_016` | 400 | false | Too many recipients — bulk purchase exceeds the 50-recipient limit. | `reduce_quantity` |
| `EVT_PURCHASE_017` | 409 | false | Duplicate recipient — the same address appears more than once in a bulk recipient list. | `none` |

---

## Entitlement Errors (`EVT_ENTITLEMENT_`)

| Code | HTTP | Retryable | Description | Support Action |
|---|---|---|---|---|
| `EVT_ENTITLEMENT_001` | 403 | false | Entitlement not found — no purchase record exists for this buyer + material pair. | `none` |
| `EVT_ENTITLEMENT_002` | 403 | false | Entitlement revoked — the purchase was refunded and access was revoked. | `none` |
| `EVT_ENTITLEMENT_003` | 403 | true | Entitlement stale — the cached entitlement is active but the on-chain settlement is no longer Pending; re-check required. | `retry_later` |
| `EVT_ENTITLEMENT_004` | 503 | true | Entitlement cache unavailable — MongoDB entitlement cache could not be reached. | `retry_later` |
| `EVT_ENTITLEMENT_005` | 409 | true | Entitlement cache desync — cached state diverges from on-chain state; reconciliation triggered. | `retry_later` |

---

## Download Errors (`EVT_DOWNLOAD_`)

| Code | HTTP | Retryable | Description | Support Action |
|---|---|---|---|---|
| `EVT_DOWNLOAD_001` | 403 | false | Capability token missing — request did not include a download capability token. | `none` |
| `EVT_DOWNLOAD_002` | 401 | false | Capability token invalid — token signature verification failed. | `none` |
| `EVT_DOWNLOAD_003` | 401 | false | Capability token expired — the short-lived capability token has passed its TTL. | `refresh_capability` |
| `EVT_DOWNLOAD_004` | 403 | false | Byte-range exceeded — the requested byte range exceeds the capability token's allowed maximum. | `none` |
| `EVT_DOWNLOAD_005` | 403 | false | Entitlement check failed — download denied because the buyer's entitlement is not active. See `EVT_ENTITLEMENT_*`. | `none` |
| `EVT_DOWNLOAD_006` | 404 | false | Content not found — the IPFS CID referenced by the material is not pinned or is unreachable. | `contact_support` |
| `EVT_DOWNLOAD_007` | 503 | true | Gateway unavailable — the IPFS gateway timed out or returned an error. | `retry_later` |

---

## Refund Errors (`EVT_REFUND_`)

| Code | HTTP | Retryable | Description | Support Action |
|---|---|---|---|---|
| `EVT_REFUND_001` | 409 | false | Refund not allowed — the purchase is not in a refundable state (already refunded, released, or expired). | `none` |
| `EVT_REFUND_002` | 409 | false | Escrow already claimed — the creator has already withdrawn the escrowed funds. | `contact_support` |
| `EVT_REFUND_003` | 403 | false | Not authorised — caller does not have the admin role required to issue a refund. | `none` |
| `EVT_REFUND_004` | 409 | false | Settlement not pending — refund requires the settlement to be in Pending state. | `none` |
| `EVT_REFUND_005` | 503 | true | Refund signing disabled — the REFUND_SIGNING_DISABLED kill switch is active; all refund signing is halted. | `contact_support` |
| `EVT_REFUND_006` | 401 | false | Refund signer version mismatch — the authorization payload was signed with a different signer version than the current active one. | `contact_support` |
| `EVT_REFUND_007` | 401 | false | Refund authorization expired — the refund authorization payload has passed its expiry timestamp. | `contact_support` |
| `EVT_REFUND_008` | 422 | false | Insufficient escrow balance — escrow does not hold enough funds to cover the refund amount. | `contact_support` |
| `EVT_REFUND_009` | 422 | false | Purchase buyer not found — the PurchaseBuyer mapping is missing; refund cannot identify the recipient. | `contact_support` |
| `EVT_REFUND_010` | 503 | true | Refund transaction failed — the Stellar transaction submission failed after retries. | `retry_later` |
| `EVT_REFUND_011` | 404 | false | Purchase not found — no purchase record exists for the given purchase ID. | `none` |
| `EVT_REFUND_012` | 409 | false | Refund window expired — the refund was requested after the `REFUND_WINDOW_DAYS` cutoff. | `contact_support` |

---

## Storage Errors (`EVT_STORAGE_`)

| Code | HTTP | Retryable | Description | Support Action |
|---|---|---|---|---|
| `EVT_STORAGE_001` | 503 | true | Primary pin failed — Pinata primary endpoint did not accept the upload. | `retry_later` |
| `EVT_STORAGE_002` | 503 | true | Secondary pin failed — secondary IPFS provider did not accept the upload; two-provider quorum not met. | `retry_later` |
| `EVT_STORAGE_003` | 503 | true | Both providers failed — neither primary nor secondary pinning succeeded; content is not persisted. | `retry_later` |
| `EVT_STORAGE_004` | 413 | false | File too large — upload exceeds the configured per-file size limit. | `none` |
| `EVT_STORAGE_005` | 415 | false | Unsupported file type — the MIME type is not in the permitted upload list. | `none` |
| `EVT_STORAGE_006` | 503 | true | Quota threshold exceeded — Pinata usage has crossed the alert threshold; new uploads are blocked. | `contact_support` |
| `EVT_STORAGE_007` | 422 | false | CID mismatch — the content hash returned by the pin endpoint does not match the expected CID. | `contact_support` |
| `EVT_STORAGE_008` | 404 | false | Content not pinned — the requested CID is not present in the primary or secondary provider's pin set. | `contact_support` |

---

## Indexer Errors (`EVT_INDEXER_`)

| Code | HTTP | Retryable | Description | Support Action |
|---|---|---|---|---|
| `EVT_INDEXER_001` | 503 | true | Horizon unavailable — the primary Horizon endpoint did not respond within the timeout. | `retry_later` |
| `EVT_INDEXER_002` | 503 | true | All Horizon fallbacks exhausted — primary and all configured fallback nodes failed. | `retry_later` |
| `EVT_INDEXER_003` | 503 | true | Soroban RPC unavailable — the Soroban RPC endpoint is not reachable. | `retry_later` |
| `EVT_INDEXER_004` | 503 | true | Cursor checkpoint lost — the `sync_state` record is missing or corrupt; indexer cannot resume safely. | `contact_support` |
| `EVT_INDEXER_005` | 409 | false | Duplicate event — an event with this stable ID has already been processed (idempotency guard). | `none` |
| `EVT_INDEXER_006` | 422 | false | Event schema mismatch — the on-chain event's topic/field set does not match the expected schema snapshot. | `contact_support` |
| `EVT_INDEXER_007` | 503 | true | Dead-letter overflow — the dead-letter queue has exceeded its depth limit; manual intervention required. | `contact_support` |
| `EVT_INDEXER_008` | 503 | true | Surge pricing detected — on-chain base fee exceeds the `STELLAR_SURGE_FEE_THRESHOLD`; transaction submission deferred. | `retry_later` |
| `EVT_INDEXER_009` | 500 | false | Ledger gap detected — a sequence discontinuity was found in the processed ledger range; recovery scan required. | `contact_support` |

---

## Webhook Errors (`EVT_WEBHOOK_`)

| Code | HTTP | Retryable | Description | Support Action |
|---|---|---|---|---|
| `EVT_WEBHOOK_001` | 401 | false | Signature verification failed — the HMAC-SHA256 signature on an inbound webhook payload did not verify. | `none` |
| `EVT_WEBHOOK_002` | 401 | false | Timestamp too old — the `X-EduVault-Timestamp` header indicates the request is outside the replay-prevention window. | `none` |
| `EVT_WEBHOOK_003` | 400 | false | Malformed payload — the webhook body could not be parsed as valid JSON. | `none` |
| `EVT_WEBHOOK_004` | 404 | false | Unknown event type — the `event` field does not match any registered webhook event type. | `none` |
| `EVT_WEBHOOK_005` | 503 | true | Delivery failed — the creator's configured webhook endpoint returned a non-2xx status. | `retry_later` |
| `EVT_WEBHOOK_006` | 503 | true | Delivery timeout — the creator's webhook endpoint did not respond within the deadline. | `retry_later` |
| `EVT_WEBHOOK_007` | 429 | true | Rate limit — too many webhook deliveries to this endpoint within the window. | `retry_later` |
| `EVT_WEBHOOK_008` | 409 | false | Secret rotation in progress — both current and previous signing secrets are temporarily active; signature must match one of them. | `none` |

---

## Authentication / Authorisation Errors (`EVT_AUTH_`)

| Code | HTTP | Retryable | Description | Support Action |
|---|---|---|---|---|
| `EVT_AUTH_001` | 401 | false | Missing authentication — no session token or wallet signature was provided. | `none` |
| `EVT_AUTH_002` | 401 | false | Invalid token — JWT verification failed (wrong secret, malformed, or tampered). | `none` |
| `EVT_AUTH_003` | 401 | false | Token expired — the JWT has passed its expiry. | `reauthenticate` |
| `EVT_AUTH_004` | 403 | false | Insufficient role — the authenticated identity does not hold the required role (e.g. `admin`). | `none` |
| `EVT_AUTH_005` | 403 | false | Wallet address mismatch — the wallet address in the request does not match the authenticated session. | `reauthenticate` |
| `EVT_AUTH_006` | 429 | true | Too many address warnings — the checkout session has exceeded `CHECKOUT_MAX_ADDRESS_WARNINGS` mismatches. | `reauthenticate` |

---

## Contract Errors (`EVT_CONTRACT_`)

These map the on-chain Soroban `contracterror` discriminants to stable API
codes.  See `soroban/contracts/purchase-manager/src/lib.rs` (`PurchaseError`)
and `soroban/contracts/material-registry/src/lib.rs` (`RegistryError`) for
the canonical numeric values.

### PurchaseManager contract errors

| Code | Contract Error | Discriminant | Retryable | Description |
|---|---|---|---|---|
| `EVT_CONTRACT_PM_001` | `AlreadyInitialized` | 1 | false | Contract already initialised. |
| `EVT_CONTRACT_PM_002` | `InvalidPlatformFee` | 2 | false | Platform fee bps exceeds the 10 % cap. |
| `EVT_CONTRACT_PM_010` | `ContractPaused` | 10 | true | Purchase-manager is paused. |
| `EVT_CONTRACT_PM_011` | `MaterialNotActive` | 11 | false | Material is paused or archived. |
| `EVT_CONTRACT_PM_012` | `AssetNotAllowed` | 12 | false | Asset not on the contract allowlist. |
| `EVT_CONTRACT_PM_013` | `InvalidQuoteAmount` | 13 | false | Expected amount does not match the quote. |
| `EVT_CONTRACT_PM_014` | `AssetNotAcceptedForMaterial` | 14 | false | Asset not in this material's quote list. |
| `EVT_CONTRACT_PM_015` | `EntitlementAlreadyExists` | 15 | false | Buyer already holds an active entitlement. |
| `EVT_CONTRACT_PM_040` | `NotAuthorized` | 40 | false | Caller does not hold the required role. |
| `EVT_CONTRACT_PM_050` | `EscrowLocked` | 50 | false | Escrow lock period has not elapsed. |
| `EVT_CONTRACT_PM_051` | `EscrowAlreadyClaimed` | 51 | false | Escrow was already withdrawn. |
| `EVT_CONTRACT_PM_070` | `SettlementNotPending` | 70 | false | Settlement is not in Pending state. |
| `EVT_CONTRACT_PM_071` | `DisputeWindowExpired` | 71 | false | Dispute window (30 000 ledgers) has passed. |
| `EVT_CONTRACT_PM_072` | `DisputeAlreadyExists` | 72 | false | A dispute is already open for this purchase. |
| `EVT_CONTRACT_PM_077` | `RefundNotAllowed` | 77 | false | Purchase is not in a refundable state. |
| `EVT_CONTRACT_PM_080` | `EmptyRecipientList` | 80 | false | Bulk purchase recipient list is empty. |
| `EVT_CONTRACT_PM_081` | `TooManyRecipients` | 81 | false | Recipient list exceeds 50. |
| `EVT_CONTRACT_PM_083` | `ArithmeticOverflow` | 83 | false | Total cost overflowed i128. |
| `EVT_CONTRACT_PM_092` | `InsufficientScholarshipCredits` | 92 | false | Learner does not hold enough scholarship credits. |
| `EVT_CONTRACT_PM_110` | `StaleSaleTermsQuote` | 110 | false | Creator updated sale terms after quote was recorded. |
| `EVT_CONTRACT_PM_111` | `StaleQuoteAsset` | 111 | false | Quote asset differs from the asset passed to purchase. |
| `EVT_CONTRACT_PM_112` | `QuoteExpired` | 112 | false | Recorded quote has passed its TTL. |
| `EVT_CONTRACT_PM_120` | `RefundAuthorizationExpired` | 120 | false | Refund auth payload has passed its expiry. |
| `EVT_CONTRACT_PM_121` | `RefundSignerDisabled` | 121 | false | Refund signer kill switch is active. |
| `EVT_CONTRACT_PM_122` | `RefundSignerVersionMismatch` | 122 | false | Signer version in payload does not match active version. |
| `EVT_CONTRACT_PM_130` | `EntitlementStale` | 130 | true | Cached entitlement is active but settlement is no longer Pending. |
| `EVT_CONTRACT_PM_131` | `EntitlementRevoked` | 131 | false | Entitlement was revoked by a refund or dispute resolution. |

### MaterialRegistry contract errors

| Code | Contract Error | Discriminant | Retryable | Description |
|---|---|---|---|---|
| `EVT_CONTRACT_REG_001` | `EmptyMetadataUri` | 1 | false | Metadata URI is empty. |
| `EVT_CONTRACT_REG_002` | `MetadataUriTooLong` | 2 | false | Metadata URI exceeds 256 characters. |
| `EVT_CONTRACT_REG_012` | `MaterialAlreadyExists` | 12 | false | A material with this ID was already registered. |
| `EVT_CONTRACT_REG_013` | `MaterialNotFound` | 13 | false | No material found for the given identifier. |
| `EVT_CONTRACT_REG_014` | `NotAuthorized` | 14 | false | Caller is not the material creator or admin. |
| `EVT_CONTRACT_REG_015` | `UnapprovedAsset` | 15 | false | Quote asset is not on the registry allowlist. |
| `EVT_CONTRACT_REG_016` | `AlreadyInitialized` | 16 | false | Registry was already initialised. |
| `EVT_CONTRACT_REG_017` | `NotInitialized` | 17 | false | Registry has not been initialised yet. |

---

## Input / Validation Errors (`EVT_INPUT_`)

| Code | HTTP | Retryable | Description | Support Action |
|---|---|---|---|---|
| `EVT_INPUT_001` | 400 | false | Required field missing — a required request field was not provided. | `none` |
| `EVT_INPUT_002` | 400 | false | Field type invalid — a field value does not match the expected type or format. | `none` |
| `EVT_INPUT_003` | 400 | false | Value out of range — a numeric field is outside the permitted bounds. | `none` |
| `EVT_INPUT_004` | 400 | false | Invalid wallet address — the address does not match a valid Stellar or EVM format. | `none` |
| `EVT_INPUT_005` | 400 | false | Invalid contract ID — the Soroban contract ID is not a well-formed 56-character `C`-prefixed address. | `none` |
| `EVT_INPUT_006` | 413 | false | Request body too large — the request body exceeds the allowed limit. | `none` |
| `EVT_INPUT_007` | 429 | true | Rate limit exceeded — too many requests from this identity within the sliding window. | `retry_later` |

---

## Support Actions

| Value | Meaning |
|---|---|
| `none` | No action — the error is terminal and the client should surface it to the user as-is. |
| `retry_later` | The client may retry after an exponential backoff delay. |
| `refresh_quote` | The buyer's price or terms snapshot is stale; call `record_quote` (on-chain) or reload the checkout page. |
| `refresh_capability` | Re-request a download capability token from `GET /api/download`. |
| `reauthenticate` | Clear the session and ask the user to reconnect their wallet. |
| `reduce_quantity` | Reduce the bulk-purchase quantity below the system limit. |
| `contact_support` | The error cannot be self-served; the user should open a support ticket. |

---

## Error Code Stability Policy

- Codes are **stable within a major API version**. A code assigned today will
  always map to the same failure category.
- `message` and `supportAction` text is **not stable** — parse `code` only.
- New codes may be added without a version bump (additive change).
- An existing code's `retryable` flag or `supportAction` may be updated in a
  minor version when the operational characteristics of the failure change.
- **Breaking changes** (removing a code, changing its HTTP status by more than
  one class, or changing `retryable` from `false` to `true`) require a major
  version increment and a migration note in this file.

---

## Changelog

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-25 | Initial stable taxonomy covering all subsystems. |

# EduVault API Error Code Reference

This document contains the event/integration error registry for purchase,
entitlement, download, refund, storage, indexer, webhook, activity
receipts, and delegated recovery contacts. It is not the canonical HTTP API response schema.

The current HTTP Problem Details schema, route coverage, operational
remediation, and stable API error codes are documented in
[API Problem Details and Error Codes](./api-problem-details.md). In
particular, `EVT_*` registry identifiers below are not aliases for the HTTP
`code` field.

---

## Event / integration registry format

The following envelope describes the event/integration registry only; HTTP API
errors use the RFC 9457 envelope in the linked API documentation:

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
| `EVT_RECEIPT_` | Activity receipts |
| `EVT_AUTH_` | Authentication / authorisation |
| `EVT_CONTRACT_` | On-chain Soroban contract errors |
| `EVT_INPUT_` | Request validation / input errors |
| `EVT_RECOVERY_` | Delegated recovery contacts / account restoration |

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
| `EVT_PURCHASE_007` | 402 | true | Quote expired — the buyer's recorded quote has passed its TVL; re-quote and try again. | `refresh_quote` |
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
| `EVT_DOWNLOAD_006` | 404 | false | Content not found — the IPFS cID referenced by the material is not pinned or is unreachable. | `contact_support` |
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
| `EVT_REFUND_010`| 503 | true | Refund transaction failed — the Stellar transaction submission failed after retries. | `retry_later` |
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
| `EVT_STORAGE_007` | 422 | false | Pinata CID mismatch — the content hash returned by the pin endpoint does not match the expected CID. | `contact_support` |
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
| `EVT_INDEXER_008` | 503 | true | Surge pricing detected — on-chain base fee exceeds the `XL_SURGE_FEE_THRESHOLD`; transaction submission deferred. | `retry_later` |
| `EVT_INDEXER_009` | 500 | false | Ledger gap detected — a sequence discontinuity was found in the processed ledger range; recovery scan required. | `contact_support` |

---

## Webhook Errors (`EVT_WEBHOOK_`)

| Code | HTTP | Retryable | Description | Support Action |
|---|---|---|---|---|
| `EVT_WEBHOOK_001` | 401 | false | Signature verification failed — the HMAC-SHA256 signature on an inbound webhook payload did not verify. | `none` |
| `EVT_WEBHOOK_002` | 401 | false | Timestamp too old — the `X-EduVault-Timestamp` Header indicates the request is outside the replay-prevention window. | `none` |
| `EVT_WEBHOOK_003` | 400 | false | Malformed payload — the webhook body could not be parsed as valid JSON. | `none` |
| `EVT_WEBHOOK_004` | 404 | false | Unknown event type — the `event` field does not match any registered webhook event type. | `none` |
| `EVT_WEBHOOK_005` | 503 | true | Delivery failed — the creator's configured webhook endpoint returned a non-2xx status. | `retry_later` |
| `EVT_WEBHOOK_006` | 503 | true | Delivery timeout — the creator's webhook endpoint did not respond within the deadline. | `retry_later` |
| `EVT_WEBHOOK_007` | 429 | true | Rate limit — too many webhook deliveries to this endpoint within the configured window. | `retry_later` |

---

## Recovery Contact Errors (`EVT_RECOVERY_`)

Recovery contacts are trusted peers a student invites to help restore
access to their own records and learning assets. The flow is strictly
opt-in and delegated:

1. Student invites a contact (`invited`).
2. Contact accepts (`active`) or rejects (`declined`) the invite.
3. Student requests recovery and active contacts approve or reject.
4. Approvals expire or can be revoked before completion.

A contact cannot approve or reject a recovery request until it has
accepted its invite. Expired or revoked approvals fail safely and cannot be
used to complete restoration. Every recovery action is audited with the
actor, the action type, and a reason metadata field.

| Code | HTTP | Retryable | Description | Support Action |
|---|---|---|---|---|
| `EVT_RECOVERY_001` | 403 | false | Contact not confirmed — the recovery contact has not accepted its invite and cannot act on requests. | `none` |
| `EVT_RECOVERY_002` | 409 | false | Invite already pending — an invite for this contact is already outstanding. | `none` |
| `EVT_RECOVERY_003` | 409 | false | Invite expired — the invitation window has passed; a new invite is required. | `none` |
| `EVT_RECOVERY_004` | 409 | false | Invite revoked — the student revoked the invite before it was accepted. | `none` |
| `EVT_RECOVERY_005` | 409 | false | Recovery request already open — an active request exists for this account. | `none` |
| `EVT_RECOVERY_006` | 409 | false | Recovery request expired — the request passed its approval window before completion. | `none` |
| `EVT_RECOVERY_007` | 409 | false | Recovery request revoked — the student revoked the request before approval completed. | `none` |
| `EVT_RECOVERY_008` | 409 | false | Approval expired — the contact's approval passed its expiry and cannot be counted. | `none` |
| `EVT_RECOVERY_009` | 409 | false | Approval revoked — the contact or student revoked the approval before completion. | `none` |
| `EVT_RECOVERY_010` | 403 | false | Contact is not a confirmed recovery contact — the actor is not in the account's confirmed recovery set. | `none` |
| `EVT_RECOVERY_011` | 422 | false | Insufficient approvals — the request does not yet meet the required confirmed-contact threshold. | `none` |
| `EVT_RECOVERY_012` | 409 | false | Duplicate approval — this contact has already approved the request. | `none` |
| `EVT_RECOVERY_013` | 422 | false | Recovery target mismatch — the request targets a record or asset the contact is not delegated for. | `none` |
| `EVT_RECOVERY_014` | 409 | false | Contact limit reached — the account has the maximum number of recovery contacts. | `none` |
| `EVT_RECOVERY_015` | 403 | false | Self-invite forbidden — a student cannot invite their own account as a recovery contact. | `none` |
| `EVT_RECOVERY_016` | 503 | true | Recovery audit write failed — the audit log for a recovery action could not be persisted; the action is rejected. | `retry_later` |

---

## Support Actions

| Action | Meaning |
|---|---|
| `none` | No automatic remedy available; the client should surface the message to the user. |
| `retry_later` | Retry the same request after a backoff delay. |
| `refresh_quote` | Re-fetch the material quote and resubmit with the new values. |
| `refresh_capability` | Obtain a new download capability token and retry. |
| `reduce_quantity` | Lower the bulk quantity and resubmit. |
| `contact_support` | Request assistance from platform support. }

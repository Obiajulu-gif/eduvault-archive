# Backend Schemas and API Contracts


This document defines the canonical backend shapes for EduVault contributors. MongoDB keeps application metadata and query models, while Soroban and Stellar events remain the source of truth for payment and entitlement state once the Stellar milestone is active.

The canonical Soroban storage boundary, normalized event names, and entitlement query rules are defined in [`docs/soroban-contract-architecture.md](soroban-contract-architecture.md).

The **Stable error-code taxonomy** for all failure paths (purchase, refund,
entitlement, download, storage, indexer, webhook, auth, contract, and input
validation) is defined in [`docs/API_REFERENCE.md](API_REFERENCE.md).
Clients and frontends must use these codes rather than parsing prose error
messages. Webhook signature verification and retry semantics are described
in [`docs/webhook-signatures.md`](webhook-signatures.md).

Canonical serialization and strict input normalization rules for signed,
hashed, compared, or settled payloads are defined in
[`docs/canonical-serialization.md`](canonical-serialization.md).

## Collections

### `users`

Authoritative off-chain creator and buyer profile data.

Required fields:

- `fullName`: display name.
- `email`: lowercase unique email address.
- `createdAt / updatedAt`: timestamps.

Optional fields:

- `institution`, `country`, `bio`.
- `walletAddress`: original wallet address supplied by the user.
- `walletAddressLower`: normalized lookup key.
- `payoutWalletAddress`: creator settlement wallet for future payouts.
- `payoutWalletAddressLower`: normalized lookup key for the payout wallet.
- `preferredPayoutCurrency`: preferred display currency for earnings and settlement metadata.
- `payoutNotes`: optional creator notes for finance and operations.
- `webhookSigningSecret`: current HMAC secret for outbound creator webhooks.
- `webhookSigningSecretPrevious`: previous secret retained during rotation (#669).
- `webhookSigningSecretRotatedAt`: timestamp when the current secret replaced the previous one.

Indexes:

- unique `email`.
- sparse `walletAddressLower`.

### `materials`

Authoritative off-chain listing metadata and derived chain linkage.

Required fields:

- `userAddress`: creator wallet address.
- `title`, `storageKey` (or legacy `fileUrl`), `visibility`, `price`.
- `createdAt / updatedAt`: timestamps.

Optional fields:

- `description`, `usageRights`, `thumbnailUrl`.
- `coverImageUrl`, `shortSummary`, `learningOutcomes`, `tableOfContents`, `sampleNotes`.
- `materialId`, `chainContractId`, `chainLedger`, `chainTxHash`, `syncStatus`.

Marketplace preview field notes:

- `coverImageUrl`: optional public image URL for the listing hero.
- `shortSummary`: short teaser used on marketplace cards and detail headers.
- `learningOutcomes`: array of short strings, or newline/comma-separated values accepted by the upload flow.
- `tableOfContents`: array of short strings, or newline/comma-separated values accepted by the upload flow.
- `sampleNotes`: array of short strings, or newline/comma-separated values accepted by the upload flow.

Indexes:

- `{ userAddress: 1, createdAt: -1 }` for creator dashboards.
- `{ visibility: 1, createdAt: -1 }` for marketplace reads.
- sparse `materialId` for indexed chain records.

### `purchases`

Derived cache of settled on-chain purchase events.

Required fields:

- `materialId`, `buyerAddress`, `status`.
- `createdAt / updatedAt`: timestamps.

Optional fields:

- `sellerAddress`, `chainTxHash`, `amount`, `asset`.

Indexes:

- `{ buyerAddress: 1, createdAt: -1 }`.
- unique sparse `{ materialId: 1, buyerAddress: 1 }`.
- unique sparse `chainTxHash`.

### `entitlement_cache`

Derived query cache used by API and frontend flows to check access quickly.

Required fields:

- `materialId`, `buyerAddress`, `active`, `source`.
- `createdAt / updatedAt`: timestamps.

Indexes:

- unique `{ buyerAddress: 1, materialId: 1 }`.
- `{ active: 1, updatedAt: -1 }`.

### `webhook_events`

Idempotency log for inbound webhook and integration callback deliveries.
Every verified delivery is recorded before side effects run so that a
replayed event with a valid signature is acknowledged without repeating
those side effects.

Required fields:

- `_id`: stable dedupe key, `{provider}:{eventId}`.
- `provider`: webhook provider or internal callback source key.
- `eventId`: provider-supplied event identifier.
- `signatureTimestamp`: Unix seconds from the signed payload header.
- `status`: `processed` or `failed`.
- `createdAt` / `updatedAt`: timestamps.

Optional fields:

- `errorCode`: stable `EVT_WEBHOOK_*` code when `status` is `failed`.
- `attempts`: delivery attempts observed for this event id.

Indexes:

- unique `_id` (dedupe key).
- `{ provider: 1, createdAt: -1 }` for provider-scoped replay auditing.
- TTL `{ createdAt: 1 }` with `expireAfterSeconds` set to the replay window
  (default 24h) so the log stays bounded.

### `sync_state`

Durable indexer checkpoint state.

Required fields:

- `_id`: source key, for example `stellar:events`.
- `source`, `cursor`, lastLedge`, `updatedAt`.

### `sync_events`

Idempotency log for processed chain events.

Required fields:

- `_id`: stable event id.
- `type`, `source`, `raw`, `createdAt`.

## Inbound Webhook Verification

Inbound webhooks and integration callbacks are verified before any handler
runs. The canonical signing scheme, header names, and rotation rules live in
[`docs/webhook-signatures.md`](webhook-signatures.md); this section defines
the backend contract that routes must honour.

Verification order (fail fast, no side effects before step 4):

1. Parse the raw body and read the signature and timestamp headers. A missing
   or malformed header is rejected with `EVT_WEBHOOK_001`.
2. Recompute the HMAC over `{timestamp}.{rawBody}` using the provider secret
   (current secret first, then `webhookSigningSecretPrevious` during
   rotation). A mismatch is rejected with `EVT_WEBHOOK_002`.
3. Reject timestamps outside the replay window (default 300s in the past,
   60s in the future) with `EVT_WEBHOOK_003`.
4. Insert `{ _id: "{provider}:{eventId}" }` into `webhook_events`. A
   duplicate key means the event was already handled: respond `200` with
   `{ "duplicate": true }` and skip side effects (`EVT_WEBHOOK_004` is
   reserved for explicit duplicate rejections when a caller opts in).
5. Run the handler, then mark the record `processed` (or `failed` with an
   `errorCode`).

Structured error envelope (see [Stable Error Codes](#stable-error-codes)):

| Condition              | Code             | `retryable` |
| ---------------------- | ---------------- | ----------- |
| Missing/malformed sig  | `EVT_WEBHOOK_001`| `false`     |
| Invalid signature      | `EVT_WEBHOOK_002`| `false`     |
| Stale/future timestamp | `EVT_WEBHOOK_003`| `false`     |
| Duplicate event id     | `EVT_WEBHOOK_004`| `false`     |
| Handler failure        | `EVT_WEBHOOK_005`| `true`      |

## API Contracts

### `POST /api/profile`

Request:

- `fullName`: required string.
- `email`: required email.
- `walletAddress`: optional EVM or Stellar public key.
- `institution`, `country`, `bio`: optional strings.

Response:

- `success`, `user`, `emailSent`.

### `PATCH /api/profile`

Request:

- `displayName`, `bio`, `avatarUrl`, `institution`, `country`, `twitterUrl`, `githubUrl`, `websiteUrl`: optional profile fields.
- `payoutWalletAddress`: optional wallet address for settlement routing.
- `preferredPayoutCurrency`: optional uppercase currency code such as `XLM`, `USD`, or `USDC`.
- `payoutNotes`: optional plain-text payout notes.

Response:

Permission-aware search and discovery index. One document per indexable
record (material), keyed by the source record id and a normalized visibility
scope. The index is derived from `materials` and `entitlement_cache` and must
never be treated as the source of truth for access control.

{
  "notifications": [
    { "id": "66f…", "type": "import_partial_failure", "severity": "error", "title": "Import partially failed",
      "message": "1 created, 0 updated, 0 skipped, 1 failed.", "link": "/dashboard/my-materials",
      "read": false, "createdAt": "2026-09-26T09:00:00.000Z" }
  ],
  "unreadCount": 1
}

- `_id`: stable index key, for example `material:<materialId>`.
- `sourceType`: always `material` today; reserved for future indexable types.
- `sourceId`: the `materials` document `id` or `materialId`.
- `visibility`: normalized visibility scope: `public`, `unlisted`, or `private`.
- `authorAddress`: normalized lowercase creator wallet address.
- `indexedAt: timestamp of the last index write.
- `updatedAt`: timestamp of the last index mutation.

Optional fields:

- `title`, `shortSummary`, `description`, `tags`, `learningOutcomes`,
  `tableOfContents`, `coverImageUrl`, `thumbnailUrl`: denormalized copy of the
  searchable material fields.
- `price`, `usageRights`, `updatedAt`: copied for display and sorting.
- `entitlementAddresses`: sorted array of lowercase buyer addresses with an
  `active` entitlement. Present only for non-`public` visibility scopes.
- `stale`: boolean flag set by the repair job when the index entry no longer
  matches the source record or its effective visibility.
- `staleReason`: machine-readable reason code such as `missing_source`,
  `visibility_changed`, `orphaned_entitlement`, or `missing_index`.

Indexes:

- unique `_id`.
- `{ visibility: 1, updatedAt: -1 }` for public discovery reads.
- `{ authorAddress: 1, updatedAt: -1 }` for creator-scoped reads.
- `{ entitlementAddresses: 1, updatedAt: -1 }` for permission-filtered reads.
- `{ stale: 1, updatedAt: -1 }` for the repair job.

Visibility constraints:

- `public`: visible to any authenticated or anonymous search caller.
- `unlisted`: excluded from discovery listings but returned to the author
  and to callers with an active entitlement.
- `private`: returned only to the author and to callers with an active
  entitlement.
- A caller must never receive a private or unlisted record without either
  authorship or an active entitlement. The query layer applies this filter before
  results leave the process.

### `search_index_repair`_log`

Audit trail for the stale-index repair job.

`signedXdr` and any other signed or settled payloads are canonicalized before
verification and settlement. Non-canonical input is normalized or rejected
consistently, and legacy records are handled via the compatibility rules in
[`docs/canonical-serialization.md`](canonical-serialization.md).

### `GET /api/entitlements`

Required fields:

- `_id`: stable run id.
- `startedAt` / `completedAt`: timestamps.
- `scanned`, `repaired`, `removed`, `skipped`: counters.
- `repairs`: array of `{ indexId, reason, action }` detailing each mutation.

## API Contracts

### `POST /api/profile`

Request:

- `fullName`: required string.
- `email`: required email.
- `walletAddress`: optional EVM or Stellar public key.
- `institution`, `country`, `bio`: optional strings.

Response:

- `success`, `user`, `emailSent`.

- `creatorAddress`, `dateRange: { from, to }`.
- `earnings`: `grossRevenue`, `salesCount` (all-time, completed purchases only),
  `windowRevenue`, `windowSalesCount` (within `dateRange`), `pendingRevenue`,
  `pendingCount`, `refundedAmount`, `refundedCount`.
- `payouts`: `totalPaidOut`, `totalPending`, `lastPayoutAt` derived from the
  `payouts` collection.
- `outstandingBalance`: `max(grossRevenue - totalPaidOut, 0)`.
- `byMaterial`: per-material `{ materialId, title, salesCount, grossRevenue }`,
  sorted by revenue descending.

### `POST /api/webhooks/{provider}`

Auth: signature headers only; no session cookie is required.

Request:

- Raw body is the exact bytes signed by the provider.
- `X-Webhook-Signature`: hex HMAC of `{timestamp}.{rawBody}`.
- `X-Webhook-Timestamp`: Unix seconds.
- `X-Webhook-Id`: provider event id used as the dedupe key.

Response:

- `200 { "received": true }` on first successful processing.
- `200 { "received": true, "duplicate": true }` when the event id was
  already processed.
- `400` with the structured envelope and `EVT_WEBHOOK_001`–`EVT_WEBHOOK_003`
  for malformed, invalid, or stale deliveries.
- `500` with `EVT_WEBHOOK_005` when the handler fails; the event record is
  left `failed` so a provider retry can reprocess it.

## Schema Change Rules

- Add fields as optional first, then backfill, then make route-level validation stricter.
- Keep on-chain fields separate from off-chain metadata.
- Treat `purchases` and `entitlement_cache` as derived from chain events.
- Do not delete or repurpose fields without a migration note.

## API Hardening Expectations

- Validate and sanitize all route input before persistence or logs.
- Apply rate limits to public and sensitive route families.
- Emit structured audit logs for validation failures, rate-limit blocks, upload failures, auth failures, purchase sync, and indexer anomalies.
- Add focused tests for validation, rate limiting, and indexer idempotency when changing backend behavior.

## Stable Error Codes

All API routes must return errors in the following envelope rather than
returning prose strings that clients parse:

```json
{
  "error": {
    "code": "EVT_PURCHASE_007",
    "message": "Human-readable description (informational only).",
    "retryable": true,
    "supportAction": "refresh_quote"
  }
}

The complete taxonomy of stable codes is in
[`docs/API_REFERENCE.md`](API_REFERENCE.md). The quick-reference mapping
below summarises the namespace-to-subsystem relationship:

| Namespace prefix    | Subsystem                         |
| ------------------- | --------------------------------- |
| `EVT_PURCHASE_`     | Purchase flow                     |
| `EVT_ENTITLEMENT_`  | Entitlement / access-check        |
| `EVT_DOWNLOAD_`     | Download capability tokens        |
| `EVT_REFUND_`       | Refund flow                       |
| `EVT_STORAGE_`      | IPFS / Pinata storage             |
| `EVT_INDEXER_`      | Stellar event indexer             |
| `EVT_WEBHOOK_`      | Inbound webhook verification and outbound creator webhooks |
| `EVT_AUTH_`         | Authentication / authorisation    |
| `EVT_CONTRACT_PM_`  | PurchaseManager on-chain errors   |
| `EVT_CONTRACT_REG_` | MaterialRegistry on-chain errors  |
| `EVT_INPUT_`        | Request validation / input errors |

### Implementation rules

- Every `catch` block in an API route handler must map the caught error to a
  code before returning. A fallback mapping (e.g. `EVT_INPUT_001` for
  validation, `EVT_PURCHASE_012` for registry call failures) is acceptable
  when a precise mapping is not yet available, but must be tracked as a
  follow-up task.
- Contract `contracterror` discriminants must be mapped to
  `EVT_CONTRACT_PM_*` or `EVT_CONTRACT_REG_*` codes by the API layer before
  the response leaves the server. Raw numeric discriminants must never
  appear in client-facing responses.
- The `retryable` flag drives frontend retry logic. Only set `true` for
  transient failures where the same request has a reasonable chance of
  succeeding after a delay.
- `supportAction` values are defined in
  [`docs/API_REFERENCE.md#support-actions`](API_REFERENCE.md#support-actions).

### Tests

Add a focused test for each new error mapping when adding or changing a route.
See `src/lib/__tests__/` for existing test patterns. Tests must assert the
stable `code` field value, not the `message` string.
Webhook verification tests must cover valid, invalid, stale, duplicate, and
malformed deliveries, and assert that duplicate valid events do not repeat
side effects.

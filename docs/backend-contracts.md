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

### `search_index`

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
| `EVT_DOWNLOAD_`      | Download capability tokens        |
| `EVT_REFUND_`        | Refund flow                       |
| `ST_STORAGE_`        | IPFS / Pinata storage             |
| `EVT_INDEXER_`       | Stellar event indexer             |
| `EVT_WEBHOOK_`       | Webhook delivery                    |

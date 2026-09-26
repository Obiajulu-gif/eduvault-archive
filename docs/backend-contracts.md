# Backend Schemas and API Contracts

This document defines the canonical backend shapes for EduVault contributors. MongoDB keeps application metadata and query models, while Soroban and Stellar events remain the source of truth for payment and entitlement state once the Stellar milestone is active.

The canonical Soroban storage boundary, normalized event names, and entitlement query rules are defined in [`docs/soroban-contract-architecture.md`](soroban-contract-architecture.md).

The **stable error-code taxonomy** for all failure paths (purchase, refund,
entitlement, download, storage, indexer, webhook, auth, contract, and input
validation) is defined in [`docs/API_REFERENCE.md`](API_REFERENCE.md).
Clients and frontends must use these codes rather than parsing prose error
messages. Webhook signature verification and retry semantics are described
in [`docs/webhook-signatures.md`](webhook-signatures.md).

## Collections

### `users`

Authoritative off-chain creator and buyer profile data.

Required fields:

- `fullName`: display name.
- `email`: lowercase unique email address.
- `createdAt` / `updatedAt`: timestamps.

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
- `createdAt` / `updatedAt`.

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
- `createdAt` / `updatedAt`.

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
- `createdAt` / `updatedAt`.

Indexes:

- unique `{ buyerAddress: 1, materialId: 1 }`.
- `{ active: 1, updatedAt: -1 }`.

### `sync_state`

Durable indexer checkpoint state.

Required fields:

- `_id`: source key, for example `stellar:events`.
- `source`, `cursor`, `lastLedger`, `updatedAt`.

### `sync_events`

Idempotency log for processed chain events.

Required fields:

- `_id`: stable event id.
- `type`, `source`, `raw`, `createdAt`.

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

- `success`, `user`.

### `GET /api/profile?address=...`

Request:

- `address`: required wallet address.

Response:

- `exists`, `user`.

### `POST /api/materials`

Request:

- `title`: required string.
- `storageKey`: required string for new uploads.
- `fileUrl`: accepted as a legacy alias for `storageKey`.
- `price`: optional non-negative number.
- `visibility`: `private`, `public`, or `unlisted`.
- `description`, `usageRights`, `thumbnailUrl`: optional strings.
- `coverImageUrl`, `shortSummary`, `learningOutcomes`, `tableOfContents`, `sampleNotes`: optional preview metadata fields.

Response:

- inserted material record with `id`.

### `POST /api/materials/import`

Auth: `auth_token` cookie; the caller must have a wallet address.

Request:

- `format`: `json` or `csv`.
- `dryRun`: boolean, default `true`. A dry run only reads and never writes.
- `records` or `items`: 1–500 material records. An optional `externalId` makes re-imports idempotent.

Response:

- Always: `dryRun`, `total`, `valid`, `invalid`, `invalidRows`, `summary` (`create`/`update`/`skip`/`error` counts) and `rows` (the per-row plan).
- On commit, also: `importBatchId`, `imported`, `created`, `updated`, `failedRows` and `rollback`.
- Statuses: `200` for a dry run or a commit with nothing to write; `201` when everything was written; `207` for a partial write; `400` for invalid rows (nothing written).

Full rules, examples and rollback steps: [`material-import.md`](material-import.md).

### `GET /api/notifications`

Auth: `auth_token` cookie; `401` `{ "error": "Unauthorized" }` otherwise.

Query: `unread=true` (optional), `limit` (1–50, default 20).

Success `200`:

```json
{
  "notifications": [
    { "id": "66f…", "type": "import_partial_failure", "severity": "error", "title": "Import partially failed",
      "message": "1 created, 0 updated, 0 skipped, 1 failed.", "link": "/dashboard/my-materials",
      "read": false, "createdAt": "2026-09-26T09:00:00.000Z" }
  ],
  "unreadCount": 1
}
```

### `PATCH /api/notifications`

Request: `{ "ids": ["66f…"] }` (up to 100) or `{ "all": true }`. Success `200` `{ "updated": 1 }`. Failure `400` `{ "error": "Provide ids or all: true" }`. Ids that belong to another user don't match and are not counted.

### Notifications (#794)

Stored in the `notifications` collection and written only through `notify()` in `src/lib/notifications/notifications.js`:

| Type | Recipient | Emitted when | Deep link |
| --- | --- | --- | --- |
| `import_completed` | the importing creator (`sub`) | an import commit writes every planned row | `/dashboard/my-materials` |
| `import_partial_failure` | the importing creator (`sub`) | some or all import writes fail | `/dashboard/my-materials` |

- **Deduplication:** each event passes a `dedupeKey` that is stable across retries (for example `import:<importBatchId>`). A unique index on `{ recipient, dedupeKey }` plus an upsert means a retried or concurrent emit creates the notification only once.
- **Privacy:** every read and every mark-read query filters on `recipient`. The API never returns `recipient` or `dedupeKey`.
- **New event types:** add the type to `NOTIFICATION_TYPES`, choose a `dedupeKey` that is stable across retries, and add the type to the `Notification.type` enum in `openapi.yaml`.

### Contract tests (#793)

`src/app/api/__tests__/contract.test.js` runs the import and notification route handlers against an in-memory Mongo and checks every response body against the schema `docs/openapi.yaml` documents for that status code. The test fails if an undocumented status is returned, a required field is missing, or a documented field changes type. If you change a response on purpose, update `openapi.yaml` in the same PR. Run it with `npx vitest run src/app/api/__tests__/contract.test.js`.

### `GET /api/materials`

Response:

- authenticated creator materials sorted newest first.

### `GET /api/purchase`

Response:

- current purchase history for the authenticated account.

### `POST /api/purchase`

Request:

- `materialId`: required material identifier.
- `signedXdr`: optional signed transaction payload.
- `email`: optional buyer email used for record enrichment.

Response:

- persisted purchase record or an existing confirmed purchase when the buyer already owns the item.

### `GET /api/entitlements`

Response:

- list of active entitlement records for the authenticated account.

### `GET /api/market-materials`

Request:

- `page`: optional positive number.
- `pageSize`: optional positive number capped at 50.

Response:

- `{ items, page, pageSize, total, totalPages }`.

### `GET /api/creator/payouts`

Aggregates and reports the authenticated creator's earnings from sales, distinct
from `GET /api/creator/analytics` which covers broader dashboard metrics.

Request:

- `from`, `to`: optional ISO date strings bounding the reporting window (default:
  trailing 30 days). Rejected with `400` when unparsable, when `from` is after
  `to`, or when the range exceeds 366 days.

Response:

- `creatorAddress`, `dateRange: { from, to }`.
- `earnings`: `grossRevenue`, `salesCount` (all-time, completed purchases only),
  `windowRevenue`, `windowSalesCount` (within `dateRange`), `pendingRevenue`,
  `pendingCount`, `refundedAmount`, `refundedCount`.
- `payouts`: `totalPaidOut`, `totalPending`, `lastPayoutAt` derived from the
  `payouts` collection.
- `outstandingBalance`: `max(grossRevenue - totalPaidOut, 0)`.
- `byMaterial`: per-material `{ materialId, title, salesCount, grossRevenue }`,
  sorted by revenue descending.

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
```

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
| `EVT_WEBHOOK_`      | Outbound creator webhooks         |
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

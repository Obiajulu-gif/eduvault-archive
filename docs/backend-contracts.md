# Backend Schemas and API Contracts

This document defines the canonical backend shapes for EduVault contributors. MongoDB keeps application metadata and query models, while Soroban and Stellar events remain the source of truth for payment and entitlement state once the Stellar milestone is active.

The canonical Soroban storage boundary, normalized event names, and entitlement query rules are defined in [`docs/soroban-contract-architecture.md`](soroban-contract-architecture.md).

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

Request:

- `format`: `json` or `csv`.
- `dryRun`: boolean flag. When `true`, the API validates without saving.
- `records` or `items`: array of material records.

Response:

- `dryRun`, `total`, `valid`, `invalid`, `invalidRows`.
- `imported` when the import is committed.

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

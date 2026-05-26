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

Indexes:

- unique `email`.
- sparse `walletAddressLower`.

### `materials`

Authoritative off-chain listing metadata and derived chain linkage.

Required fields:

- `userAddress`: creator wallet address.
- `title`, `fileUrl`, `visibility`, `price`.
- `createdAt` / `updatedAt`.

Optional fields:

- `description`, `usageRights`, `thumbnailUrl`.
- `fileType`, `fileSize`, `thumbnailType`, `thumbnailSize`.
- `materialId`, `chainContractId`, `chainLedger`, `chainTxHash`, `syncStatus`.

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

### `GET /api/profile?address=...`

Request:

- `address`: required wallet address.

Response:

- `exists`, `user`.

### `POST /api/materials`

Request:

- `title`: required string, trimmed and collapsed to a single-spaced label.
- `fileUrl`: required HTTP, HTTPS, or IPFS URL.
- `price`: optional non-negative number; omitted values normalize to `0`.
- `visibility`: optional `private`, `public`, or `unlisted`; omitted values normalize to `private`.
- `description`, `usageRights`: optional strings normalized with trimmed outer whitespace.
- `thumbnailUrl`: optional HTTP, HTTPS, or IPFS URL.
- `fileType` / `fileSize`: optional upload metadata. Supported file types are PDF, DOC, DOCX, PPT, PPTX, and ZIP. Maximum file size is 10 MB when provided.
- `thumbnailType` / `thumbnailSize`: optional upload metadata. Supported thumbnail types are JPEG, PNG, WebP, and GIF. Maximum thumbnail size is 5 MB when provided.
- `materialId`, `chainContractId`, `chainLedger`, `chainTxHash`, `syncStatus`: optional chain linkage fields normalized when present.

Response:

- inserted material record with `id`.
- validation failures return `400` with `{ error, details: { errors: [{ field, message, code }] } }`.

### `GET /api/materials`

Response:

- authenticated creator materials sorted newest first.

### `GET /api/materials/download/[id]`

Request:

- `id`: material database `_id` or `materialId`.
- Requires an authenticated session with a wallet address.

Access rules:

- If the material `price` is `0` or less, the file can be served without a purchase entitlement.
- If the material is paid, the route checks `entitlement_cache` first.
- Fresh cache hits allow or deny access immediately.
- Missing or stale cache entries fall back to a chain-verification adapter when `ENTITLEMENT_VERIFIER_URL` is configured.
- If the cache is missing or stale and no chain verifier is available, the route returns `503` with `stale_entitlement`.
- A successful entitlement check returns a short-lived signed `downloadUrl`.
- Opening the signed `downloadUrl` streams the protected file and keeps the raw storage URL hidden from the client.

Response:

- First response: `{ success, downloadUrl, title }`.
- Signed access response: streams the protected file with `Content-Disposition: attachment`.
- `401` for missing session.
- `403` for an authenticated user without entitlement.
- `404` for a missing material.
- `502` for storage or proxy failures.
- `503` for stale or unverifiable entitlement data.

### `GET /api/market-materials`

Request:

- `page`: optional positive number.
- `pageSize`: optional positive number capped at 50.

Response:

- `{ items, page, pageSize, total, totalPages }`.

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

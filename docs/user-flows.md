# EduVault User Flows

Two concise user flows are documented below: Creator and Buyer.

## Creator Flow

1. Connect wallet and create profile in the app.
2. Upload material metadata and file via the Creator Upload UI.
3. Backend pins file and metadata to IPFS (Pinata) and creates a `materials` record in MongoDB.
4. Creator sets price, visibility, and rights.
5. Optionally the backend registers the material on-chain via `MaterialRegistry` (Soroban), emitting `material.registered` events.
6. Indexer picks up on-chain events and updates derived state.

Systems involved: Frontend, Backend API, MongoDB (`materials`), IPFS/Pinata, Soroban `MaterialRegistry`, Indexer.

## Buyer Flow

1. Browse marketplace, open a material detail page.
2. Start checkout; frontend requests a signed Stellar transaction via wallet.
3. Backend or frontend submits transaction to Soroban `PurchaseManager`.
4. Soroban emits `purchase.completed` event on success.
5. Indexer consumes events and writes `purchases` and `entitlement_cache`.
6. Buyer requests material access; backend checks `entitlement_cache` and `purchases` and returns an access status.

Systems involved: Frontend, Wallet, Soroban `PurchaseManager`, Stellar RPC, Indexer, MongoDB (`purchases`, `entitlement_cache`).

## Maintainer Operations

- Run the indexer locally: `docker compose up -d mongodb` (waits for the
  single-node replica set to come up), then `npm run indexer:stellar` (uses
  `scripts/run-stellar-indexer.mjs`). The replica set is required: the indexer
  commits each event's `sync_events` receipt and its purchase/entitlement
  projections in one transaction, and Mongo only permits transactions on a
  replica set. Against a standalone mongod the indexer logs a warning and falls
  back to non-transactional writes.
- Process one batch and exit: `npm run indexer:stellar:once`.
- Reprocess dead-letter entries: `node scripts/reprocess-deadletter.mjs`.
- Inspect dead-letter events in MongoDB collection `dead_letter_events` for failure details.

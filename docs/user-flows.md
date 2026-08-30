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
2. View bounded/watermarked preview of paid material.
3. Start checkout; frontend requests a signed Stellar transaction via wallet.
3. Backend or frontend submits transaction to Soroban `PurchaseManager`.
4. Soroban emits `purchase.completed` event on success.
5. Indexer consumes events and writes `purchases` and `entitlement_cache`.
6. Buyer requests material access; backend checks `entitlement_cache` and `purchases` and returns an access status.

Systems involved: Frontend, Wallet, Soroban `PurchaseManager`, Stellar RPC, Indexer, MongoDB (`purchases`, `entitlement_cache`).

## Maintainer Operations

- Run the indexer locally: `npm run indexer:stellar` (uses `scripts/run-stellar-indexer.mjs`).
- Reprocess dead-letter entries: `node scripts/reprocess-deadletter.mjs`.
- Inspect dead-letter events in MongoDB collection `dead_letter_events` for failure details.

## Mobile checkout recovery (#684)

Mobile users who leave the browser or wallet popup mid-checkout can now resume or safely cancel:

- `PurchaseManager::begin_checkout(buyer, material_id)` records a pending attempt; a second submission while pending is blocked with `CheckoutPending` (no duplicate checkout).
- `PurchaseManager::cancel_checkout(buyer, material_id)` clears a pending attempt after an interruption (safe to call; missing attempts are not an error).
- A completed `purchase` clears the pending state automatically.

Flow: begin checkout -> wallet signing interrupted -> return to app -> either retry (pending blocks duplicates until cancelled) or cancel and re-quote.

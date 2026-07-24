# Indexer event schema (#7)

This document is the canonical normalized-event contract for the Stellar
indexer (`src/lib/indexer/`). Contract, indexer, and schema changes must
update this file, `src/lib/indexer/eventSchema.js`, and the corresponding
Rust `#[contractevent]` definitions in the same PR.

## Decoding pipeline

`createJsonRpcEventSource` (`src/lib/indexer/stellarIndexer.js`) fetches raw
events from Soroban RPC `getEvents` and passes each one through
`decodeContractEvent` (`src/lib/indexer/eventDecoder.js`) before it reaches
`applyIndexedEvent`. A raw event is rejected — logged and dropped, not
thrown — when any of the following is true, so one bad or unrecognized
event never blocks the rest of a batch:

| Reason | Meaning |
|---|---|
| `unlisted_contract` | `contractId` isn't in the allowlisted deployment manifest (`src/lib/indexer/contractManifest.js`) for the configured network passphrase, or claims to be a contract kind it isn't allowlisted for. |
| `malformed_topics` | Fewer than 2 topics, or the first two topics don't decode to Symbols (event name topics are always Symbols). |
| `unknown_event` | The `topic[0].topic[1]` pair (e.g. `"material.registered"`) has no entry in `EVENT_SCHEMAS`. |
| `malformed_data` | The `vec` data payload has fewer elements than the schema requires, or a field fails type validation (wrong byte length, invalid address, non-integer amount, ...). |

Raw payloads are preserved verbatim on every successfully decoded event
(`normalized.raw`) for audit — normalized fields are for projection code,
the raw XDR/JSON stays available if you need to re-derive something the
normalizer doesn't expose yet.

## Network / contract allowlist

`src/lib/indexer/contractManifest.js` maps a network passphrase to the
allowlisted `materialRegistry` / `purchaseManager` contract ids for that
network (sourced from the same env vars as `src/lib/config/chain.js`, plus
optional `*_MAINNET` variants). `decodeContractEvent` always requires an
explicit `networkPassphrase` and rejects any event whose `contractId` isn't
listed for that passphrase — this is what prevents, for example, a testnet
RPC misconfiguration from having its events silently indexed as mainnet
data (or vice versa).

## Normalized event schemas

Each entry below corresponds to a `#[contractevent(topics = [...])]` struct
in `soroban/contracts/material-registry/src/lib.rs` or
`soroban/contracts/purchase-manager/src/lib.rs`. Field order matches the
Rust struct's field order — event data uses `data_format = "vec"`, so
fields are decoded positionally, not by name.

### `material.registered` (materialRegistry, schema v1)

| Field | Type | Notes |
|---|---|---|
| `materialId` | `bytes32Hex` | topic |
| `creator` | `address` | topic |
| `metadataUri` | `string` | |
| `metadataHash` | `bytes32Hex` | |
| `rightsHash` | `bytes32Hex` | |
| `status` | passthrough | `MaterialStatus` enum, not yet interpreted by the indexer |
| `quotes` | passthrough | `Vec<AssetQuote>` |
| `payoutShares` | passthrough | `Vec<PayoutShare>` |

### `material.sale_terms_updated` (materialRegistry, schema v1)
`materialId` (topic), `creator` (topic), `status`, `quotes`, `payoutShares`.

### `material.status_updated` (materialRegistry, schema v1)
`materialId` (topic), `creator` (topic), `status`.

### `material.status_changed` (materialRegistry, schema v1)
`materialId` (topic), `creator` (topic), `paused` (bool), `status`.

### `material.version_published` (materialRegistry, schema v1)
`materialId` (topic), `version` (topic, u32), `manifestDigest` (bytes32Hex),
`fileCid` (string), `fileHash` (bytes32Hex), `creator` (address).

### `material.version_withdrawn` (materialRegistry, schema v1)
`materialId` (topic), `version` (topic, u32), `reason` (string), `actor` (address).

### `purchase.completed` (purchaseManager, schema v1)

| Field | Type | Notes |
|---|---|---|
| `purchaseId` | `u64` | topic, returned as a string to avoid precision loss |
| `materialId` | `bytes32Hex` | topic |
| `buyer` | `address` | topic |
| `seller` | `address` | |
| `asset` | `address` | |
| `amount` | `i128` | returned as a decimal string — do not use `Number()` on it |
| `platformFee` | `i128` | string |
| `sellerNetAmount` | `i128` | string |
| `entitlementActive` | `bool` | |
| `transactionId` | `bytes` | hex-encoded |

### `payout.distributed` (purchaseManager, schema v1)
`purchaseId` (topic), `materialId` (topic), `recipient` (topic, address),
`role` (Symbol), `asset`, `amount` (passthrough — not yet interpreted).

## Versioning rules

- **Additive** (new field appended to the end of the Rust struct / `vec`
  payload): does **not** require a `schemaVersion` bump. `decodeDataFields`
  in `eventDecoder.js` only requires the data vec to have *at least* as
  many elements as the schema's field list — extra trailing elements are
  ignored. Add the new field to the schema's `fields` array whenever the
  indexer needs to read it; older decoders keep working against newer
  on-chain events in the meantime (forward compatibility).
- **Breaking** (a field's type changes, a field is removed or reordered,
  the topic pair changes): bump `schemaVersion` for that event in
  `eventSchema.js` and update this document in the same PR as the contract
  change. If both the old and new on-chain shapes need to coexist during a
  migration, give the new shape a new topic pair (e.g.
  `["material", "registered_v2"]`) rather than silently reinterpreting the
  same topic pair — `decodeContractEvent` resolves schemas by exact topic
  pair, so this keeps old and new events routing to the correct decoder
  without an explicit on-chain version topic.

## Known gaps / follow-up

This decoder covers `MaterialRegistry` and `PurchaseManager`. It does not
yet:
- Wire `purchase.completed`'s decoded `platformFee` / `sellerNetAmount` /
  `entitlementActive` / `transactionId` fields into `applyIndexedEvent`'s
  Mongo writes (only the fields it already read from the old raw-passthrough
  shape are bridged in `eventDecoder.js`).
- Cross-validate against contract-side Rust test fixtures/snapshots — the
  JS fixtures in `src/lib/indexer/__tests__/eventDecoder.test.mjs` are
  constructed independently using `@stellar/stellar-sdk`'s XDR helpers.
  Wiring these to real Rust `soroban-sdk` test snapshot output (e.g. via a
  shared fixture file emitted by `cargo test`) is tracked as a follow-up.

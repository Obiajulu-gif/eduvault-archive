/**
 * Versioned normalized schemas for MaterialRegistry / PurchaseManager Soroban
 * contract events (#7).
 *
 * Each entry describes:
 *  - the on-chain topic pair that identifies the event (`["material", "registered"]`),
 *  - `schemaVersion`: bumped when a field's meaning/type changes or a
 *    required field is removed. Purely additive fields (new optional data
 *    appended at the end of the `vec` payload) do NOT require a bump — the
 *    decoder tolerates extra trailing elements it doesn't know about.
 *  - `fields`: the ordered list of data fields as emitted by
 *    `data_format = "vec"` in the Rust `#[contractevent]` definitions
 *    (see `soroban/contracts/material-registry/src/lib.rs` and
 *    `soroban/contracts/purchase-manager/src/lib.rs`). Each field has a
 *    `type` used by `eventDecoder.js` to validate/coerce the decoded native
 *    value.
 *
 * Supported field types:
 *  - "bytes32Hex"  — 32-byte value (e.g. BytesN<32> material id), hex-encoded
 *  - "address"     — Stellar StrKey address (account G... or contract C...)
 *  - "string"      — UTF-8 string
 *  - "i128"         — signed 128-bit integer, returned as a decimal string
 *  - "u32" / "u64" — unsigned integer, returned as a JS number (u32) or
 *                     string (u64, to avoid precision loss)
 *  - "bool"        — boolean
 *  - "bytes"       — arbitrary bytes, hex-encoded
 *  - "symbol"      — Soroban Symbol, returned as a string
 *  - "any"         — passed through as decoded native value, for fields the
 *                     indexer doesn't need to interpret yet (e.g. nested
 *                     Vec<AssetQuote>); still decoded so the raw payload
 *                     doesn't have to be trusted for these fields either.
 */

export const EVENT_SCHEMAS = Object.freeze({
  "material.registered": {
    contract: "materialRegistry",
    schemaVersion: 1,
    fields: [
      { name: "materialId", type: "bytes32Hex" },
      { name: "creator", type: "address" },
      { name: "metadataUri", type: "string" },
      { name: "metadataHash", type: "bytes32Hex" },
      { name: "rightsHash", type: "bytes32Hex" },
      { name: "status", type: "any" },
      { name: "quotes", type: "any" },
      { name: "payoutShares", type: "any" },
    ],
  },
  "material.sale_terms_updated": {
    contract: "materialRegistry",
    schemaVersion: 1,
    fields: [
      { name: "materialId", type: "bytes32Hex" },
      { name: "creator", type: "address" },
      { name: "status", type: "any" },
      { name: "quotes", type: "any" },
      { name: "payoutShares", type: "any" },
    ],
  },
  "material.status_updated": {
    contract: "materialRegistry",
    schemaVersion: 1,
    fields: [
      { name: "materialId", type: "bytes32Hex" },
      { name: "creator", type: "address" },
      { name: "status", type: "any" },
    ],
  },
  "material.status_changed": {
    contract: "materialRegistry",
    schemaVersion: 1,
    fields: [
      { name: "materialId", type: "bytes32Hex" },
      { name: "creator", type: "address" },
      { name: "paused", type: "bool" },
      { name: "status", type: "any" },
    ],
  },
  "material.version_published": {
    contract: "materialRegistry",
    schemaVersion: 1,
    fields: [
      { name: "materialId", type: "bytes32Hex" },
      { name: "version", type: "u32" },
      { name: "manifestDigest", type: "bytes32Hex" },
      { name: "fileCid", type: "string" },
      { name: "fileHash", type: "bytes32Hex" },
      { name: "creator", type: "address" },
    ],
  },
  "material.version_withdrawn": {
    contract: "materialRegistry",
    schemaVersion: 1,
    fields: [
      { name: "materialId", type: "bytes32Hex" },
      { name: "version", type: "u32" },
      { name: "reason", type: "string" },
      { name: "actor", type: "address" },
    ],
  },
  "purchase.completed": {
    contract: "purchaseManager",
    schemaVersion: 1,
    fields: [
      { name: "purchaseId", type: "u64" },
      { name: "materialId", type: "bytes32Hex" },
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "i128" },
      { name: "platformFee", type: "i128" },
      { name: "sellerNetAmount", type: "i128" },
      { name: "entitlementActive", type: "bool" },
      { name: "transactionId", type: "bytes" },
    ],
  },
  "payout.distributed": {
    contract: "purchaseManager",
    schemaVersion: 1,
    fields: [
      { name: "purchaseId", type: "u64" },
      { name: "materialId", type: "bytes32Hex" },
      { name: "recipient", type: "address" },
      { name: "role", type: "symbol" },
      { name: "asset", type: "any" },
      { name: "amount", type: "any" },
    ],
  },
  "escrow.funded": {
    contract: "trustlessWork",
    schemaVersion: 1,
    fields: [
      { name: "escrowId", type: "bytes32Hex" },
      { name: "engager", type: "address" },
      { name: "amount", type: "i128" },
      { name: "asset", type: "address" },
    ],
  },
  "escrow.released": {
    contract: "trustlessWork",
    schemaVersion: 1,
    fields: [
      { name: "escrowId", type: "bytes32Hex" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "i128" },
    ],
  },
  "escrow.refunded": {
    contract: "trustlessWork",
    schemaVersion: 1,
    fields: [
      { name: "escrowId", type: "bytes32Hex" },
      { name: "engager", type: "address" },
      { name: "amount", type: "i128" },
    ],
  },
  "escrow.disputed": {
    contract: "trustlessWork",
    schemaVersion: 1,
    fields: [
      { name: "escrowId", type: "bytes32Hex" },
      { name: "engager", type: "address" },
      { name: "reason", type: "string" },
    ],
  },
  "milestone.approved": {
    contract: "trustlessWork",
    schemaVersion: 1,
    fields: [
      { name: "escrowId", type: "bytes32Hex" },
      { name: "milestoneId", type: "u64" },
      { name: "approver", type: "address" },
    ],
  },
});

/** `topic[0]:topic[1]` -> schema key, e.g. `"material:registered"` -> `"material.registered"`. */
export function schemaKeyForTopics(topic0, topic1) {
  const key = `${topic0}.${topic1}`;
  return Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, key) ? key : null;
}

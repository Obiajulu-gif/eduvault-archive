# Purchase & Entitlement Flow Architecture

To solve Issue #10, EduVault implements a hybrid Web3 approach that bridges on-chain payments with off-chain entitlement enforcement.

## Boundaries: On-Chain vs Off-Chain

### On-Chain (Stellar Network)
* **Value Transfer**: The actual payment from the buyer to the seller occurs securely on the Stellar network (or Soroban if using a custom token).
* **Cryptographic Proof**: The resulting transaction hash serves as the immutable proof of payment.

### Off-Chain (EduVault Backend & MongoDB)
* **Entitlement Record**: The `/api/purchase` endpoint records the wallet address, material ID, and transaction hash in MongoDB.
* **Gated Delivery**: The `/api/materials/[id]/download` endpoint queries the database. The actual IPFS CID (or protected file stream) is withheld until the off-chain entitlement check passes.

## Failure States & Edge Cases Handled
1. **Missing Entitlement (403)**: If a user tries to hit the download endpoint without a confirmed purchase record, access is explicitly denied.
2. **Missing Address (401)**: If a request lacks a wallet address payload, it is rejected.
3. **Duplicate Purchases**: The system idempotently catches duplicate purchase submissions and returns the existing entitlement instead of crashing or double-charging.

## Future Production Enhancements
Currently, the prototype relies on the client submitting the transaction hash to the backend. For a fully trustless production system, the `/api/purchase` endpoint should be upgraded to use the Stellar Horizon SDK to verify the transaction payload mathematically (verifying the `amount`, `destination`, and `asset`) before generating the entitlement.

## Receipt Provenance Bundles (Issue #679)

Learners and auditors need a receipt that ties material version, creator,
payment asset, transaction hash, entitlement state, and refund status into a
deterministic bundle that can be re-verified at any later time. This is
provided by `src/lib/purchases/receiptProvenance.js`.

### Schema

Every receipt is a canonical, self-describing bundle:

```json
{
  "schemaVersion": "1.0.0",
  "purpose": "purchase-receipt-provenance",
  "purchase": {
    "purchaseId": "...",
    "materialId": "...",
    "materialVersion": "v2.3.0",
    "creator": "GDQX...",
    "buyer": "GBCB...",
    "asset": "native | USDC:issuer",
    "amount": "250.0000000",
    "transactionHash": "cafebabe...",
    "entitlementState": "finalized",
    "refundStatus": "none | requested | refunded",
    "issuedAt": "2026-08-28T..."
  }
}
```

### Generation

`createReceiptProvenanceBundle()` produces the bundle plus a SHA-256
`receiptHash` over a canonical serialization (keys sorted recursively), so the
same underlying purchase always yields the same bundle + hash. Generate it when
a purchase is confirmed and when a refund contacts the entitlement state, so
refunded receipts differ from the original.

### Verification

`verifyReceiptProvenanceBundle({ bundle, hash })` recomputes the canonical hash
and confirms it matches using a constant-time comparison. Any field changed
after issuance (material version bump, refund status flip, altered tx hash)
breaks the bundle and verification fails.

### Tests

`tests/backend/receipt-provenance.test.mjs` covers generation, determinism,
re-verification, tamper detection (version bump + refund flip), canonical
key-order independence, and required-field enforcement.
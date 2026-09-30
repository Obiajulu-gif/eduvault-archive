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

## Creator Revenue State Model

The creator revenue dashboard separates earnings into distinct lifecycle states to match purchase and payout events:
- **Pending**: Purchases recorded but settlement is still in progress (escrowed or awaiting finalization).
- **Settled**: Funds distributed to the creator's wallet.
- **Refunded**: Funds returned to the buyer.
- **Disputed**: Funds held in custody pending dispute resolution.
- **Fees**: The platform fee portion deducted from gross sales.

These buckets aggregate purchase, refund, and payout events to ensure totals reconcile properly for creator exports.

## Future Production Enhancements
Currently, the prototype relies on the client submitting the transaction hash to the backend. For a fully trustless production system, the `/api/purchase` endpoint should be upgraded to use the Stellar Horizon SDK to verify the transaction payload mathematically (verifying the `amount`, `destination`, and `asset`) before generating the entitlement.

## Concurrency & Idempotency Strategy (Issue #10)

Critical mutation paths in the purchase and entitlement flow are protected by
deterministic locking plus idempotency keys so that concurrent requests cannot
produce duplicate or inconsistent records.

### Protected Mutation Paths
* **`POST /api/purchase`** — creates the entitlement record and (on success) the
  receipt provenance bundle. Vulnerable to duplicate submissions from retries,
  double-clicks, or parallel tabs.
* **`POST /api/purchase/:id/refund`** — flips `refundStatus` and re-issues the
  receipt bundle. Vulnerable to concurrent refund requests racing the same
  purchase.
* **`POST /api/disputes`** — transitions a purchase into a dispute lifecycle.
  Vulnerable to two disputes being opened for the same purchase.

### Locking Model
* Each mutation acquires a **per-resource lock** keyed by a deterministic
  identifier (`purchase:{buyer}:{materialId}` for purchases,
  `refund:{purchaseId}` for refunds, `dispute:{purchaseId}` for disputes).
* Locks are implemented as an in-process async mutex for the prototype and are
  designed to be swapped for a MongoDB unique-index + `findOneAndUpdate`
  compare-and-set in production.
* The lock is held only for the duration of the read-modify-write critical
  section; network I/O is performed inside the section to guarantee that the
  entitlement record and receipt bundle are written atomically from the
  caller's perspective.

### Idempotency
* Every mutation accepts an `Idempotency-Key` header. The key is stored
  alongside the resulting record. A repeated request with the same key returns
  the previously created record unchanged instead of creating a new one.
* Duplicate purchase retries therefore return the existing entitlement and the
  same `receiptHash`; they never create a second irreversible record.
* Refund and dispute mutations are idempotent on `(purchaseId, targetState)`:
  replaying a refund that already reached `refunded` is a no-op.

### Timeout Behavior
* Mutations that exceed the configured lock-acquisition timeout (default
  `LOCK_TIMEOUT_MS = 5000`) fail fast with `409 Conflict` and a
  `retryable: true` body, rather than blocking indefinitely or partially
  writing state.
* If the critical section is interrupted after the entitlement write but before
  the receipt bundle write, the next request with the same idempotency key
  repairs the missing bundle deterministically.

### Tests
`tests/backend/purchase-concurrency.test.mjs` exercises the mutation paths with
simultaneous success, conflicting requests, duplicate retries, and timeout
scenarios, asserting that domain invariants hold and no duplicate irreversible
records are created.

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

## Dispute Evidence Bundles (#709)

Disputes raised against purchases require structured evidence bundles (`DisputeEvidenceBundle`) containing buyer claims, creator metadata, purchase transaction proof, access logs, and entitlement state. The dispute lifecycle moves through `opened` -> `reviewing` -> `approved`/`denied` -> `executed`, ensuring refund authorizations reference valid approved dispute states.

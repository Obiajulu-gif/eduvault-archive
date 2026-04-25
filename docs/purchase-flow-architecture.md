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
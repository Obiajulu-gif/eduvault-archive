# Migration Path: EVM Entitlement Records to Soroban (Issue #756)

## 1. Executive Summary & Objective

EduVault is transitioning its payment settlement and access authorization architecture from the legacy/archived EVM prototype to Stellar Soroban smart contracts (`material-registry` and `purchase-manager`).

The primary challenge of this migration is that EVM and Stellar/Soroban are heterogeneous blockchains with distinct cryptography (Secp256k1 vs. Ed25519), different address schemas (`0x...` 20-byte hex vs. `G...` 56-character Strkey format), and no native cross-chain state bridge.

This migration plan defines how:
1. **Existing EVM-based purchase history and entitlement records remain permanently honored** with zero migration cost or re-claim actions required from historical buyers.
2. **All new purchases route directly to Soroban contracts** without breaking or modifying existing catalog listings.
3. **Dual-Read Entitlement Abstraction** governs access control during and after the migration.
4. **Cutover sequence and automated rollback triggers** ensure zero downtime and safeguard in-flight checkouts.

---

## 2. Architectural Strategy: Dual-Read Entitlement Abstraction

Rather than attempting an expensive, risk-prone on-chain attestation/porting of historical records into Soroban storage, EduVault utilizes an application-level **Dual-Read Entitlement Abstraction** (`DualReadEntitlementProvider` and `resolveEntitlement`).

```
                              +--------------------------------+
                              |      Access / Download Route   |
                              |   (/api/download, /api/access) |
                              +---------------+----------------+
                                              |
                                              v
                              +--------------------------------+
                              |   Unified Entitlement Policy   |
                              |       resolveEntitlement()     |
                              +---------------+----------------+
                                              |
                                              v
                              +--------------------------------+
                              |   DualReadEntitlementProvider  |
                              +---------------+----------------+
                                              |
                     +------------------------+------------------------+
                     | (Primary Check)                                 | (Fallback Check)
                     v                                                 v
       +----------------------------+                    +----------------------------+
       | SorobanEntitlementProvider |                    |   EvmEntitlementProvider   |
       +--------------+-------------+                    +--------------+-------------+
                      |                                                 |
         +------------+------------+                                    |
         |                         |                                    |
         v                         v                                    v
+------------------+     +------------------+                 +--------------------+
| MongoDB Purchases|     | Soroban RPC      |                 | MongoDB Purchases  |
| (chain='soroban')|     | (getContractData)|                 | (chain='evm' /     |
|                  |     |                  |                 | legacy records)    |
+------------------+     +------------------+                 +--------------------+
```

### Governing Rules:
1. **Primary Authority (Soroban):** All new purchases executed on or after the cutover date are settled on Stellar/Soroban, recorded in MongoDB with `chain: 'soroban'`, and verified via the Soroban provider.
2. **Read-Only Legacy Authority (EVM):** Historical purchases recorded under the EVM prototype (`chain: 'evm'`, `0x...` buyer addresses, or legacy EVM tx hashes) are evaluated via the `EvmEntitlementProvider`.
3. **Revocation Precedence:** If an entitlement is in a terminal revoked/refunded/disputed state on either path, access is immediately denied (`state: 'REVOKED'`). A legacy check will never re-grant access to an entitlement that has been revoked or refunded.
4. **Deny-by-Default (Fail Closed):** Any database or RPC errors produce `UNAVAILABLE` (deny access), preventing unauthorized content release.

---

## 3. Preservation of Existing Listings & Catalog Records

1. **Chain-Agnostic Listings:** The `materials` collection in MongoDB stores material metadata independently of the blockchain settlement layer (`title`, `price`, `description`, `storageKey`/`ipfsCid`, `usageRights`).
2. **Zero Listing Changes:** Existing published listings require no updates, no re-uploading to IPFS, and no creator intervention.
3. **Transparent Checkout Routing:** When a learner initiates a checkout for any listing (whether created before or after cutover), the checkout engine generates a Stellar Soroban purchase quote locking in current price and terms.

---

## 4. Multi-Chain Address & Session Handling

| Dimension | Legacy EVM Path | Soroban Path |
| :--- | :--- | :--- |
| **Address Format** | `0x[a-fA-F0-9]{40}` (Secp256k1) | `G[A-Z2-7]{55}` (Ed25519 Strkey) |
| **Normalization** | `address.trim().toLowerCase()` | `address.trim().toUpperCase()` |
| **Signature Scheme** | EIP-191 / Personal Sign | SEP-0010 Stellar Web Auth |
| **Entitlement Key** | `materialId + buyerAddressLower` | `materialId + buyerAddressUpper` |
| **Purchase Record** | `chain: 'evm'` | `chain: 'soroban'` |

---

## 5. Phased Cutover Sequence

### Phase 1: Pre-Cutover Verification & Dual-Read Activation
* Deploy `DualReadEntitlementProvider` as the default access provider.
* Run backward-compatibility test suite against historical EVM fixture purchases and ensure 100% pass rate.
* Verify entitlement cache invalidation and bounded TTL functionality.

### Phase 2: Soroban Contract Deployment & Verification
* Deploy `material-registry` and `purchase-manager` contracts to Stellar network.
* Verify contract IDs in environment configurations (`SOROBAN_ENTITLEMENT_CONTRACT_ID`, `PURCHASE_MANAGER_CONTRACT_ID`).
* Conduct end-to-end checkout smoke test on testnet.

### Phase 3: Transaction Routing Switch (Cutover)
* Update `src/app/api/checkout/initiate` and `src/app/api/purchase` to emit Soroban contract invocation payloads.
* In-flight checkout quotes created prior to cutover are allowed to complete within their 10-minute TTL window (`checkout_quotes.expiresAt`).
* Lock EVM purchase endpoint: disable creation of new EVM checkout intents while keeping verification endpoints live.

### Phase 4: Post-Cutover Monitoring & Stability Window
* Monitor RPC latency and error rates via Stellar indexer and telemetry.
* Monitor download verification success rates across both legacy EVM buyers and new Soroban buyers.

---

## 6. Rollback Triggers & Recovery Procedures

If unexpected issues occur during Soroban checkout or settlement, the system follows this automated rollback runbook:

| Trigger Metric | Threshold | Action |
| :--- | :--- | :--- |
| **Soroban RPC Outage** | 3 consecutive failures over 60s | Switch checkout engine to provisional reservation grace mode |
| **Settlement Transaction Errors** | > 5% failure rate over 15 min | Pause new Soroban checkout initiations; surface maintenance banner |
| **Entitlement Verification Fault** | Dual-read resolution latency > 2500ms | Bypass live RPC queries and rely on bounded TTL cache + MongoDB purchases mirror |

> [!NOTE]
> **Rollback Safety:** Rollback of the checkout gateway to maintenance mode **never** disrupts or revokes existing read access for either EVM or Soroban buyers, as `DualReadEntitlementProvider` continues reading historical and confirmed purchases from the database.

---

## 7. Governance Matrix: Which Path Governs Which Purchases

| Purchase Scenario | Settlement Path | Entitlement Provider | Access Governance |
| :--- | :--- | :--- | :--- |
| **Purchased prior to cutover (EVM)** | Archived EVM Prototype | `EvmEntitlementProvider` | Read-only from MongoDB `purchases` record; honored indefinitely |
| **Purchased on or after cutover** | Soroban Smart Contract | `SorobanEntitlementProvider` | Live Soroban contract data + indexed MongoDB purchase records |
| **Refunded / Disputed legacy purchase** | Archived DB Settlement | `DualReadEntitlementProvider` | State `REVOKED`; access blocked immediately |
| **Free / Public educational materials** | Off-chain | Static Authorization | Granted to all users regardless of chain or wallet |

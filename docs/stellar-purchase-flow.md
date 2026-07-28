# Stellar/Soroban Purchase & Entitlement Flow

This document provides a detailed sequence diagram for the checkout and entitlement flow in EduVault's Stellar-native architecture.

## Overview

The purchase flow bridges a browser-based wallet interaction with on-chain Soroban settlement and off-chain entitlement verification. A buyer initiates checkout, signs a Stellar transaction that the `PurchaseManager` contract settles atomically, and the backend indexes the resulting event to grant or deny download access.

## Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    participant Buyer as Buyer (Browser)
    participant Wallet as Stellar Wallet
    participant FE as Next.js Frontend
    participant API as Backend API
    participant RPC as Stellar RPC
    participant PM as PurchaseManager (Soroban)
    participant MR as MaterialRegistry (Soroban)
    participant IDX as Indexer
    participant DB as MongoDB

    Note over Buyer, DB: Checkout initiation

    Buyer->>FE: Click "Buy" on material detail page
    FE->>API: POST /api/checkout { materialId, buyerAddress }
    API->>MR: get_material(materialId)
    MR-->>API: MaterialRecord (quotes, status, payoutShares)
    API-->>FE: Checkout intent (quotes, expectedAmount)

    Note over Buyer, DB: Wallet signing

    FE->>Wallet: Request transaction sign
    Wallet->>Buyer: Show transaction summary
    Buyer->>Wallet: Approve transaction

    Note over Buyer, DB: On-chain settlement

    Wallet->>RPC: Submit signed transaction
    RPC->>PM: purchase(materialId, asset, expectedAmount)
    PM->>MR: Validate material exists and is Active
    MR-->>PM: MaterialRecord confirmed
    PM->>PM: Verify buyer has no existing entitlement
    PM->>PM: Calculate platform fee and payout splits
    PM->>PM: Transfer funds to creator, treasury, payout recipients
    PM->>PM: Write EntitlementRecord (materialId, buyer, active=true)
    PM-->>RPC: Emit purchase.completed event
    RPC-->>Wallet: Transaction confirmed
    Wallet-->>FE: Transaction success

    Note over Buyer, DB: Event indexing and cache sync

    IDX->>RPC: Poll for purchase.completed events
    RPC-->>IDX: Event payload
    IDX->>DB: Upsert purchases record
    IDX->>DB: Upsert entitlement_cache record
    IDX->>DB: Append to sync_events (idempotent)

    Note over Buyer, DB: Access verification

    Buyer->>FE: Click "Download"
    FE->>API: GET /api/materials/{id}/download { buyerAddress }
    API->>DB: Check entitlement_cache
    alt Cache hit
        DB-->>API: EntitlementRecord (active=true)
    else Cache miss or stale
        API->>PM: has_entitlement(materialId, buyerAddress)
        PM-->>API: true
        API->>DB: Refresh entitlement_cache
    end
    API-->>FE: 200 OK (IPFS CID or protected file stream)
    FE->>FE: Fetch file from IPFS gateway
    FE-->>Buyer: Material delivered
```

## Flow Phases

### 1. Checkout Initiation

The frontend sends the buyer's wallet address and the material ID to the backend. The backend reads the current `MaterialRecord` from the `MaterialRegistry` contract to confirm the material is `Active`, retrieve the accepted-asset quotes, and return the expected payment amount to the frontend.

### 2. Wallet Signing

The frontend constructs a Stellar transaction targeting the `PurchaseManager` contract and forwards it to the buyer's Stellar wallet (e.g., Freighter). The wallet displays a human-readable summary of the transaction, including the asset, amount, and destination, before the buyer approves.

### 3. On-Chain Settlement

`PurchaseManager.purchase()` performs the following atomically in a single Soroban transaction:

1. Validates the material exists and is `Active` via `MaterialRegistry`.
2. Confirms the selected asset is in the material's accepted-asset quotes and is globally allowed.
3. Verifies the buyer does not already hold an active entitlement for this material.
4. Transfers the gross payment from the buyer to creator payout recipients and the platform treasury.
5. Writes an `EntitlementRecord` keyed by `(materialId, buyer)`.
6. Emits a `purchase.completed` event.

If any step fails, the entire transaction reverts. No partial state is written.

### 4. Event Indexing

The backend indexer polls Stellar RPC for `purchase.completed` events, then:

- Creates or updates a `purchases` record in MongoDB.
- Upserts an `entitlement_cache` entry for fast download-gate reads.
- Logs a normalized `sync_events` entry for idempotency tracking.

### 5. Download Access Gating

When a buyer requests a material download, the backend checks `entitlement_cache` for a valid entitlement. On a cache miss, it falls back to a direct `has_entitlement()` simulation call to the `PurchaseManager` contract. Only confirmed entitlement holders receive the IPFS CID or protected file stream.

## Failure States

| State | HTTP Status | Description |
| --- | --- | --- |
| No wallet connected | 401 | Buyer address is missing from the request |
| Material not active | 400 | Material is paused or archived |
| Stale price | 400 | Transaction amount does not match current contract quote |
| Duplicate purchase | 200 | Entitlement already exists; returns existing entitlement |
| Contract simulation error | 500 | Soroban RPC or contract call failure |
| Download without entitlement | 403 | No active entitlement found on-chain or in cache |

## Related Documentation

- [Architecture](architecture.md)
- [Soroban Contract Architecture](soroban-contract-architecture.md)
- [Purchase Flow Architecture](purchase-flow-architecture.md)
- [Stellar Integration Guide](stellar-integration.md)

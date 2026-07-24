# Migration Guide: ERC-721 to Soroban

This guide outlines the conceptual and technical shifts required when migrating the EduVault platform from the legacy EVM ERC-721 prototype to the Stellar-native architecture using Soroban smart contracts.

## Conceptual Shifts

### 1. From NFTs to Entitlements
In the legacy EVM prototype, access rights were represented by non-fungible tokens (ERC-721). Users proved access by demonstrating ownership of a token via `ownerOf` or `balanceOf`. 

In the Soroban architecture, we use a more direct **entitlement model**. The `PurchaseManager` contract records discrete `PurchaseEvent` and `EntitlementRecord` entries. A user's right to access content is proven by the existence of an entitlement record tying their address to the specific material ID.

### 2. From TokenURIs to MaterialRegistry
The ERC-721 contract stored a `tokenURI` pointing to IPFS metadata. 
In Soroban, we have introduced the `MaterialRegistry` contract. Instead of minting a token, creators register a `MaterialRecord`. This record securely binds:
- The immutable IPFS metadata hash and URI
- The creator's Stellar address
- The accepted payment assets (e.g., XLM, USDC)
- The required purchase quotes (prices)
- Configurable payout shares for revenue distribution

### 3. Payment Routing
EVM payments typically involved `msg.value` (native ETH/Celo) or standard ERC-20 transfers.
The Soroban `PurchaseManager` is designed around the Stellar Asset Contract (SAC). It explicitly supports native XLM, stablecoins like USDC, and even creator-issued tokens. When a purchase occurs, the contract automatically divides and routes the payment to the platform treasury and to all creator payout shares in a single transaction.

## Integration Changes for the Backend Indexer

1. **Event Listening**: Instead of indexing EVM `Transfer` logs, the backend indexer must now listen for Soroban events emitted by the `PurchaseManager` (e.g., `purchase.completed`).
2. **Entitlement State**: The backend indexer creates a denormalized cache (`entitlement_cache`) based on these Soroban events. When the frontend requests a material download, the backend queries this MongoDB cache rather than making synchronous RPC calls to a blockchain.
3. **Immutability**: Since materials are registered via `MaterialRegistry` (with a `RightsHash` and `MetadataHash`), backend validations can confidently rely on the material's data integrity.

## Deprecated Components
- `EduVaultAbi.js` and all associated wagmi/ethers.js frontend hooks.
- EVM wallet connection flows (replaced by Stellar wallet integrations such as Freighter).
- Solidity smart contracts (`contracts/EduVault.sol`) and their respective hardhat test suites (`tests/legacy-evm/`).

## Conclusion
This migration fully aligns EduVault with its strategic goals: low-cost, cross-border payments combined with a scalable, event-driven entitlement system. By moving off the NFT paradigm into a specialized Soroban architecture, the platform can support complex creator payouts and stablecoin integrations natively.

# MaterialRegistry Soroban Contract - Deployment Guide

## Overview

The MaterialRegistry contract is a Soroban smart contract designed to handle the registration and metadata management of educational materials on the Stellar network. This document provides comprehensive instructions for deploying the contract to the Stellar Testnet.

## Prerequisites

Before deploying, ensure you have the following installed:

1. **Rust toolchain** (1.70.0 or later):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **Soroban CLI**:
   ```bash
   cargo install --locked soroban-cli --version 25.3.1
   ```

3. **Stellar Account**:
   - Create a funded testnet account at https://laboratory.stellar.org/
   - Or use the Stellar CLI:
     ```bash
     soroban config identity generate --global <identity-name>
     ```

4. **Environment Variables**:
   Set up your Stellar account details:
   ```bash
   export SOROBAN_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
   export SOROBAN_RPC_HOST="https://soroban-testnet.stellar.org"
   ```

## Building the Contract

### Step 1: Build the WASM Binary

Navigate to the Soroban contracts directory:

```bash
cd soroban
cargo build --target wasm32-unknown-unknown --release
```

This generates the compiled contract at:
```
target/wasm32-unknown-unknown/release/material_registry.wasm
```

### Step 2: Optimize the WASM Binary (Optional but Recommended)

To reduce contract size and improve gas efficiency, optimize the compiled binary:

```bash
soroban contract optimize --wasm target/wasm32-unknown-unknown/release/material_registry.wasm
```

The optimized contract will be saved as:
```
material_registry_optimized.wasm
```

## Deploying to Stellar Testnet

### Step 1: Set Up Your Identity

Create or use an existing Soroban CLI identity:

```bash
# Create a new identity
soroban config identity generate --global eduvault-deployer

# Or use an existing one
soroban config identity use --global eduvault-deployer
```

Fund your identity with testnet lumens:
```bash
# Get your public key
soroban config identity show --global eduvault-deployer

# Visit https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY> to fund it
```

### Step 2: Deploy the Contract

Deploy the optimized contract to Stellar Testnet:

```bash
soroban contract deploy \
  --wasm material_registry_optimized.wasm \
  --source eduvault-deployer \
  --network testnet
```

**Output Example:**
```
Deployed contract successfully.
Contract ID: CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5C
```

Save the Contract ID for later use.

### Step 3: Verify Deployment

Verify the contract is deployed correctly:

```bash
soroban contract inspect \
  --id CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5C \
  --network testnet
```

## Contract Functions Reference

### 1. Register Material

Registers a new educational material in the contract.

**Function Signature:**
```rust
pub fn register_material(
    env: Env,
    creator: Address,
    metadata_uri: String,
    metadata_hash: BytesN<32>,
    rights_hash: BytesN<32>,
    quotes: Vec<AssetQuote>,
    payout_shares: Vec<PayoutShare>,
) -> Result<BytesN<32>, RegistryError>
```

**Parameters:**
- `creator`: The Stellar address of the material creator (must authorize)
- `metadata_uri`: IPFS CID URI pointing to the material's metadata (max 256 bytes)
- `metadata_hash`: SHA-256 hash of the metadata content (32 bytes)
- `rights_hash`: SHA-256 hash of the usage rights/licensing terms (32 bytes)
- `quotes`: Vector of asset quotes (pricing in different assets - max 4)
  - Each quote includes:
    - `asset`: Stellar address of the asset (XLM, USDC, etc.)
    - `amount`: Price in the smallest unit of the asset
- `payout_shares`: Vector of payout recipients and their shares (max 5 recipients)
  - Each share includes:
    - `recipient`: Stellar address of the payout recipient
    - `share_bps`: Share percentage in basis points (must total 10,000)

**Returns:** BytesN<32> - The unique material ID

**Example Usage:**
```bash
soroban contract invoke \
  --id CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5C \
  --source eduvault-deployer \
  --network testnet \
  -- \
  register_material \
  --creator GBRPYHIL2CI3WHZDTOOQFC6EB4AXLAND5E7DOUSPF5MGNEGHARQWAIHY \
  --metadata_uri "ipfs://bafybeiheuvbzf5wvfsjnfgd7g32efvbjl5yk3oiebw55zxyzhgwhqxpiqe" \
  --metadata_hash "0x" \
  --rights_hash "0x" \
  --quotes "[{\"asset\": \"GBUQWP3BOUZX34MANHXRX7OZJXDJHTQHQ5ONOBIYBHDSMWYPA72KQ6B6\", \"amount\": \"5000000\"}]" \
  --payout_shares "[{\"recipient\": \"GBRPYHIL2CI3WHZDTOOQFC6EB4AXLAND5E7DOUSPF5MGNEGHARQWAIHY\", \"share_bps\": \"10000\"}]"
```

### 2. Update Sale Terms

Updates the pricing quotes and payout shares for an existing material.

**Function Signature:**
```rust
pub fn update_sale_terms(
    env: Env,
    material_id: BytesN<32>,
    quotes: Vec<AssetQuote>,
    payout_shares: Vec<PayoutShare>,
) -> Result<(), RegistryError>
```

**Parameters:**
- `material_id`: ID of the material to update (from register_material response)
- `quotes`: Updated asset quotes
- `payout_shares`: Updated payout distributions

### 3. Set Material Status

Changes the status of a material (Active, Paused, or Archived).

**Function Signature:**
```rust
pub fn set_material_status(
    env: Env,
    material_id: BytesN<32>,
    status: MaterialStatus,
) -> Result<(), RegistryError>
```

**Status Options:**
- `Active (0)`: Material is available for purchase
- `Paused (1)`: Material is temporarily unavailable
- `Archived (2)`: Material is archived

### 4. Get Material

Retrieves the complete information for a registered material.

**Function Signature:**
```rust
pub fn get_material(
    env: Env,
    material_id: BytesN<32>,
) -> Result<MaterialRecord, RegistryError>
```

**Returns:** MaterialRecord with all material details

### 5. Get Quote

Retrieves the price quote for a specific material and asset.

**Function Signature:**
```rust
pub fn get_quote(
    env: Env,
    material_id: BytesN<32>,
    asset: Address,
) -> Result<Option<AssetQuote>, RegistryError>
```

**Returns:** AssetQuote if available, None if no quote exists for that asset

## Testing Locally

Before deploying to testnet, test the contract locally:

```bash
cd soroban
cargo test --lib
```

**Test Coverage:**
- Material registration with events
- Duplicate quote asset rejection
- Invalid payout share sum rejection
- Duplicate material ID rejection
- Creator authorization requirements
- Sale terms updates
- Status changes
- Quote lookup functionality

## Error Codes

The contract returns the following error codes:

| Code | Error | Description |
|------|-------|-------------|
| 1 | EmptyMetadataUri | Metadata URI is empty |
| 2 | MetadataUriTooLong | Metadata URI exceeds 256 bytes |
| 3 | EmptyQuotes | No quotes provided |
| 4 | TooManyQuotes | More than 4 quotes provided |
| 5 | DuplicateQuoteAsset | Same asset used in multiple quotes |
| 6 | InvalidQuoteAmount | Quote amount is not positive |
| 7 | EmptyPayoutShares | No payout shares provided |
| 8 | TooManyPayoutShares | More than 5 payout recipients |
| 9 | DuplicatePayoutRecipient | Same recipient appears in multiple shares |
| 10 | InvalidPayoutShare | Payout share is 0 basis points |
| 11 | InvalidPayoutShareSum | Payout shares don't sum to 10,000 basis points |
| 12 | MaterialAlreadyExists | Material ID collision (extremely rare) |
| 13 | MaterialNotFound | Material ID doesn't exist |

## Gas Estimation

Typical gas costs for Stellar Testnet operations:

- **register_material**: 5,000-7,000 lumens
- **update_sale_terms**: 2,000-3,000 lumens
- **set_material_status**: 1,500-2,000 lumens
- **get_material**: Free (read-only)
- **get_quote**: Free (read-only)

## Data Storage

The contract uses persistent storage:
- **Creator Nonce**: Tracks how many materials each creator has registered (for ID uniqueness)
- **Material Records**: Complete material information indexed by material ID

Storage is retained indefinitely unless the contract is updated.

## Security Considerations

1. **Creator Authorization**: All registration and updates require the creator's signature
2. **Immutable Metadata Hash**: Once registered, the metadata hash cannot be changed
3. **Rights Hash**: Ensures licensing terms are part of the contract record
4. **Basis Points Validation**: Ensures all payout shares sum to exactly 100% (10,000 basis points)
5. **Asset Uniqueness**: Prevents duplicate pricing for the same asset

## Contract Events

The contract emits the following events:

### MaterialRegisteredEvent
Emitted when a new material is registered.
- Topics: `["material", "registered", material_id, creator]`
- Data: `[metadata_uri, metadata_hash, rights_hash, status, quotes, payout_shares]`

### MaterialSaleTermsUpdatedEvent
Emitted when sale terms are updated.
- Topics: `["material", "sale_terms_updated", material_id, creator]`
- Data: `[status, quotes, payout_shares]`

### MaterialStatusUpdatedEvent
Emitted when material status changes.
- Topics: `["material", "status_updated", material_id, creator]`
- Data: `[status]`

## Mainnet Deployment

To deploy to Stellar Mainnet:

1. Update environment variables:
   ```bash
   export SOROBAN_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
   export SOROBAN_RPC_HOST="https://soroban-mainnet.stellar.org"
   ```

2. Use mainnet identity (with real lumens):
   ```bash
   soroban contract deploy \
     --wasm material_registry_optimized.wasm \
     --source mainnet-identity \
     --network mainnet
   ```

3. Consider:
   - Gas costs will be real (use actual lumens)
   - Thoroughly test on testnet first
   - Keep the Contract ID secure
   - Monitor contract performance

## Troubleshooting

### Contract Not Deploying
- Verify account is funded with enough lumens
- Check network connectivity to RPC endpoint
- Ensure WASM binary is properly optimized

### Transaction Failing
- Verify creator has authorization
- Check payout shares sum to 10,000 basis points
- Ensure metadata URI doesn't exceed 256 bytes
- Verify asset addresses are valid Stellar addresses

### Events Not Appearing
- Check that the transaction succeeded
- Confirm network RPC supports event queries
- Verify Soroban CLI version matches network

## Additional Resources

- [Soroban Documentation](https://developers.stellar.org/learn/soroban)
- [Stellar Testnet](https://stellar.expert/explorer/testnet/)
- [Soroban CLI Reference](https://developers.stellar.org/tools/soroban-cli)
- [EduVault Documentation](./backend-contracts.md)

## Support

For issues or questions about the MaterialRegistry contract, please:
1. Check the troubleshooting section above
2. Review contract tests in `soroban/contracts/material-registry/src/test.rs`
3. Open an issue in the EduVault repository

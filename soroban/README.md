# MaterialRegistry Soroban Contract

This directory contains the Soroban smart contract implementation for the EduVault platform. The MaterialRegistry contract manages the registration and metadata of educational materials on the Stellar blockchain.

## Overview

The MaterialRegistry contract provides a decentralized registry for educational materials with the following features:

- **Material Registration**: Register new educational materials with unique IDs
- **Metadata Management**: Store IPFS CIDs and content hashes
- **Flexible Pricing**: Support multiple asset prices (XLM, USDC, etc.)
- **Creator Attribution**: Secure creator identification and authentication
- **Usage Rights**: Store and verify licensing terms
- **Payout Distribution**: Support multiple payout recipients

## Project Structure

```
soroban/
├── Cargo.toml                           # Workspace configuration
├── build.sh                             # Build script
├── run-tests.sh                         # Test runner script
├── contracts/
│   └── material-registry/
│       ├── Cargo.toml                   # Contract package configuration
│       └── src/
│           ├── lib.rs                   # Main contract implementation
│           └── test.rs                  # Contract unit tests
```

## Prerequisites

Before you can build and test the contract, ensure you have:

1. **Rust 1.70.0 or later**:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup update
   ```

2. **WebAssembly target**:
   ```bash
   rustup target add wasm32-unknown-unknown
   ```

3. **Soroban CLI** (for deployment):
   ```bash
   cargo install --locked soroban-cli --version 25.3.1
   ```

## Quick Start

### Build the Contract

```bash
# Using the provided build script (recommended)
./build.sh

# Or manually
cargo build --target wasm32-unknown-unknown --release
```

### Run Tests

```bash
# Using the provided test script (recommended)
./run-tests.sh

# Or manually
cargo test --lib
```

### Deploy to Testnet

See [SOROBAN_DEPLOYMENT.md](../docs/SOROBAN_DEPLOYMENT.md) for comprehensive deployment instructions.

## Contract Architecture

### Core Data Structures

#### MaterialRecord
Represents a registered educational material with:
- `material_id`: Unique identifier (BytesN<32>)
- `creator`: Creator's Stellar address
- `metadata_uri`: IPFS URI of the material metadata
- `metadata_hash`: SHA-256 hash of the metadata
- `rights_hash`: SHA-256 hash of usage rights
- `status`: Current status (Active, Paused, Archived)
- `quotes`: Price quotes in different assets (max 4)
- `payout_shares`: Distribution of proceeds (max 5 recipients)
- `created_ledger`: Ledger number when registered
- `updated_ledger`: Ledger number of last update

#### AssetQuote
Pricing information for a specific asset:
- `asset`: Stellar asset address
- `amount`: Price in the smallest unit of the asset

#### PayoutShare
Distribution of proceeds to a recipient:
- `recipient`: Stellar address of recipient
- `share_bps`: Share in basis points (must total 10,000)

### Contract Functions

#### register_material(creator, metadata_uri, metadata_hash, rights_hash, quotes, payout_shares)
Registers a new educational material.
- **Returns**: Material ID (BytesN<32>)
- **Requires**: Creator authorization
- **Emits**: MaterialRegisteredEvent

#### update_sale_terms(material_id, quotes, payout_shares)
Updates pricing and payout information for an existing material.
- **Requires**: Creator authorization
- **Emits**: MaterialSaleTermsUpdatedEvent

#### set_material_status(material_id, status)
Changes the status of a material.
- **Requires**: Creator authorization
- **Emits**: MaterialStatusUpdatedEvent

#### get_material(material_id)
Retrieves complete information about a material.
- **Returns**: MaterialRecord
- **Read-only**: No authorization required

#### get_quote(material_id, asset)
Retrieves the price quote for a specific asset.
- **Returns**: AssetQuote or None
- **Read-only**: No authorization required

## Validation Rules

The contract enforces the following validation rules:

1. **Metadata URI**:
   - Must not be empty
   - Must not exceed 256 bytes

2. **Quotes**:
   - Must have at least 1 quote
   - Maximum 4 quotes per material
   - Each asset must be unique
   - Quote amounts must be positive

3. **Payout Shares**:
   - Must have at least 1 recipient
   - Maximum 5 recipients per material
   - Each recipient must be unique
   - Each share must be positive (> 0 basis points)
   - All shares must sum to exactly 10,000 basis points (100%)

4. **Material IDs**:
   - Generated using creator address and nonce
   - Collision detection prevents duplicates

## Events

The contract emits three types of events:

### MaterialRegisteredEvent
Published when a new material is registered.

**Topics**: `["material", "registered", material_id, creator]`

**Data**:
```rust
[metadata_uri, metadata_hash, rights_hash, status, quotes, payout_shares]
```

### MaterialSaleTermsUpdatedEvent
Published when sale terms are updated.

**Topics**: `["material", "sale_terms_updated", material_id, creator]`

**Data**:
```rust
[status, quotes, payout_shares]
```

### MaterialStatusUpdatedEvent
Published when material status changes.

**Topics**: `["material", "status_updated", material_id, creator]`

**Data**:
```rust
[status]
```

## Error Handling

The contract defines comprehensive error codes:

| Code | Error | Meaning |
|------|-------|---------|
| 1 | EmptyMetadataUri | Metadata URI cannot be empty |
| 2 | MetadataUriTooLong | Metadata URI exceeds 256 bytes |
| 3 | EmptyQuotes | At least one quote is required |
| 4 | TooManyQuotes | More than 4 quotes provided |
| 5 | DuplicateQuoteAsset | Same asset appears in multiple quotes |
| 6 | InvalidQuoteAmount | Quote amount must be positive |
| 7 | EmptyPayoutShares | At least one payout recipient is required |
| 8 | TooManyPayoutShares | More than 5 payout recipients |
| 9 | DuplicatePayoutRecipient | Same recipient in multiple shares |
| 10 | InvalidPayoutShare | Payout share must be positive |
| 11 | InvalidPayoutShareSum | Payout shares must total 10,000 basis points |
| 12 | MaterialAlreadyExists | Material ID already registered |
| 13 | MaterialNotFound | Material ID does not exist |

## Testing

The contract includes comprehensive unit tests covering:

- ✓ Material registration with event validation
- ✓ Duplicate quote asset rejection
- ✓ Invalid payout share sum rejection
- ✓ Duplicate material ID collision prevention
- ✓ Creator authorization requirements
- ✓ Sale terms updates
- ✓ Material status transitions
- ✓ Quote lookup functionality

Run tests with:
```bash
./run-tests.sh
```

## Development

### Adding New Tests

Edit `contracts/material-registry/src/test.rs` and add your test functions:

```rust
#[test]
fn my_test() {
    let env = Env::default();
    let (contract_id, client) = install_contract(&env);
    env.mock_all_auths();
    
    // Your test code here
}
```

### Modifying the Contract

Edit `contracts/material-registry/src/lib.rs` to modify contract functionality.

### Building for Production

```bash
./build.sh
```

This creates both the standard and optimized WASM binaries.

## Performance Considerations

- **Storage**: Uses persistent storage for materials and nonces
- **Gas**: Typical operations cost 1,500-7,000 lumens on testnet
- **Scalability**: No hard limits on number of materials (depends on ledger capacity)

## Security

The contract implements several security measures:

1. **Authorization**: All write operations require creator signature
2. **Immutable Metadata**: Once registered, metadata hash cannot be changed
3. **Basis Points Validation**: Prevents incorrect payout distributions
4. **Asset Uniqueness**: Prevents pricing confusion
5. **Ledger Tracking**: Records when materials are created/updated

## Deployment

For detailed deployment instructions, see [SOROBAN_DEPLOYMENT.md](../docs/SOROBAN_DEPLOYMENT.md).

### Quick Testnet Deploy

```bash
# Build the contract
./build.sh

# Set up your identity
soroban config identity generate --global eduvault-deployer

# Get testnet XLM from: https://friendbot.stellar.org/

# Deploy
soroban contract deploy \
  --wasm material_registry_optimized.wasm \
  --source eduvault-deployer \
  --network testnet
```

## Troubleshooting

### Build Fails

**Problem**: `error: target 'wasm32-unknown-unknown' not installed`

**Solution**:
```bash
rustup target add wasm32-unknown-unknown
```

**Problem**: `error: linker \`cc\` not found`

**Solution**: Install a C compiler
- Windows: Install Visual Studio Build Tools
- macOS: `xcode-select --install`
- Linux: `sudo apt install build-essential`

### Tests Fail

**Problem**: Tests won't run

**Solution**:
```bash
cargo test --lib -- --nocapture
```

## Contributing

When contributing to the MaterialRegistry contract:

1. Write tests for new features
2. Ensure all tests pass: `./run-tests.sh`
3. Follow Rust best practices and naming conventions
4. Update documentation
5. Test on Stellar Testnet before mainnet deployment

## Resources

- [Soroban Documentation](https://developers.stellar.org/learn/soroban)
- [Stellar JavaScript SDK](https://github.com/stellar/js-stellar-sdk)
- [Soroban CLI Docs](https://developers.stellar.org/tools/soroban-cli)
- [Stellar Testnet](https://stellar.expert/explorer/testnet/)

## License

MIT License - see LICENSE file in the root directory

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review test examples in `src/test.rs`
3. Open an issue on GitHub
4. Consult the main EduVault documentation

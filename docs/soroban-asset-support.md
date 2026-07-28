# Soroban Asset Support

This document describes how to register and use different asset types in EduVault's Soroban contracts for payments and access control.

## Supported Asset Types

### 1. Native (XLM)

The Stellar native asset. Always supported by default when the contract is initialized.

**Registration**: No action required — XLM is pre-enabled.

### 2. Stellar Standard Assets (USDC, EURC, etc.)

Standard Stellar Connector (SAC) wrapped tokens. This includes stablecoins like USDC and EURC.

**Registration**:

```rust
// Call register_token_asset on PurchaseManager contract
pub fn register_token_asset(
    env: Env,
    admin: Address,
    asset: Address,  // Token contract address
    enabled: bool,
) -> Result<(), PurchaseError>
```

**Example: Register USDC**

```javascript
// On Stellar testnet
const usdcAddress = "CBBD47AB2EB00A4D975253440DD55C69B7CC446D72E1E7932E4CCC72525C9238B";

await purchaseManagerContract.invoke('register_token_asset', [
  adminAddress,
  usdcAddress,
  true, // enabled
]);
```

**Benefits**:
- Low-cost stablecoin payments
- Global reach and acceptance
- No volatility risk for pricing

### 3. Creator Tokens

SAC-wrapped tokens minted and controlled by content creators. Used for exclusive access or loyalty programs.

**Registration**: Same process as standard assets, but specify `CreatorToken` kind via `set_asset_allowed`.

```rust
pub fn set_asset_allowed(
    env: Env,
    admin: Address,
    asset: Address,
    kind: AssetKind, // Set to CreatorToken
    enabled: bool,
) -> Result<(), PurchaseError>
```

### 4. Institution-Issued Access Assets

Custom SAC-wrapped tokens issued by educational institutions to grant access to their content at scale. These are particularly useful for:

- **Bulk licensing**: Institutions issue tokens to grant access to students
- **Scholarship programs**: Institutions distribute tokens as scholarships
- **Institution-specific pricing**: Different pricing tiers for different user groups
- **Access expiration**: Tokens can be programmed with time-based or usage-based expiration

**Registration**:

```rust
pub fn register_institution_asset(
    env: Env,
    admin: Address,
    asset: Address,  // Institution-issued token contract
    enabled: bool,
) -> Result<(), PurchaseError>
```

**Example: Register Institution Asset**

```javascript
const institutionTokenAddress = "CAAAA...";

await purchaseManagerContract.invoke('register_institution_asset', [
  adminAddress,
  institutionTokenAddress,
  true, // enabled
]);
```

**Key Features**:
- Institutions have full control over token supply and distribution
- Can implement custom access logic (time-limited, usage-limited, role-based)
- Enables institution-specific marketplace features
- Reduces friction for institutional bulk purchases

## Purchase Flow

Once an asset is registered, the standard purchase flow supports it:

1. Creator lists material with pricing in supported assets
2. Buyer selects preferred asset for payment
3. Backend verifies asset is registered via `is_asset_allowed`
4. Contract processes payment and records entitlement
5. Buyer gains access to material

## Asset Configuration

### Enabling/Disabling Assets

```rust
pub fn set_asset_allowed(
    env: Env,
    admin: Address,
    asset: Address,
    kind: AssetKind,
    enabled: bool,
) -> Result<(), PurchaseError>
```

Set `enabled: false` to temporarily pause payments in an asset without deleting its registration.

### Querying Asset Status

```rust
pub fn get_asset_info(env: Env, asset: Address) -> Option<AssetInfo>

pub fn is_asset_allowed(env: Env, asset: Address) -> bool
```

## TTL Management

Registered assets have a Stellar ledger TTL (Time-To-Live). The contract automatically extends asset registrations when their TTL drops below 50% of the network maximum. Operators can also manually trigger TTL extension:

```rust
pub fn extend_allowed_asset_ttl(env: Env, cursor: u64, limit: u32) -> u64
```

See [TTL Operations](ttl-operations.md) for details.

## Best Practices

### For USDC Payments

1. **Use stable pricing**: Quote prices in USDC to avoid volatility
2. **Enable testnet first**: Verify on Stellar testnet before mainnet
3. **Monitor adoption**: Track which assets buyers prefer
4. **Plan migrations**: If switching assets, grandfather existing purchases

### For Institution Assets

1. **Verify token contracts**: Ensure token contracts implement SAC correctly
2. **Test access logic**: Verify institution-specific access rules work
3. **Document policies**: Clearly communicate token expiration and usage terms
4. **Monitor supply**: Track institution token distribution and recirculation

## Testing

See [`soroban/tests/`](../soroban/tests/) for integration tests covering:

- USDC payment flows
- Institution asset registration
- Multi-asset purchase scenarios
- Asset enable/disable operations
- TTL renewal for assets

## Troubleshooting

**"Asset not allowed"**: Asset is not registered. Call `register_token_asset` or `register_institution_asset`.

**"Invalid asset kind"**: Asset kind value is outside the valid range [0..3].

**"Already initialized"**: Asset already registered. Call `set_asset_allowed` to update it.

**TTL expired**: Asset registration expired on-ledger. Call `extend_allowed_asset_ttl` to renew.

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
    IntoVal, Symbol, Vec,
};

const BASIS_POINTS: u32 = 10_000;
const MAX_PLATFORM_FEE_BPS: u32 = 1_000;

/// Material status from registry (replicated here to avoid circular deps)
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaterialStatus {
    Active = 0,
    Paused = 1,
    Archived = 2,
}

/// Classification of a Stellar asset accepted by the purchase manager.
///
/// Must be kept in sync with `AssetKind` in the material-registry contract.
///
/// - `Native`      – XLM (Stellar native asset via its SAC).
/// - `Token`       – SAC-wrapped token (e.g. USDC, EURC).
/// - `CreatorToken`– Creator-specific SAC token.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssetKind {
    Native = 0,
    Token = 1,
    CreatorToken = 2,
}

/// Allowlist record stored for each approved payment asset.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetInfo {
    pub kind: AssetKind,
    pub enabled: bool,
}

/// Asset quote structure from registry
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetQuote {
    pub asset: Address,
    pub amount: i128,
}

/// Payout share structure from registry
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutShare {
    pub recipient: Address,
    pub share_bps: u32,
}

/// Material record structure (minimal fields needed from registry)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialRecord {
    pub material_id: BytesN<32>,
    pub creator: Address,
    pub status: MaterialStatus,
    pub quotes: Vec<AssetQuote>,
    pub payout_shares: Vec<PayoutShare>,
}

/// Platform configuration stored in PurchaseManager
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformConfig {
    pub registry: Address,
    pub treasury: Address,
    pub platform_fee_bps: u32,
    pub paused: bool,
    /// Optional price-oracle address for future cross-asset conversion support.
    /// When `None`, no oracle is configured and all prices must be quoted in
    /// the exact accepted asset (no conversion).
    pub oracle: Option<Address>,
}

/// Entitlement record for a successful purchase
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntitlementRecord {
    pub material_id: BytesN<32>,
    pub buyer: Address,
    pub active: bool,
    pub purchase_id: u64,
    pub asset: Address,
    pub amount: i128,
    pub granted_ledger: u32,
}

/// Data keys for contract storage
#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    PlatformConfig,
    AllowedAsset(Address),
    PurchaseNonce,
    Entitlement((BytesN<32>, Address)),
}

/// Contract errors
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PurchaseError {
    // Initialization errors
    AlreadyInitialized = 1,
    InvalidPlatformFee = 2,

    // Purchase validation errors
    ContractPaused = 10,
    MaterialNotActive = 11,
    AssetNotAllowed = 12,
    InvalidQuoteAmount = 13,
    AssetNotAcceptedForMaterial = 14,
    EntitlementAlreadyExists = 15,

    // Payout errors
    PayoutTransferFailed = 20,
    InvalidPayoutShares = 21,

    // Registry errors
    RegistryCallFailed = 30,
    MaterialNotFound = 31,

    // Admin errors
    NotAuthorized = 40,
    InvalidTreasury = 41,
    UpgradeFailed = 42,
}

/// Event: purchase.completed
#[contractevent(topics = ["purchase", "completed"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PurchaseCompletedEvent {
    #[topic]
    pub purchase_id: u64,
    #[topic]
    pub material_id: BytesN<32>,
    #[topic]
    pub buyer: Address,
    pub seller: Address,
    pub asset: Address,
    pub amount: i128,
    pub platform_fee: i128,
    pub seller_net_amount: i128,
    pub entitlement_active: bool,
}

/// Event: payout.distributed
#[contractevent(topics = ["payout", "distributed"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutDistributedEvent {
    #[topic]
    pub purchase_id: u64,
    #[topic]
    pub material_id: BytesN<32>,
    #[topic]
    pub recipient: Address,
    pub role: Symbol,
    pub asset: Address,
    pub amount: i128,
}

/// Event: admin.asset_policy_updated
#[contractevent(topics = ["admin", "asset_policy_updated"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetPolicyUpdatedEvent {
    #[topic]
    pub asset: Address,
    pub kind: AssetKind,
    pub enabled: bool,
}

/// Event: admin.platform_config_updated
#[contractevent(topics = ["admin", "platform_config_updated"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformConfigUpdatedEvent {
    pub treasury: Address,
    pub platform_fee_bps: u32,
    pub paused: bool,
}

/// The PurchaseManager contract
#[contract]
pub struct PurchaseManager;

// ============== SAC Token Interface (SEP-41) ==============

/// Wrapper around a Stellar Asset Contract (SAC) address that exposes the
/// SEP-41 token interface methods needed by the purchase flow.
///
/// Both XLM (via its native SAC) and any other SAC-wrapped token (USDC, EURC,
/// creator tokens, …) implement this interface, so the purchase logic is
/// asset-agnostic.
pub struct SacToken<'a> {
    env: &'a Env,
    address: &'a Address,
}

impl<'a> SacToken<'a> {
    pub fn new(env: &'a Env, address: &'a Address) -> Self {
        SacToken { env, address }
    }

    /// Transfer `amount` tokens from `from` to `to`.
    /// Equivalent to calling `transfer(from, to, amount)` on the SAC.
    pub fn transfer(&self, from: &Address, to: &Address, amount: i128) {
        let func = Symbol::new(self.env, "transfer");
        let args = Vec::from_array(
            self.env,
            [
                from.into_val(self.env),
                to.into_val(self.env),
                amount.into_val(self.env),
            ],
        );
        self.env.invoke_contract::<()>(self.address, &func, args);
    }

    /// Query the token balance of `id`.
    /// Equivalent to calling `balance(id)` on the SAC.
    pub fn balance(&self, id: &Address) -> i128 {
        let func = Symbol::new(self.env, "balance");
        let args = Vec::from_array(self.env, [id.into_val(self.env)]);
        self.env.invoke_contract::<i128>(self.address, &func, args)
    }
}

// ============== Price Oracle Stub ==============

/// Stub for a future price-oracle integration (e.g. Reflector Oracle / SEP-40).
///
/// Returns `None` for every query until a concrete oracle is integrated.
/// The `oracle` field in `PlatformConfig` holds the oracle contract address
/// once deployed.
pub struct PriceOracle<'a> {
    env: &'a Env,
    address: &'a Address,
}

impl<'a> PriceOracle<'a> {
    pub fn new(env: &'a Env, address: &'a Address) -> Self {
        PriceOracle { env, address }
    }

    /// Returns the last price of `base` denominated in `quote` as
    /// `Some((price, decimals))`, or `None` when the oracle is unavailable.
    ///
    /// TODO: implement Reflector Oracle or equivalent SEP-40 feed when an
    ///       on-chain price source is available on the target network.
    pub fn last_price(&self, _base: &Address, _quote: &Address) -> Option<(i128, u32)> {
        let _ = (self.env, self.address);
        None
    }
}

// ============== Registry Cross-Contract Interface ==============

/// Interface for calling MaterialRegistry contract
pub trait MaterialRegistryInterface {
    fn get_material(&self, env: &Env, material_id: &BytesN<32>) -> Result<MaterialRecord, PurchaseError>;
}

/// Interface implementation using cross-contract call
impl MaterialRegistryInterface for Address {
    fn get_material(&self, env: &Env, material_id: &BytesN<32>) -> Result<MaterialRecord, PurchaseError> {
        let func = Symbol::new(env, "get_material");
        let result: Result<MaterialRecord, PurchaseError> = env
            .invoke_contract(self, &func, Vec::from_array(env, [material_id.into_val(env)]));
        result.map_err(|_| PurchaseError::RegistryCallFailed)
    }
}

#[contractimpl]
impl PurchaseManager {
    /// Initialize the PurchaseManager contract with platform configuration
    /// Must be called once by the admin before any purchases can be made
    pub fn initialize(
        env: Env,
        admin: Address,
        registry: Address,
        treasury: Address,
        platform_fee_bps: u32,
    ) -> Result<(), PurchaseError> {
        admin.require_auth();

        // Check if already initialized
        if env.storage().persistent().has(&DataKey::PlatformConfig) {
            return Err(PurchaseError::AlreadyInitialized);
        }

        // Validate platform fee
        if platform_fee_bps > MAX_PLATFORM_FEE_BPS {
            return Err(PurchaseError::InvalidPlatformFee);
        }

        // Validate treasury address
        if treasury == env.current_contract_address() {
            return Err(PurchaseError::InvalidTreasury);
        }

        let config = PlatformConfig {
            registry,
            treasury,
            platform_fee_bps,
            paused: false,
            oracle: None,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Admin, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::PlatformConfig, &config);
        env.storage().persistent().set(&DataKey::PurchaseNonce, &0u64);

        // Emit config event
        PlatformConfigUpdatedEvent {
            treasury,
            platform_fee_bps,
            paused: false,
        }
        .publish(&env);

        Ok(())
    }

    /// Execute a purchase for a material
    /// - Validates material is active and asset is accepted
    /// - Collects payment from buyer
    /// - Routes payouts to creator shares and treasury
    /// - Records entitlement for buyer
    pub fn purchase(
        env: Env,
        buyer: Address,
        material_id: BytesN<32>,
        asset: Address,
        expected_amount: i128,
    ) -> Result<u64, PurchaseError> {
        buyer.require_auth();

        let config = get_platform_config(&env)?;

        // Check global pause
        if config.paused {
            return Err(PurchaseError::ContractPaused);
        }

        // Check global asset allowlist
        if !is_asset_allowed(&env, &asset) {
            return Err(PurchaseError::AssetNotAllowed);
        }

        // Check for existing entitlement (prevent duplicate purchase)
        if has_entitlement_internal(&env, &material_id, &buyer) {
            return Err(PurchaseError::EntitlementAlreadyExists);
        }

        // Fetch material from registry
        let material: MaterialRecord = config
            .registry
            .get_material(&env, &material_id)
            .map_err(|_| PurchaseError::MaterialNotFound)?;

        // Verify material is active
        if material.status != MaterialStatus::Active {
            return Err(PurchaseError::MaterialNotActive);
        }

        // Find quote for the requested asset
        let quote = find_quote(&material.quotes, &asset)
            .ok_or(PurchaseError::AssetNotAcceptedForMaterial)?;

        // Verify expected amount matches current quote (prevent stale UI)
        if quote.amount != expected_amount {
            return Err(PurchaseError::InvalidQuoteAmount);
        }
        if quote.amount <= 0 {
            return Err(PurchaseError::InvalidQuoteAmount);
        }

        // Calculate payout amounts
        let gross = quote.amount;
        let platform_fee = (gross * config.platform_fee_bps as i128) / BASIS_POINTS as i128;
        let seller_net = gross - platform_fee;

        // Get purchase ID and increment nonce
        let purchase_id = get_and_increment_purchase_nonce(&env)?;
        let current_ledger = env.ledger().sequence();

        // Execute transfers atomically
        // 1. Transfer platform fee to treasury
        if platform_fee > 0 {
            transfer_asset(&env, &buyer, &config.treasury, &asset, platform_fee)?;
            
            // Emit treasury payout event
            PayoutDistributedEvent {
                purchase_id,
                material_id: material_id.clone(),
                recipient: config.treasury.clone(),
                role: Symbol::new(&env, "platform_fee"),
                asset: asset.clone(),
                amount: platform_fee,
            }
            .publish(&env);
        }

        // 2. Transfer seller net amount to payout recipients
        distribute_payout_shares(
            &env,
            purchase_id,
            &material_id,
            &buyer,
            &material.payout_shares,
            &asset,
            seller_net,
        )?;

        // 3. Record entitlement
        let entitlement = EntitlementRecord {
            material_id: material_id.clone(),
            buyer: buyer.clone(),
            active: true,
            purchase_id,
            asset: asset.clone(),
            amount: gross,
            granted_ledger: current_ledger,
        };

        set_entitlement(&env, &entitlement);

        // Emit purchase completed event
        PurchaseCompletedEvent {
            purchase_id,
            material_id: material_id.clone(),
            buyer: buyer.clone(),
            seller: material.creator.clone(),
            asset: asset.clone(),
            amount: gross,
            platform_fee,
            seller_net_amount: seller_net,
            entitlement_active: true,
        }
        .publish(&env);

        Ok(purchase_id)
    }

    /// Check if a buyer has an active entitlement for a material
    pub fn has_entitlement(env: Env, material_id: BytesN<32>, buyer: Address) -> bool {
        has_entitlement_internal(&env, &material_id, &buyer)
    }

    /// Get entitlement details for a buyer and material
    pub fn get_entitlement(
        env: Env,
        material_id: BytesN<32>,
        buyer: Address,
    ) -> Option<EntitlementRecord> {
        get_entitlement_internal(&env, &material_id, &buyer)
    }

    /// Get current platform configuration
    pub fn get_platform_config(env: Env) -> Option<PlatformConfig> {
        env.storage()
            .persistent()
            .get(&DataKey::PlatformConfig)
    }

    /// Check if an asset is globally allowed for purchases
    pub fn is_asset_allowed(env: Env, asset: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::AllowedAsset(asset))
            .unwrap_or(false)
    }

    // ============== Admin Functions ==============

    /// Set whether an asset is allowed for purchases (admin only).
    ///
    /// `kind` classifies the asset: `Native` for XLM, `Token` for SAC-wrapped
    /// fungible tokens such as USDC, and `CreatorToken` for creator-specific
    /// tokens. The classification is stored for informational purposes and
    /// future filtering.
    pub fn set_asset_allowed(
        env: Env,
        admin: Address,
        asset: Address,
        kind: AssetKind,
        enabled: bool,
    ) -> Result<(), PurchaseError> {
        admin.require_auth();
        verify_admin(&env, &admin)?;

        let info = AssetInfo { kind, enabled };
        env.storage()
            .persistent()
            .set(&DataKey::AllowedAsset(asset.clone()), &info);

        // Emit policy update event
        AssetPolicyUpdatedEvent { asset, kind, enabled }.publish(&env);

        Ok(())
    }

    /// Update platform configuration (admin only)
    pub fn set_platform_config(
        env: Env,
        admin: Address,
        treasury: Address,
        platform_fee_bps: u32,
        paused: bool,
    ) -> Result<(), PurchaseError> {
        admin.require_auth();
        verify_admin(&env, &admin)?;

        // Validate platform fee
        if platform_fee_bps > MAX_PLATFORM_FEE_BPS {
            return Err(PurchaseError::InvalidPlatformFee);
        }

        // Validate treasury
        if treasury == env.current_contract_address() {
            return Err(PurchaseError::InvalidTreasury);
        }

        let current_config = get_platform_config(&env)?;

        let new_config = PlatformConfig {
            registry: current_config.registry,
            treasury,
            platform_fee_bps,
            paused,
            // Preserve the existing oracle; use set_oracle() to change it.
            oracle: current_config.oracle,
        };

        env.storage()
            .persistent()
            .set(&DataKey::PlatformConfig, &new_config);

        // Emit config update event
        PlatformConfigUpdatedEvent {
            treasury,
            platform_fee_bps,
            paused,
        }
        .publish(&env);

        Ok(())
    }

    /// Returns the full `AssetInfo` record for `asset`, if present.
    pub fn get_asset_info(env: Env, asset: Address) -> Option<AssetInfo> {
        env.storage()
            .persistent()
            .get(&DataKey::AllowedAsset(asset))
    }

    /// Configure the price-oracle address used for future cross-asset
    /// conversion (admin only). Pass `None` to clear the oracle.
    pub fn set_oracle(
        env: Env,
        admin: Address,
        oracle: Option<Address>,
    ) -> Result<(), PurchaseError> {
        admin.require_auth();
        verify_admin(&env, &admin)?;

        let mut config = get_platform_config(&env)?;
        config.oracle = oracle;
        env.storage()
            .persistent()
            .set(&DataKey::PlatformConfig, &config);

        Ok(())
    }

    /// Update registry address (admin only, for migrations)
    pub fn set_registry(
        env: Env,
        admin: Address,
        registry: Address,
    ) -> Result<(), PurchaseError> {
        admin.require_auth();
        verify_admin(&env, &admin)?;

        let mut config = get_platform_config(&env)?;
        config.registry = registry;

        env.storage()
            .persistent()
            .set(&DataKey::PlatformConfig, &config);

        Ok(())
    }

    /// Upgrade contract WASM hash (admin only).
    pub fn upgrade(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), PurchaseError> {
        admin.require_auth();
        verify_admin(&env, &admin)?;
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }
}

// ============== Internal Functions ==============

fn get_platform_config(env: &Env) -> Result<PlatformConfig, PurchaseError> {
    env.storage()
        .persistent()
        .get(&DataKey::PlatformConfig)
        .ok_or(PurchaseError::NotAuthorized)
}

fn verify_admin(env: &Env, admin: &Address) -> Result<(), PurchaseError> {
    let _ = get_platform_config(env)?;
    let stored_admin: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .ok_or(PurchaseError::NotAuthorized)?;
    if &stored_admin != admin {
        return Err(PurchaseError::NotAuthorized);
    }
    Ok(())
}

fn is_asset_allowed(env: &Env, asset: &Address) -> bool {
    env.storage()
        .persistent()
        .get::<DataKey, AssetInfo>(&DataKey::AllowedAsset(asset.clone()))
        .map(|info| info.enabled)
        .unwrap_or(false)
}

fn find_quote(quotes: &Vec<AssetQuote>, asset: &Address) -> Option<AssetQuote> {
    let mut index = 0;
    while index < quotes.len() {
        let quote = quotes.get_unchecked(index);
        if quote.asset == *asset {
            return Some(quote);
        }
        index += 1;
    }
    None
}

fn get_and_increment_purchase_nonce(env: &Env) -> Result<u64, PurchaseError> {
    let nonce: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::PurchaseNonce)
        .ok_or(PurchaseError::NotAuthorized)?;
    env.storage()
        .persistent()
        .set(&DataKey::PurchaseNonce, &(nonce + 1));
    Ok(nonce)
}

fn transfer_asset(
    env: &Env,
    from: &Address,
    to: &Address,
    asset: &Address,
    amount: i128,
) -> Result<(), PurchaseError> {
    // Delegate to the Stellar Asset Contract (SAC) via the SEP-41 interface.
    // Works for XLM (native SAC), USDC, and any other SAC-wrapped token.
    SacToken::new(env, asset).transfer(from, to, amount);
    Ok(())
}

fn distribute_payout_shares(
    env: &Env,
    purchase_id: u64,
    material_id: &BytesN<32>,
    buyer: &Address,
    payout_shares: &Vec<PayoutShare>,
    asset: &Address,
    seller_net: i128,
) -> Result<(), PurchaseError> {
    let mut total_distributed: i128 = 0;
    let share_count = payout_shares.len();
    
    let mut index = 0;
    while index < share_count {
        let share = payout_shares.get_unchecked(index);
        
        // Calculate share amount
        let share_amount = if index == share_count - 1 {
            // Last recipient gets remaining to avoid rounding errors
            seller_net - total_distributed
        } else {
            (seller_net * share.share_bps as i128) / BASIS_POINTS as i128
        };

        if share_amount > 0 {
            // Transfer to recipient
            transfer_asset(env, buyer, &share.recipient, asset, share_amount)?;
            total_distributed += share_amount;

            // Emit payout event
            PayoutDistributedEvent {
                purchase_id,
                material_id: material_id.clone(),
                recipient: share.recipient.clone(),
                role: Symbol::new(env, "creator_share"),
                asset: asset.clone(),
                amount: share_amount,
            }
            .publish(env);
        }

        index += 1;
    }

    // Verify full distribution
    if total_distributed != seller_net {
        // This shouldn't happen with proper payout shares, but we verify
        return Err(PurchaseError::InvalidPayoutShares);
    }

    Ok(())
}

fn has_entitlement_internal(env: &Env, material_id: &BytesN<32>, buyer: &Address) -> bool {
    get_entitlement_internal(env, material_id, buyer)
        .map(|e| e.active)
        .unwrap_or(false)
}

fn get_entitlement_internal(
    env: &Env,
    material_id: &BytesN<32>,
    buyer: &Address,
) -> Option<EntitlementRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::Entitlement((material_id.clone(), buyer.clone())))
}

fn set_entitlement(env: &Env, entitlement: &EntitlementRecord) {
    env.storage().persistent().set(
        &DataKey::Entitlement((entitlement.material_id.clone(), entitlement.buyer.clone())),
        entitlement,
    );
}

#[cfg(test)]
mod test;

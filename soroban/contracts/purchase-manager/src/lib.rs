#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN,
    Env, IntoVal, Symbol, Vec,
};

pub mod auth;

const BASIS_POINTS: u32 = 10_000;
const MAX_PLATFORM_FEE_BPS: u32 = 1_000;
const MAX_PAYOUT_RECIPIENTS: u32 = 5;
const ESCROW_LOCK_PERIOD_LEDGERS: u32 = 35_000;

/// Volume-tier discounted fee rates (basis points).
/// Tier 1: 2.5 %, Tier 2: 1.5 %.
const TIER1_FEE_BPS: u32 = 250;
const TIER2_FEE_BPS: u32 = 150;

/// Material status from registry (replicated here to avoid circular deps)
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaterialStatus {
    Active = 0,
    Paused = 1,
    Archived = 2,
}

/// Volume tier assigned to a creator that controls the platform fee rate they pay.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CreatorTier {
    /// Standard rate — uses the global `platform_fee_bps` from `PlatformConfig`.
    Default = 0,
    /// High-volume tier: 2.5 % platform fee.
    Tier1 = 1,
    /// Premium-volume tier: 1.5 % platform fee.
    Tier2 = 2,
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
    pub paused: bool,
    pub status: MaterialStatus,
    pub quotes: Vec<AssetQuote>,
    pub payout_shares: Vec<PayoutShare>,
}

/// Legacy platform configuration stored in PurchaseManager (v1)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformConfigV1 {
    pub registry: Address,
    pub treasury: Address,
    pub platform_fee_bps: u32,
    pub paused: bool,
    pub oracle: Option<Address>,
}

/// Platform configuration stored in PurchaseManager
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformConfig {
    pub registry: Address,
    pub treasury: Address,
    pub platform_fee_bps: u32,
    pub paused: bool,
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

/// Escrow record holding creator payout funds during the cooling-off period
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRecord {
    pub purchase_id: u64,
    pub material_id: BytesN<32>,
    pub asset: Address,
    pub total_amount: i128,
    pub platform_fee: i128,
    pub seller_net: i128,
    pub payout_shares: Vec<PayoutShare>,
    pub purchase_ledger: u32,
    pub transaction_id: Bytes,
    pub claimed: bool,
}

/// Pending admin transfer record for two-step admin ownership handoff
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdminTransfer {
    pub from: Address,
    pub to: Address,
}

/// Data keys for contract storage
#[contracttype]
#[derive(Clone)]
enum DataKey {
    PlatformConfig,
    AllowedAsset(Address),
    PurchaseNonce,
    ConsumedIntent(BytesN<32>),
    Entitlement((BytesN<32>, Address)),
    Escrow(u64),
    PendingAdmin,
    CreatorTier(Address),
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

    // Escrow errors
    EscrowLocked = 50,

    // Admin transfer errors
    NoPendingAdminTransfer = 60,

    // Checkout intent errors
    IntentExpired = 70,
    IntentConsumed = 71,
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
    pub transaction_id: Bytes,
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
    pub transaction_id: Bytes,
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

/// Event: escrow.created
#[contractevent(topics = ["escrow", "created"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowCreatedEvent {
    #[topic]
    pub purchase_id: u64,
    #[topic]
    pub material_id: BytesN<32>,
    pub asset: Address,
    pub amount: i128,
    pub lock_until_ledger: u32,
}

/// Event: escrow.released
#[contractevent(topics = ["escrow", "released"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowReleasedEvent {
    #[topic]
    pub purchase_id: u64,
    pub material_id: BytesN<32>,
    pub asset: Address,
    pub amount: i128,
}

/// Event: admin.transfer_initiated
#[contractevent(topics = ["admin", "transfer_initiated"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferInitiatedEvent {
    #[topic]
    pub from: Address,
    pub pending_admin: Address,
}

/// Event: admin.transfer_accepted
#[contractevent(topics = ["admin", "transfer_accepted"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferAcceptedEvent {
    #[topic]
    pub new_admin: Address,
}

/// Event: creator.tier_updated
#[contractevent(topics = ["creator", "tier_updated"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatorTierUpdatedEvent {
    #[topic]
    pub creator: Address,
    pub tier: CreatorTier,
}

/// Event: checkout_intent.consumed
#[contractevent(topics = ["checkout_intent", "consumed"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckoutIntentConsumedEvent {
    #[topic]
    pub intent_hash: BytesN<32>,
    #[topic]
    pub purchase_id: u64,
    pub policy_version: Bytes,
    pub expires_ledger: u32,
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
// ============== Registry Cross-Contract Interface ==============

/// Interface for calling MaterialRegistry contract
pub trait MaterialRegistryInterface {
    fn get_material(
        &self,
        env: &Env,
        material_id: &BytesN<32>,
    ) -> Result<MaterialRecord, PurchaseError>;
}

/// Interface implementation using cross-contract call
impl MaterialRegistryInterface for Address {
    fn get_material(
        &self,
        env: &Env,
        material_id: &BytesN<32>,
    ) -> Result<MaterialRecord, PurchaseError> {
        let func = Symbol::new(env, "get_material");
        let result: Result<MaterialRecord, PurchaseError> = env.invoke_contract(
            self,
            &func,
            Vec::from_array(env, [material_id.into_val(env)]),
        );
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
            treasury: treasury.clone(),
            platform_fee_bps,
            paused: false,
        };

        auth::set_admin_role(&env, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::PlatformConfig, &config);
        env.storage()
            .persistent()
            .set(&DataKey::PurchaseNonce, &0u64);

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
    /// - Locks creator payout funds in escrow for cooling-off period
    /// - Records entitlement for buyer
    pub fn purchase(
        env: Env,
        buyer: Address,
        material_id: BytesN<32>,
        asset: Address,
        expected_amount: i128,
        transaction_id: Bytes,
    ) -> Result<u64, PurchaseError> {
        execute_purchase(
            env,
            buyer,
            material_id,
            asset,
            expected_amount,
            transaction_id,
            None,
        )
    }

    /// Execute a purchase bound to a server-authenticated checkout intent.
    ///
    /// The backend signs the full intent terms off-chain. The contract stores
    /// the intent hash as single-use state, rejects expired intents, and emits
    /// a link between the finalized purchase and the exact intent policy.
    pub fn purchase_with_intent(
        env: Env,
        buyer: Address,
        material_id: BytesN<32>,
        asset: Address,
        expected_amount: i128,
        transaction_id: Bytes,
        intent_hash: BytesN<32>,
        expires_ledger: u32,
        policy_version: Bytes,
    ) -> Result<u64, PurchaseError> {
        if env.ledger().sequence() > expires_ledger {
            return Err(PurchaseError::IntentExpired);
        }

        if env
            .storage()
            .persistent()
            .has(&DataKey::ConsumedIntent(intent_hash.clone()))
        {
            return Err(PurchaseError::IntentConsumed);
        }

        env.storage()
            .persistent()
            .set(&DataKey::ConsumedIntent(intent_hash.clone()), &true);

        execute_purchase(
            env,
            buyer,
            material_id,
            asset,
            expected_amount,
            transaction_id,
            Some((intent_hash, policy_version, expires_ledger)),
        )
    }

    /// Check whether a checkout intent hash has already been consumed.
    pub fn is_intent_consumed(env: Env, intent_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::ConsumedIntent(intent_hash))
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
        env.storage().persistent().get(&DataKey::PlatformConfig)
    }

    /// Check if an asset is globally allowed for purchases
    pub fn is_asset_allowed(env: Env, asset: Address) -> bool {
        is_asset_allowed(&env, &asset)
    }

    /// Withdraw escrowed creator payout funds after the lock period expires.
    /// Only callable by a payout recipient (e.g., the creator).
    pub fn withdraw_payouts(
        env: Env,
        caller: Address,
        purchase_id: u64,
    ) -> Result<(), PurchaseError> {
        caller.require_auth();

        let mut escrow =
            get_escrow_record_internal(&env, purchase_id).ok_or(PurchaseError::MaterialNotFound)?;

        if escrow.claimed {
            return Err(PurchaseError::EntitlementAlreadyExists);
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger < escrow.purchase_ledger + ESCROW_LOCK_PERIOD_LEDGERS {
            return Err(PurchaseError::EscrowLocked);
        }

        let caller_is_recipient = {
            let mut index = 0;
            let mut found = false;
            while index < escrow.payout_shares.len() {
                if escrow.payout_shares.get_unchecked(index).recipient == caller {
                    found = true;
                    break;
                }
                index += 1;
            }
            found
        };

        if !caller_is_recipient {
            return Err(PurchaseError::NotAuthorized);
        }

        if escrow.seller_net > 0 {
            distribute_payout_shares_from_contract(
                &env,
                purchase_id,
                &escrow.material_id,
                &escrow,
            )?;
        }

        escrow.claimed = true;
        set_escrow_record(&env, purchase_id, &escrow);

        EscrowReleasedEvent {
            purchase_id,
            material_id: escrow.material_id,
            asset: escrow.asset,
            amount: escrow.seller_net,
        }
        .publish(&env);

        Ok(())
    }

    /// Get the escrow record for a purchase
    pub fn get_escrow_record(env: Env, purchase_id: u64) -> Option<EscrowRecord> {
        get_escrow_record_internal(&env, purchase_id)
    }

    /// Check if the escrow for a purchase can be released
    pub fn is_escrow_releasable(env: Env, purchase_id: u64) -> bool {
        if let Some(escrow) = get_escrow_record_internal(&env, purchase_id) {
            if escrow.claimed {
                return false;
            }
            let current_ledger = env.ledger().sequence();
            return current_ledger >= escrow.purchase_ledger + ESCROW_LOCK_PERIOD_LEDGERS;
        }
        false
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
        auth::require_admin(&env, &admin)?;

        let info = AssetInfo { kind, enabled };
        env.storage()
            .persistent()
            .set(&DataKey::AllowedAsset(asset.clone()), &info);

        // Emit policy update event
        AssetPolicyUpdatedEvent {
            asset,
            kind,
            enabled,
        }
        .publish(&env);

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
        auth::require_admin(&env, &admin)?;

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
            treasury: treasury.clone(),
            platform_fee_bps,
            paused,
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

    /// Migrate PlatformConfig from V1 (with oracle) to V2 (without oracle).
    /// This should be called once by the admin after upgrading the contract
    /// from a version that used `PlatformConfigV1` schema.
    pub fn migrate_config_v1_to_v2(env: Env, admin: Address) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let old_config: PlatformConfigV1 = env
            .storage()
            .persistent()
            .get(&DataKey::PlatformConfig)
            .ok_or(PurchaseError::NotAuthorized)?;

        let new_config = PlatformConfig {
            registry: old_config.registry,
            treasury: old_config.treasury,
            platform_fee_bps: old_config.platform_fee_bps,
            paused: old_config.paused,
        };

        env.storage()
            .persistent()
            .set(&DataKey::PlatformConfig, &new_config);

        Ok(())
    }

    /// Update registry address (admin only, for migrations)
    pub fn set_registry(env: Env, admin: Address, registry: Address) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let mut config = get_platform_config(&env)?;
        config.registry = registry;

        env.storage()
            .persistent()
            .set(&DataKey::PlatformConfig, &config);

        Ok(())
    }

    /// Update the platform fee rate (admin only).
    ///
    /// Updates the platform fee to a new rate, validated against the maximum
    /// ceiling of 10% (1 000 basis points). The change is applied instantly
    /// to all subsequent purchases.
    pub fn update_platform_fee(
        env: Env,
        admin: Address,
        new_platform_fee_bps: u32,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        if new_platform_fee_bps > MAX_PLATFORM_FEE_BPS {
            return Err(PurchaseError::InvalidPlatformFee);
        }

        let mut config = get_platform_config(&env)?;
        config.platform_fee_bps = new_platform_fee_bps;

        env.storage()
            .persistent()
            .set(&DataKey::PlatformConfig, &config);

        PlatformConfigUpdatedEvent {
            treasury: config.treasury.clone(),
            platform_fee_bps: new_platform_fee_bps,
            paused: config.paused,
        }
        .publish(&env);

        Ok(())
    }

    /// Pause contract operations (admin only)
    /// When paused, all state-modifying functions will fail
    pub fn pause(env: Env, admin: Address) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let mut config = get_platform_config(&env)?;
        config.paused = true;

        env.storage()
            .persistent()
            .set(&DataKey::PlatformConfig, &config);

        // Emit config update event
        PlatformConfigUpdatedEvent {
            treasury: config.treasury,
            platform_fee_bps: config.platform_fee_bps,
            paused: true,
        }
        .publish(&env);

        Ok(())
    }

    /// Unpause contract operations (admin only)
    /// When unpaused, normal operations resume
    pub fn unpause(env: Env, admin: Address) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let mut config = get_platform_config(&env)?;
        config.paused = false;

        env.storage()
            .persistent()
            .set(&DataKey::PlatformConfig, &config);

        // Emit config update event
        PlatformConfigUpdatedEvent {
            treasury: config.treasury,
            platform_fee_bps: config.platform_fee_bps,
            paused: false,
        }
        .publish(&env);

        Ok(())
    }

    /// Upgrade contract WASM hash (admin only).
    pub fn upgrade(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    // ============== Admin Transfer (two-step, #378) ==============

    /// Begin an admin ownership transfer.
    ///
    /// Stores `new_admin` as the pending admin and emits an event.  The
    /// transfer is NOT complete until `new_admin` calls `accept_admin`.
    pub fn transfer_admin(
        env: Env,
        admin: Address,
        new_admin: Address,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let transfer = PendingAdminTransfer {
            from: admin.clone(),
            to: new_admin.clone(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::PendingAdmin, &transfer);

        AdminTransferInitiatedEvent {
            from: admin,
            pending_admin: new_admin,
        }
        .publish(&env);

        Ok(())
    }

    /// Complete an admin ownership transfer initiated by `transfer_admin`.
    ///
    /// Only the address stored as `PendingAdmin` may call this.  On success
    /// the caller becomes the sole admin and the pending slot is cleared.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), PurchaseError> {
        new_admin.require_auth();

        let transfer: PendingAdminTransfer = env
            .storage()
            .persistent()
            .get(&DataKey::PendingAdmin)
            .ok_or(PurchaseError::NoPendingAdminTransfer)?;

        if transfer.to != new_admin {
            return Err(PurchaseError::NotAuthorized);
        }

        auth::remove_admin_role(&env, &transfer.from);
        auth::set_admin_role(&env, &new_admin);

        env.storage().persistent().remove(&DataKey::PendingAdmin);

        AdminTransferAcceptedEvent {
            new_admin: new_admin.clone(),
        }
        .publish(&env);

        Ok(())
    }

    /// Return the pending admin address, if a transfer is in progress.
    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage()
            .persistent()
            .get::<DataKey, PendingAdminTransfer>(&DataKey::PendingAdmin)
            .map(|t| t.to)
    }

    // ============== Creator Volume Tiers (#381) ==============

    /// Assign a volume tier to a creator (admin only).
    ///
    /// The tier controls the platform fee rate applied when the creator's
    /// materials are purchased.  Use `CreatorTier::Default` to revert a
    /// creator back to the global `platform_fee_bps`.
    pub fn set_creator_tier(
        env: Env,
        admin: Address,
        creator: Address,
        tier: CreatorTier,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        env.storage()
            .persistent()
            .set(&DataKey::CreatorTier(creator.clone()), &tier);

        CreatorTierUpdatedEvent { creator, tier }.publish(&env);

        Ok(())
    }

    /// Return the volume tier assigned to a creator.
    /// Returns `CreatorTier::Default` when no tier has been set.
    pub fn get_creator_tier(env: Env, creator: Address) -> CreatorTier {
        env.storage()
            .persistent()
            .get(&DataKey::CreatorTier(creator))
            .unwrap_or(CreatorTier::Default)
    }
}

// ============== Internal Functions ==============

fn execute_purchase(
    env: Env,
    buyer: Address,
    material_id: BytesN<32>,
    asset: Address,
    expected_amount: i128,
    transaction_id: Bytes,
    intent_meta: Option<(BytesN<32>, Bytes, u32)>,
) -> Result<u64, PurchaseError> {
    buyer.require_auth();

    let config = get_platform_config(&env)?;

    if config.paused {
        return Err(PurchaseError::ContractPaused);
    }

    if !is_asset_allowed(&env, &asset) {
        return Err(PurchaseError::AssetNotAllowed);
    }

    if has_entitlement_internal(&env, &material_id, &buyer) {
        return Err(PurchaseError::EntitlementAlreadyExists);
    }

    let material: MaterialRecord = config
        .registry
        .get_material(&env, &material_id)
        .map_err(|_| PurchaseError::MaterialNotFound)?;

    if material.status != MaterialStatus::Active || material.paused {
        return Err(PurchaseError::MaterialNotActive);
    }

    let quote =
        find_quote(&material.quotes, &asset).ok_or(PurchaseError::AssetNotAcceptedForMaterial)?;

    if quote.amount != expected_amount {
        return Err(PurchaseError::InvalidQuoteAmount);
    }
    if quote.amount <= 0 {
        return Err(PurchaseError::InvalidQuoteAmount);
    }

    validate_payout_shares(&material.payout_shares)?;

    let gross = quote.amount;
    let effective_fee_bps = get_effective_fee_bps(&env, &material.creator, config.platform_fee_bps);
    let platform_fee = (gross * effective_fee_bps as i128) / BASIS_POINTS as i128;
    let seller_net = gross - platform_fee;

    let purchase_id = get_and_increment_purchase_nonce(&env)?;
    let current_ledger = env.ledger().sequence();

    if platform_fee > 0 {
        transfer_asset(&env, &buyer, &config.treasury, &asset, platform_fee)?;

        PayoutDistributedEvent {
            purchase_id,
            material_id: material_id.clone(),
            recipient: config.treasury.clone(),
            role: Symbol::new(&env, "platform_fee"),
            asset: asset.clone(),
            amount: platform_fee,
            transaction_id: transaction_id.clone(),
        }
        .publish(&env);
    }

    if seller_net > 0 {
        transfer_asset(
            &env,
            &buyer,
            &env.current_contract_address(),
            &asset,
            seller_net,
        )?;
    }

    let escrow_record = EscrowRecord {
        purchase_id,
        material_id: material_id.clone(),
        asset: asset.clone(),
        total_amount: gross,
        platform_fee,
        seller_net,
        payout_shares: material.payout_shares.clone(),
        purchase_ledger: current_ledger,
        transaction_id: transaction_id.clone(),
        claimed: false,
    };
    set_escrow_record(&env, purchase_id, &escrow_record);

    EscrowCreatedEvent {
        purchase_id,
        material_id: material_id.clone(),
        asset: asset.clone(),
        amount: seller_net,
        lock_until_ledger: current_ledger + ESCROW_LOCK_PERIOD_LEDGERS,
    }
    .publish(&env);

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

    PurchaseCompletedEvent {
        purchase_id,
        material_id: material_id.clone(),
        buyer,
        seller: material.creator,
        asset,
        amount: gross,
        platform_fee,
        seller_net_amount: seller_net,
        entitlement_active: true,
        transaction_id,
    }
    .publish(&env);

    if let Some((intent_hash, policy_version, expires_ledger)) = intent_meta {
        CheckoutIntentConsumedEvent {
            intent_hash,
            purchase_id,
            policy_version,
            expires_ledger,
        }
        .publish(&env);
    }

    Ok(purchase_id)
}

/// Return the effective platform fee rate for `creator`.
///
/// Tier-discounted rates take precedence over the global config fee.
/// Integer truncation in the caller ensures the creator is never charged more
/// than the stated rate.
fn get_effective_fee_bps(env: &Env, creator: &Address, config_fee_bps: u32) -> u32 {
    match env
        .storage()
        .persistent()
        .get::<DataKey, CreatorTier>(&DataKey::CreatorTier(creator.clone()))
        .unwrap_or(CreatorTier::Default)
    {
        CreatorTier::Default => config_fee_bps,
        CreatorTier::Tier1 => TIER1_FEE_BPS,
        CreatorTier::Tier2 => TIER2_FEE_BPS,
    }
}

fn get_platform_config(env: &Env) -> Result<PlatformConfig, PurchaseError> {
    env.storage()
        .persistent()
        .get(&DataKey::PlatformConfig)
        .ok_or(PurchaseError::NotAuthorized)
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

fn validate_payout_shares(payout_shares: &Vec<PayoutShare>) -> Result<(), PurchaseError> {
    let share_count = payout_shares.len();
    if share_count == 0 || share_count > MAX_PAYOUT_RECIPIENTS {
        return Err(PurchaseError::InvalidPayoutShares);
    }

    let mut total_share_bps = 0u32;
    let mut index = 0;
    while index < share_count {
        let share = payout_shares.get_unchecked(index);
        if share.share_bps == 0 || share.share_bps > BASIS_POINTS {
            return Err(PurchaseError::InvalidPayoutShares);
        }

        total_share_bps = total_share_bps
            .checked_add(share.share_bps)
            .ok_or(PurchaseError::InvalidPayoutShares)?;

        let mut other = index + 1;
        while other < share_count {
            if share.recipient == payout_shares.get_unchecked(other).recipient {
                return Err(PurchaseError::InvalidPayoutShares);
            }
            other += 1;
        }

        index += 1;
    }

    if total_share_bps != BASIS_POINTS {
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

fn get_escrow_record_internal(env: &Env, purchase_id: u64) -> Option<EscrowRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::Escrow(purchase_id))
}

fn set_escrow_record(env: &Env, purchase_id: u64, record: &EscrowRecord) {
    env.storage()
        .persistent()
        .set(&DataKey::Escrow(purchase_id), record);
}

fn distribute_payout_shares_from_contract(
    env: &Env,
    purchase_id: u64,
    material_id: &BytesN<32>,
    escrow: &EscrowRecord,
) -> Result<(), PurchaseError> {
    let contract_address = env.current_contract_address();
    let mut total_distributed: i128 = 0;
    let share_count = escrow.payout_shares.len();

    let mut index = 0;
    while index < share_count {
        let share = escrow.payout_shares.get_unchecked(index);

        let share_amount = if index == share_count - 1 {
            escrow.seller_net - total_distributed
        } else {
            (escrow.seller_net * share.share_bps as i128) / BASIS_POINTS as i128
        };

        if share_amount > 0 {
            transfer_asset(
                env,
                &contract_address,
                &share.recipient,
                &escrow.asset,
                share_amount,
            )?;
            total_distributed += share_amount;

            PayoutDistributedEvent {
                purchase_id,
                material_id: material_id.clone(),
                recipient: share.recipient.clone(),
                role: Symbol::new(env, "creator_share"),
                asset: escrow.asset.clone(),
                amount: share_amount,
                transaction_id: escrow.transaction_id.clone(),
            }
            .publish(env);
        }

        index += 1;
    }

    if total_distributed != escrow.seller_net {
        return Err(PurchaseError::InvalidPayoutShares);
    }

    Ok(())
}

#[cfg(test)]
mod test;

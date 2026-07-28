#![no_std]

use shared_interface::{
    AssetKind, AssetPolicyInfo, AssetQuote, MaterialStatus, PayoutShare, PendingAdminTransfer,
    MIN_ADMIN_TRANSFER_DELAY_SECS,
};
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
    IntoVal, String, Val, Vec,
};

const BASIS_POINTS: u32 = 10_000;
const MAX_METADATA_URI_LEN: u32 = 256;
const MAX_QUOTES_PER_MATERIAL: u32 = 4;
const MAX_PAYOUT_RECIPIENTS: u32 = 5;

/// TTL renewal policy (#464): whenever a tracked entry's remaining TTL drops
/// below half of the network's configured maximum, extend it back out to
/// the maximum. See ../../docs/ttl-operations.md for the operational
/// rationale, renewal cadence, and alert thresholds.
const TTL_RENEWAL_DIVISOR: u32 = 2;

/// Upper bound on how many records a single maintenance call will touch, so
/// a TTL-renewal sweep can never exceed a transaction's resource limits
/// regardless of what a caller passes as `limit`. `extend_materials_ttl`
/// touches up to 3 ledger entries per material (index slot + core + sale);
/// at 25 that's a worst-case footprint of 75 entries, comfortably under the
/// current mainnet per-invocation footprint cap of 100 — verified directly
/// by `extend_materials_ttl_is_cursor_based_and_bounded`, which fails loudly
/// if this constant is ever raised past what the network actually allows.
const MAX_MAINTENANCE_BATCH: u32 = 25;

// MaterialStatus, AssetKind, AssetQuote, and PayoutShare are defined once in
// `shared-interface` (#465) and imported above, so a field-order or enum
// change can't silently desync this contract's XDR encoding from
// `purchase-manager`'s.

/// Initial allowlist entry supplied to `initialize` (#462), letting the
/// deploying admin pre-approve assets in the same transaction that
/// establishes upgrade-admin authority — closing the chicken-and-egg gap
/// that previously forced the first `register_material` call to bypass the
/// allowlist entirely.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitialAssetPolicy {
    pub asset: Address,
    pub kind: AssetKind,
    pub enabled: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialRecord {
    pub material_id: BytesN<32>,
    pub creator: Address,
    pub metadata_uri: String,
    pub metadata_hash: BytesN<32>,
    pub rights_hash: BytesN<32>,
    pub paused: bool,
    pub status: MaterialStatus,
    pub quotes: Vec<AssetQuote>,
    pub payout_shares: Vec<PayoutShare>,
    pub created_ledger: u32,
    pub updated_ledger: u32,
}

/// Write-once fields for a material, stored separately from the mutable sale
/// state so that sale-term/status updates don't re-write immutable data
/// (creator, metadata, hashes) on every call. `material_id` is intentionally
/// omitted here since it's already the `DataKey::MaterialCore` storage key.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct MaterialCore {
    creator: Address,
    metadata_uri: String,
    metadata_hash: BytesN<32>,
    rights_hash: BytesN<32>,
    created_ledger: u32,
}

/// Mutable sale-state fields for a material, rewritten on every sale-terms or
/// status update. Kept in its own storage entry so those writes only pay for
/// the bytes that actually change.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct MaterialSaleState {
    paused: bool,
    status: MaterialStatus,
    quotes: Vec<AssetQuote>,
    payout_shares: Vec<PayoutShare>,
    updated_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// Instance storage (#464 Tier A) — shares the contract instance's own
    /// TTL, so it never needs independent renewal.
    UpgradeAdmin,
    /// A pending, not-yet-accepted admin-authority transfer (#463).
    PendingAdminTransfer,
    CreatorNonce(Address),
    MaterialCore(BytesN<32>),
    MaterialSale(BytesN<32>),
    AllowedAsset(Address),
    /// Maintenance index (#464): sequential slot -> material_id, populated
    /// at registration time so `extend_materials_ttl` can page through every
    /// material without depending on any off-chain enumeration.
    MaterialIndex(u64),
    /// Instance storage: total number of `MaterialIndex` slots populated.
    MaterialCount,
    /// Maintenance index (#464): sequential slot -> asset address, populated
    /// the first time an asset is added to the allowlist.
    AllowedAssetIndex(u64),
    /// Instance storage: total number of `AllowedAssetIndex` slots populated.
    AllowedAssetCount,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    EmptyMetadataUri = 1,
    MetadataUriTooLong = 2,
    EmptyQuotes = 3,
    TooManyQuotes = 4,
    DuplicateQuoteAsset = 5,
    InvalidQuoteAmount = 6,
    EmptyPayoutShares = 7,
    TooManyPayoutShares = 8,
    DuplicatePayoutRecipient = 9,
    InvalidPayoutShare = 10,
    InvalidPayoutShareSum = 11,
    MaterialAlreadyExists = 12,
    MaterialNotFound = 13,
    NotAuthorized = 14,
    /// A quote asset is not in the registry's approved-asset allowlist.
    UnapprovedAsset = 15,
    /// `initialize` was called on a contract that already has an admin set.
    AlreadyInitialized = 16,
    /// An entrypoint that requires an established admin (e.g.
    /// `register_material`) was called before `initialize`.
    NotInitialized = 17,
    /// `accept_admin_transfer` / `cancel_admin_transfer` called with no
    /// transfer in progress.
    NoPendingAdminTransfer = 18,
    /// `accept_admin_transfer` called before the configured delay elapsed.
    TransferDelayNotElapsed = 19,
    /// `initiate_admin_transfer` called with a delay shorter than
    /// `shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS`.
    InvalidTransferDelay = 20,
}

#[contractevent(topics = ["material", "registered"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialRegisteredEvent {
    #[topic]
    pub material_id: BytesN<32>,
    #[topic]
    pub creator: Address,
    pub metadata_uri: String,
    pub metadata_hash: BytesN<32>,
    pub rights_hash: BytesN<32>,
    pub status: MaterialStatus,
    pub quotes: Vec<AssetQuote>,
    pub payout_shares: Vec<PayoutShare>,
}

#[contractevent(topics = ["material", "sale_terms_updated"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialSaleTermsUpdatedEvent {
    #[topic]
    pub material_id: BytesN<32>,
    #[topic]
    pub creator: Address,
    pub status: MaterialStatus,
    pub quotes: Vec<AssetQuote>,
    pub payout_shares: Vec<PayoutShare>,
}

#[contractevent(topics = ["material", "status_updated"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialStatusUpdatedEvent {
    #[topic]
    pub material_id: BytesN<32>,
    #[topic]
    pub creator: Address,
    pub status: MaterialStatus,
}

#[contractevent(topics = ["material", "status_changed"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialStatusChangedEvent {
    #[topic]
    pub material_id: BytesN<32>,
    #[topic]
    pub creator: Address,
    pub paused: bool,
    pub status: MaterialStatus,
}

/// Emitted when the upgrade-admin updates the approved-asset allowlist.
#[contractevent(topics = ["asset", "policy_updated"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetPolicyUpdatedEvent {
    #[topic]
    pub asset: Address,
    pub kind: AssetKind,
    pub enabled: bool,
}

#[contract]
pub struct MaterialRegistry;

#[contractimpl]
impl MaterialRegistry {
    pub fn register_material(
        env: Env,
        creator: Address,
        metadata_uri: String,
        metadata_hash: BytesN<32>,
        rights_hash: BytesN<32>,
        quotes: Vec<AssetQuote>,
        payout_shares: Vec<PayoutShare>,
    ) -> Result<BytesN<32>, RegistryError> {
        creator.require_auth();
        if !env.storage().instance().has(&DataKey::UpgradeAdmin) {
            return Err(RegistryError::NotInitialized);
        }
        validate_metadata_uri(&metadata_uri)?;
        validate_quotes(&quotes)?;
        validate_payout_shares(&payout_shares)?;
        validate_quote_assets(&env, &quotes)?;

        let next_nonce = get_creator_nonce(&env, &creator);
        let material_id = derive_material_id(&env, &creator, next_nonce);
        if has_material(&env, &material_id) {
            return Err(RegistryError::MaterialAlreadyExists);
        }

        let current_ledger = env.ledger().sequence();
        let core = MaterialCore {
            creator: creator.clone(),
            metadata_uri: metadata_uri.clone(),
            metadata_hash: metadata_hash.clone(),
            rights_hash: rights_hash.clone(),
            created_ledger: current_ledger,
        };
        let sale_state = MaterialSaleState {
            paused: false,
            status: MaterialStatus::Active,
            quotes: quotes.clone(),
            payout_shares: payout_shares.clone(),
            updated_ledger: current_ledger,
        };
        put_material_core(&env, &material_id, &core);
        put_material_sale(&env, &material_id, &sale_state);
        set_creator_nonce(&env, &creator, next_nonce + 1);
        index_material(&env, &material_id);

        MaterialRegisteredEvent {
            material_id: material_id.clone(),
            creator,
            metadata_uri,
            metadata_hash,
            rights_hash,
            status: MaterialStatus::Active,
            quotes,
            payout_shares,
        }
        .publish(&env);

        Ok(material_id)
    }

    pub fn update_sale_terms(
        env: Env,
        material_id: BytesN<32>,
        quotes: Vec<AssetQuote>,
        payout_shares: Vec<PayoutShare>,
    ) -> Result<(), RegistryError> {
        validate_quotes(&quotes)?;
        validate_payout_shares(&payout_shares)?;
        validate_quote_assets(&env, &quotes)?;

        let mut record = get_material_record(&env, &material_id)?;
        record.creator.require_auth();
        record.quotes = quotes.clone();
        record.payout_shares = payout_shares.clone();
        record.updated_ledger = env.ledger().sequence();

        put_material_sale(&env, &material_id, &sale_state_from_record(&record));

        MaterialSaleTermsUpdatedEvent {
            material_id,
            creator: record.creator,
            status: record.status,
            quotes,
            payout_shares,
        }
        .publish(&env);

        Ok(())
    }

    pub fn set_material_status(
        env: Env,
        actor: Address,
        material_id: BytesN<32>,
        status: MaterialStatus,
    ) -> Result<(), RegistryError> {
        let mut record = get_material_record(&env, &material_id)?;
        require_creator_or_upgrade_admin(&env, &record.creator, &actor)?;

        if record.status == status {
            return Ok(());
        }

        record.status = status;
        record.paused = status == MaterialStatus::Paused;
        record.updated_ledger = env.ledger().sequence();
        put_material_sale(&env, &material_id, &sale_state_from_record(&record));

        MaterialStatusUpdatedEvent {
            material_id: material_id.clone(),
            creator: record.creator.clone(),
            status,
        }
        .publish(&env);

        MaterialStatusChangedEvent {
            material_id,
            creator: record.creator,
            paused: record.paused,
            status,
        }
        .publish(&env);

        Ok(())
    }

    pub fn set_material_paused(
        env: Env,
        actor: Address,
        material_id: BytesN<32>,
        paused: bool,
    ) -> Result<(), RegistryError> {
        let status = if paused {
            MaterialStatus::Paused
        } else {
            MaterialStatus::Active
        };
        Self::set_material_status(env, actor, material_id, status)
    }

    pub fn toggle_material_paused(
        env: Env,
        actor: Address,
        material_id: BytesN<32>,
    ) -> Result<(), RegistryError> {
        let record = get_material_record(&env, &material_id)?;
        Self::set_material_paused(env, actor, material_id, !record.paused)
    }

    pub fn is_material_paused(env: Env, material_id: BytesN<32>) -> Result<bool, RegistryError> {
        let record = get_material_record(&env, &material_id)?;
        Ok(record.paused)
    }

    pub fn set_material_active(
        env: Env,
        actor: Address,
        material_id: BytesN<32>,
        active: bool,
    ) -> Result<(), RegistryError> {
        Self::set_material_paused(env, actor, material_id, !active)
    }

    pub fn set_material_deactivated(
        env: Env,
        actor: Address,
        material_id: BytesN<32>,
        deactivated: bool,
    ) -> Result<(), RegistryError> {
        let mut record = get_material_record(&env, &material_id)?;
        require_creator_or_upgrade_admin(&env, &record.creator, &actor)?;
        let next_status = if deactivated {
            MaterialStatus::Archived
        } else if record.paused {
            MaterialStatus::Paused
        } else {
            MaterialStatus::Active
        };
        if record.status == next_status {
            return Ok(());
        }
        record.status = next_status;
        record.updated_ledger = env.ledger().sequence();
        put_material_sale(&env, &material_id, &sale_state_from_record(&record));
        MaterialStatusChangedEvent {
            material_id: material_id.clone(),
            creator: record.creator.clone(),
            paused: record.paused,
            status: next_status,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_material(
        env: Env,
        material_id: BytesN<32>,
    ) -> Result<MaterialRecord, RegistryError> {
        get_material_record(&env, &material_id)
    }

    pub fn get_quote(
        env: Env,
        material_id: BytesN<32>,
        asset: Address,
    ) -> Result<Option<AssetQuote>, RegistryError> {
        let record = get_material_record(&env, &material_id)?;
        let mut index = 0;
        while index < record.quotes.len() {
            let quote = record.quotes.get_unchecked(index);
            if quote.asset == asset {
                return Ok(Some(quote));
            }
            index += 1;
        }

        Ok(None)
    }

    // ============== Asset Allowlist (SAC / Multi-Asset Support) ==============

    /// Add or update an asset in the registry's approved-asset allowlist.
    ///
    /// Only the upgrade-admin may call this. Assets must be approved before
    /// creators can include them in material quotes. Supports XLM (Native),
    /// USDC/other SAC-wrapped tokens (Token), and creator-specific tokens
    /// (CreatorToken).
    pub fn set_asset_allowed(
        env: Env,
        admin: Address,
        asset: Address,
        kind: AssetKind,
        enabled: bool,
    ) -> Result<(), RegistryError> {
        admin.require_auth();
        require_upgrade_admin(&env, &admin)?;

        let asset_key = DataKey::AllowedAsset(asset.clone());
        let is_new_asset = !env.storage().persistent().has(&asset_key);

        let info = AssetPolicyInfo { kind, enabled };
        env.storage().persistent().set(&asset_key, &info);
        extend_persistent_ttl(&env, &asset_key);

        if is_new_asset {
            index_allowed_asset(&env, &asset);
        }

        AssetPolicyUpdatedEvent {
            asset,
            kind,
            enabled,
        }
        .publish(&env);

        Ok(())
    }

    /// Returns `true` when `asset` is in the allowlist and currently enabled.
    pub fn is_asset_allowed(env: Env, asset: Address) -> bool {
        get_allowed_asset_info(&env, &asset)
            .map(|i| i.enabled)
            .unwrap_or(false)
    }

    /// Returns the full `AssetPolicyInfo` record for `asset`, if present.
    pub fn get_asset_info(env: Env, asset: Address) -> Option<AssetPolicyInfo> {
        get_allowed_asset_info(&env, &asset)
    }

    // ============== TTL Maintenance (#464) ==============

    /// Bump the TTL of up to `limit` (capped at `MAX_MAINTENANCE_BATCH`)
    /// materials, starting at `cursor` — an index into the registration-
    /// order material index, not a material_id itself. Permissionless: this
    /// is a pure keep-alive operation with no business-state mutation, so
    /// anyone (the platform operator or a third-party keeper) can drive it,
    /// e.g. on a schedule from the off-chain indexer.
    ///
    /// Returns the cursor to resume from on the next call. Once the
    /// returned cursor equals the total material count, this pass has
    /// covered every material and a fresh pass can restart from 0.
    ///
    /// Skips (rather than aborts on) any slot whose `MaterialCore`/
    /// `MaterialSale` entries have already expired/archived — those need
    /// out-of-band restoration (see ../../docs/ttl-operations.md) rather
    /// than a plain extend, and one archived material must not block the
    /// rest of the batch.
    pub fn extend_materials_ttl(env: Env, cursor: u64, limit: u32) -> u64 {
        let limit = limit.min(MAX_MAINTENANCE_BATCH) as u64;
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::MaterialCount)
            .unwrap_or(0);
        extend_instance_ttl(&env);

        let end = cursor.saturating_add(limit).min(count);
        let mut i = cursor;
        while i < end {
            let index_key = DataKey::MaterialIndex(i);
            if let Some(material_id) = env.storage().persistent().get::<_, BytesN<32>>(&index_key) {
                extend_persistent_ttl(&env, &index_key);
                let core_key = DataKey::MaterialCore(material_id.clone());
                let sale_key = DataKey::MaterialSale(material_id.clone());
                if env.storage().persistent().has(&core_key) {
                    extend_persistent_ttl(&env, &core_key);
                }
                if env.storage().persistent().has(&sale_key) {
                    extend_persistent_ttl(&env, &sale_key);
                }
            }
            i += 1;
        }

        end
    }

    /// Bump the TTL of up to `limit` (capped at `MAX_MAINTENANCE_BATCH`)
    /// allowlisted assets, starting at `cursor`. Same semantics as
    /// `extend_materials_ttl` — permissionless, cursor-based, resume by
    /// passing back the returned cursor.
    pub fn extend_asset_policy_ttl(env: Env, cursor: u64, limit: u32) -> u64 {
        let limit = limit.min(MAX_MAINTENANCE_BATCH) as u64;
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::AllowedAssetCount)
            .unwrap_or(0);
        extend_instance_ttl(&env);

        let end = cursor.saturating_add(limit).min(count);
        let mut i = cursor;
        while i < end {
            let index_key = DataKey::AllowedAssetIndex(i);
            if let Some(asset) = env.storage().persistent().get::<_, Address>(&index_key) {
                extend_persistent_ttl(&env, &index_key);
                let asset_key = DataKey::AllowedAsset(asset);
                if env.storage().persistent().has(&asset_key) {
                    extend_persistent_ttl(&env, &asset_key);
                }
            }
            i += 1;
        }

        end
    }

    // ============== Initialization / Upgrade / Admin ==============

    /// One-time contract initialization (#462). Must be called before any
    /// material can be registered. `initial_assets` lets the deploying admin
    /// pre-approve payment assets atomically in the same transaction, so
    /// `register_material` never needs to special-case "no admin yet".
    ///
    /// This closes a front-runnable bootstrap gap: previously, admin
    /// authority was assigned implicitly to whoever's `register_material`
    /// transaction landed first after deploy, and that same first call
    /// bypassed asset-allowlist validation entirely. Explicit initialization
    /// means authority is established in one authenticated, one-time call,
    /// and every material — including the first — is validated the same way.
    ///
    /// # Migration for already-deployed registries
    /// A registry deployed before this change already has `UpgradeAdmin` set
    /// (via the old implicit bootstrap, from its first registered material),
    /// so calling `initialize` on it simply returns `AlreadyInitialized` — no
    /// action is required there. Only fresh deployments must call this
    /// explicitly, before anyone can call `register_material`.
    pub fn initialize(
        env: Env,
        admin: Address,
        initial_assets: Vec<InitialAssetPolicy>,
    ) -> Result<(), RegistryError> {
        admin.require_auth();

        if env.storage().instance().has(&DataKey::UpgradeAdmin) {
            return Err(RegistryError::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::UpgradeAdmin, &admin);

        let mut index = 0;
        while index < initial_assets.len() {
            let entry = initial_assets.get_unchecked(index);
            let asset_key = DataKey::AllowedAsset(entry.asset.clone());
            let info = AssetPolicyInfo {
                kind: entry.kind,
                enabled: entry.enabled,
            };
            env.storage().persistent().set(&asset_key, &info);
            extend_persistent_ttl(&env, &asset_key);
            index_allowed_asset(&env, &entry.asset);

            AssetPolicyUpdatedEvent {
                asset: entry.asset,
                kind: entry.kind,
                enabled: entry.enabled,
            }
            .publish(&env);

            index += 1;
        }

        extend_instance_ttl(&env);
        Ok(())
    }

    pub fn get_upgrade_admin(env: Env) -> Option<Address> {
        let admin = env.storage().instance().get(&DataKey::UpgradeAdmin);
        extend_instance_ttl(&env);
        admin
    }

    /// Begin a two-step, time-delayed transfer of upgrade-admin authority
    /// (#463). The current admin remains fully authoritative until
    /// `candidate` calls `accept_admin_transfer`, and only after `delay_secs`
    /// (floored at `shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS`) has
    /// elapsed. This replaces the old `set_upgrade_admin`, which transferred
    /// authority instantly and irreversibly in a single call — a typo'd or
    /// compromised `next_admin` address had no recovery window.
    pub fn initiate_admin_transfer(
        env: Env,
        current_admin: Address,
        candidate: Address,
        delay_secs: u64,
    ) -> Result<(), RegistryError> {
        current_admin.require_auth();
        require_upgrade_admin(&env, &current_admin)?;

        if delay_secs < MIN_ADMIN_TRANSFER_DELAY_SECS {
            return Err(RegistryError::InvalidTransferDelay);
        }

        let now = env.ledger().timestamp();
        let pending = PendingAdminTransfer {
            candidate,
            initiated_at: now,
            accept_after: now + delay_secs,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingAdminTransfer, &pending);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Complete a pending admin-authority transfer initiated by
    /// `initiate_admin_transfer`. Only the nominated candidate may call
    /// this, and only once the configured delay has elapsed.
    pub fn accept_admin_transfer(env: Env, candidate: Address) -> Result<(), RegistryError> {
        candidate.require_auth();

        let pending: PendingAdminTransfer = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdminTransfer)
            .ok_or(RegistryError::NoPendingAdminTransfer)?;

        if pending.candidate != candidate {
            return Err(RegistryError::NotAuthorized);
        }
        if env.ledger().timestamp() < pending.accept_after {
            return Err(RegistryError::TransferDelayNotElapsed);
        }

        env.storage()
            .instance()
            .set(&DataKey::UpgradeAdmin, &candidate);
        env.storage().instance().remove(&DataKey::PendingAdminTransfer);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Cancel a pending admin-authority transfer before it's accepted —
    /// e.g. after nominating the wrong address. Callable by the current
    /// admin only.
    pub fn cancel_admin_transfer(env: Env, current_admin: Address) -> Result<(), RegistryError> {
        current_admin.require_auth();
        require_upgrade_admin(&env, &current_admin)?;

        if !env.storage().instance().has(&DataKey::PendingAdminTransfer) {
            return Err(RegistryError::NoPendingAdminTransfer);
        }
        env.storage().instance().remove(&DataKey::PendingAdminTransfer);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Return the pending admin transfer, if one is in progress.
    pub fn get_pending_admin_transfer(env: Env) -> Option<PendingAdminTransfer> {
        let pending = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdminTransfer);
        extend_instance_ttl(&env);
        pending
    }

    /// Apply a Soroban WASM upgrade, controlled by an upgrade admin.
    pub fn upgrade(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), RegistryError> {
        admin.require_auth();
        require_upgrade_admin(&env, &admin)?;
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }
}

fn validate_metadata_uri(metadata_uri: &String) -> Result<(), RegistryError> {
    let byte_len = metadata_uri.to_bytes().len();
    if byte_len == 0 {
        return Err(RegistryError::EmptyMetadataUri);
    }
    if byte_len > MAX_METADATA_URI_LEN {
        return Err(RegistryError::MetadataUriTooLong);
    }
    Ok(())
}

fn validate_quotes(quotes: &Vec<AssetQuote>) -> Result<(), RegistryError> {
    let len = quotes.len();
    if len == 0 {
        return Err(RegistryError::EmptyQuotes);
    }
    if len > MAX_QUOTES_PER_MATERIAL {
        return Err(RegistryError::TooManyQuotes);
    }

    let mut index = 0;
    while index < len {
        let quote = quotes.get_unchecked(index);
        if quote.amount <= 0 {
            return Err(RegistryError::InvalidQuoteAmount);
        }

        let mut other = index + 1;
        while other < len {
            if quote.asset == quotes.get_unchecked(other).asset {
                return Err(RegistryError::DuplicateQuoteAsset);
            }
            other += 1;
        }

        index += 1;
    }

    Ok(())
}

fn validate_payout_shares(payout_shares: &Vec<PayoutShare>) -> Result<(), RegistryError> {
    let len = payout_shares.len();
    if len == 0 {
        return Err(RegistryError::EmptyPayoutShares);
    }
    if len > MAX_PAYOUT_RECIPIENTS {
        return Err(RegistryError::TooManyPayoutShares);
    }

    let mut total_share_bps = 0u32;
    let mut index = 0;
    while index < len {
        let share = payout_shares.get_unchecked(index);
        if share.share_bps == 0 || share.share_bps > BASIS_POINTS {
            return Err(RegistryError::InvalidPayoutShare);
        }

        total_share_bps = total_share_bps
            .checked_add(share.share_bps)
            .ok_or(RegistryError::InvalidPayoutShareSum)?;

        let mut other = index + 1;
        while other < len {
            if share.recipient == payout_shares.get_unchecked(other).recipient {
                return Err(RegistryError::DuplicatePayoutRecipient);
            }
            other += 1;
        }

        index += 1;
    }

    if total_share_bps != BASIS_POINTS {
        return Err(RegistryError::InvalidPayoutShareSum);
    }

    Ok(())
}

fn derive_material_id(env: &Env, creator: &Address, nonce: u64) -> BytesN<32> {
    let mut seed = creator.to_xdr(env);
    seed.append(&nonce.to_xdr(env));
    env.crypto().sha256(&seed).to_bytes()
}

fn get_creator_nonce(env: &Env, creator: &Address) -> u64 {
    let key = DataKey::CreatorNonce(creator.clone());
    let nonce = env.storage().persistent().get(&key).unwrap_or(0);
    if env.storage().persistent().has(&key) {
        extend_persistent_ttl(env, &key);
    }
    nonce
}

fn set_creator_nonce(env: &Env, creator: &Address, nonce: u64) {
    let key = DataKey::CreatorNonce(creator.clone());
    env.storage().persistent().set(&key, &nonce);
    extend_persistent_ttl(env, &key);
}

fn has_material(env: &Env, material_id: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::MaterialCore(material_id.clone()))
}

/// Reassembles the public `MaterialRecord` from its two on-ledger parts.
/// `material_id` is attached from the lookup key rather than being stored.
/// Extends both parts' TTL on every successful read — the primary organic
/// renewal path for materials that are still being actively browsed/bought.
fn get_material_record(
    env: &Env,
    material_id: &BytesN<32>,
) -> Result<MaterialRecord, RegistryError> {
    let core_key = DataKey::MaterialCore(material_id.clone());
    let sale_key = DataKey::MaterialSale(material_id.clone());
    let core: MaterialCore = env
        .storage()
        .persistent()
        .get(&core_key)
        .ok_or(RegistryError::MaterialNotFound)?;
    let sale: MaterialSaleState = env
        .storage()
        .persistent()
        .get(&sale_key)
        .ok_or(RegistryError::MaterialNotFound)?;
    extend_persistent_ttl(env, &core_key);
    extend_persistent_ttl(env, &sale_key);

    Ok(MaterialRecord {
        material_id: material_id.clone(),
        creator: core.creator,
        metadata_uri: core.metadata_uri,
        metadata_hash: core.metadata_hash,
        rights_hash: core.rights_hash,
        paused: sale.paused,
        status: sale.status,
        quotes: sale.quotes,
        payout_shares: sale.payout_shares,
        created_ledger: core.created_ledger,
        updated_ledger: sale.updated_ledger,
    })
}

fn sale_state_from_record(record: &MaterialRecord) -> MaterialSaleState {
    MaterialSaleState {
        paused: record.paused,
        status: record.status,
        quotes: record.quotes.clone(),
        payout_shares: record.payout_shares.clone(),
        updated_ledger: record.updated_ledger,
    }
}

fn put_material_core(env: &Env, material_id: &BytesN<32>, core: &MaterialCore) {
    let key = DataKey::MaterialCore(material_id.clone());
    env.storage().persistent().set(&key, core);
    extend_persistent_ttl(env, &key);
}

fn put_material_sale(env: &Env, material_id: &BytesN<32>, sale: &MaterialSaleState) {
    let key = DataKey::MaterialSale(material_id.clone());
    env.storage().persistent().set(&key, sale);
    extend_persistent_ttl(env, &key);
}

// ============== TTL Renewal (#464) ==============

/// Extends `key`'s persistent-storage TTL back out to the network maximum
/// whenever it has dropped below half of that maximum. Safe and cheap to
/// call on every read and write of a tracked key — a no-op when the TTL is
/// already healthy.
fn extend_persistent_ttl<K: IntoVal<Env, Val>>(env: &Env, key: &K) {
    let max_ttl = env.storage().max_ttl();
    env.storage()
        .persistent()
        .extend_ttl(key, max_ttl / TTL_RENEWAL_DIVISOR, max_ttl);
}

/// Extends the contract instance's TTL — and therefore everything stored in
/// instance storage alongside it (`UpgradeAdmin`, the maintenance counters)
/// — back out to the network maximum whenever it has dropped below half of
/// that maximum. Cheap to call from every entrypoint that touches admin
/// state, since almost every invocation does.
fn extend_instance_ttl(env: &Env) {
    let max_ttl = env.storage().max_ttl();
    env.storage()
        .instance()
        .extend_ttl(max_ttl / TTL_RENEWAL_DIVISOR, max_ttl);
}

/// Appends `material_id` to the maintenance index and bumps the instance-
/// stored count, so `extend_materials_ttl` can page through every
/// registered material without needing any off-chain enumeration.
fn index_material(env: &Env, material_id: &BytesN<32>) {
    let count: u64 = env
        .storage()
        .instance()
        .get(&DataKey::MaterialCount)
        .unwrap_or(0);
    let index_key = DataKey::MaterialIndex(count);
    env.storage().persistent().set(&index_key, material_id);
    extend_persistent_ttl(env, &index_key);
    env.storage()
        .instance()
        .set(&DataKey::MaterialCount, &(count + 1));
    extend_instance_ttl(env);
}

/// Appends `asset` to the allowlist maintenance index and bumps the
/// instance-stored count. Only called the first time an asset is added to
/// the allowlist — subsequent `set_asset_allowed` calls for the same asset
/// update its value in place without growing the index.
fn index_allowed_asset(env: &Env, asset: &Address) {
    let count: u64 = env
        .storage()
        .instance()
        .get(&DataKey::AllowedAssetCount)
        .unwrap_or(0);
    let index_key = DataKey::AllowedAssetIndex(count);
    env.storage().persistent().set(&index_key, asset);
    extend_persistent_ttl(env, &index_key);
    env.storage()
        .instance()
        .set(&DataKey::AllowedAssetCount, &(count + 1));
    extend_instance_ttl(env);
}

fn require_upgrade_admin(env: &Env, candidate: &Address) -> Result<(), RegistryError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::UpgradeAdmin)
        .ok_or(RegistryError::NotAuthorized)?;
    extend_instance_ttl(env);
    if admin != *candidate {
        return Err(RegistryError::NotAuthorized);
    }
    Ok(())
}

fn require_creator_or_upgrade_admin(
    env: &Env,
    creator: &Address,
    actor: &Address,
) -> Result<(), RegistryError> {
    #[cfg(feature = "seeded-defects")]
    {
        return Ok(());
    }
    actor.require_auth();
    if actor == creator {
        return Ok(());
    }
    require_upgrade_admin(env, actor)
}

// ============== Asset Allowlist Internals ==============

fn get_allowed_asset_info(env: &Env, asset: &Address) -> Option<AssetPolicyInfo> {
    let key = DataKey::AllowedAsset(asset.clone());
    let info = env.storage().persistent().get(&key);
    if info.is_some() {
        extend_persistent_ttl(env, &key);
    }
    info
}

/// Validate that every asset referenced in `quotes` is present in the
/// allowlist and currently enabled. Callers must ensure the contract has
/// been initialized (an upgrade-admin exists) before calling this — this
/// function no longer bypasses validation for a pre-initialization state,
/// since `register_material` and `update_sale_terms` are only reachable
/// after `initialize` has run (#462).
fn validate_quote_assets(env: &Env, quotes: &Vec<AssetQuote>) -> Result<(), RegistryError> {
    let mut index = 0;
    while index < quotes.len() {
        let quote = quotes.get_unchecked(index);
        let approved = get_allowed_asset_info(env, &quote.asset)
            .map(|i| i.enabled)
            .unwrap_or(false);
        if !approved {
            return Err(RegistryError::UnapprovedAsset);
        }
        index += 1;
    }
    Ok(())
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod fuzz;

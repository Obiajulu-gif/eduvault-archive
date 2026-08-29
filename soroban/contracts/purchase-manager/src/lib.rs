#![no_std]

use shared_interface::{PendingAdminTransfer, MIN_ADMIN_TRANSFER_DELAY_SECS};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN,
    Env, IntoVal, String, Symbol, Val, Vec,
};

pub mod auth;

const BASIS_POINTS: u32 = 10_000;
const MAX_PLATFORM_FEE_BPS: u32 = 1_000;
const MAX_PAYOUT_RECIPIENTS: u32 = 5;
const ESCROW_LOCK_PERIOD_LEDGERS: u32 = 35_000;
const DISPUTE_WINDOW_LEDGERS: u32 = 30_000;

/// Maximum number of recipients allowed in a single bulk-license purchase.
/// Capped at 50 to stay within Soroban transaction resource limits while
/// still covering typical school/class sizes. Each recipient creates a
/// persistent-storage entitlement entry and an escrow record, so the
/// budget must account for ~2*N writes plus N+1 token transfers.
const MAX_BULK_LICENSE_RECIPIENTS: u32 = 50;

/// Maximum number of active scholarship grants a single learner may hold
/// simultaneously. Keeps bounded iteration during redemption within
/// Soroban resource limits.
const MAX_ACTIVE_SCHOLARSHIP_GRANTS: u32 = 50;

/// TTL renewal policy (#464): whenever a tracked entry's remaining TTL drops
/// below half of the network's configured maximum, extend it back out to
/// the maximum. See ../../docs/ttl-operations.md for the operational
/// rationale, renewal cadence, and alert thresholds.
const TTL_RENEWAL_DIVISOR: u32 = 2;

/// Upper bound on how many records a single maintenance call will touch, so
/// a TTL-renewal sweep can never exceed a transaction's resource limits
/// regardless of what a caller passes as `limit`. Mirrors the same
/// footprint-budget reasoning as material-registry's constant of the same
/// name — verified directly by this contract's maintenance-sweep tests.
const MAX_MAINTENANCE_BATCH: u32 = 25;

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
/// - `Native`           – XLM (the Stellar native asset, wrapped via its SAC).
/// - `Token`            – Any SAC-wrapped token such as USDC or EURC.
/// - `CreatorToken`     – A creator-specific SAC token (e.g., a course-access token minted by a creator).
/// - `InstitutionAsset`  – Institution-issued access assets for granting bulk or targeted access.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssetKind {
    Native = 0,
    Token = 1,
    CreatorToken = 2,
    InstitutionAsset = 3,
}

/// Settlement state machine for a purchase.
///
/// Each purchase reaches exactly one terminal settlement state.
/// - `Pending`:   After purchase, escrow locked, entitlement active.
/// - `Released`:  Escrow released to creator (terminal). Entitlement stays active.
/// - `Disputed`:  Buyer opened a dispute before lock period expired.
/// - `Refunded`:  Buyer refunded, entitlement revoked (terminal).
/// - `Expired`:   Timeout reached without action (terminal).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettlementState {
    Pending = 0,
    Released = 1,
    Disputed = 2,
    Refunded = 3,
    Expired = 4,
}

/// Resolution applied by admin when closing a dispute.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DisputeResolution {
    /// Not yet resolved (default/unresolved state).
    Unresolved = 0,
    /// Refund the buyer and revoke entitlement.
    RefundBuyer = 1,
    /// Release funds to the creator, keep entitlement active.
    ReleaseToCreator = 2,
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

/// Platform configuration stored in PurchaseManager
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformConfig {
    pub registry: Address,
    pub treasury: Address,
    pub platform_fee_bps: u32,
    pub paused: bool,
    /// Optional price-oracle address for future cross-asset conversion support.
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

/// Immutable material metadata captured at purchase time (#667).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PurchaseSnapshot {
    pub material_id: BytesN<32>,
    pub metadata_uri: String,
    pub metadata_hash: BytesN<32>,
    pub rights_hash: BytesN<32>,
    pub sale_terms_version: u32,
    pub purchase_ledger: u32,
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
    pub claimed: bool,
}

/// Settlement record tracking the lifecycle state of a purchase.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementRecord {
    pub purchase_id: u64,
    pub state: SettlementState,
    pub disputed_ledger: Option<u32>,
    pub resolved_ledger: Option<u32>,
    pub refunded_amount: i128,
}

/// Dispute record with details about an opened dispute.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeRecord {
    pub purchase_id: u64,
    pub opener: Address,
    pub reason: Bytes,
    pub opened_ledger: u32,
    /// Resolution status: `Unresolved` = pending, `RefundBuyer` or `ReleaseToCreator` = resolved.
    pub resolution: DisputeResolution,
    pub resolved_ledger: Option<u32>,
}

/// Result returned by a successful bulk-license purchase.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BulkLicensePurchaseResult {
    pub material_id: BytesN<32>,
    pub purchaser: Address,
    pub recipient_count: u32,
    pub unit_price: i128,
    pub total_paid: i128,
    pub first_purchase_id: u64,
}

// ============== Scholarship Credit Types ==============

/// A single scholarship credit grant issued to a learner by an authorized
/// issuer. Each grant tracks its own remaining balance, issuance metadata,
/// and optional expiry so that credits can be consumed deterministically
/// (earliest-expiry-first) and audited after revocation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScholarshipCreditGrant {
    pub grant_id: u64,
    pub learner: Address,
    pub issuer: Address,
    pub total_credits: i128,
    pub remaining_credits: i128,
    pub issued_at: u32,
    pub expires_at: Option<u32>,
    pub active: bool,
}

/// Record of a scholarship credit redemption against a specific material.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScholarshipRedemptionRecord {
    pub redemption_id: u64,
    pub learner: Address,
    pub material_id: BytesN<32>,
    pub credits_used: i128,
    pub redeemed_at: u32,
}

/// Structured result returned by a successful scholarship redemption.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScholarshipRedemptionResult {
    pub redemption_id: u64,
    pub material_id: BytesN<32>,
    pub learner: Address,
    pub credits_used: i128,
    pub remaining_credits: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BulkRefundResult {
    pub material_id: BytesN<32>,
    pub purchaser: Address,
    pub refunded_count: u32,
    pub skipped_count: u32,
    pub total_refund_amount: i128,
    pub asset: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BulkPurchaseRecord {
    pub purchaser: Address,
    pub material_id: BytesN<32>,
    pub first_purchase_id: u64,
    pub recipient_count: u32,
    pub unit_price: i128,
    pub asset: Address,
}

/// Result of a single purchase refund operation (internal helper)
#[derive(Clone, Debug, Eq, PartialEq)]
struct SingleRefundResult {
    pub refunded: bool,
    pub refund_amount: i128,
    pub reason_skipped: Option<&'static str>,
}

/// Data keys for contract storage
#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// Instance storage (#464 Tier A) — shares the contract instance's own
    /// TTL, so it never needs independent renewal.
    PlatformConfig,
    PurchaseNonce,
    PendingAdmin,
    AllowedAsset(Address),
    Entitlement((BytesN<32>, Address)),
    Escrow(u64),
    Settlement(u64),
    Dispute(u64),
    PurchaseBuyer(u64),
    /// Current refund signer version (#666): refund authorization payloads
    /// carry the version they were signed under; bumping this key disables
    /// all older signer versions without touching valid historical records.
    RefundSignerVersion,
    /// Pending mobile checkout attempt (#684): `(buyer, material_id)` ->
    /// pending attempt state so an interrupted wallet signing can be resumed
    /// or safely cancelled, and duplicates are blocked while pending.
    PendingCheckout((Address, BytesN<32>)),
    /// The sale-terms version a buyer's quote was rendered at (#681):
    /// `(buyer, material_id)` -> u32. Compared against the registry's current
    /// version at purchase time; a mismatch rejects the stale quote.
    QuotedSaleTermsVersion((Address, BytesN<32>)),
    /// The admin address that called `transfer_admin`, so `accept_admin` can
    /// revoke that specific admin's role once the transfer completes (#463).
    PendingAdminFrom,
    CreatorTier(Address),
    /// Maintenance index (#464): sequential slot -> (purchase_id,
    /// material_id, buyer), populated at purchase time so
    /// `extend_purchases_ttl` can renew both the `Escrow` and `Entitlement`
    /// halves of a purchase together without off-chain enumeration.
    PurchaseIndex(u64),
    /// Instance storage: total number of `PurchaseIndex` slots populated.
    PurchaseIndexCount,
    /// Maintenance index (#464): sequential slot -> asset address.
    AllowedAssetIndex(u64),
    /// Instance storage: total number of `AllowedAssetIndex` slots populated.
    AllowedAssetIndexCount,
    /// Maintenance index (#464): sequential slot -> creator address.
    CreatorTierIndex(u64),
    /// Immutable purchase metadata snapshot (#667).
    PurchaseSnapshot(u64),
    /// Instance storage: total number of `CreatorTierIndex` slots populated.
    CreatorTierIndexCount,
    /// Instance storage: total number of `auth::AuthDataKey::AdminRoleIndex`
    /// slots populated. Lives here (rather than in `auth`) purely so every
    /// maintenance counter is defined in one place; the index entries
    /// themselves stay in `auth`'s own storage namespace.
    AdminRoleIndexCount,
    /// Bulk purchase correlation: `BulkPurchase(purchaser, material_id)` -> 
    /// `(first_purchase_id, recipient_count)` to enable batch operations.
    BulkPurchase((Address, BytesN<32>)),

    // ============== Scholarship Credit Storage ==============
    /// Monotonic nonce for generating unique scholarship grant IDs.
    ScholarshipGrantNonce,
    /// Monotonic nonce for generating unique scholarship redemption IDs.
    ScholarshipRedemptionNonce,
    /// Individual grant record: `ScholarshipGrant(u64)` -> `ScholarshipCreditGrant`
    ScholarshipGrant(u64),
    /// Aggregate spendable credit balance for a learner.
    ScholarshipBalance(Address),
    /// Per-material scholarship credit cost: `ScholarshipCreditCost(material_id)` -> `i128`
    ScholarshipCreditCost(BytesN<32>),
    /// Redemption record keyed by (learner, material_id) for duplicate prevention.
    ScholarshipRedemption((Address, BytesN<32>)),
    /// List of active grant IDs belonging to a learner.
    ScholarshipGrantsForLearner(Address),
    /// Whether a given address is an authorized scholarship issuer.
    ScholarshipIssuer(Address),
    /// Maintenance index: sequential slot -> issuer address.
    ScholarshipIssuerIndex(u64),
    /// Instance storage: total ScholarshipIssuerIndex slots populated.
    ScholarshipIssuerIndexCount,
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
    EscrowAlreadyClaimed = 51,

    // Admin transfer errors
    NoPendingAdminTransfer = 60,
    /// `accept_admin` called before the configured transfer delay elapsed.
    TransferDelayNotElapsed = 61,
    /// `transfer_admin` called with a delay shorter than
    /// `shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS`.
    InvalidTransferDelay = 62,

    // Settlement / Dispute errors
    SettlementNotPending = 70,
    DisputeWindowExpired = 71,
    DisputeAlreadyExists = 72,
    NoActiveDispute = 73,
    DisputeNotResolved = 74,
    InvalidDisputeReason = 75,
    PurchaseAlreadySettled = 76,
    RefundNotAllowed = 77,
    InsufficientEscrowBalance = 78,

    // Bulk licensing errors
    EmptyRecipientList = 80,
    TooManyRecipients = 81,
    DuplicateRecipient = 82,
    ArithmeticOverflow = 83,

    // Scholarship credit errors
    InvalidCreditAmount = 90,
    InvalidCreditCost = 91,
    InsufficientScholarshipCredits = 92,
    ScholarshipGrantNotFound = 93,
    ScholarshipGrantExpired = 94,
    ScholarshipGrantInactive = 95,
    GrantAlreadyProcessed = 96,
    ContentNotScholarshipEligible = 97,
    RedemptionAlreadyExists = 98,
    InvalidExpiry = 99,
    TooManyActiveGrants = 100,

    // Quote invalidation (#681)
    StaleSaleTermsQuote = 110,
    StaleQuoteAsset = 111,

    // Refund signer versioning (#666)
    RefundAuthorizationExpired = 120,
    RefundSignerDisabled = 121,
    RefundSignerVersionMismatch = 122,

    // Entitlement reconciliation (#665)
    EntitlementStale = 130,
    EntitlementRevoked = 131,

    // Mobile checkout recovery (#684)
    CheckoutPending = 140,
    CheckoutNotFound = 141,
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
    pub metadata_hash: BytesN<32>,
    pub rights_hash: BytesN<32>,
    pub sale_terms_version: u32,
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

/// Event: dispute.opened
#[contractevent(topics = ["dispute", "opened"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeOpenedEvent {
    #[topic]
    pub purchase_id: u64,
    #[topic]
    pub material_id: BytesN<32>,
    #[topic]
    pub opener: Address,
    pub reason: Bytes,
    pub opened_ledger: u32,
}

/// Event: dispute.resolved
#[contractevent(topics = ["dispute", "resolved"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeResolvedEvent {
    #[topic]
    pub purchase_id: u64,
    #[topic]
    pub material_id: BytesN<32>,
    pub resolution: DisputeResolution,
    pub resolved_ledger: u32,
}

/// Event: purchase.refunded
#[contractevent(topics = ["purchase", "refunded"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PurchaseRefundedEvent {
    #[topic]
    pub purchase_id: u64,
    #[topic]
    pub material_id: BytesN<32>,
    #[topic]
    pub buyer: Address,
    pub asset: Address,
    pub refund_amount: i128,
    pub entitlement_revoked: bool,
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

/// Event: purchase.bulk_completed
#[contractevent(topics = ["purchase", "bulk_completed"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BulkPurchaseCompletedEvent {
    #[topic]
    pub purchaser: Address,
    #[topic]
    pub material_id: BytesN<32>,
    pub recipient_count: u32,
    pub unit_price: i128,
    pub total_paid: i128,
    pub asset: Address,
}

// ============== Scholarship Credit Events ==============

/// Event: scholarship.credits_issued
#[contractevent(topics = ["scholarship", "credits_issued"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScholarshipCreditsIssuedEvent {
    #[topic]
    pub grant_id: u64,
    #[topic]
    pub learner: Address,
    pub issuer: Address,
    pub amount: i128,
    pub expires_at: Option<u32>,
}

/// Event: scholarship.credits_redeemed
#[contractevent(topics = ["scholarship", "credits_redeemed"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScholarshipCreditsRedeemedEvent {
    #[topic]
    pub redemption_id: u64,
    #[topic]
    pub learner: Address,
    #[topic]
    pub material_id: BytesN<32>,
    pub credits_used: i128,
    pub remaining_credits: i128,
}

/// Event: scholarship.grant_revoked
#[contractevent(topics = ["scholarship", "grant_revoked"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScholarshipGrantRevokedEvent {
    #[topic]
    pub grant_id: u64,
    #[topic]
    pub learner: Address,
    pub issuer: Address,
    pub credits_revoked: i128,
}

/// Event: scholarship.cost_updated
#[contractevent(topics = ["scholarship", "cost_updated"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScholarshipCostUpdatedEvent {
    #[topic]
    pub material_id: BytesN<32>,
    pub credit_cost: i128,
}

/// Event: scholarship.issuer_updated
#[contractevent(topics = ["scholarship", "issuer_updated"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScholarshipIssuerUpdatedEvent {
    #[topic]
    pub issuer: Address,
    pub enabled: bool,
}

/// The PurchaseManager contract
#[contract]
pub struct PurchaseManager;

// ============== SAC Token Interface (SEP-41) ==============

/// Wrapper around a Stellar Asset Contract (SAC) address that exposes the
/// SEP-41 token interface methods needed by the purchase flow.
pub struct SacToken<'a> {
    env: &'a Env,
    address: &'a Address,
}

impl<'a> SacToken<'a> {
    pub fn new(env: &'a Env, address: &'a Address) -> Self {
        SacToken { env, address }
    }

    /// Transfer `amount` tokens from `from` to `to`.
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
    pub fn balance(&self, id: &Address) -> i128 {
        let func = Symbol::new(self.env, "balance");
        let args = Vec::from_array(self.env, [id.into_val(self.env)]);
        self.env.invoke_contract::<i128>(self.address, &func, args)
    }
}

// ============== Price Oracle Stub ==============

/// Stub for a future price-oracle integration (e.g. Reflector Oracle / SEP-40).
pub struct PriceOracle<'a> {
    env: &'a Env,
    address: &'a Address,
}

impl<'a> PriceOracle<'a> {
    pub fn new(env: &'a Env, address: &'a Address) -> Self {
        PriceOracle { env, address }
    }

    pub fn last_price(&self, _base: &Address, _quote: &Address) -> Option<(i128, u32)> {
        let _ = (self.env, self.address);
        None
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

    fn get_material_immutable(
        &self,
        env: &Env,
        material_id: &BytesN<32>,
    ) -> Result<MaterialImmutableSnapshot, PurchaseError>;

    /// Sale-terms version (#681): bumped by the registry on every
    /// `update_sale_terms`; used to reject stale buyer quotes.
    fn get_sale_terms_version(
        &self,
        env: &Env,
        material_id: &BytesN<32>,
    ) -> Result<u32, PurchaseError>;
}

/// Immutable metadata anchors returned by the registry (#667).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialImmutableSnapshot {
    pub metadata_uri: String,
    pub metadata_hash: BytesN<32>,
    pub rights_hash: BytesN<32>,
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

    fn get_material_immutable(
        &self,
        env: &Env,
        material_id: &BytesN<32>,
    ) -> Result<MaterialImmutableSnapshot, PurchaseError> {
        let func = Symbol::new(env, "get_material_immutable");
        let result: Result<MaterialImmutableSnapshot, PurchaseError> = env.invoke_contract(
            self,
            &func,
            Vec::from_array(env, [material_id.into_val(env)]),
        );
        result.map_err(|_| PurchaseError::RegistryCallFailed)
    }

    fn get_sale_terms_version(
        &self,
        env: &Env,
        material_id: &BytesN<32>,
    ) -> Result<u32, PurchaseError> {
        let func = Symbol::new(env, "get_sale_terms_version");
        let result: Result<u32, PurchaseError> = env.invoke_contract(
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
    pub fn initialize(
        env: Env,
        admin: Address,
        registry: Address,
        treasury: Address,
        platform_fee_bps: u32,
    ) -> Result<(), PurchaseError> {
        admin.require_auth();

        // Check if already initialized
        if env.storage().instance().has(&DataKey::PlatformConfig) {
            return Err(PurchaseError::AlreadyInitialized);
        }

        if platform_fee_bps > MAX_PLATFORM_FEE_BPS {
            return Err(PurchaseError::InvalidPlatformFee);
        }

        if treasury == env.current_contract_address() {
            return Err(PurchaseError::InvalidTreasury);
        }

        let config = PlatformConfig {
            registry,
            treasury: treasury.clone(),
            platform_fee_bps,
            paused: false,
            oracle: None,
        };

        auth::set_admin_role(&env, &admin);
        put_platform_config(&env, &config);
        env.storage().instance().set(&DataKey::PurchaseNonce, &0u64);
        extend_instance_ttl(&env);

        PlatformConfigUpdatedEvent {
            treasury,
            platform_fee_bps,
            paused: false,
        }
        .publish(&env);

        Ok(())
    }

    /// Execute a purchase for a material
    pub fn purchase(
        env: Env,
        buyer: Address,
        material_id: BytesN<32>,
        asset: Address,
        expected_amount: i128,
        transaction_id: Bytes,
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

        // Mobile checkout recovery (#684): a pending attempt blocks duplicate
        // submission until it is resumed or cancelled.
        let checkout_key = DataKey::PendingCheckout((buyer.clone(), material_id.clone()));
        if env.storage().instance().has(&checkout_key) {
            return Err(PurchaseError::CheckoutPending);
        }

        let material: MaterialRecord = config
            .registry
            .get_material(&env, &material_id)
            .map_err(|_| PurchaseError::MaterialNotFound)?;

        if material.status != MaterialStatus::Active || material.paused {
            return Err(PurchaseError::MaterialNotActive);
        }

        let quote = find_quote(&material.quotes, &asset)
            .ok_or(PurchaseError::AssetNotAcceptedForMaterial)?;

        if quote.amount != expected_amount {
            return Err(PurchaseError::InvalidQuoteAmount);
        }
        if quote.amount <= 0 {
            return Err(PurchaseError::InvalidQuoteAmount);
        }

        // Bind the purchase to the current sale-terms version (#681): if the
        // creator changed price or asset since the buyer's quote was rendered,
        // the version moved and this attempt is rejected.
        let quoted_version: Option<u32> = env
            .storage()
            .instance()
            .get(&DataKey::QuotedSaleTermsVersion((buyer.clone(), material_id.clone())));
        if let Some(quoted) = quoted_version {
            let current = config.registry.get_sale_terms_version(&env, &material_id)?;
            if quoted != current {
                return Err(PurchaseError::StaleSaleTermsQuote);
            }
        }

        validate_payout_shares(&material.payout_shares)?;

        let gross = quote.amount;
        let effective_fee_bps =
            get_effective_fee_bps(&env, &material.creator, config.platform_fee_bps);
        let platform_fee = (gross * effective_fee_bps as i128) / BASIS_POINTS as i128;
        let seller_net = gross - platform_fee;

        let purchase_id = get_and_increment_purchase_nonce(&env)?;
        let current_ledger = env.ledger().sequence();
        let sale_terms_version = config.registry.get_sale_terms_version(&env, &material_id)?;
        let immutable = config
            .registry
            .get_material_immutable(&env, &material_id)?;

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
        index_purchase(&env, purchase_id, &material_id, &buyer);

        let snapshot = PurchaseSnapshot {
            material_id: material_id.clone(),
            metadata_uri: immutable.metadata_uri,
            metadata_hash: immutable.metadata_hash.clone(),
            rights_hash: immutable.rights_hash.clone(),
            sale_terms_version,
            purchase_ledger: current_ledger,
        };
        set_purchase_snapshot(&env, purchase_id, &snapshot);

        // Store purchase → buyer mapping for admin refunds
        env.storage()
            .persistent()
            .set(&DataKey::PurchaseBuyer(purchase_id), &buyer);

        // Initialize settlement record in Pending state
        let settlement = SettlementRecord {
            purchase_id,
            state: SettlementState::Pending,
            disputed_ledger: None,
            resolved_ledger: None,
            refunded_amount: 0,
        };
        set_settlement_record(&env, purchase_id, &settlement);

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
            metadata_hash: immutable.metadata_hash,
            rights_hash: immutable.rights_hash,
            sale_terms_version,
            transaction_id,
        }
        .publish(&env);

        // A completed purchase clears any pending mobile checkout state (#684).
        env.storage().instance().remove(&checkout_key);
        env.storage()
            .instance()
            .remove(&DataKey::QuotedSaleTermsVersion((buyer, material_id)));

        Ok(purchase_id)
    }

    /// Purchase licenses for multiple recipients in a single operation.
    ///
    /// The `purchaser` pays the aggregate cost for all recipients. Each
    /// recipient receives their own entitlement and escrow record. The
    /// operation is atomic: if any validation fails or any recipient is
    /// ineligible, the entire transaction is rejected and no tokens are
    /// transferred.
    ///
    /// # Arguments
    /// * `purchaser` - The address authorizing and paying for the licenses.
    /// * `material_id` - The educational material to license.
    /// * `asset` - The payment asset address.
    /// * `expected_unit_price` - Expected price per license (must match quote).
    /// * `transaction_id` - Off-chain transaction reference.
    /// * `recipients` - List of addresses to receive licenses.
    ///
    /// # Errors
    /// * `EmptyRecipientList` - recipients is empty
    /// * `TooManyRecipients` - recipients exceeds MAX_BULK_LICENSE_RECIPIENTS
    /// * `DuplicateRecipient` - same address appears twice in recipients
    /// * `EntitlementAlreadyExists` - any recipient already has an active license
    /// * `ContractPaused` - contract is paused
    /// * `MaterialNotActive` - material is not active
    /// * `AssetNotAllowed` - asset is not in the allowlist
    /// * `InvalidQuoteAmount` - expected_unit_price does not match the quote
    /// * `AssetNotAcceptedForMaterial` - asset not in material quotes
    /// * `ArithmeticOverflow` - total cost overflowed
    pub fn purchase_bulk_licenses(
        env: Env,
        purchaser: Address,
        material_id: BytesN<32>,
        asset: Address,
        expected_unit_price: i128,
        transaction_id: Bytes,
        recipients: Vec<Address>,
    ) -> Result<BulkLicensePurchaseResult, PurchaseError> {
        purchaser.require_auth();

        // Validate recipient list
        let recipient_count = recipients.len();
        if recipient_count == 0 {
            return Err(PurchaseError::EmptyRecipientList);
        }
        if recipient_count > MAX_BULK_LICENSE_RECIPIENTS {
            return Err(PurchaseError::TooManyRecipients);
        }

        // Check for duplicates
        let mut i = 0u32;
        while i < recipient_count {
            let addr_i = recipients.get_unchecked(i);
            let mut j = i + 1;
            while j < recipient_count {
                if addr_i == recipients.get_unchecked(j) {
                    return Err(PurchaseError::DuplicateRecipient);
                }
                j += 1;
            }
            i += 1;
        }

        // Platform and asset checks (before material fetch for cheap rejections)
        let config = get_platform_config(&env)?;
        if config.paused {
            return Err(PurchaseError::ContractPaused);
        }
        if !is_asset_allowed(&env, &asset) {
            return Err(PurchaseError::AssetNotAllowed);
        }

        // Fetch material and validate
        let material: MaterialRecord = config
            .registry
            .get_material(&env, &material_id)
            .map_err(|_| PurchaseError::MaterialNotFound)?;
        if material.status != MaterialStatus::Active || material.paused {
            return Err(PurchaseError::MaterialNotActive);
        }

        let quote = find_quote(&material.quotes, &asset)
            .ok_or(PurchaseError::AssetNotAcceptedForMaterial)?;
        if quote.amount != expected_unit_price || quote.amount <= 0 {
            return Err(PurchaseError::InvalidQuoteAmount);
        }

        validate_payout_shares(&material.payout_shares)?;

        // Check no recipient already has an active entitlement
        i = 0;
        while i < recipient_count {
            let recipient = recipients.get_unchecked(i);
            if has_entitlement_internal(&env, &material_id, &recipient) {
                return Err(PurchaseError::EntitlementAlreadyExists);
            }
            i += 1;
        }

        // Calculate total cost with checked arithmetic
        let recipient_count_i128 = recipient_count as i128;
        let total_amount = quote
            .amount
            .checked_mul(recipient_count_i128)
            .ok_or(PurchaseError::ArithmeticOverflow)?;
        if total_amount <= 0 {
            return Err(PurchaseError::ArithmeticOverflow);
        }

        // Payment: single aggregate transfer from purchaser
        let effective_fee_bps =
            get_effective_fee_bps(&env, &material.creator, config.platform_fee_bps);
        let total_platform_fee = (total_amount * effective_fee_bps as i128) / BASIS_POINTS as i128;
        let total_seller_net = total_amount - total_platform_fee;

        // Transfer platform fee
        if total_platform_fee > 0 {
            transfer_asset(
                &env,
                &purchaser,
                &config.treasury,
                &asset,
                total_platform_fee,
            )?;
        }

        // Transfer seller net to escrow (contract holds until release)
        if total_seller_net > 0 {
            transfer_asset(
                &env,
                &purchaser,
                &env.current_contract_address(),
                &asset,
                total_seller_net,
            )?;
        }

        let first_purchase_id = get_and_increment_purchase_nonce(&env)?;
        let current_ledger = env.ledger().sequence();

        // Grant entitlement and create escrow for each recipient
        let mut idx = 0u32;
        let mut current_purchase_id = first_purchase_id;
        while idx < recipient_count {
            let recipient = recipients.get_unchecked(idx);

            // Per-recipient escrow (individual purchase_id for dispute/refund tracking)
            let unit_platform_fee =
                (quote.amount * effective_fee_bps as i128) / BASIS_POINTS as i128;
            let unit_seller_net = quote.amount - unit_platform_fee;

            let escrow_record = EscrowRecord {
                purchase_id: current_purchase_id,
                material_id: material_id.clone(),
                asset: asset.clone(),
                total_amount: quote.amount,
                platform_fee: unit_platform_fee,
                seller_net: unit_seller_net,
                payout_shares: material.payout_shares.clone(),
                purchase_ledger: current_ledger,
                claimed: false,
            };
            set_escrow_record(&env, current_purchase_id, &escrow_record);

            // Entitlement for this recipient
            let entitlement = EntitlementRecord {
                material_id: material_id.clone(),
                buyer: recipient.clone(),
                active: true,
                purchase_id: current_purchase_id,
                asset: asset.clone(),
                amount: quote.amount,
                granted_ledger: current_ledger,
            };
            set_entitlement(&env, &entitlement);

            // Index for TTL maintenance
            index_purchase(&env, current_purchase_id, &material_id, &recipient);

            // Store purchase -> buyer mapping for admin refunds
            env.storage()
                .persistent()
                .set(&DataKey::PurchaseBuyer(current_purchase_id), &recipient);

            // Initialize settlement in Pending state
            let settlement = SettlementRecord {
                purchase_id: current_purchase_id,
                state: SettlementState::Pending,
                disputed_ledger: None,
                resolved_ledger: None,
                refunded_amount: 0,
            };
            set_settlement_record(&env, current_purchase_id, &settlement);

            current_purchase_id = current_purchase_id
                .checked_add(1)
                .ok_or(PurchaseError::ArithmeticOverflow)?;
            idx += 1;
        }

        // Immutable purchase metadata snapshot (#667): capture the same
        // sale-terms version and metadata/rights hashes the single-purchase
        // path records, so bulk-license purchase events are indexer-compatible.
        let sale_terms_version = config.registry.get_sale_terms_version(&env, &material_id)?;
        let immutable = config.registry.get_material_immutable(&env, &material_id)?;
        let metadata_hash = immutable.metadata_hash;
        let rights_hash = immutable.rights_hash;

        // Emit individual purchase completed events for indexer compatibility
        idx = 0;
        let mut event_purchase_id = first_purchase_id;
        while idx < recipient_count {
            let recipient = recipients.get_unchecked(idx);
            PurchaseCompletedEvent {
                purchase_id: event_purchase_id,
                material_id: material_id.clone(),
                buyer: recipient.clone(),
                seller: material.creator.clone(),
                asset: asset.clone(),
                amount: quote.amount,
                platform_fee: (quote.amount * effective_fee_bps as i128) / BASIS_POINTS as i128,
                seller_net_amount: quote.amount
                    - (quote.amount * effective_fee_bps as i128) / BASIS_POINTS as i128,
                entitlement_active: true,
                metadata_hash: metadata_hash.clone(),
                rights_hash: rights_hash.clone(),
                sale_terms_version,
                transaction_id: transaction_id.clone(),
            }
            .publish(&env);

            EscrowCreatedEvent {
                purchase_id: event_purchase_id,
                material_id: material_id.clone(),
                asset: asset.clone(),
                amount: quote.amount
                    - (quote.amount * effective_fee_bps as i128) / BASIS_POINTS as i128,
                lock_until_ledger: current_ledger + ESCROW_LOCK_PERIOD_LEDGERS,
            }
            .publish(&env);

            event_purchase_id = event_purchase_id
                .checked_add(1)
                .ok_or(PurchaseError::ArithmeticOverflow)?;
            idx += 1;
        }

        // Emit aggregate bulk-purchase event
        BulkPurchaseCompletedEvent {
            purchaser: purchaser.clone(),
            material_id: material_id.clone(),
            recipient_count,
            unit_price: quote.amount,
            total_paid: total_amount,
            asset: asset.clone(),
        }
        .publish(&env);

        // Store bulk purchase record for potential batch operations
        let bulk_record = BulkPurchaseRecord {
            purchaser: purchaser.clone(),
            material_id: material_id.clone(),
            first_purchase_id,
            recipient_count,
            unit_price: quote.amount,
            asset: asset.clone(),
        };
        let bulk_key = DataKey::BulkPurchase((purchaser.clone(), material_id.clone()));
        env.storage().persistent().set(&bulk_key, &bulk_record);
        extend_persistent_ttl(&env, &bulk_key);

        Ok(BulkLicensePurchaseResult {
            material_id,
            purchaser,
            recipient_count,
            unit_price: quote.amount,
            total_paid: total_amount,
            first_purchase_id,
        })
    }

    /// Check if a buyer has an active entitlement for a material
    pub fn has_entitlement(env: Env, material_id: BytesN<32>, buyer: Address) -> bool {
        has_entitlement_internal(&env, &material_id, &buyer)
    }

    /// Reconcile a buyer's cached entitlement against on-contract purchase
    /// state before a protected download (#665).
    ///
    /// A cached `active: true` entitlement can be stale: the settlement may
    /// have been refunded (entitlement revoked) or the purchase may not exist
    /// at all (missing indexer event). This returns the *safe* answer instead
    /// of trusting the cache: `true` only when the settlement exists and is
    /// still `Pending` with an active entitlement; otherwise a denied state
    /// with a stable error so a stale cache can never grant access silently.
    pub fn reconcile_entitlement(
        env: Env,
        material_id: BytesN<32>,
        buyer: Address,
    ) -> Result<bool, PurchaseError> {
        let key = DataKey::Entitlement((material_id.clone(), buyer.clone()));
        let entitlement: EntitlementRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PurchaseError::EntitlementRevoked)?;

        if !entitlement.active {
            return Err(PurchaseError::EntitlementRevoked);
        }

        // Verify the purchase's settlement is still Pending (not refunded or
        // released) — a revoked/refunded purchase must not authorize downloads.
        let settlement = get_settlement_record_internal(&env, entitlement.purchase_id)
            .ok_or(PurchaseError::EntitlementStale)?;
        if settlement.state != SettlementState::Pending {
            return Err(PurchaseError::EntitlementStale);
        }

        Ok(true)
    }

    /// Verify a refund authorization payload carrying a signer version and
    /// expiry (#666). The current signer version lives in instance storage;
    /// bumping it (via `set_refund_signer_version`) disables every older
    /// signer without breaking valid historical records. Replayed payloads
    /// are rejected by the expiry bound.
    pub fn verify_refund_authorization(
        env: Env,
        signer_version: u32,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<(), PurchaseError> {
        let current: u32 = env
            .storage()
            .instance()
            .get::<_, u32>(&DataKey::RefundSignerVersion)
            .unwrap_or(1);
        if signer_version != current {
            return Err(PurchaseError::RefundSignerVersionMismatch);
        }
        if signer_version < current {
            return Err(PurchaseError::RefundSignerDisabled);
        }
        let ledger_ts: u64 = env.ledger().timestamp();
        if ledger_ts < issued_at || ledger_ts > expires_at {
            return Err(PurchaseError::RefundAuthorizationExpired);
        }
        Ok(())
    }

    /// Set (or bump) the refund signer version (#666). A bump disables all
    /// authorizations signed with older versions — the compromise recovery
    /// workflow. Returns the new active version.
    pub fn set_refund_signer_version(env: Env, admin: Address, version: u32) -> Result<u32, PurchaseError> {
        auth::require_admin(&env, &admin)?;
        if version == 0 {
            return Err(PurchaseError::NotAuthorized);
        }
        env.storage()
            .instance()
            .set(&DataKey::RefundSignerVersion, &version);
        Ok(version)
    }

    /// Verify a buyer's quoted sale-terms version is still current (#681).
    /// Pass the version the buyer saw when the quote was rendered; after the
    /// creator updates price or asset, the registry's version is higher and
    /// the pending purchase attempt is rejected so the buyer re-quotes.
    pub fn verify_quote_version(
        env: Env,
        material_id: BytesN<32>,
        quoted_version: u32,
    ) -> Result<(), PurchaseError> {
        let config = get_platform_config(&env)?;
        let current: u32 = config
            .registry
            .get_sale_terms_version(&env, &material_id)
            .map_err(|_| PurchaseError::MaterialNotFound)?;
        if quoted_version != current {
            return Err(PurchaseError::StaleSaleTermsQuote);
        }
        Ok(())
    }

    /// Record the sale-terms version a buyer's quote was rendered at (#681).
    /// The buyer calls this (or the UI calls it) when a quote is shown; the
    /// version is then checked at purchase time so a creator-side terms
    /// update invalidates the pending purchase attempt.
    pub fn record_quote(
        env: Env,
        buyer: Address,
        material_id: BytesN<32>,
    ) -> Result<u32, PurchaseError> {
        buyer.require_auth();
        let config = get_platform_config(&env)?;
        let current = config
            .registry
            .get_sale_terms_version(&env, &material_id)
            .map_err(|_| PurchaseError::MaterialNotFound)?;
        env.storage().instance().set(
            &DataKey::QuotedSaleTermsVersion((buyer.clone(), material_id.clone())),
            &current,
        );
        Ok(current)
    }

    /// Begin a mobile checkout attempt (#684): records a pending state for
    /// `(buyer, material_id)` so an interrupted wallet signing can be resumed
    /// and duplicate submissions are blocked while pending.
    pub fn begin_checkout(
        env: Env,
        buyer: Address,
        material_id: BytesN<32>,
    ) -> Result<(), PurchaseError> {
        buyer.require_auth();
        let key = DataKey::PendingCheckout((buyer.clone(), material_id.clone()));
        if env.storage().instance().has(&key) {
            return Err(PurchaseError::CheckoutPending);
        }
        let ledger_ts: u64 = env.ledger().timestamp();
        env.storage().instance().set(&key, &ledger_ts);
        Ok(())
    }

    /// Cancel a pending mobile checkout attempt (#684). Safe to call after an
    /// interrupted wallet signing; a missing attempt is not an error (the
    /// purchase may have completed and already cleared it).
    pub fn cancel_checkout(
        env: Env,
        buyer: Address,
        material_id: BytesN<32>,
    ) -> Result<(), PurchaseError> {
        buyer.require_auth();
        let key = DataKey::PendingCheckout((buyer.clone(), material_id.clone()));
        env.storage().instance().remove(&key);
        Ok(())
    }

    /// Get entitlement details for a buyer and material
    pub fn get_entitlement(
        env: Env,
        material_id: BytesN<32>,
        buyer: Address,
    ) -> Option<EntitlementRecord> {
        get_entitlement_internal(&env, &material_id, &buyer)
    }

    /// Immutable metadata snapshot captured at purchase time (#667).
    pub fn get_purchase_snapshot(env: Env, purchase_id: u64) -> Option<PurchaseSnapshot> {
        env.storage()
            .persistent()
            .get(&DataKey::PurchaseSnapshot(purchase_id))
    }

    /// Get current platform configuration
    pub fn get_platform_config(env: Env) -> Option<PlatformConfig> {
        get_platform_config(&env).ok()
    }

    /// Check if an asset is globally allowed for purchases
    pub fn is_asset_allowed(env: Env, asset: Address) -> bool {
        is_asset_allowed(&env, &asset)
    }

    /// Withdraw escrowed creator payout funds after the lock period expires.
    /// Only callable by a payout recipient (e.g., the creator).
    /// Transitions settlement from Pending → Released.
    pub fn withdraw_payouts(
        env: Env,
        caller: Address,
        purchase_id: u64,
    ) -> Result<(), PurchaseError> {
        caller.require_auth();

        let mut escrow =
            get_escrow_record_internal(&env, purchase_id).ok_or(PurchaseError::MaterialNotFound)?;

        if escrow.claimed {
            return Err(PurchaseError::EscrowAlreadyClaimed);
        }

        // Verify settlement is in Pending state (not disputed, refunded, or already released)
        let mut settlement = get_settlement_record_internal(&env, purchase_id)
            .ok_or(PurchaseError::SettlementNotPending)?;
        if settlement.state != SettlementState::Pending {
            return Err(PurchaseError::SettlementNotPending);
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

        // Transition settlement to Released
        settlement.state = SettlementState::Released;
        settlement.resolved_ledger = Some(current_ledger);
        set_settlement_record(&env, purchase_id, &settlement);

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
            // Also check settlement state — must be Pending
            if let Some(settlement) = get_settlement_record_internal(&env, purchase_id) {
                if settlement.state != SettlementState::Pending {
                    return false;
                }
            }
            let current_ledger = env.ledger().sequence();
            return current_ledger >= escrow.purchase_ledger + ESCROW_LOCK_PERIOD_LEDGERS;
        }
        false
    }

    // ============== Dispute Functions ==============

    /// Open a dispute on a purchase.
    ///
    /// Only the buyer who made the purchase can open a dispute.
    /// The dispute must be opened within the dispute window (before lock period expires).
    /// Transitions settlement from Pending → Disputed.
    pub fn open_dispute(
        env: Env,
        buyer: Address,
        purchase_id: u64,
        reason: Bytes,
    ) -> Result<(), PurchaseError> {
        buyer.require_auth();

        // Validate reason is not empty
        if reason.is_empty() {
            return Err(PurchaseError::InvalidDisputeReason);
        }

        let escrow =
            get_escrow_record_internal(&env, purchase_id).ok_or(PurchaseError::MaterialNotFound)?;

        // Verify the caller is the buyer who made the purchase
        let entitlement_key = DataKey::Entitlement((escrow.material_id.clone(), buyer.clone()));
        let entitlement: EntitlementRecord = env
            .storage()
            .persistent()
            .get(&entitlement_key)
            .ok_or(PurchaseError::NotAuthorized)?;

        if !entitlement.active {
            return Err(PurchaseError::NotAuthorized);
        }

        // Check no dispute already exists for this purchase (must be first)
        if env
            .storage()
            .persistent()
            .has(&DataKey::Dispute(purchase_id))
        {
            return Err(PurchaseError::DisputeAlreadyExists);
        }

        // Verify settlement is in Pending state
        let mut settlement = get_settlement_record_internal(&env, purchase_id)
            .ok_or(PurchaseError::SettlementNotPending)?;
        if settlement.state != SettlementState::Pending {
            return Err(PurchaseError::SettlementNotPending);
        }

        // Dispute must be opened within the dispute window
        let current_ledger = env.ledger().sequence();
        if current_ledger >= escrow.purchase_ledger + DISPUTE_WINDOW_LEDGERS {
            return Err(PurchaseError::DisputeWindowExpired);
        }

        // Create dispute record
        let dispute = DisputeRecord {
            purchase_id,
            opener: buyer.clone(),
            reason: reason.clone(),
            opened_ledger: current_ledger,
            resolution: DisputeResolution::Unresolved,
            resolved_ledger: None,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Dispute(purchase_id), &dispute);

        // Transition settlement to Disputed
        settlement.state = SettlementState::Disputed;
        settlement.disputed_ledger = Some(current_ledger);
        set_settlement_record(&env, purchase_id, &settlement);

        DisputeOpenedEvent {
            purchase_id,
            material_id: escrow.material_id.clone(),
            opener: buyer,
            reason,
            opened_ledger: current_ledger,
        }
        .publish(&env);

        Ok(())
    }

    /// Resolve an active dispute (admin only).
    ///
    /// - `RefundBuyer`: Refunds the buyer from escrow, revokes entitlement.
    /// - `ReleaseToCreator`: Releases funds to creator, keeps entitlement active.
    /// Transitions settlement from Disputed → Refunded or Disputed → Released.
    pub fn resolve_dispute(
        env: Env,
        admin: Address,
        purchase_id: u64,
        resolution: DisputeResolution,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let dispute: DisputeRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(purchase_id))
            .ok_or(PurchaseError::NoActiveDispute)?;

        // Dispute must not already be resolved
        if dispute.resolution != DisputeResolution::Unresolved {
            return Err(PurchaseError::DisputeNotResolved);
        }

        let mut settlement = get_settlement_record_internal(&env, purchase_id)
            .ok_or(PurchaseError::SettlementNotPending)?;
        if settlement.state != SettlementState::Disputed {
            return Err(PurchaseError::SettlementNotPending);
        }

        let mut escrow =
            get_escrow_record_internal(&env, purchase_id).ok_or(PurchaseError::MaterialNotFound)?;

        let current_ledger = env.ledger().sequence();

        match resolution {
            DisputeResolution::RefundBuyer => {
                // Use the shared refund logic
                let refund_result = perform_single_refund(&env, purchase_id)?;
                
                if !refund_result.refunded {
                    return Err(PurchaseError::InsufficientEscrowBalance);
                }

                // Update dispute record
                let mut updated_dispute = dispute.clone();
                updated_dispute.resolution = DisputeResolution::RefundBuyer;
                updated_dispute.resolved_ledger = Some(current_ledger);
                env.storage()
                    .persistent()
                    .set(&DataKey::Dispute(purchase_id), &updated_dispute);
            }
            DisputeResolution::ReleaseToCreator => {
                // Release funds to creator (same as withdraw_payouts)
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

                // Update settlement to Released
                settlement.state = SettlementState::Released;
                settlement.resolved_ledger = Some(current_ledger);
                set_settlement_record(&env, purchase_id, &settlement);

                // Update dispute record
                let mut updated_dispute = dispute.clone();
                updated_dispute.resolution = DisputeResolution::ReleaseToCreator;
                updated_dispute.resolved_ledger = Some(current_ledger);
                env.storage()
                    .persistent()
                    .set(&DataKey::Dispute(purchase_id), &updated_dispute);

                EscrowReleasedEvent {
                    purchase_id,
                    material_id: escrow.material_id.clone(),
                    asset: escrow.asset.clone(),
                    amount: escrow.seller_net,
                }
                .publish(&env);
            }
            DisputeResolution::Unresolved => {
                // Should never happen because input parameter should not be Unresolved
                return Err(PurchaseError::DisputeNotResolved);
            }
        }

        DisputeResolvedEvent {
            purchase_id,
            material_id: escrow.material_id,
            resolution,
            resolved_ledger: current_ledger,
        }
        .publish(&env);

        Ok(())
    }

    /// Admin-initiated refund for a purchase (without prior dispute).
    ///
    /// Only works when settlement is in Pending state.
    /// Transitions settlement from Pending → Refunded.
    /// Revokes entitlement and returns funds to buyer.
    /// Uses the stored PurchaseBuyer mapping to find the buyer.
    pub fn refund_purchase(
        env: Env,
        admin: Address,
        purchase_id: u64,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let refund_result = perform_single_refund(&env, purchase_id)?;
        
        if !refund_result.refunded {
            // Map the skip reasons to appropriate errors
            match refund_result.reason_skipped {
                Some("settlement_not_found") => return Err(PurchaseError::SettlementNotPending),
                Some("already_settled") => return Err(PurchaseError::RefundNotAllowed),
                Some("already_claimed") => return Err(PurchaseError::EscrowAlreadyClaimed),
                Some("buyer_not_found") | Some("entitlement_not_found") | Some("entitlement_inactive") => {
                    return Err(PurchaseError::NotAuthorized);
                }
                _ => return Err(PurchaseError::RefundNotAllowed),
            }
        }

        Ok(())
    }

    /// Refund a purchase to a specific buyer (admin only).
    ///
    /// This variant includes the buyer address explicitly for admin-initiated refunds.
    /// Transitions settlement from Pending → Refunded.
    pub fn refund_purchase_to_buyer(
        env: Env,
        admin: Address,
        purchase_id: u64,
        buyer: Address,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let refund_result = perform_single_refund(&env, purchase_id)?;
        
        if !refund_result.refunded {
            // Map the skip reasons to appropriate errors
            match refund_result.reason_skipped {
                Some("settlement_not_found") => return Err(PurchaseError::SettlementNotPending),
                Some("already_settled") => return Err(PurchaseError::RefundNotAllowed),
                Some("already_claimed") => return Err(PurchaseError::EscrowAlreadyClaimed),
                Some("buyer_not_found") | Some("entitlement_not_found") | Some("entitlement_inactive") => {
                    return Err(PurchaseError::NotAuthorized);
                }
                _ => return Err(PurchaseError::RefundNotAllowed),
            }
        }

        Ok(())
    }

    // ============== Settlement Query Functions ==============

    /// Get the settlement record for a purchase
    pub fn get_settlement(env: Env, purchase_id: u64) -> Option<SettlementRecord> {
        get_settlement_record_internal(&env, purchase_id)
    }

    /// Get the dispute record for a purchase
    pub fn get_dispute(env: Env, purchase_id: u64) -> Option<DisputeRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Dispute(purchase_id))
    }

    /// Get the current settlement state for a purchase
    pub fn get_settlement_state(env: Env, purchase_id: u64) -> Option<SettlementState> {
        get_settlement_record_internal(&env, purchase_id).map(|s| s.state)
    }

    /// Check if a purchase has been settled (reached a terminal state)
    pub fn is_settled(env: Env, purchase_id: u64) -> bool {
        if let Some(settlement) = get_settlement_record_internal(&env, purchase_id) {
            matches!(
                settlement.state,
                SettlementState::Released | SettlementState::Refunded | SettlementState::Expired
            )
        } else {
            false
        }
    }

    /// Check if a purchase has been refunded
    pub fn is_refunded(env: Env, purchase_id: u64) -> bool {
        if let Some(settlement) = get_settlement_record_internal(&env, purchase_id) {
            settlement.state == SettlementState::Refunded
        } else {
            false
        }
    }

    // ============== Admin Functions ==============

    /// Set whether an asset is allowed for purchases (admin only).
    pub fn set_asset_allowed(
        env: Env,
        admin: Address,
        asset: Address,
        kind: AssetKind,
        enabled: bool,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let asset_key = DataKey::AllowedAsset(asset.clone());
        let is_new_asset = !env.storage().persistent().has(&asset_key);

        let info = AssetInfo { kind, enabled };
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

    /// Update platform configuration (admin only)
    pub fn set_platform_config(
        env: Env,
        admin: Address,
        treasury: Address,
        platform_fee_bps: u32,
        paused: bool,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        if platform_fee_bps > MAX_PLATFORM_FEE_BPS {
            return Err(PurchaseError::InvalidPlatformFee);
        }

        if treasury == env.current_contract_address() {
            return Err(PurchaseError::InvalidTreasury);
        }

        let current_config = get_platform_config(&env)?;

        let new_config = PlatformConfig {
            registry: current_config.registry,
            treasury: treasury.clone(),
            platform_fee_bps,
            paused,
            oracle: current_config.oracle,
        };

        put_platform_config(&env, &new_config);

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
        let key = DataKey::AllowedAsset(asset);
        let info = env.storage().persistent().get(&key);
        if info.is_some() {
            extend_persistent_ttl(&env, &key);
        }
        info
    }

    /// Register a standard Stellar token for checkout (admin only).
    /// This is a convenience function for registering tokens like USDC, EURC, etc.
    pub fn register_token_asset(
        env: Env,
        admin: Address,
        asset: Address,
        enabled: bool,
    ) -> Result<(), PurchaseError> {
        Self::set_asset_allowed(env, admin, asset, AssetKind::Token, enabled)
    }

    /// Register an institution-issued access asset (admin only).
    /// Institution assets are custom tokens issued by educational institutions
    /// to grant access to their content or materials at scale.
    pub fn register_institution_asset(
        env: Env,
        admin: Address,
        asset: Address,
        enabled: bool,
    ) -> Result<(), PurchaseError> {
        Self::set_asset_allowed(env, admin, asset, AssetKind::InstitutionAsset, enabled)
    }

    /// Register the Stellar native asset XLM for checkout (admin only).
    /// XLM is the native asset of the Stellar network, wrapped via its SAC contract.
    pub fn register_native_asset(
        env: Env,
        admin: Address,
        asset: Address,
        enabled: bool,
    ) -> Result<(), PurchaseError> {
        Self::set_asset_allowed(env, admin, asset, AssetKind::Native, enabled)
    }

    /// Configure the price-oracle address (admin only).
    pub fn set_oracle(
        env: Env,
        admin: Address,
        oracle: Option<Address>,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let mut config = get_platform_config(&env)?;
        config.oracle = oracle;
        put_platform_config(&env, &config);

        Ok(())
    }

    /// Update registry address (admin only, for migrations)
    pub fn set_registry(env: Env, admin: Address, registry: Address) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let mut config = get_platform_config(&env)?;
        config.registry = registry;

        put_platform_config(&env, &config);

        Ok(())
    }

    /// Update the platform fee rate (admin only).
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

        put_platform_config(&env, &config);

        PlatformConfigUpdatedEvent {
            treasury: config.treasury.clone(),
            platform_fee_bps: new_platform_fee_bps,
            paused: config.paused,
        }
        .publish(&env);

        Ok(())
    }

    /// Pause contract operations (admin only)
    pub fn pause(env: Env, admin: Address) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let mut config = get_platform_config(&env)?;
        config.paused = true;

        put_platform_config(&env, &config);

        PlatformConfigUpdatedEvent {
            treasury: config.treasury,
            platform_fee_bps: config.platform_fee_bps,
            paused: true,
        }
        .publish(&env);

        Ok(())
    }

    /// Unpause contract operations (admin only)
    pub fn unpause(env: Env, admin: Address) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let mut config = get_platform_config(&env)?;
        config.paused = false;

        put_platform_config(&env, &config);

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

    // ============== Admin Transfer (two-step, time-delayed — #463) ==============

    /// Begin a time-delayed admin ownership transfer. `admin` remains fully
    /// authoritative — and other existing admins, if any, are unaffected —
    /// until `new_admin` calls `accept_admin`, and only after `delay_secs`
    /// (floored at `shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS`) has
    /// elapsed. Overwrites any transfer already pending.
    pub fn transfer_admin(
        env: Env,
        admin: Address,
        new_admin: Address,
        delay_secs: u64,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        if delay_secs < MIN_ADMIN_TRANSFER_DELAY_SECS {
            return Err(PurchaseError::InvalidTransferDelay);
        }

        let now = env.ledger().timestamp();
        let pending = PendingAdminTransfer {
            candidate: new_admin.clone(),
            initiated_at: now,
            accept_after: now + delay_secs,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &pending);
        env.storage()
            .instance()
            .set(&DataKey::PendingAdminFrom, &admin);
        extend_instance_ttl(&env);

        AdminTransferInitiatedEvent {
            from: admin,
            pending_admin: new_admin,
        }
        .publish(&env);

        Ok(())
    }

    /// Complete an admin ownership transfer initiated by `transfer_admin`,
    /// once the configured delay has elapsed. Revokes the initiating admin's
    /// role as part of accepting — previously, accepting only ever granted
    /// the new admin the role and never revoked the old one, so authority
    /// accumulated indefinitely instead of actually transferring.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), PurchaseError> {
        new_admin.require_auth();

        let pending: PendingAdminTransfer = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(PurchaseError::NoPendingAdminTransfer)?;
        extend_instance_ttl(&env);

        if pending.candidate != new_admin {
            return Err(PurchaseError::NotAuthorized);
        }
        if env.ledger().timestamp() < pending.accept_after {
            return Err(PurchaseError::TransferDelayNotElapsed);
        }

        auth::set_admin_role(&env, &new_admin);
        if let Some(previous_admin) = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::PendingAdminFrom)
        {
            auth::revoke_admin_role(&env, &previous_admin);
        }
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.storage().instance().remove(&DataKey::PendingAdminFrom);
        extend_instance_ttl(&env);

        AdminTransferAcceptedEvent {
            new_admin: new_admin.clone(),
        }
        .publish(&env);

        Ok(())
    }

    /// Cancel a pending admin transfer before it's accepted — e.g. after
    /// nominating the wrong address. Callable by any current admin, not only
    /// the one who initiated it, since all admins are equally trusted in
    /// this contract's authority model.
    pub fn cancel_admin_transfer(env: Env, admin: Address) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        if !env.storage().instance().has(&DataKey::PendingAdmin) {
            return Err(PurchaseError::NoPendingAdminTransfer);
        }
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.storage().instance().remove(&DataKey::PendingAdminFrom);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Return the pending admin transfer, if one is in progress.
    pub fn get_pending_admin(env: Env) -> Option<PendingAdminTransfer> {
        let pending = env.storage().instance().get(&DataKey::PendingAdmin);
        extend_instance_ttl(&env);
        pending
    }

    /// Return the buyer address for a purchase, if known.
    pub fn get_purchase_buyer(env: Env, purchase_id: u64) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::PurchaseBuyer(purchase_id))
    }

    // ============== Creator Volume Tiers ==============

    /// Assign a volume tier to a creator (admin only).
    pub fn set_creator_tier(
        env: Env,
        admin: Address,
        creator: Address,
        tier: CreatorTier,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let tier_key = DataKey::CreatorTier(creator.clone());
        let is_new_creator = !env.storage().persistent().has(&tier_key);

        env.storage().persistent().set(&tier_key, &tier);
        extend_persistent_ttl(&env, &tier_key);

        if is_new_creator {
            index_creator_tier(&env, &creator);
        }

        CreatorTierUpdatedEvent { creator, tier }.publish(&env);

        Ok(())
    }

    /// Return the volume tier assigned to a creator.
    pub fn get_creator_tier(env: Env, creator: Address) -> CreatorTier {
        let key = DataKey::CreatorTier(creator);
        let tier = env.storage().persistent().get(&key);
        if tier.is_some() {
            extend_persistent_ttl(&env, &key);
        }
        tier.unwrap_or(CreatorTier::Default)
    }

    // ============== TTL Maintenance (#464) ==============

    /// Bump the TTL of up to `limit` (capped at `MAX_MAINTENANCE_BATCH`)
    /// purchases — both the `Escrow` and `Entitlement` halves together —
    /// starting at `cursor`. Permissionless, cursor-based; this is the
    /// entrypoint that specifically protects paid access and escrowed
    /// funds, which otherwise have no natural heartbeat once a buyer stops
    /// re-checking their entitlement.
    ///
    /// Returns the cursor to resume from. Skips (rather than aborts on) any
    /// slot whose escrow/entitlement has already expired/archived — see
    /// ../../docs/ttl-operations.md for the restoration runbook.
    pub fn extend_purchases_ttl(env: Env, cursor: u64, limit: u32) -> u64 {
        let limit = (limit.min(MAX_MAINTENANCE_BATCH)) as u64;
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PurchaseIndexCount)
            .unwrap_or(0);
        extend_instance_ttl(&env);

        let end = cursor.saturating_add(limit).min(count);
        let mut i = cursor;
        while i < end {
            let index_key = DataKey::PurchaseIndex(i);
            if let Some((purchase_id, material_id, buyer)) =
                env.storage()
                    .persistent()
                    .get::<_, (u64, BytesN<32>, Address)>(&index_key)
            {
                extend_persistent_ttl(&env, &index_key);

                let escrow_key = DataKey::Escrow(purchase_id);
                if env.storage().persistent().has(&escrow_key) {
                    extend_persistent_ttl(&env, &escrow_key);
                }

                let entitlement_key = DataKey::Entitlement((material_id, buyer));
                if env.storage().persistent().has(&entitlement_key) {
                    extend_persistent_ttl(&env, &entitlement_key);
                }
            }
            i += 1;
        }

        end
    }

    /// Bump the TTL of up to `limit` allowlisted assets, starting at
    /// `cursor`. Same semantics as `extend_purchases_ttl`.
    pub fn extend_allowed_asset_ttl(env: Env, cursor: u64, limit: u32) -> u64 {
        let limit = (limit.min(MAX_MAINTENANCE_BATCH)) as u64;
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::AllowedAssetIndexCount)
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

    /// Bump the TTL of up to `limit` creator-tier assignments, starting at
    /// `cursor`. Same semantics as `extend_purchases_ttl`.
    pub fn extend_creator_tier_ttl(env: Env, cursor: u64, limit: u32) -> u64 {
        let limit = (limit.min(MAX_MAINTENANCE_BATCH)) as u64;
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CreatorTierIndexCount)
            .unwrap_or(0);
        extend_instance_ttl(&env);

        let end = cursor.saturating_add(limit).min(count);
        let mut i = cursor;
        while i < end {
            let index_key = DataKey::CreatorTierIndex(i);
            if let Some(creator) = env.storage().persistent().get::<_, Address>(&index_key) {
                extend_persistent_ttl(&env, &index_key);
                let tier_key = DataKey::CreatorTier(creator);
                if env.storage().persistent().has(&tier_key) {
                    extend_persistent_ttl(&env, &tier_key);
                }
            }
            i += 1;
        }

        end
    }

    /// Bump the TTL of up to `limit` admin-role grants, starting at
    /// `cursor`. Same semantics as `extend_purchases_ttl`; delegates to
    /// `auth`, which owns the `AdminRole` storage namespace.
    pub fn extend_admin_role_ttl(env: Env, cursor: u64, limit: u32) -> u64 {
        auth::extend_admin_role_ttl(&env, cursor, limit)
    }

    // ============== Scholarship Credit Management ==============

    /// Authorize or revoke a scholarship issuer address.
    ///
    /// Only an admin may call this. Authorized issuers can then distribute
    /// scholarship credits to learners.
    pub fn set_scholarship_issuer(
        env: Env,
        admin: Address,
        issuer: Address,
        enabled: bool,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        let key = DataKey::ScholarshipIssuer(issuer.clone());
        let is_new = !env.storage().persistent().has(&key);
        env.storage().persistent().set(&key, &enabled);
        extend_persistent_ttl(&env, &key);

        if is_new && enabled {
            index_scholarship_issuer(&env, &issuer);
        }

        ScholarshipIssuerUpdatedEvent { issuer, enabled }.publish(&env);
        Ok(())
    }

    /// Check if an address is an authorized scholarship issuer.
    pub fn is_scholarship_issuer(env: Env, issuer: Address) -> bool {
        let key = DataKey::ScholarshipIssuer(issuer);
        let has = env.storage().persistent().has(&key);
        if has {
            extend_persistent_ttl(&env, &key);
        }
        has && env
            .storage()
            .persistent()
            .get::<_, bool>(&key)
            .unwrap_or(false)
    }

    /// Configure the scholarship-credit cost for a material.
    ///
    /// Only admin may set the credit cost. The material must already exist
    /// in the registry. A cost of zero or negative is rejected.
    pub fn set_scholarship_credit_cost(
        env: Env,
        admin: Address,
        material_id: BytesN<32>,
        credit_cost: i128,
    ) -> Result<(), PurchaseError> {
        auth::require_admin(&env, &admin)?;

        if credit_cost <= 0 {
            return Err(PurchaseError::InvalidCreditCost);
        }

        let config = get_platform_config(&env)?;
        let _material: MaterialRecord = config
            .registry
            .get_material(&env, &material_id)
            .map_err(|_| PurchaseError::MaterialNotFound)?;

        let key = DataKey::ScholarshipCreditCost(material_id.clone());
        env.storage().persistent().set(&key, &credit_cost);
        extend_persistent_ttl(&env, &key);

        ScholarshipCostUpdatedEvent {
            material_id,
            credit_cost,
        }
        .publish(&env);

        Ok(())
    }

    /// Get the scholarship-credit cost for a material, if configured.
    pub fn get_scholarship_credit_cost(env: Env, material_id: BytesN<32>) -> Option<i128> {
        let key = DataKey::ScholarshipCreditCost(material_id);
        let cost: Option<i128> = env.storage().persistent().get(&key);
        if cost.is_some() {
            extend_persistent_ttl(&env, &key);
        }
        cost
    }

    /// Issue scholarship credits to a learner.
    ///
    /// The issuer must be authorized via `set_scholarship_issuer`. Credits
    /// are tracked per-grant with optional expiry. The learner's aggregate
    /// balance is updated atomically. Returns the new grant ID.
    pub fn issue_scholarship_credits(
        env: Env,
        issuer: Address,
        learner: Address,
        amount: i128,
        expires_at: Option<u32>,
    ) -> Result<u64, PurchaseError> {
        issuer.require_auth();

        if !is_scholarship_issuer_internal(&env, &issuer) {
            return Err(PurchaseError::NotAuthorized);
        }

        if amount <= 0 {
            return Err(PurchaseError::InvalidCreditAmount);
        }

        let current_ledger = env.ledger().sequence();

        if let Some(expiry) = expires_at {
            if expiry <= current_ledger {
                return Err(PurchaseError::InvalidExpiry);
            }
        }

        let grant_id = get_and_increment_scholarship_grant_nonce(&env)?;

        let grant = ScholarshipCreditGrant {
            grant_id,
            learner: learner.clone(),
            issuer: issuer.clone(),
            total_credits: amount,
            remaining_credits: amount,
            issued_at: current_ledger,
            expires_at,
            active: true,
        };

        let grant_key = DataKey::ScholarshipGrant(grant_id);
        env.storage().persistent().set(&grant_key, &grant);
        extend_persistent_ttl(&env, &grant_key);

        // Add grant_id to learner's grant list
        add_grant_to_learner(&env, &learner, grant_id)?;

        // Update aggregate balance
        increment_learner_balance(&env, &learner, amount)?;

        ScholarshipCreditsIssuedEvent {
            grant_id,
            learner,
            issuer,
            amount,
            expires_at,
        }
        .publish(&env);

        Ok(grant_id)
    }

    /// Get the available (spendable) scholarship credit balance for a learner.
    ///
    /// Excludes credits from expired, revoked, or fully-consumed grants.
    pub fn get_scholarship_credit_balance(env: Env, learner: Address) -> i128 {
        compute_scholarship_balance(&env, &learner)
    }

    /// Get a specific scholarship grant by ID.
    pub fn get_scholarship_grant(
        env: Env,
        grant_id: u64,
    ) -> Result<ScholarshipCreditGrant, PurchaseError> {
        let key = DataKey::ScholarshipGrant(grant_id);
        let grant: Option<ScholarshipCreditGrant> = env.storage().persistent().get(&key);
        if grant.is_some() {
            extend_persistent_ttl(&env, &key);
        }
        grant.ok_or(PurchaseError::ScholarshipGrantNotFound)
    }

    /// Redeem scholarship credits for a material.
    ///
    /// - Learner must authorize
    /// - Material must be active in the registry
    /// - Material must have a configured scholarship credit cost
    /// - Learner must not already have an entitlement for the material
    /// - Learner must have sufficient available credits
    /// - Credits are consumed earliest-expiry-first
    /// - A standard entitlement is granted upon successful redemption
    /// - The operation is atomic
    pub fn redeem_scholarship_credits(
        env: Env,
        learner: Address,
        material_id: BytesN<32>,
    ) -> Result<ScholarshipRedemptionResult, PurchaseError> {
        learner.require_auth();

        // Check no existing redemption for this (learner, material) pair
        let redemption_key = DataKey::ScholarshipRedemption((learner.clone(), material_id.clone()));
        if env.storage().persistent().has(&redemption_key) {
            return Err(PurchaseError::RedemptionAlreadyExists);
        }

        // Check the learner does not already have an entitlement
        if has_entitlement_internal(&env, &material_id, &learner) {
            return Err(PurchaseError::EntitlementAlreadyExists);
        }

        // Check material exists, is active, and is scholarship eligible
        let config = get_platform_config(&env)?;
        let material: MaterialRecord = config
            .registry
            .get_material(&env, &material_id)
            .map_err(|_| PurchaseError::MaterialNotFound)?;

        if material.status != MaterialStatus::Active || material.paused {
            return Err(PurchaseError::MaterialNotActive);
        }

        let credit_cost_key = DataKey::ScholarshipCreditCost(material_id.clone());
        let credit_cost: i128 = env
            .storage()
            .persistent()
            .get(&credit_cost_key)
            .ok_or(PurchaseError::ContentNotScholarshipEligible)?;
        extend_persistent_ttl(&env, &credit_cost_key);

        if credit_cost <= 0 {
            return Err(PurchaseError::ContentNotScholarshipEligible);
        }

        // Compute available balance
        let available = compute_scholarship_balance(&env, &learner);
        if available < credit_cost {
            return Err(PurchaseError::InsufficientScholarshipCredits);
        }

        // Consume credits from grants (earliest-expiry-first)
        let _credits_consumed = consume_scholarship_credits(&env, &learner, credit_cost)?;

        // Grant entitlement using the existing system
        let purchase_id = get_and_increment_purchase_nonce(&env)?;
        let current_ledger = env.ledger().sequence();

        let entitlement = EntitlementRecord {
            material_id: material_id.clone(),
            buyer: learner.clone(),
            active: true,
            purchase_id,
            asset: env.current_contract_address(),
            amount: 0,
            granted_ledger: current_ledger,
        };
        set_entitlement(&env, &entitlement);
        index_purchase(&env, purchase_id, &material_id, &learner);

        // Initialize settlement in Pending state (no escrow for scholarship)
        let settlement = SettlementRecord {
            purchase_id,
            state: SettlementState::Pending,
            disputed_ledger: None,
            resolved_ledger: None,
            refunded_amount: 0,
        };
        set_settlement_record(&env, purchase_id, &settlement);

        // Store purchase -> buyer mapping
        env.storage()
            .persistent()
            .set(&DataKey::PurchaseBuyer(purchase_id), &learner);

        // Record redemption
        let redemption_id = get_and_increment_scholarship_redemption_nonce(&env)?;
        let redemption = ScholarshipRedemptionRecord {
            redemption_id,
            learner: learner.clone(),
            material_id: material_id.clone(),
            credits_used: credit_cost,
            redeemed_at: current_ledger,
        };
        env.storage().persistent().set(&redemption_key, &redemption);
        extend_persistent_ttl(&env, &redemption_key);

        let remaining = compute_scholarship_balance(&env, &learner);

        ScholarshipCreditsRedeemedEvent {
            redemption_id,
            learner: learner.clone(),
            material_id: material_id.clone(),
            credits_used: credit_cost,
            remaining_credits: remaining,
        }
        .publish(&env);

        Ok(ScholarshipRedemptionResult {
            redemption_id,
            material_id,
            learner,
            credits_used: credit_cost,
            remaining_credits: remaining,
        })
    }

    /// Get a scholarship redemption record by learner and material.
    pub fn get_scholarship_redemption(
        env: Env,
        learner: Address,
        material_id: BytesN<32>,
    ) -> Option<ScholarshipRedemptionRecord> {
        let key = DataKey::ScholarshipRedemption((learner, material_id));
        let record: Option<ScholarshipRedemptionRecord> = env.storage().persistent().get(&key);
        if record.is_some() {
            extend_persistent_ttl(&env, &key);
        }
        record
    }

    /// Revoke unused credits from a scholarship grant.
    ///
    /// Only the original issuer or a platform admin may revoke. Already
    /// redeemed credits and their entitlements remain valid. Returns the
    /// number of credits revoked.
    pub fn revoke_scholarship_grant(
        env: Env,
        caller: Address,
        grant_id: u64,
    ) -> Result<i128, PurchaseError> {
        caller.require_auth();

        let key = DataKey::ScholarshipGrant(grant_id);
        let mut grant: ScholarshipCreditGrant = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PurchaseError::ScholarshipGrantNotFound)?;

        // Only the original issuer or an admin may revoke
        let is_issuer = grant.issuer == caller;
        let is_admin = auth::has_admin_role(&env, &caller);
        if !is_issuer && !is_admin {
            return Err(PurchaseError::NotAuthorized);
        }

        if !grant.active {
            return Err(PurchaseError::ScholarshipGrantInactive);
        }

        let credits_to_revoke = grant.remaining_credits;
        if credits_to_revoke <= 0 {
            return Err(PurchaseError::ScholarshipGrantInactive);
        }

        grant.remaining_credits = 0;
        grant.active = false;
        env.storage().persistent().set(&key, &grant);
        extend_persistent_ttl(&env, &key);

        // Decrease learner's aggregate balance
        decrement_learner_balance(&env, &grant.learner, credits_to_revoke);

        // Remove from learner's active grant list
        remove_grant_from_learner(&env, &grant.learner, grant_id);

        ScholarshipGrantRevokedEvent {
            grant_id,
            learner: grant.learner,
            issuer: grant.issuer,
            credits_revoked: credits_to_revoke,
        }
        .publish(&env);

        Ok(credits_to_revoke)
    }

    // ============== Scholarship TTL Maintenance ==============

    /// Bump the TTL of up to `limit` scholarship issuers, starting at
    /// `cursor`. Same cursor-based, permissionless semantics as the other
    /// maintenance entrypoints.
    pub fn extend_scholarship_issuer_ttl(env: Env, cursor: u64, limit: u32) -> u64 {
        let limit = (limit.min(MAX_MAINTENANCE_BATCH)) as u64;
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ScholarshipIssuerIndexCount)
            .unwrap_or(0);
        extend_instance_ttl(&env);

        let end = cursor.saturating_add(limit).min(count);
        let mut i = cursor;
        while i < end {
            let index_key = DataKey::ScholarshipIssuerIndex(i);
            if let Some(issuer) = env.storage().persistent().get::<_, Address>(&index_key) {
                extend_persistent_ttl(&env, &index_key);
                let issuer_key = DataKey::ScholarshipIssuer(issuer);
                if env.storage().persistent().has(&issuer_key) {
                    extend_persistent_ttl(&env, &issuer_key);
                }
            }
            i += 1;
        }

        end
    }

    /// Batch refund for bulk-license purchases.
    ///
    /// Allows the original purchaser (who paid for the bulk purchase) or an admin
    /// to refund multiple purchase IDs from a single bulk purchase in one transaction.
    /// Respects resource limits and gracefully skips already-refunded purchases.
    ///
    /// # Parameters
    /// * `caller` - The caller (must be admin or original bulk purchaser)
    /// * `purchaser` - The original purchaser of the bulk license
    /// * `material_id` - The material ID from the bulk purchase
    /// * `limit` - Maximum number of purchases to refund (capped at MAX_MAINTENANCE_BATCH)
    ///
    /// # Returns
    /// * `BulkRefundResult` - Summary of refund operation with counts and amounts
    pub fn refund_bulk_purchase(
        env: Env,
        caller: Address,
        purchaser: Address,
        material_id: BytesN<32>,
        limit: u32,
    ) -> Result<BulkRefundResult, PurchaseError> {
        caller.require_auth();

        // Authorization: admin or the original purchaser
        let is_admin = auth::has_admin_role(&env, &caller);
        let is_purchaser = caller == purchaser;
        if !is_admin && !is_purchaser {
            return Err(PurchaseError::NotAuthorized);
        }

        // Look up the bulk purchase record
        let bulk_key = DataKey::BulkPurchase((purchaser.clone(), material_id.clone()));
        let bulk_record: BulkPurchaseRecord = env
            .storage()
            .persistent()
            .get(&bulk_key)
            .ok_or(PurchaseError::MaterialNotFound)?; // Bulk purchase not found

        // Bound the operation to prevent resource exhaustion
        let limit = limit.min(MAX_MAINTENANCE_BATCH).min(bulk_record.recipient_count);
        
        let mut refunded_count = 0u32;
        let mut skipped_count = 0u32;
        let mut total_refund_amount = 0i128;

        // Process each purchase ID in the bulk purchase
        let mut purchase_id = bulk_record.first_purchase_id;
        let mut processed = 0u32;
        
        while processed < limit {
            let refund_result = perform_single_refund(&env, purchase_id);
            
            match refund_result {
                Ok(result) => {
                    if result.refunded {
                        refunded_count += 1;
                        total_refund_amount = total_refund_amount
                            .checked_add(result.refund_amount)
                            .ok_or(PurchaseError::ArithmeticOverflow)?;
                    } else {
                        skipped_count += 1;
                    }
                }
                Err(_) => {
                    // Skip failed refunds but continue processing others
                    skipped_count += 1;
                }
            }

            purchase_id = purchase_id
                .checked_add(1)
                .ok_or(PurchaseError::ArithmeticOverflow)?;
            processed += 1;
        }

        Ok(BulkRefundResult {
            material_id,
            purchaser,
            refunded_count,
            skipped_count,
            total_refund_amount,
            asset: bulk_record.asset,
        })
    }

    /// Get bulk purchase information for potential batch operations.
    ///
    /// Returns the bulk purchase record that can be used to identify
    /// the range of purchase IDs created by a bulk purchase.
    pub fn get_bulk_purchase(
        env: Env,
        purchaser: Address,
        material_id: BytesN<32>,
    ) -> Option<BulkPurchaseRecord> {
        let bulk_key = DataKey::BulkPurchase((purchaser, material_id));
        let record = env.storage().persistent().get(&bulk_key);
        if record.is_some() {
            extend_persistent_ttl(&env, &bulk_key);
        }
        record
    }
}

// ============== TTL Renewal (#464) ==============

/// Internal helper function that performs a single purchase refund.
/// Factors out common refund logic used by refund_purchase, resolve_dispute, and refund_bulk_purchase.
fn perform_single_refund(env: &Env, purchase_id: u64) -> Result<SingleRefundResult, PurchaseError> {
    // Check if settlement exists and is in Pending state
    let settlement = match get_settlement_record_internal(env, purchase_id) {
        Some(s) => s,
        None => return Ok(SingleRefundResult {
            refunded: false,
            refund_amount: 0,
            reason_skipped: Some("settlement_not_found"),
        }),
    };

    if settlement.state != SettlementState::Pending {
        return Ok(SingleRefundResult {
            refunded: false,
            refund_amount: 0,
            reason_skipped: Some("already_settled"),
        });
    }

    // Check escrow record
    let mut escrow = match get_escrow_record_internal(env, purchase_id) {
        Some(e) => e,
        None => return Ok(SingleRefundResult {
            refunded: false,
            refund_amount: 0,
            reason_skipped: Some("escrow_not_found"),
        }),
    };

    if escrow.claimed {
        return Ok(SingleRefundResult {
            refunded: false,
            refund_amount: 0,
            reason_skipped: Some("already_claimed"),
        });
    }

    // Look up the buyer
    let buyer: Address = match env
        .storage()
        .persistent()
        .get(&DataKey::PurchaseBuyer(purchase_id))
    {
        Some(b) => b,
        None => return Ok(SingleRefundResult {
            refunded: false,
            refund_amount: 0,
            reason_skipped: Some("buyer_not_found"),
        }),
    };

    // Check entitlement
    let entitlement_key = DataKey::Entitlement((escrow.material_id.clone(), buyer.clone()));
    let entitlement: EntitlementRecord = match env
        .storage()
        .persistent()
        .get(&entitlement_key)
    {
        Some(e) => e,
        None => return Ok(SingleRefundResult {
            refunded: false,
            refund_amount: 0,
            reason_skipped: Some("entitlement_not_found"),
        }),
    };

    if !entitlement.active {
        return Ok(SingleRefundResult {
            refunded: false,
            refund_amount: 0,
            reason_skipped: Some("entitlement_inactive"),
        });
    }

    // Perform the refund
    let current_ledger = env.ledger().sequence();
    let refund_amount = escrow.seller_net;

    // Transfer funds back to buyer
    if refund_amount > 0 {
        let contract_address = env.current_contract_address();
        let balance = SacToken::new(env, &escrow.asset).balance(&contract_address);
        
        if balance < refund_amount {
            return Err(PurchaseError::InsufficientEscrowBalance);
        }

        transfer_asset(
            env,
            &contract_address,
            &buyer,
            &escrow.asset,
            refund_amount,
        )?;
    }

    // Mark escrow as claimed
    escrow.claimed = true;
    set_escrow_record(env, purchase_id, &escrow);

    // Revoke entitlement
    let mut updated_entitlement = entitlement;
    updated_entitlement.active = false;
    env.storage().persistent().set(&entitlement_key, &updated_entitlement);

    // Update settlement to Refunded
    let mut updated_settlement = settlement;
    updated_settlement.state = SettlementState::Refunded;
    updated_settlement.resolved_ledger = Some(current_ledger);
    updated_settlement.refunded_amount = refund_amount;
    set_settlement_record(env, purchase_id, &updated_settlement);

    // Emit refund event
    PurchaseRefundedEvent {
        purchase_id,
        material_id: escrow.material_id.clone(),
        buyer: buyer.clone(),
        asset: escrow.asset.clone(),
        refund_amount,
        entitlement_revoked: true,
    }
    .publish(env);

    Ok(SingleRefundResult {
        refunded: true,
        refund_amount,
        reason_skipped: None,
    })
}

/// Extends `key`'s persistent-storage TTL back out to the network maximum
/// whenever it has dropped below half of that maximum. Safe and cheap to
/// call on every read and write of a tracked key — a no-op when the TTL is
/// already healthy. `pub(crate)` so `auth.rs` can reuse it for `AdminRole`.
pub(crate) fn extend_persistent_ttl<K: IntoVal<Env, Val>>(env: &Env, key: &K) {
    let max_ttl = env.storage().max_ttl();
    env.storage()
        .persistent()
        .extend_ttl(key, max_ttl / TTL_RENEWAL_DIVISOR, max_ttl);
}

/// Extends the contract instance's TTL — and therefore everything stored in
/// instance storage alongside it (`PlatformConfig`, `PurchaseNonce`,
/// `PendingAdmin`, the maintenance counters) — back out to the network
/// maximum whenever it has dropped below half of that maximum.
pub(crate) fn extend_instance_ttl(env: &Env) {
    let max_ttl = env.storage().max_ttl();
    env.storage()
        .instance()
        .extend_ttl(max_ttl / TTL_RENEWAL_DIVISOR, max_ttl);
}

/// Appends `(purchase_id, material_id, buyer)` to the purchase maintenance
/// index and bumps the instance-stored count, so `extend_purchases_ttl` can
/// renew both the `Escrow` and `Entitlement` halves of every purchase
/// without off-chain enumeration.
fn index_purchase(env: &Env, purchase_id: u64, material_id: &BytesN<32>, buyer: &Address) {
    let count: u64 = env
        .storage()
        .instance()
        .get(&DataKey::PurchaseIndexCount)
        .unwrap_or(0);
    let index_key = DataKey::PurchaseIndex(count);
    let entry = (purchase_id, material_id.clone(), buyer.clone());
    env.storage().persistent().set(&index_key, &entry);
    extend_persistent_ttl(env, &index_key);
    env.storage()
        .instance()
        .set(&DataKey::PurchaseIndexCount, &(count + 1));
    extend_instance_ttl(env);
}

/// Appends `asset` to the allowlist maintenance index. Only called the
/// first time an asset is added to the allowlist.
fn index_allowed_asset(env: &Env, asset: &Address) {
    let count: u64 = env
        .storage()
        .instance()
        .get(&DataKey::AllowedAssetIndexCount)
        .unwrap_or(0);
    let index_key = DataKey::AllowedAssetIndex(count);
    env.storage().persistent().set(&index_key, asset);
    extend_persistent_ttl(env, &index_key);
    env.storage()
        .instance()
        .set(&DataKey::AllowedAssetIndexCount, &(count + 1));
    extend_instance_ttl(env);
}

/// Appends `creator` to the creator-tier maintenance index. Only called the
/// first time a tier is assigned to that creator.
fn index_creator_tier(env: &Env, creator: &Address) {
    let count: u64 = env
        .storage()
        .instance()
        .get(&DataKey::CreatorTierIndexCount)
        .unwrap_or(0);
    let index_key = DataKey::CreatorTierIndex(count);
    env.storage().persistent().set(&index_key, creator);
    extend_persistent_ttl(env, &index_key);
    env.storage()
        .instance()
        .set(&DataKey::CreatorTierIndexCount, &(count + 1));
    extend_instance_ttl(env);
}

// ============== Internal Functions ==============

/// Return the effective platform fee rate for `creator`.
fn get_effective_fee_bps(env: &Env, creator: &Address, config_fee_bps: u32) -> u32 {
    let key = DataKey::CreatorTier(creator.clone());
    let tier: Option<CreatorTier> = env.storage().persistent().get(&key);
    if tier.is_some() {
        extend_persistent_ttl(env, &key);
    }
    match tier.unwrap_or(CreatorTier::Default) {
        CreatorTier::Default => config_fee_bps,
        CreatorTier::Tier1 => TIER1_FEE_BPS,
        CreatorTier::Tier2 => TIER2_FEE_BPS,
    }
}

fn get_platform_config(env: &Env) -> Result<PlatformConfig, PurchaseError> {
    let config = env
        .storage()
        .instance()
        .get(&DataKey::PlatformConfig)
        .ok_or(PurchaseError::NotAuthorized)?;
    extend_instance_ttl(env);
    Ok(config)
}

fn put_platform_config(env: &Env, config: &PlatformConfig) {
    env.storage()
        .instance()
        .set(&DataKey::PlatformConfig, config);
    extend_instance_ttl(env);
}

fn is_asset_allowed(env: &Env, asset: &Address) -> bool {
    let key = DataKey::AllowedAsset(asset.clone());
    let info: Option<AssetInfo> = env.storage().persistent().get(&key);
    if info.is_some() {
        extend_persistent_ttl(env, &key);
    }
    info.map(|info| info.enabled).unwrap_or(false)
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
        .instance()
        .get(&DataKey::PurchaseNonce)
        .ok_or(PurchaseError::NotAuthorized)?;
    env.storage()
        .instance()
        .set(&DataKey::PurchaseNonce, &(nonce + 1));
    extend_instance_ttl(env);
    Ok(nonce)
}

fn transfer_asset(
    env: &Env,
    from: &Address,
    to: &Address,
    asset: &Address,
    amount: i128,
) -> Result<(), PurchaseError> {
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

/// Reads an entitlement and, when present, extends its TTL — the primary
/// organic renewal path for paid access (#464 Tier D): a buyer actively
/// using what they paid for keeps their own record alive for free, every
/// time a content-access check runs.
fn get_entitlement_internal(
    env: &Env,
    material_id: &BytesN<32>,
    buyer: &Address,
) -> Option<EntitlementRecord> {
    let key = DataKey::Entitlement((material_id.clone(), buyer.clone()));
    let entitlement = env.storage().persistent().get(&key);
    if entitlement.is_some() {
        extend_persistent_ttl(env, &key);
    }
    entitlement
}

fn set_entitlement(env: &Env, entitlement: &EntitlementRecord) {
    let key = DataKey::Entitlement((entitlement.material_id.clone(), entitlement.buyer.clone()));
    env.storage().persistent().set(&key, entitlement);
    extend_persistent_ttl(env, &key);
}

fn set_purchase_snapshot(env: &Env, purchase_id: u64, snapshot: &PurchaseSnapshot) {
    let key = DataKey::PurchaseSnapshot(purchase_id);
    env.storage().persistent().set(&key, snapshot);
    extend_persistent_ttl(env, &key);
}

fn get_escrow_record_internal(env: &Env, purchase_id: u64) -> Option<EscrowRecord> {
    let key = DataKey::Escrow(purchase_id);
    let escrow = env.storage().persistent().get(&key);
    if escrow.is_some() {
        extend_persistent_ttl(env, &key);
    }
    escrow
}

fn set_escrow_record(env: &Env, purchase_id: u64, record: &EscrowRecord) {
    let key = DataKey::Escrow(purchase_id);
    env.storage().persistent().set(&key, record);
    extend_persistent_ttl(env, &key);
}

fn get_settlement_record_internal(env: &Env, purchase_id: u64) -> Option<SettlementRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::Settlement(purchase_id))
}

fn set_settlement_record(env: &Env, purchase_id: u64, record: &SettlementRecord) {
    env.storage()
        .persistent()
        .set(&DataKey::Settlement(purchase_id), record);
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
                // EscrowRecord does not carry the originating purchase's
                // transaction_id, so the delayed-release payout event can't
                // correlate back to it — empty Bytes is an accepted value
                // for this field (see `empty_transaction_id_is_accepted`).
                transaction_id: Bytes::new(env),
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

// ============== Scholarship Credit Internals ==============

fn is_scholarship_issuer_internal(env: &Env, issuer: &Address) -> bool {
    let key = DataKey::ScholarshipIssuer(issuer.clone());
    let has = env.storage().persistent().has(&key);
    if has {
        extend_persistent_ttl(env, &key);
    }
    has && env
        .storage()
        .persistent()
        .get::<_, bool>(&key)
        .unwrap_or(false)
}

fn get_and_increment_scholarship_grant_nonce(env: &Env) -> Result<u64, PurchaseError> {
    let nonce: u64 = env
        .storage()
        .instance()
        .get(&DataKey::ScholarshipGrantNonce)
        .unwrap_or(0);
    env.storage()
        .instance()
        .set(&DataKey::ScholarshipGrantNonce, &(nonce + 1));
    extend_instance_ttl(env);
    Ok(nonce)
}

fn get_and_increment_scholarship_redemption_nonce(env: &Env) -> Result<u64, PurchaseError> {
    let nonce: u64 = env
        .storage()
        .instance()
        .get(&DataKey::ScholarshipRedemptionNonce)
        .unwrap_or(0);
    env.storage()
        .instance()
        .set(&DataKey::ScholarshipRedemptionNonce, &(nonce + 1));
    extend_instance_ttl(env);
    Ok(nonce)
}

fn get_learner_grant_ids(env: &Env, learner: &Address) -> soroban_sdk::Vec<u64> {
    let key = DataKey::ScholarshipGrantsForLearner(learner.clone());
    let ids: soroban_sdk::Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(soroban_sdk::Vec::new(env));
    if !env.storage().persistent().has(&key) {
        // no-op, already returned empty
    } else {
        extend_persistent_ttl(env, &key);
    }
    ids
}

fn set_learner_grant_ids(env: &Env, learner: &Address, ids: &soroban_sdk::Vec<u64>) {
    let key = DataKey::ScholarshipGrantsForLearner(learner.clone());
    env.storage().persistent().set(&key, ids);
    extend_persistent_ttl(env, &key);
}

fn add_grant_to_learner(env: &Env, learner: &Address, grant_id: u64) -> Result<(), PurchaseError> {
    let mut ids = get_learner_grant_ids(env, learner);
    if ids.len() >= MAX_ACTIVE_SCHOLARSHIP_GRANTS {
        return Err(PurchaseError::TooManyActiveGrants);
    }
    ids.push_back(grant_id);
    set_learner_grant_ids(env, learner, &ids);
    Ok(())
}

fn remove_grant_from_learner(env: &Env, learner: &Address, grant_id: u64) {
    let ids = get_learner_grant_ids(env, learner);
    let mut new_ids = soroban_sdk::Vec::new(env);
    let mut i = 0u32;
    while i < ids.len() {
        let id = ids.get_unchecked(i);
        if id != grant_id {
            new_ids.push_back(id);
        }
        i += 1;
    }
    set_learner_grant_ids(env, learner, &new_ids);
}

fn increment_learner_balance(
    env: &Env,
    learner: &Address,
    amount: i128,
) -> Result<(), PurchaseError> {
    let key = DataKey::ScholarshipBalance(learner.clone());
    let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    let new_balance = current
        .checked_add(amount)
        .ok_or(PurchaseError::ArithmeticOverflow)?;
    env.storage().persistent().set(&key, &new_balance);
    extend_persistent_ttl(env, &key);
    Ok(())
}

fn decrement_learner_balance(env: &Env, learner: &Address, amount: i128) {
    let key = DataKey::ScholarshipBalance(learner.clone());
    let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    let new_balance = current.saturating_sub(amount);
    env.storage().persistent().set(&key, &new_balance);
    extend_persistent_ttl(env, &key);
}

/// Compute the actual spendable balance for a learner by iterating their
/// active grants and summing remaining credits from non-expired grants.
/// This is the authoritative balance — the stored aggregate may include
/// credits from grants that have since expired.
fn compute_scholarship_balance(env: &Env, learner: &Address) -> i128 {
    let ids = get_learner_grant_ids(env, learner);
    let current_ledger = env.ledger().sequence();
    let mut total: i128 = 0;
    let mut i = 0u32;
    while i < ids.len() {
        let grant_id = ids.get_unchecked(i);
        let key = DataKey::ScholarshipGrant(grant_id);
        if let Some(grant) = env
            .storage()
            .persistent()
            .get::<_, ScholarshipCreditGrant>(&key)
        {
            extend_persistent_ttl(env, &key);
            if grant.active && grant.remaining_credits > 0 {
                // Check expiry
                let is_expired = grant
                    .expires_at
                    .map(|exp| exp <= current_ledger)
                    .unwrap_or(false);
                if !is_expired {
                    total = total
                        .checked_add(grant.remaining_credits)
                        .unwrap_or(i128::MAX);
                }
            }
        }
        i += 1;
    }
    total
}

/// Consume `required` credits from a learner's grants using
/// earliest-expiry-first policy. Only consumes from active, non-expired
/// grants. Returns the total credits consumed.
fn consume_scholarship_credits(
    env: &Env,
    learner: &Address,
    required: i128,
) -> Result<i128, PurchaseError> {
    let ids = get_learner_grant_ids(env, learner);
    let current_ledger = env.ledger().sequence();
    let mut remaining_to_consume = required;
    let mut total_consumed: i128 = 0;

    // Consume credits using earliest-expiry-first policy.
    // Each iteration picks the active grant with the earliest expiry
    // that still has spendable credits. Bounded by MAX_ACTIVE_SCHOLARSHIP_GRANTS.
    while remaining_to_consume > 0 {
        let mut best_idx: Option<u32> = None;
        let mut best_expiry: Option<u32> = None;
        let mut i = 0u32;

        while i < ids.len() {
            let grant_id = ids.get_unchecked(i);
            let key = DataKey::ScholarshipGrant(grant_id);
            if let Some(grant) = env
                .storage()
                .persistent()
                .get::<_, ScholarshipCreditGrant>(&key)
            {
                if grant.active && grant.remaining_credits > 0 {
                    let is_expired = grant
                        .expires_at
                        .map(|exp| exp <= current_ledger)
                        .unwrap_or(false);
                    if !is_expired {
                        // Pick earliest expiry (None = non-expiring, treated as "latest")
                        let dominated = match (best_expiry, grant.expires_at) {
                            (None, Some(_)) => true,
                            (Some(best_exp), Some(this_exp)) => this_exp < best_exp,
                            _ => false,
                        };
                        if dominated || best_idx.is_none() {
                            best_idx = Some(i);
                            best_expiry = grant.expires_at;
                        }
                    }
                }
            }
            i += 1;
        }

        let idx = match best_idx {
            Some(i) => i,
            None => return Err(PurchaseError::InsufficientScholarshipCredits),
        };

        let grant_id = ids.get_unchecked(idx);
        let key = DataKey::ScholarshipGrant(grant_id);
        let mut grant: ScholarshipCreditGrant = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PurchaseError::ScholarshipGrantNotFound)?;

        let take = remaining_to_consume.min(grant.remaining_credits);
        grant.remaining_credits = grant
            .remaining_credits
            .checked_sub(take)
            .ok_or(PurchaseError::ArithmeticOverflow)?;
        if grant.remaining_credits == 0 {
            grant.active = false;
            // Remove from learner's list
            remove_grant_from_learner(env, learner, grant_id);
            // Re-read the list since we just modified it
            // (remove_grant_from_learner already persisted the change)
        }
        env.storage().persistent().set(&key, &grant);
        extend_persistent_ttl(env, &key);

        remaining_to_consume = remaining_to_consume
            .checked_sub(take)
            .ok_or(PurchaseError::ArithmeticOverflow)?;
        total_consumed = total_consumed
            .checked_add(take)
            .ok_or(PurchaseError::ArithmeticOverflow)?;
    }

    // Update aggregate balance
    decrement_learner_balance(env, learner, total_consumed);

    Ok(total_consumed)
}

fn index_scholarship_issuer(env: &Env, issuer: &Address) {
    let count: u64 = env
        .storage()
        .instance()
        .get(&DataKey::ScholarshipIssuerIndexCount)
        .unwrap_or(0);
    let index_key = DataKey::ScholarshipIssuerIndex(count);
    env.storage().persistent().set(&index_key, issuer);
    extend_persistent_ttl(env, &index_key);
    env.storage()
        .instance()
        .set(&DataKey::ScholarshipIssuerIndexCount, &(count + 1));
    extend_instance_ttl(env);
}

#[cfg(test)]
mod test;

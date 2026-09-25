#![no_std]

//! Canonical cross-contract types shared between `material-registry` and
//! `purchase-manager` (#465), so a field-order or enum-discriminant change
//! can't silently desync the two contracts' XDR encodings.
//!
//! # Versioning and rollout order
//!
//! These types are part of both contracts' public ABI. Soroban
//! `#[contracttype]` structs encode as a map keyed by field name, so decoding
//! only ever looks up the *destination* struct's own fields in the source
//! value — a reader with fewer fields than the stored value simply ignores
//! the extra map entries, but a reader compiled against a struct with a field
//! the stored value doesn't have will fail to decode.
//!
//! Rollout order for a breaking change to any type in this crate:
//! 1. Land the change here and in both contracts in the same PR — this crate
//!    has no independent versioning of its own; both contracts always build
//!    against the workspace-pinned copy.
//! 2. Deploy `material-registry` first, `purchase-manager` second, since
//!    `purchase-manager` is the one decoding registry-authored values (via
//!    `get_material`). Deploying in the other order would let
//!    `purchase-manager` reject already-correct registry data during the
//!    window between the two upgrades.
//! 3. Never remove or reorder an existing enum discriminant (`Active = 0`,
//!    etc.) — only append new variants at the end. Removing or reordering
//!    changes the meaning of values already persisted on-chain.

use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// Lifecycle status of a registered material.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaterialStatus {
    Active = 0,
    Paused = 1,
    Archived = 2,
}

/// Classification of a Stellar asset supported for checkout.
///
/// - `Native`            – XLM (the Stellar native asset, wrapped via its SAC).
/// - `Token`              – Any SAC-wrapped token such as USDC or EURC.
/// - `CreatorToken`       – A creator-specific SAC token.
/// - `InstitutionAsset`   – Institution-issued access assets.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssetKind {
    Native = 0,
    Token = 1,
    CreatorToken = 2,
    InstitutionAsset = 3,
}

/// Allowlist record stored for an approved asset. Shared by both contracts'
/// independent allowlists (registry gates `register_material`/
/// `update_sale_terms`; purchase-manager gates `purchase`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetPolicyInfo {
    pub kind: AssetKind,
    pub enabled: bool,
}

/// Asset decimal metadata specifying how UI/display amounts map to on-chain minor units (`i128`) (#710).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetDecimalMetadata {
    pub asset: Address,
    pub decimals: u32,
}

/// Helper functions for canonical minor-unit decimal handling (#710).
pub mod decimals {
    /// Native Stellar XLM decimal precision (7 decimals = stroops).
    pub const NATIVE_XLM_DECIMALS: u32 = 7;
    /// USDC asset default decimal precision (7 decimals).
    pub const USDC_DECIMALS: u32 = 7;

    /// Calculates maximum refund in minor units given original payment in minor units and refund ratio in basis points.
    /// Invariant: Truncates downwards so refund can NEVER round above original payment.
    pub fn calculate_max_refund_minor_units(original_payment: i128, refund_ratio_bps: u32) -> i128 {
        if original_payment <= 0 || refund_ratio_bps == 0 {
            return 0;
        }
        let bps = if refund_ratio_bps > 10_000 { 10_000 } else { refund_ratio_bps };
        (original_payment * (bps as i128)) / 10_000
    }
}


/// A single accepted-asset price quote for a material.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetQuote {
    pub asset: Address,
    pub amount: i128,
}

/// A single payout recipient's share of a sale, in basis points.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutShare {
    pub recipient: Address,
    pub share_bps: u32,
}

/// The subset of a registry material record that `purchase-manager` actually
/// needs from a cross-contract `get_material` call.
///
/// Deliberately narrower than the registry's own (public) material record,
/// which additionally carries `metadata_uri`, `metadata_hash`, `rights_hash`,
/// `created_ledger`, and `updated_ledger`. Because Soroban decodes
/// `#[contracttype]` structs by looking up each of the *destination* struct's
/// fields in the source value's field map, purchase-manager can safely
/// decode a registry-authored value that has more fields than `MaterialView`
/// without paying to deserialize fields it never uses (metadata URIs in
/// particular can be up to 256 bytes). Keeping the registry's full record and
/// this trimmed view as two distinct types is an intentional design choice,
/// not leftover duplication — see the module docs above for the versioning
/// rule that keeps them compatible.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialView {
    pub material_id: BytesN<32>,
    pub creator: Address,
    pub paused: bool,
    pub status: MaterialStatus,
    pub quotes: Vec<AssetQuote>,
    pub payout_shares: Vec<PayoutShare>,
}

/// Minimum enforced delay, in seconds, between initiating and accepting an
/// admin-authority transfer in either contract (#463). Callers may choose a
/// longer delay; this floor exists so a transfer can't be configured with a
/// trivially small delay that defeats the point of the two-step window (e.g.
/// a fat-fingered `delay_secs: 0`).
pub const MIN_ADMIN_TRANSFER_DELAY_SECS: u64 = 3600; // 1 hour

/// A pending, not-yet-accepted admin-authority transfer.
///
/// Shared by both contracts so two-step-transfer semantics (who can cancel,
/// when acceptance becomes valid) can't drift between them, even though each
/// contract stores this under its own `DataKey` variant and applies it to its
/// own authority model (registry: single admin address in instance storage;
/// purchase-manager: additive admin-role set in persistent storage — see
/// each contract's `docs` comments on `transfer` / `accept_transfer`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdminTransfer {
    pub candidate: Address,
    /// Ledger timestamp (seconds) the transfer was initiated at.
    pub initiated_at: u64,
    /// Ledger timestamp (seconds) at or after which `candidate` may accept.
    pub accept_after: u64,
}

/// Canonical, machine-checked snapshots of the on-chain **event schemas**
/// (#673) that indexers and both contracts (`material-registry`,
/// `purchase-manager`) depend on.
///
/// Soroban `#[contractevent]` events are emitted under a leading set of
/// topic `Symbol`s followed by `#[topic]` fields, with the remaining struct
/// fields serialized into the event data payload. A change to any of those
/// topic symbols, their order, or the payload field set is a *breaking*
/// change for every consumer (indexers, entitlement logic, off-chain
/// refund/dispute services).
///
/// These constants are the single source of truth for the event ABI. The
/// snapshot tests in `test.rs` lock them so that renaming a field, reordering
/// topics, or dropping a payload column fails CI in this leaf crate **before**
/// the change can reach production and desync an indexer.
///
/// # Compatibility policy
///
/// - **Additive** payload/topic changes are allowed without a new version, as
///   long as existing columns are not reordered or removed (consumers ignore
///   unknown trailing data columns).
/// - **Breaking** changes (renaming/reordering/removing a topic or a payload
///   field, or changing a field's encoded type) require updating this module
///   and adding an explicitly-named *previous* schema fixture in `test.rs` in
///   the same PR, following the same rollout ordering described at the top of
///   this file (deploy `material-registry` first, `purchase-manager` second).
pub mod events {
    /// A single event schema: its topic column labels (the leading topic
    /// `Symbol`s plus the `#[topic]` field names, in emit order) and its
    /// ordered payload field names (the non-topic struct fields, in
    /// declaration order).
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct EventSchema {
        /// Canonical human-readable event name, e.g. `"purchase.completed"`.
        pub name: &'static str,
        /// Topic `Symbol`s + `#[topic]` field names, in emit order.
        pub topics: &'static [&'static str],
        /// Non-topic payload field names, in declaration order.
        pub fields: &'static [&'static str],
    }

    /// `material-registry`: publish — `register_material`.
    ///
    /// Emits `MaterialRegisteredEvent` with topic symbols
    /// `["material", "registered"]` and `#[topic]` `material_id`, `creator`.
    pub const MATERIAL_REGISTERED: EventSchema = EventSchema {
        name: "material.registered",
        topics: &["material", "registered", "material_id", "creator"],
        fields: &[
            "metadata_uri",
            "metadata_hash",
            "rights_hash",
            "status",
            "quotes",
            "payout_shares",
        ],
    };

    /// `material-registry`: sale update — `update_sale_terms`.
    ///
    /// Emits `MaterialSaleTermsUpdatedEvent` with topic symbols
    /// `["material", "sale_terms_updated"]` and `#[topic]` `material_id`,
    /// `creator`.
    pub const MATERIAL_SALE_TERMS_UPDATED: EventSchema = EventSchema {
        name: "material.sale_terms_updated",
        topics: &["material", "sale_terms_updated", "material_id", "creator"],
        fields: &["status", "quotes", "payout_shares"],
    };

    /// `purchase-manager`: purchase — `purchase`.
    ///
    /// Emits `PurchaseCompletedEvent` with topic symbols
    /// `["purchase", "completed"]` and `#[topic]` `purchase_id`, `material_id`,
    /// `buyer`.
    pub const PURCHASE_COMPLETED: EventSchema = EventSchema {
        name: "purchase.completed",
        topics: &["purchase", "completed", "purchase_id", "material_id", "buyer"],
        fields: &[
            "seller",
            "asset",
            "amount",
            "platform_fee",
            "seller_net_amount",
            "entitlement_active",
            "metadata_hash",
            "rights_hash",
            "sale_terms_version",
            "transaction_id",
        ],
    };

    /// `purchase-manager`: purchase — `purchase_bulk_licenses`.
    ///
    /// Emits `BulkPurchaseCompletedEvent` with topic symbols
    /// `["purchase", "bulk_completed"]` and `#[topic]` `purchaser`,
    /// `material_id`.
    pub const PURCHASE_BULK_COMPLETED: EventSchema = EventSchema {
        name: "purchase.bulk_completed",
        topics: &["purchase", "bulk_completed", "purchaser", "material_id"],
        fields: &["recipient_count", "unit_price", "total_paid", "asset"],
    };

    /// `purchase-manager`: refund — `refund_purchase`.
    ///
    /// Emits `PurchaseRefundedEvent` with topic symbols
    /// `["purchase", "refunded"]` and `#[topic]` `purchase_id`, `material_id`,
    /// `buyer`.
    pub const PURCHASE_REFUNDED: EventSchema = EventSchema {
        name: "purchase.refunded",
        topics: &["purchase", "refunded", "purchase_id", "material_id", "buyer"],
        fields: &["asset", "refund_amount", "entitlement_revoked"],
    };

    /// `purchase-manager`: entitlement lifecycle.
    ///
    /// There is no standalone entitlement event; entitlement status is
    /// surfaced on the purchase/refund events above via `entitlement_active`
    /// (granted) and `entitlement_revoked` (revoked). These two fields are
    /// the cross-contract entitlement schema and must stay present on their
    /// respective events.
    pub const ENTITLEMENT_STATUS_FIELDS: &[&str] =
        &["entitlement_active", "entitlement_revoked"];

    /// Every production event schema tracked by the snapshot suite in
    /// `test.rs`. A new production event must be added here (and covered by a
    /// snapshot test) when it is introduced.
    pub const ALL: &[EventSchema] = &[
        MATERIAL_REGISTERED,
        MATERIAL_SALE_TERMS_UPDATED,
        PURCHASE_COMPLETED,
        PURCHASE_BULK_COMPLETED,
        PURCHASE_REFUNDED,
    ];
}

#[cfg(test)]
mod test;

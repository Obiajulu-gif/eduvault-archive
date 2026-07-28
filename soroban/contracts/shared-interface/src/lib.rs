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

#[cfg(test)]
mod test;

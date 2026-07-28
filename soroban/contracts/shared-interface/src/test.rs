//! Golden compatibility fixtures for the shared cross-contract types (#465).
//!
//! Each test round-trips a value through the exact same storage-encoding
//! path the two contracts use in production (`env.storage()....set` /
//! `.get`), which forces the value through real XDR encode/decode. A field
//! rename, type change, or enum reorder that would desync `material-registry`
//! and `purchase-manager` will break these tests immediately, in this crate,
//! rather than surfacing as a runtime cross-contract-call failure later.
//!
//! This intentionally covers today's deployed shape of each type rather than
//! a history of past versions, since no historical deployed-contract XDR
//! snapshots are available to this repository. When a breaking change is
//! made to any of these types, add the *previous* shape as a second,
//! explicitly-named fixture here before changing it, so the regression this
//! module exists to catch keeps covering both the old and new wire formats
//! during the rollout window described in `lib.rs`'s module docs.

use crate::*;
use soroban_sdk::{contracttype, testutils::Address as _, vec, Env};

#[contracttype]
enum FixtureKey {
    Slot(u32),
}

fn roundtrip<T>(env: &Env, value: &T) -> T
where
    T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val> + soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
{
    let key = FixtureKey::Slot(0);
    env.as_contract(&env.register(FixtureContract, ()), || {
        env.storage().temporary().set(&key, value);
        env.storage().temporary().get(&key).unwrap()
    })
}

#[soroban_sdk::contract]
struct FixtureContract;

#[test]
fn material_status_round_trips_and_keeps_discriminants() {
    let env = Env::default();
    assert_eq!(MaterialStatus::Active as u32, 0);
    assert_eq!(MaterialStatus::Paused as u32, 1);
    assert_eq!(MaterialStatus::Archived as u32, 2);
    assert_eq!(roundtrip(&env, &MaterialStatus::Paused), MaterialStatus::Paused);
}

#[test]
fn asset_kind_round_trips_and_keeps_discriminants() {
    let env = Env::default();
    assert_eq!(AssetKind::Native as u32, 0);
    assert_eq!(AssetKind::Token as u32, 1);
    assert_eq!(AssetKind::CreatorToken as u32, 2);
    assert_eq!(AssetKind::InstitutionAsset as u32, 3);
    assert_eq!(roundtrip(&env, &AssetKind::InstitutionAsset), AssetKind::InstitutionAsset);
}

#[test]
fn asset_policy_info_round_trips() {
    let env = Env::default();
    let value = AssetPolicyInfo {
        kind: AssetKind::Token,
        enabled: true,
    };
    assert_eq!(roundtrip(&env, &value), value);
}

#[test]
fn asset_quote_round_trips() {
    let env = Env::default();
    let value = AssetQuote {
        asset: Address::generate(&env),
        amount: 1_000_000,
    };
    assert_eq!(roundtrip(&env, &value), value);
}

#[test]
fn payout_share_round_trips() {
    let env = Env::default();
    let value = PayoutShare {
        recipient: Address::generate(&env),
        share_bps: 5_000,
    };
    assert_eq!(roundtrip(&env, &value), value);
}

#[test]
fn material_view_round_trips() {
    let env = Env::default();
    let value = MaterialView {
        material_id: BytesN::from_array(&env, &[7u8; 32]),
        creator: Address::generate(&env),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: Address::generate(&env),
                amount: 42,
            },
        ],
        payout_shares: vec![
            &env,
            PayoutShare {
                recipient: Address::generate(&env),
                share_bps: 10_000,
            },
        ],
    };
    assert_eq!(roundtrip(&env, &value), value);
}

#[test]
fn pending_admin_transfer_round_trips() {
    let env = Env::default();
    let value = PendingAdminTransfer {
        candidate: Address::generate(&env),
        initiated_at: 1_000,
        accept_after: 1_000 + MIN_ADMIN_TRANSFER_DELAY_SECS,
    };
    assert_eq!(roundtrip(&env, &value), value);
}

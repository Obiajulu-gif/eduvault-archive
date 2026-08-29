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
    assert_eq!(
        roundtrip(&env, &MaterialStatus::Paused),
        MaterialStatus::Paused
    );
}

#[test]
fn asset_kind_round_trips_and_keeps_discriminants() {
    let env = Env::default();
    assert_eq!(AssetKind::Native as u32, 0);
    assert_eq!(AssetKind::Token as u32, 1);
    assert_eq!(AssetKind::CreatorToken as u32, 2);
    assert_eq!(AssetKind::InstitutionAsset as u32, 3);
    assert_eq!(
        roundtrip(&env, &AssetKind::InstitutionAsset),
        AssetKind::InstitutionAsset
    );
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

// ============== #673: Event Schema Snapshots ==============
//
// These lock the canonical event schemas defined in `crate::events`. A
// breaking change to any topic `Symbol`, its order, or a payload field set
// (rename / reorder / remove / retype) must update `lib.rs`'s `events`
// module AND these fixtures in the same PR, otherwise CI fails here — before
// the drift can desync an indexer or entitlement logic at runtime.

use crate::events::{EventSchema, ALL, ENTITLEMENT_STATUS_FIELDS};

fn schema_has_duplicate(items: &[&str]) -> bool {
    for (i, &item) in items.iter().enumerate() {
        for &other in &items[i + 1..] {
            if item == other {
                return true;
            }
        }
    }
    false
}

fn assert_valid_schema(event: &EventSchema) {
    assert!(!event.name.is_empty(), "event name must not be empty");
    assert!(
        event.topics.len() >= 2,
        "event '{}' must have at least the leading topic symbols",
        event.name
    );
    assert!(
        event.fields.len() >= 1,
        "event '{}' must have at least one payload field",
        event.name
    );
    // No duplicate topic symbols or payload columns — a duplicate is almost
    // always an accidental breaking change.
    assert!(
        !schema_has_duplicate(event.topics),
        "event '{}' has duplicate topic symbols",
        event.name
    );
    assert!(
        !schema_has_duplicate(event.fields),
        "event '{}' has duplicate payload fields",
        event.name
    );
}

#[test]
fn event_schema_snapshots_are_valid_and_complete() {
    // At minimum the publish, sale-update, purchase, refund and entitlement
    // lifecycle events must be snapshotted.
    assert!(ALL.len() >= 5, "expected 5+ event schemas, got {}", ALL.len());

    for expected in [
        "material.registered",
        "material.sale_terms_updated",
        "purchase.completed",
        "purchase.bulk_completed",
        "purchase.refunded",
    ] {
        assert!(
            ALL.iter().any(|e| e.name == expected),
            "event schema '{}' missing from events::ALL",
            expected
        );
    }

    for event in ALL {
        assert_valid_schema(event);
    }
}

#[test]
fn event_schema_names_are_unique() {
    for (i, event) in ALL.iter().enumerate() {
        for other in &ALL[i + 1..] {
            assert_ne!(
                event.name, other.name,
                "duplicate event schema name '{}'",
                event.name
            );
        }
    }
}

#[test]
fn publish_event_schema_snapshot() {
    assert_eq!(events::MATERIAL_REGISTERED.name, "material.registered");
    assert_eq!(
        events::MATERIAL_REGISTERED.topics,
        &["material", "registered", "material_id", "creator"]
    );
    assert_eq!(
        events::MATERIAL_REGISTERED.fields,
        &[
            "metadata_uri",
            "metadata_hash",
            "rights_hash",
            "status",
            "quotes",
            "payout_shares",
        ]
    );
}

#[test]
fn sale_update_event_schema_snapshot() {
    let ev = &events::MATERIAL_SALE_TERMS_UPDATED;
    assert_eq!(ev.name, "material.sale_terms_updated");
    assert_eq!(
        ev.topics,
        &["material", "sale_terms_updated", "material_id", "creator"]
    );
    assert_eq!(ev.fields, &["status", "quotes", "payout_shares"]);
}

#[test]
fn purchase_event_schema_snapshot() {
    let ev = &events::PURCHASE_COMPLETED;
    assert_eq!(ev.name, "purchase.completed");
    assert_eq!(
        ev.topics,
        &["purchase", "completed", "purchase_id", "material_id", "buyer"]
    );
    assert_eq!(
        ev.fields,
        &[
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
        ]
    );
    // The entitlement-granted column must stay on the purchase event.
    assert!(ev.fields.contains(&"entitlement_active"));
}

#[test]
fn bulk_purchase_event_schema_snapshot() {
    let ev = &events::PURCHASE_BULK_COMPLETED;
    assert_eq!(ev.name, "purchase.bulk_completed");
    assert_eq!(
        ev.topics,
        &["purchase", "bulk_completed", "purchaser", "material_id"]
    );
    assert_eq!(ev.fields, &["recipient_count", "unit_price", "total_paid", "asset"]);
}

#[test]
fn refund_event_schema_snapshot() {
    let ev = &events::PURCHASE_REFUNDED;
    assert_eq!(ev.name, "purchase.refunded");
    assert_eq!(
        ev.topics,
        &["purchase", "refunded", "purchase_id", "material_id", "buyer"]
    );
    assert_eq!(ev.fields, &["asset", "refund_amount", "entitlement_revoked"]);
    // The entitlement-revoked column must stay on the refund event.
    assert!(ev.fields.contains(&"entitlement_revoked"));
}

#[test]
fn entitlement_status_fields_are_locked() {
    assert_eq!(
        ENTITLEMENT_STATUS_FIELDS,
        &["entitlement_active", "entitlement_revoked"]
    );
}

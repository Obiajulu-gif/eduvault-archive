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

// ============== Property / Invariant Tests (#fuzz) ==========================
//
// These tests exercise the shared-interface types and helpers under
// randomised inputs rather than fixed examples.  Because the Soroban test
// harness is deterministic we generate "random" values by varying a seed
// byte that drives every parameter, so a failure can always be reproduced
// by re-running with the same seed.  Each property is documented with its
// invariant assumption so contributors know exactly what the test is
// asserting and why the invariant must hold.
//
// Seed sweep range: 0..=255 covers the full u8 space, giving 256 distinct
// parameter combinations per property without requiring an external fuzzing
// framework.

/// Sweep helper: run `f(seed)` for every seed in `0..=255`.
fn sweep(mut f: impl FnMut(u8)) {
    for seed in 0u8..=255 {
        f(seed);
    }
}

// ── Invariant: calculate_max_refund_minor_units never exceeds the original
// payment, regardless of refund_ratio_bps value.
//
// Assumption: a refund must be at most 100 % of the original payment.  Even
// with `refund_ratio_bps = 10_001` the function must clamp and return at
// most `original_payment`.  Negative original_payment always returns 0.
#[test]
fn property_max_refund_never_exceeds_original_payment() {
    sweep(|seed| {
        // Map seed to a range of interesting original_payment values:
        // 0, tiny, typical (1_000_000), large (i128::MAX / 2).
        let payment: i128 = match seed % 4 {
            0 => 0,
            1 => seed as i128,
            2 => 1_000_000i128 * (1 + seed as i128),
            _ => i128::MAX / 2,
        };

        // Map seed to a range of bps values including over-limit ones.
        let bps: u32 = match seed % 5 {
            0 => 0,
            1 => seed as u32,
            2 => 5_000,
            3 => 10_000,
            _ => 10_001 + seed as u32, // deliberately over limit
        };

        let refund = decimals::calculate_max_refund_minor_units(payment, bps);

        // Invariant 1: refund ≤ original_payment for non-negative payments.
        if payment >= 0 {
            assert!(
                refund <= payment,
                "seed={seed} payment={payment} bps={bps}: refund {refund} > payment"
            );
        }

        // Invariant 2: refund ≥ 0 always.
        assert!(
            refund >= 0,
            "seed={seed}: refund {refund} is negative"
        );
    });
}

// ── Invariant: calculate_max_refund_minor_units with bps = 0 always → 0.
//
// Assumption: a zero refund ratio must produce a zero refund, regardless of
// the payment size.  This guards against accidental integer rounding causing
// a non-zero payout when no refund was intended.
#[test]
fn property_zero_bps_always_produces_zero_refund() {
    sweep(|seed| {
        let payment: i128 = (seed as i128) * 1_000_000;
        let refund = decimals::calculate_max_refund_minor_units(payment, 0);
        assert_eq!(
            refund, 0,
            "seed={seed}: zero bps must produce zero refund, got {refund}"
        );
    });
}

// ── Invariant: calculate_max_refund_minor_units with bps = 10_000 (100 %)
// returns exactly the original payment (full refund, no rounding loss).
//
// Assumption: (payment * 10_000) / 10_000 == payment for all non-negative
// payment values that fit in i128 without overflow.
#[test]
fn property_full_bps_returns_exact_original_payment() {
    sweep(|seed| {
        let payment: i128 = seed as i128 * 500_000;
        let refund = decimals::calculate_max_refund_minor_units(payment, 10_000);
        assert_eq!(
            refund, payment,
            "seed={seed}: 10_000 bps must return exactly the payment {payment}, got {refund}"
        );
    });
}

// ── Invariant: refund is monotonically non-decreasing in bps for a fixed
// positive payment.
//
// Assumption: a higher refund ratio must never produce a smaller refund.
// This prevents a logic inversion where increasing the allowed refund
// percentage accidentally reduces what a buyer receives.
#[test]
fn property_refund_monotone_in_bps() {
    sweep(|seed| {
        let payment: i128 = 1_000_000 + seed as i128 * 7_777;
        let bps_lo: u32 = seed as u32 % 5_000;
        let bps_hi: u32 = bps_lo + (seed as u32 % 5_001);

        let refund_lo = decimals::calculate_max_refund_minor_units(payment, bps_lo);
        let refund_hi = decimals::calculate_max_refund_minor_units(payment, bps_hi);

        assert!(
            refund_hi >= refund_lo,
            "seed={seed} payment={payment}: higher bps ({bps_hi}) produced smaller \
             refund ({refund_hi}) than lower bps ({bps_lo}) refund ({refund_lo})"
        );
    });
}

// ── Invariant: refund is monotonically non-decreasing in payment for a
// fixed positive bps.
//
// Assumption: a larger original payment must never yield a smaller refund
// at the same ratio.
#[test]
fn property_refund_monotone_in_payment() {
    sweep(|seed| {
        let bps: u32 = 1 + (seed as u32 % 10_000);
        let payment_lo: i128 = seed as i128 * 100_000;
        let payment_hi: i128 = payment_lo + 1_000_000;

        let refund_lo = decimals::calculate_max_refund_minor_units(payment_lo, bps);
        let refund_hi = decimals::calculate_max_refund_minor_units(payment_hi, bps);

        assert!(
            refund_hi >= refund_lo,
            "seed={seed} bps={bps}: higher payment ({payment_hi}) produced \
             smaller refund ({refund_hi}) than lower payment ({payment_lo}) \
             refund ({refund_lo})"
        );
    });
}

// ── Invariant: AssetQuote and PayoutShare round-trip through storage
// encoding without losing any field, across a sweep of generated values.
//
// Assumption: the XDR codec is lossless for all valid field values, so any
// value written with `storage().set` is exactly recoverable with `.get`.
#[test]
fn property_asset_quote_round_trips_across_amounts() {
    let env = Env::default();
    sweep(|seed| {
        let amount: i128 = seed as i128 * 12_345_678;
        let value = AssetQuote {
            asset: Address::generate(&env),
            amount,
        };
        assert_eq!(
            roundtrip(&env, &value),
            value,
            "seed={seed}: AssetQuote round-trip failed for amount={amount}"
        );
    });
}

#[test]
fn property_payout_share_round_trips_across_bps_values() {
    let env = Env::default();
    sweep(|seed| {
        // Sweep bps from 1 to 10_000 in 256 steps.
        let bps: u32 = 1 + (seed as u32 * 40).min(9_999);
        let value = PayoutShare {
            recipient: Address::generate(&env),
            share_bps: bps,
        };
        assert_eq!(
            roundtrip(&env, &value),
            value,
            "seed={seed}: PayoutShare round-trip failed for bps={bps}"
        );
    });
}

// ── Invariant: MaterialStatus and AssetKind discriminants never change.
//
// Assumption: on-chain XDR encodes enum variants by their integer
// discriminant, so any reorder or removal of a variant changes the meaning
// of values already persisted.  This test locks the discriminants so that
// even a refactor that "looks harmless" in Rust fails CI before it reaches
// a deployed contract.
#[test]
fn property_enum_discriminants_are_stable_across_full_value_range() {
    // MaterialStatus
    assert_eq!(MaterialStatus::Active as u32, 0, "MaterialStatus::Active discriminant changed");
    assert_eq!(MaterialStatus::Paused as u32, 1, "MaterialStatus::Paused discriminant changed");
    assert_eq!(MaterialStatus::Archived as u32, 2, "MaterialStatus::Archived discriminant changed");

    // AssetKind
    assert_eq!(AssetKind::Native as u32, 0, "AssetKind::Native discriminant changed");
    assert_eq!(AssetKind::Token as u32, 1, "AssetKind::Token discriminant changed");
    assert_eq!(AssetKind::CreatorToken as u32, 2, "AssetKind::CreatorToken discriminant changed");
    assert_eq!(AssetKind::InstitutionAsset as u32, 3, "AssetKind::InstitutionAsset discriminant changed");
}

// ── Invariant: MIN_ADMIN_TRANSFER_DELAY_SECS is always exactly 3600 (1 hour).
//
// Assumption: the minimum delay floor is a cross-contract constant shared by
// both registry and purchase-manager.  A change here would silently weaken
// the two-step transfer window, so we lock it with an explicit assertion.
#[test]
fn property_min_admin_transfer_delay_is_one_hour() {
    assert_eq!(
        MIN_ADMIN_TRANSFER_DELAY_SECS, 3600,
        "MIN_ADMIN_TRANSFER_DELAY_SECS changed from 3600 (1 hour); \
         update both contracts and this test together"
    );
}

// ── Invariant: event schemas in events::ALL cover all entitlement-lifecycle
// columns under randomised reindexing.
//
// Assumption: entitlement_active (on purchase.completed) and
// entitlement_revoked (on purchase.refunded) must always be present, no
// matter how fields are reordered within those schemas.  The sweep confirms
// that every index into ALL reaches a valid schema and the two sentinel
// columns are never absent.
#[test]
fn property_all_event_schemas_always_carry_entitlement_lifecycle_columns() {
    // Not seed-dependent: sweeping over ALL indices instead.
    for (i, schema) in events::ALL.iter().enumerate() {
        assert!(!schema.name.is_empty(), "schema[{i}]: empty name");
        assert!(schema.topics.len() >= 2, "schema[{i}] '{}': fewer than 2 topics", schema.name);
        assert!(!schema.fields.is_empty(), "schema[{i}] '{}': no payload fields", schema.name);
    }

    // The two cross-contract entitlement columns must appear on their
    // respective events and must not have been silently removed.
    let purchase_schema = events::ALL.iter().find(|e| e.name == "purchase.completed")
        .expect("purchase.completed schema missing from events::ALL");
    assert!(
        purchase_schema.fields.contains(&"entitlement_active"),
        "purchase.completed is missing 'entitlement_active' payload field"
    );

    let refund_schema = events::ALL.iter().find(|e| e.name == "purchase.refunded")
        .expect("purchase.refunded schema missing from events::ALL");
    assert!(
        refund_schema.fields.contains(&"entitlement_revoked"),
        "purchase.refunded is missing 'entitlement_revoked' payload field"
    );
}

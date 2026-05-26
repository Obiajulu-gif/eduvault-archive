#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{vec, Event};

fn install_contract(env: &Env) -> (Address, MaterialRegistryClient<'_>) {
    let contract_id = env.register(MaterialRegistry, ());
    let client = MaterialRegistryClient::new(env, &contract_id);
    (contract_id, client)
}

fn bytes32(env: &Env, value: u8) -> BytesN<32> {
    BytesN::from_array(env, &[value; 32])
}

fn metadata_uri(env: &Env) -> String {
    String::from_str(env, "ipfs://eduvault/material/intro-to-soroban")
}

fn default_quotes(env: &Env) -> Vec<AssetQuote> {
    let xlm = Address::generate(env);
    let usdc = Address::generate(env);
    vec![
        env,
        AssetQuote {
            asset: xlm,
            amount: 2_000_000,
        },
        AssetQuote {
            asset: usdc,
            amount: 5_000_000,
        },
    ]
}

fn replacement_quotes(env: &Env) -> Vec<AssetQuote> {
    let usdc = Address::generate(env);
    vec![
        env,
        AssetQuote {
            asset: usdc,
            amount: 7_500_000,
        },
    ]
}

fn default_payout_shares(env: &Env) -> Vec<PayoutShare> {
    let creator_payout = Address::generate(env);
    let collaborator_payout = Address::generate(env);
    vec![
        env,
        PayoutShare {
            recipient: creator_payout,
            share_bps: 8_000,
        },
        PayoutShare {
            recipient: collaborator_payout,
            share_bps: 2_000,
        },
    ]
}

fn replacement_payout_shares(env: &Env) -> Vec<PayoutShare> {
    let payout = Address::generate(env);
    vec![
        env,
        PayoutShare {
            recipient: payout,
            share_bps: 10_000,
        },
    ]
}

fn seed_material(
    env: &Env,
    contract_id: &Address,
    creator: &Address,
    material_id: &BytesN<32>,
) -> MaterialRecord {
    let record = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        metadata_uri: metadata_uri(env),
        metadata_hash: bytes32(env, 1),
        rights_hash: bytes32(env, 2),
        status: MaterialStatus::Active,
        quotes: default_quotes(env),
        payout_shares: default_payout_shares(env),
        created_ledger: env.ledger().sequence(),
        updated_ledger: env.ledger().sequence(),
    };
    env.as_contract(contract_id, || put_material(env, &record));
    record
}

#[test]
fn registers_material_and_emits_registered_event() {
    let env = Env::default();
    let (contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let metadata_uri = metadata_uri(&env);
    let metadata_hash = bytes32(&env, 11);
    let rights_hash = bytes32(&env, 22);
    let quotes = default_quotes(&env);
    let payout_shares = default_payout_shares(&env);

    let material_id = client.register_material(
        &creator,
        &metadata_uri,
        &metadata_hash,
        &rights_hash,
        &quotes,
        &payout_shares,
    );
    let registered_events = env.events().all();
    let record = client.get_material(&material_id);

    assert_eq!(record.material_id, material_id);
    assert_eq!(record.creator, creator);
    assert_eq!(record.metadata_uri, metadata_uri);
    assert_eq!(record.metadata_hash, metadata_hash);
    assert_eq!(record.rights_hash, rights_hash);
    assert_eq!(record.status, MaterialStatus::Active);
    assert_eq!(record.quotes, quotes);
    assert_eq!(record.payout_shares, payout_shares);
    assert_eq!(record.payout_shares.len(), 2);
    assert_eq!(record.payout_shares.get_unchecked(0).share_bps, 8_000);
    assert_eq!(record.payout_shares.get_unchecked(1).share_bps, 2_000);
    assert_eq!(record.created_ledger, record.updated_ledger);

    assert_eq!(registered_events.events().len(), 1);
    let _ = contract_id;
}

#[test]
fn rejects_duplicate_quote_assets() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let asset = Address::generate(&env);
    let duplicate_quotes = vec![
        &env,
        AssetQuote {
            asset: asset.clone(),
            amount: 1,
        },
        AssetQuote { asset, amount: 2 },
    ];

    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &duplicate_quotes,
        &default_payout_shares(&env),
    );

    assert_eq!(result, Err(Ok(RegistryError::DuplicateQuoteAsset)));
}

#[test]
fn rejects_empty_payout_shares() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let empty_payouts: Vec<PayoutShare> = vec![&env];
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &empty_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::EmptyPayoutShares)));
}

#[test]
fn rejects_too_many_payout_shares() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let invalid_payouts = vec![
        &env,
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 2_000,
        },
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 2_000,
        },
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 2_000,
        },
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 2_000,
        },
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 1_000,
        },
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 1_000,
        },
    ];
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::TooManyPayoutShares)));
}

#[test]
fn rejects_duplicate_payout_recipient() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let invalid_payouts = vec![
        &env,
        PayoutShare {
            recipient: recipient.clone(),
            share_bps: 5_000,
        },
        PayoutShare {
            recipient,
            share_bps: 5_000,
        },
    ];
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::DuplicatePayoutRecipient)));
}

#[test]
fn rejects_zero_payout_share() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let invalid_payouts = vec![
        &env,
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 0,
        },
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 10_000,
        },
    ];
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShare)));
}

#[test]
fn rejects_payout_share_over_basis_points_without_overflow() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let invalid_payouts = vec![
        &env,
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: u32::MAX,
        },
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 1,
        },
    ];
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShare)));
}

#[test]
fn rejects_payout_share_sum_below_basis_points() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let invalid_payouts = vec![
        &env,
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 7_000,
        },
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 2_000,
        },
    ];
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShareSum)));
}

#[test]
fn rejects_payout_share_sum_above_basis_points() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let invalid_payouts = vec![
        &env,
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 6_000,
        },
        PayoutShare {
            recipient: Address::generate(&env),
            share_bps: 5_000,
        },
    ];
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShareSum)));
}

#[test]
fn rejects_duplicate_material_id_collisions() {
    let env = Env::default();
    let (contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let duplicate_id = derive_material_id(&env, &creator, 0);
    seed_material(&env, &contract_id, &creator, &duplicate_id);

    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 7),
        &bytes32(&env, 8),
        &default_quotes(&env),
        &default_payout_shares(&env),
    );

    assert_eq!(result, Err(Ok(RegistryError::MaterialAlreadyExists)));
}

#[test]
fn requires_creator_auth_for_updates() {
    let env = Env::default();
    let (contract_id, client) = install_contract(&env);

    let creator = Address::generate(&env);
    let material_id = bytes32(&env, 99);
    seed_material(&env, &contract_id, &creator, &material_id);

    let result = client.try_update_sale_terms(
        &material_id,
        &replacement_quotes(&env),
        &replacement_payout_shares(&env),
    );

    assert!(result.is_err());
}

#[test]
fn updates_sale_terms_and_status_and_supports_quote_lookup() {
    let env = Env::default();
    let (contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 4),
        &bytes32(&env, 5),
        &default_quotes(&env),
        &default_payout_shares(&env),
    );

    let next_quotes = replacement_quotes(&env);
    let tracked_asset = next_quotes.get_unchecked(0).asset.clone();
    let next_payout_shares = replacement_payout_shares(&env);

    // Approve the replacement asset before updating sale terms.
    // The upgrade-admin is the first creator; auth is mocked for the whole test.
    client.set_asset_allowed(&creator, &tracked_asset, &AssetKind::Token, &true);

    client.update_sale_terms(&material_id, &next_quotes, &next_payout_shares);
    let sale_terms_events = env.events().all();
    assert_eq!(sale_terms_events.events().len(), 1);
    assert_eq!(
        &sale_terms_events.events()[0],
        &MaterialSaleTermsUpdatedEvent {
            material_id: material_id.clone(),
            creator: creator.clone(),
            status: MaterialStatus::Active,
            quotes: next_quotes.clone(),
            payout_shares: next_payout_shares.clone(),
        }
        .to_xdr(&env, &contract_id)
    );

    client.set_material_status(&material_id, &MaterialStatus::Paused);
    let status_events = env.events().all();
    assert_eq!(status_events.events().len(), 1);
    assert_eq!(
        &status_events.events()[0],
        &MaterialStatusUpdatedEvent {
            material_id: material_id.clone(),
            creator: creator.clone(),
            status: MaterialStatus::Paused,
        }
        .to_xdr(&env, &contract_id)
    );

    let record = client.get_material(&material_id);
    let quote = client.get_quote(&material_id, &tracked_asset);
    let missing_quote = client.get_quote(&material_id, &Address::generate(&env));

    assert_eq!(record.status, MaterialStatus::Paused);
    assert_eq!(record.quotes, next_quotes);
    assert_eq!(record.payout_shares, next_payout_shares);
    assert_eq!(quote, Some(next_quotes.get_unchecked(0)));
    assert_eq!(missing_quote, None);
}

#[test]
fn bootstraps_and_transfers_upgrade_admin() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 33),
        &bytes32(&env, 44),
        &default_quotes(&env),
        &default_payout_shares(&env),
    );
    let _ = client.get_material(&material_id);

    assert_eq!(client.get_upgrade_admin(), Some(creator.clone()));

    let next_admin = Address::generate(&env);
    client.set_upgrade_admin(&creator, &next_admin);
    assert_eq!(client.get_upgrade_admin(), Some(next_admin.clone()));

    let denied = client.try_set_upgrade_admin(&creator, &Address::generate(&env));
    assert_eq!(denied, Err(Ok(RegistryError::NotAuthorized)));
}

// ============== Asset Allowlist Tests ==============

#[test]
fn set_asset_allowed_stores_info_and_emits_event() {
    let env = Env::default();
    let (contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let xlm = Address::generate(&env);

    // Bootstrap: first registration sets upgrade-admin = creator
    client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &default_payout_shares(&env),
    );

    assert!(!client.is_asset_allowed(&xlm));
    assert!(client.get_asset_info(&xlm).is_none());

    client.set_asset_allowed(&creator, &xlm, &AssetKind::Native, &true);
    let asset_policy_events = env.events().all();

    assert!(client.is_asset_allowed(&xlm));
    let info = client.get_asset_info(&xlm).unwrap();
    assert_eq!(info.kind, AssetKind::Native);
    assert!(info.enabled);

    // Check event
    let events = asset_policy_events.events();
    let last = &events[events.len() - 1];
    assert_eq!(
        last,
        &AssetPolicyUpdatedEvent {
            asset: xlm,
            kind: AssetKind::Native,
            enabled: true,
        }
        .to_xdr(&env, &contract_id)
    );
}

#[test]
fn disabling_asset_blocks_quote_registration() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let usdc = Address::generate(&env);

    // First registration; no admin yet so validation is skipped.
    client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &default_payout_shares(&env),
    );

    // Allow USDC, then immediately disable it.
    client.set_asset_allowed(&creator, &usdc, &AssetKind::Token, &true);
    client.set_asset_allowed(&creator, &usdc, &AssetKind::Token, &false);

    // Attempting to register a second material quoting the disabled asset must fail.
    let bad_quotes = vec![
        &env,
        AssetQuote { asset: usdc, amount: 1_000_000 },
    ];
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 10),
        &bytes32(&env, 11),
        &bad_quotes,
        &default_payout_shares(&env),
    );
    assert_eq!(result, Err(Ok(RegistryError::UnapprovedAsset)));
}

#[test]
fn update_sale_terms_rejects_unapproved_asset() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);

    // First registration; no admin yet so validation skipped.
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &default_payout_shares(&env),
    );

    // Try to update with an asset that has never been approved.
    let unapproved = Address::generate(&env);
    let bad_quotes = vec![&env, AssetQuote { asset: unapproved, amount: 5_000_000 }];

    let result = client.try_update_sale_terms(
        &material_id,
        &bad_quotes,
        &default_payout_shares(&env),
    );
    assert_eq!(result, Err(Ok(RegistryError::UnapprovedAsset)));
}

#[test]
fn non_admin_cannot_set_asset_allowed() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let intruder = Address::generate(&env);
    let asset = Address::generate(&env);

    // Bootstrap admin.
    client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &default_payout_shares(&env),
    );

    let result = client.try_set_asset_allowed(&intruder, &asset, &AssetKind::Token, &true);
    assert_eq!(result, Err(Ok(RegistryError::NotAuthorized)));
}

#[test]
fn first_registration_skips_asset_validation() {
    // Before any material has been registered the upgrade-admin key does not
    // exist, so asset allowlist validation must be bypassed entirely.
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    // Use completely random, never-approved addresses for the quotes.
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env),
        &default_payout_shares(&env),
    );
    // Should succeed even though no assets are pre-approved.
    assert!(result.is_ok());
}

#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{vec, Event, IntoVal};

fn install_and_init_contract(
    env: &Env,
) -> (
    Address,
    MaterialRegistryClient<'_>,
    Address,
    Address,
    Address,
) {
    let contract_id = env.register(MaterialRegistry, ());
    let client = MaterialRegistryClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let xlm = Address::generate(env);
    let usdc = Address::generate(env);
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::UpgradeAdmin, &admin);
        env.storage().persistent().set(
            &DataKey::AllowedAsset(xlm.clone()),
            &AllowedAssetInfo {
                kind: AssetKind::Native,
                enabled: true,
            },
        );
        env.storage().persistent().set(
            &DataKey::AllowedAsset(usdc.clone()),
            &AllowedAssetInfo {
                kind: AssetKind::Token,
                enabled: true,
            },
        );
    });
    (contract_id, client, admin, xlm, usdc)
}

fn bytes32(env: &Env, value: u8) -> BytesN<32> {
    BytesN::from_array(env, &[value; 32])
}

fn metadata_uri(env: &Env) -> String {
    String::from_str(env, "ipfs://eduvault/material/intro-to-soroban")
}

fn default_quotes(env: &Env, xlm: &Address, usdc: &Address) -> Vec<AssetQuote> {
    vec![
        env,
        AssetQuote {
            asset: xlm.clone(),
            amount: 2_000_000,
        },
        AssetQuote {
            asset: usdc.clone(),
            amount: 5_000_000,
        },
    ]
}

fn replacement_quotes(env: &Env, usdc: &Address) -> Vec<AssetQuote> {
    vec![
        env,
        AssetQuote {
            asset: usdc.clone(),
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
    xlm: &Address,
    usdc: &Address,
) -> MaterialRecord {
    let record = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        metadata_uri: metadata_uri(env),
        metadata_hash: bytes32(env, 1),
        rights_hash: bytes32(env, 2),
        paused: false,
        status: MaterialStatus::Active,
        quotes: default_quotes(env, xlm, usdc),
        payout_shares: default_payout_shares(env),
        created_ledger: env.ledger().sequence(),
        updated_ledger: env.ledger().sequence(),
    };
    env.as_contract(contract_id, || put_material(env, &record));
    record
}

#[test]
fn initializes_successfully() {
    let env = Env::default();
    let contract_id = env.register(MaterialRegistry, ());
    let client = MaterialRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let initial_assets = vec![
        &env,
        InitialAsset {
            asset: asset.clone(),
            kind: AssetKind::Token,
        },
    ];

    env.mock_all_auths();
    client.initialize(&admin, &initial_assets);

    assert_eq!(client.get_upgrade_admin(), Some(admin));
    assert!(client.is_asset_allowed(&asset));
}

#[test]
fn registers_material_and_emits_registered_event() {
    let env = Env::default();
    let (contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let metadata_uri = metadata_uri(&env);
    let metadata_hash = bytes32(&env, 11);
    let rights_hash = bytes32(&env, 22);
    let quotes = default_quotes(&env, &xlm, &usdc);
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
    assert!(!record.paused);
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
    let (_contract_id, client, _admin, _xlm, _usdc) = install_and_init_contract(&env);
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
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let empty_payouts: Vec<PayoutShare> = vec![&env];
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &empty_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::EmptyPayoutShares)));
}

#[test]
fn rejects_too_many_payout_shares() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
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
        &default_quotes(&env, &xlm, &usdc),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::TooManyPayoutShares)));
}

#[test]
fn rejects_duplicate_payout_recipient() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
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
        &default_quotes(&env, &xlm, &usdc),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::DuplicatePayoutRecipient)));
}

#[test]
fn rejects_zero_payout_share() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
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
        &default_quotes(&env, &xlm, &usdc),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShare)));
}

#[test]
fn rejects_payout_share_over_basis_points_without_overflow() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
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
        &default_quotes(&env, &xlm, &usdc),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShare)));
}

#[test]
fn rejects_payout_share_sum_below_basis_points() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
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
        &default_quotes(&env, &xlm, &usdc),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShareSum)));
}

#[test]
fn rejects_payout_share_sum_above_basis_points() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
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
        &default_quotes(&env, &xlm, &usdc),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShareSum)));
}

#[test]
fn rejects_duplicate_material_id_collisions() {
    let env = Env::default();
    let (contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let duplicate_id = derive_material_id(&env, &creator, 0);
    seed_material(&env, &contract_id, &creator, &duplicate_id, &xlm, &usdc);

    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 7),
        &bytes32(&env, 8),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    assert_eq!(result, Err(Ok(RegistryError::MaterialAlreadyExists)));
}

#[test]
fn requires_creator_auth_for_updates() {
    let env = Env::default();
    let (contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);

    let creator = Address::generate(&env);
    let material_id = bytes32(&env, 99);
    seed_material(&env, &contract_id, &creator, &material_id, &xlm, &usdc);

    let result = client.try_update_sale_terms(
        &material_id,
        &replacement_quotes(&env, &usdc),
        &replacement_payout_shares(&env),
    );

    assert!(result.is_err());
}

#[test]
fn updates_sale_terms_and_status_and_supports_quote_lookup() {
    let env = Env::default();
    let (contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 4),
        &bytes32(&env, 5),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let next_quotes = replacement_quotes(&env, &usdc);
    let tracked_asset = next_quotes.get_unchecked(0).asset.clone();
    let next_payout_shares = replacement_payout_shares(&env);

    // Approve the replacement asset before updating sale terms.
    // The upgrade-admin is the first creator; auth is mocked for the whole test.

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

    client.set_material_status(&creator, &material_id, &MaterialStatus::Paused);
    let status_events = env.events().all();
    assert_eq!(status_events.events().len(), 2);
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
    assert!(record.paused);
    assert_eq!(record.quotes, next_quotes);
    assert_eq!(record.payout_shares, next_payout_shares);
    assert_eq!(quote, Some(next_quotes.get_unchecked(0)));
    assert_eq!(missing_quote, None);
}

#[test]
fn transfers_upgrade_admin() {
    let env = Env::default();
    let (_contract_id, client, admin, _xlm, _usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    assert_eq!(client.get_upgrade_admin(), Some(admin.clone()));

    let next_admin = Address::generate(&env);
    client.set_upgrade_admin(&admin, &next_admin);
    assert_eq!(client.get_upgrade_admin(), Some(next_admin.clone()));

    let denied = client.try_set_upgrade_admin(&admin, &Address::generate(&env));
    assert_eq!(denied, Err(Ok(RegistryError::NotAuthorized)));
}

// ============== Asset Allowlist Tests ==============

#[test]
fn set_asset_allowed_stores_info_and_emits_event() {
    let env = Env::default();
    let (contract_id, client, admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let new_asset = Address::generate(&env);

    // Bootstrap: first registration sets upgrade-admin = creator
    client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    assert!(!client.is_asset_allowed(&new_asset));
    assert!(client.get_asset_info(&new_asset).is_none());

    client.set_asset_allowed(&admin, &new_asset, &AssetKind::Native, &true);
    let asset_policy_events = env.events().all();

    assert!(client.is_asset_allowed(&new_asset));
    let info = client.get_asset_info(&new_asset).unwrap();
    assert_eq!(info.kind, AssetKind::Native);
    assert!(info.enabled);

    // Check event
    let events = asset_policy_events.events();
    let last = &events[events.len() - 1];
    assert_eq!(
        last,
        &AssetPolicyUpdatedEvent {
            asset: new_asset.clone(),
            kind: AssetKind::Native,
            enabled: true,
        }
        .to_xdr(&env, &contract_id)
    );
}

#[test]
fn disabling_asset_blocks_quote_registration() {
    let env = Env::default();
    let (_contract_id, client, admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);

    // First registration; no admin yet so validation is skipped.
    client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    // Allow USDC, then immediately disable it.
    client.set_asset_allowed(&admin, &usdc, &AssetKind::Token, &true);
    client.set_asset_allowed(&admin, &usdc, &AssetKind::Token, &false);

    // Attempting to register a second material quoting the disabled asset must fail.
    let bad_quotes = vec![
        &env,
        AssetQuote {
            asset: usdc.clone(),
            amount: 1_000_000,
        },
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
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);

    // First registration; no admin yet so validation skipped.
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    // Try to update with an asset that has never been approved.
    let unapproved = Address::generate(&env);
    let bad_quotes = vec![
        &env,
        AssetQuote {
            asset: unapproved,
            amount: 5_000_000,
        },
    ];

    let result =
        client.try_update_sale_terms(&material_id, &bad_quotes, &default_payout_shares(&env));
    assert_eq!(result, Err(Ok(RegistryError::UnapprovedAsset)));
}

#[test]
fn non_admin_cannot_set_asset_allowed() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
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
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let result = client.try_set_asset_allowed(&intruder, &asset, &AssetKind::Token, &true);
    assert_eq!(result, Err(Ok(RegistryError::NotAuthorized)));
}

// ============== Version Anchoring Tests ==============

fn version_manifest_digest(env: &Env, value: u8) -> BytesN<32> {
    BytesN::from_array(env, &[value; 32])
}

fn version_file_cid(env: &Env, version: u32) -> String {
    if version == 1 {
        String::from_str(env, "QmVersion1")
    } else {
        String::from_str(env, "QmVersion2")
    }
}

#[test]
fn publishes_version_and_emits_event() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );
    let digest = version_manifest_digest(&env, 11);
    let file_cid = version_file_cid(&env, 1);
    let file_hash = version_manifest_digest(&env, 21);

    client.publish_version(&material_id, &1, &digest, &file_cid, &file_hash, &None);
    let events = env.events().all();

    let record = client.get_version(&material_id, &1);
    assert_eq!(record.material_id, material_id);
    assert_eq!(record.version, 1);
    assert_eq!(record.manifest_digest, digest);
    assert_eq!(record.file_cid, file_cid);
    assert_eq!(record.file_hash, file_hash);
    assert_eq!(record.previous_version_digest, None);
    assert_eq!(record.creator, creator);
    assert!(!record.withdrawn);

    assert_eq!(events.events().len(), 1);
}

#[test]
fn publishes_chained_versions() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let digest_v1 = version_manifest_digest(&env, 11);
    let cid_v1 = version_file_cid(&env, 1);
    let hash_v1 = version_manifest_digest(&env, 21);

    client.publish_version(&material_id, &1, &digest_v1, &cid_v1, &hash_v1, &None);

    let digest_v2 = version_manifest_digest(&env, 12);
    let cid_v2 = version_file_cid(&env, 2);
    let hash_v2 = version_manifest_digest(&env, 22);

    client.publish_version(
        &material_id,
        &2,
        &digest_v2,
        &cid_v2,
        &hash_v2,
        &Some(digest_v1.clone()),
    );

    let latest = client.get_latest_version(&material_id);
    assert_eq!(latest, 2);

    let v1 = client.get_version(&material_id, &1);
    let v2 = client.get_version(&material_id, &2);
    assert_eq!(v2.previous_version_digest, Some(digest_v1));
    assert_eq!(v1.previous_version_digest, None);
}

#[test]
fn rejects_duplicate_version() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let digest = version_manifest_digest(&env, 11);
    let file_cid = version_file_cid(&env, 1);
    let file_hash = version_manifest_digest(&env, 21);

    client.publish_version(&material_id, &1, &digest, &file_cid, &file_hash, &None);

    let result = client.try_publish_version(
        &material_id,
        &1,
        &version_manifest_digest(&env, 99),
        &version_file_cid(&env, 99),
        &version_manifest_digest(&env, 99),
        &None,
    );
    assert_eq!(result, Err(Ok(RegistryError::VersionAlreadyPublished)));
}

#[test]
fn rejects_version_zero_and_out_of_range() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let digest = version_manifest_digest(&env, 11);
    let file_cid = version_file_cid(&env, 1);
    let file_hash = version_manifest_digest(&env, 21);

    let result =
        client.try_publish_version(&material_id, &0, &digest, &file_cid, &file_hash, &None);
    assert_eq!(result, Err(Ok(RegistryError::InvalidVersionNumber)));

    let result =
        client.try_publish_version(&material_id, &10001, &digest, &file_cid, &file_hash, &None);
    assert_eq!(result, Err(Ok(RegistryError::InvalidVersionNumber)));
}

#[test]
fn rejects_empty_file_cid() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let digest = version_manifest_digest(&env, 11);
    let empty_cid = String::from_str(&env, "");
    let file_hash = version_manifest_digest(&env, 21);

    let result =
        client.try_publish_version(&material_id, &1, &digest, &empty_cid, &file_hash, &None);
    assert_eq!(result, Err(Ok(RegistryError::InvalidFileCid)));
}

#[test]
fn rejects_version_chain_break() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let digest_v1 = version_manifest_digest(&env, 11);
    let cid_v1 = version_file_cid(&env, 1);
    let hash_v1 = version_manifest_digest(&env, 21);

    client.publish_version(&material_id, &1, &digest_v1, &cid_v1, &hash_v1, &None);

    // V2 with wrong previous digest
    let digest_v2 = version_manifest_digest(&env, 12);
    let cid_v2 = version_file_cid(&env, 2);
    let hash_v2 = version_manifest_digest(&env, 22);
    let wrong_digest = version_manifest_digest(&env, 99);

    let result = client.try_publish_version(
        &material_id,
        &2,
        &digest_v2,
        &cid_v2,
        &hash_v2,
        &Some(wrong_digest),
    );
    assert_eq!(result, Err(Ok(RegistryError::VersionChainBroken)));
}

#[test]
fn rejects_v2_without_previous_digest() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let digest_v1 = version_manifest_digest(&env, 11);
    let cid_v1 = version_file_cid(&env, 1);
    let hash_v1 = version_manifest_digest(&env, 21);

    client.publish_version(&material_id, &1, &digest_v1, &cid_v1, &hash_v1, &None);

    let digest_v2 = version_manifest_digest(&env, 12);
    let cid_v2 = version_file_cid(&env, 2);
    let hash_v2 = version_manifest_digest(&env, 22);

    let result = client.try_publish_version(&material_id, &2, &digest_v2, &cid_v2, &hash_v2, &None);
    assert_eq!(result, Err(Ok(RegistryError::VersionChainBroken)));
}

#[test]
fn rejects_v1_with_previous_digest() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let digest = version_manifest_digest(&env, 11);
    let file_cid = version_file_cid(&env, 1);
    let file_hash = version_manifest_digest(&env, 21);
    let fake_digest = version_manifest_digest(&env, 99);

    let result = client.try_publish_version(
        &material_id,
        &1,
        &digest,
        &file_cid,
        &file_hash,
        &Some(fake_digest),
    );
    assert_eq!(result, Err(Ok(RegistryError::VersionChainBroken)));
}

#[test]
fn withdraw_version_blocks_subsequent_versions() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let digest_v1 = version_manifest_digest(&env, 11);
    let cid_v1 = version_file_cid(&env, 1);
    let hash_v1 = version_manifest_digest(&env, 21);

    client.publish_version(&material_id, &1, &digest_v1, &cid_v1, &hash_v1, &None);

    client.withdraw_version(
        &creator,
        &material_id,
        &1,
        &String::from_str(&env, "security recall"),
    );

    let v1 = client.get_version(&material_id, &1);
    assert!(v1.withdrawn);
    assert_eq!(
        v1.withdrawal_reason,
        String::from_str(&env, "security recall")
    );

    // Cannot publish v2 chaining from withdrawn v1
    let digest_v2 = version_manifest_digest(&env, 12);
    let cid_v2 = version_file_cid(&env, 2);
    let hash_v2 = version_manifest_digest(&env, 22);

    let result = client.try_publish_version(
        &material_id,
        &2,
        &digest_v2,
        &cid_v2,
        &hash_v2,
        &Some(digest_v1),
    );
    assert_eq!(result, Err(Ok(RegistryError::VersionChainBroken)));
}

#[test]
fn cannot_withdraw_already_withdrawn_version() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let digest = version_manifest_digest(&env, 11);
    let file_cid = version_file_cid(&env, 1);
    let file_hash = version_manifest_digest(&env, 21);

    client.publish_version(&material_id, &1, &digest, &file_cid, &file_hash, &None);

    client.withdraw_version(
        &creator,
        &material_id,
        &1,
        &String::from_str(&env, "first recall"),
    );

    let result = client.try_withdraw_version(
        &creator,
        &material_id,
        &1,
        &String::from_str(&env, "second recall"),
    );
    assert_eq!(result, Err(Ok(RegistryError::VersionAlreadyWithdrawn)));
}

#[test]
fn verify_version_digest_works() {
    let env = Env::default();
    let (_contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let digest = version_manifest_digest(&env, 11);
    let file_cid = version_file_cid(&env, 1);
    let file_hash = version_manifest_digest(&env, 21);

    client.publish_version(&material_id, &1, &digest, &file_cid, &file_hash, &None);

    assert!(client.verify_version_digest(&material_id, &1, &digest));
    assert!(!client.verify_version_digest(&material_id, &1, &version_manifest_digest(&env, 99)));

    // Non-existent version
    let result = client.try_verify_version_digest(&material_id, &2, &digest);
    assert_eq!(result, Err(Ok(RegistryError::VersionNotFound)));
}

#[test]
fn non_creator_cannot_publish_version() {
    let env = Env::default();
    let (contract_id, client, _admin, xlm, usdc) = install_and_init_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &xlm, &usdc),
        &default_payout_shares(&env),
    );

    let intruder = Address::generate(&env);
    let digest = version_manifest_digest(&env, 11);
    let file_cid = version_file_cid(&env, 1);
    let file_hash = version_manifest_digest(&env, 21);

    // Only intruder is auth'd — creator is not mocked
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &intruder,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "publish_version",
            args: (
                &material_id,
                &1u32,
                &digest,
                &file_cid,
                &file_hash,
                &None::<BytesN<32>>,
            )
                .into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let result =
        client.try_publish_version(&material_id, &1, &digest, &file_cid, &file_hash, &None);
    assert!(result.is_err());
}

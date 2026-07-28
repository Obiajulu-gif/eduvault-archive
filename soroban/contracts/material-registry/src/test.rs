#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{vec, Event};

/// Registers and initializes a fresh registry contract (#462 — no material
/// can be registered before `initialize` is called), returning the contract
/// id, a client, and the admin address `initialize` was called with.
///
/// Calls `env.mock_all_auths()` up front (idempotent — harmless if a test
/// also calls it again afterwards) since `initialize` itself requires the
/// admin's auth.
fn install_contract(env: &Env) -> (Address, MaterialRegistryClient<'_>, Address) {
    env.mock_all_auths();
    let contract_id = env.register(MaterialRegistry, ());
    let client = MaterialRegistryClient::new(env, &contract_id);
    let admin = Address::generate(env);
    client.initialize(&admin, &Vec::new(env));
    (contract_id, client, admin)
}

fn bytes32(env: &Env, value: u8) -> BytesN<32> {
    BytesN::from_array(env, &[value; 32])
}

fn metadata_uri(env: &Env) -> String {
    String::from_str(env, "ipfs://eduvault/material/intro-to-soroban")
}

/// Generates a fresh XLM + USDC quote pair and approves both assets on the
/// allowlist (#462 removed the pre-initialization allowlist bypass, so every
/// quote asset used in a test now needs an explicit approval).
fn default_quotes(env: &Env, client: &MaterialRegistryClient, admin: &Address) -> Vec<AssetQuote> {
    let xlm = Address::generate(env);
    let usdc = Address::generate(env);
    client.set_asset_allowed(admin, &xlm, &AssetKind::Native, &true);
    client.set_asset_allowed(admin, &usdc, &AssetKind::Token, &true);
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

fn replacement_quotes(env: &Env, client: &MaterialRegistryClient, admin: &Address) -> Vec<AssetQuote> {
    let usdc = Address::generate(env);
    client.set_asset_allowed(admin, &usdc, &AssetKind::Token, &true);
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
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            env,
            AssetQuote {
                asset: Address::generate(env),
                amount: 2_000_000,
            },
        ],
        payout_shares: default_payout_shares(env),
        created_ledger: env.ledger().sequence(),
        updated_ledger: env.ledger().sequence(),
    };
    env.as_contract(contract_id, || {
        put_material_core(
            env,
            material_id,
            &MaterialCore {
                creator: record.creator.clone(),
                metadata_uri: record.metadata_uri.clone(),
                metadata_hash: record.metadata_hash.clone(),
                rights_hash: record.rights_hash.clone(),
                created_ledger: record.created_ledger,
            },
        );
        put_material_sale(env, material_id, &sale_state_from_record(&record));
    });
    record
}

#[test]
fn registers_material_and_emits_registered_event() {
    let env = Env::default();
    let (contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let metadata_uri = metadata_uri(&env);
    let metadata_hash = bytes32(&env, 11);
    let rights_hash = bytes32(&env, 22);
    let quotes = default_quotes(&env, &client, &admin);
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
    let (_contract_id, client, admin) = install_contract(&env);
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
    let (_contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let empty_payouts: Vec<PayoutShare> = vec![&env];
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &client, &admin),
        &empty_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::EmptyPayoutShares)));
}

#[test]
fn rejects_too_many_payout_shares() {
    let env = Env::default();
    let (_contract_id, client, admin) = install_contract(&env);
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
        &default_quotes(&env, &client, &admin),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::TooManyPayoutShares)));
}

#[test]
fn rejects_duplicate_payout_recipient() {
    let env = Env::default();
    let (_contract_id, client, admin) = install_contract(&env);
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
        &default_quotes(&env, &client, &admin),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::DuplicatePayoutRecipient)));
}

#[test]
fn rejects_zero_payout_share() {
    let env = Env::default();
    let (_contract_id, client, admin) = install_contract(&env);
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
        &default_quotes(&env, &client, &admin),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShare)));
}

#[test]
fn rejects_payout_share_over_basis_points_without_overflow() {
    let env = Env::default();
    let (_contract_id, client, admin) = install_contract(&env);
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
        &default_quotes(&env, &client, &admin),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShare)));
}

#[test]
fn rejects_payout_share_sum_below_basis_points() {
    let env = Env::default();
    let (_contract_id, client, admin) = install_contract(&env);
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
        &default_quotes(&env, &client, &admin),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShareSum)));
}

#[test]
fn rejects_payout_share_sum_above_basis_points() {
    let env = Env::default();
    let (_contract_id, client, admin) = install_contract(&env);
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
        &default_quotes(&env, &client, &admin),
        &invalid_payouts,
    );

    assert_eq!(result, Err(Ok(RegistryError::InvalidPayoutShareSum)));
}

#[test]
fn rejects_duplicate_material_id_collisions() {
    let env = Env::default();
    let (contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let duplicate_id = derive_material_id(&env, &creator, 0);
    seed_material(&env, &contract_id, &creator, &duplicate_id);

    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 7),
        &bytes32(&env, 8),
        &default_quotes(&env, &client, &admin),
        &default_payout_shares(&env),
    );

    assert_eq!(result, Err(Ok(RegistryError::MaterialAlreadyExists)));
}

#[test]
fn requires_creator_auth_for_updates() {
    let env = Env::default();
    let (contract_id, client, admin) = install_contract(&env);

    let creator = Address::generate(&env);
    let material_id = bytes32(&env, 99);
    seed_material(&env, &contract_id, &creator, &material_id);

    let result = client.try_update_sale_terms(
        &material_id,
        &replacement_quotes(&env, &client, &admin),
        &replacement_payout_shares(&env),
    );

    assert!(result.is_err());
}

#[test]
fn updates_sale_terms_and_status_and_supports_quote_lookup() {
    let env = Env::default();
    let (contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 4),
        &bytes32(&env, 5),
        &default_quotes(&env, &client, &admin),
        &default_payout_shares(&env),
    );

    let next_quotes = replacement_quotes(&env, &client, &admin);
    let tracked_asset = next_quotes.get_unchecked(0).asset.clone();
    let next_payout_shares = replacement_payout_shares(&env);

    // `replacement_quotes` already approved `tracked_asset` on the allowlist.

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
fn initialize_sets_admin_and_rejects_double_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client, admin) = install_contract(&env);

    assert_eq!(client.get_upgrade_admin(), Some(admin.clone()));

    let result = client.try_initialize(&Address::generate(&env), &Vec::new(&env));
    assert_eq!(result, Err(Ok(RegistryError::AlreadyInitialized)));
}

#[test]
fn register_material_requires_initialization() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(MaterialRegistry, ());
    let client = MaterialRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);

    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &vec![&env],
        &default_payout_shares(&env),
    );
    assert_eq!(result, Err(Ok(RegistryError::NotInitialized)));
}

#[test]
fn admin_transfer_requires_delay_before_acceptance_and_revokes_old_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client, admin) = install_contract(&env);

    let next_admin = Address::generate(&env);

    // A delay below the shared minimum floor is rejected.
    let too_short = client.try_initiate_admin_transfer(&admin, &next_admin, &60);
    assert_eq!(too_short, Err(Ok(RegistryError::InvalidTransferDelay)));

    client.initiate_admin_transfer(&admin, &next_admin, &shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS);
    assert_eq!(
        client.get_pending_admin_transfer(),
        Some(PendingAdminTransfer {
            candidate: next_admin.clone(),
            initiated_at: env.ledger().timestamp(),
            accept_after: env.ledger().timestamp() + shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS,
        })
    );

    // Accepting before the delay elapses is rejected.
    let too_early = client.try_accept_admin_transfer(&next_admin);
    assert_eq!(too_early, Err(Ok(RegistryError::TransferDelayNotElapsed)));

    // Old admin is still fully authoritative during the pending window.
    assert_eq!(client.get_upgrade_admin(), Some(admin.clone()));

    env.ledger()
        .set_timestamp(env.ledger().timestamp() + shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS);
    client.accept_admin_transfer(&next_admin);

    assert_eq!(client.get_upgrade_admin(), Some(next_admin.clone()));
    assert_eq!(client.get_pending_admin_transfer(), None);

    // The old admin no longer has any authority (single-admin model — the
    // slot was overwritten, so this is an implicit revocation).
    let denied = client.try_initiate_admin_transfer(
        &admin,
        &Address::generate(&env),
        &shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS,
    );
    assert_eq!(denied, Err(Ok(RegistryError::NotAuthorized)));
}

#[test]
fn admin_transfer_can_be_cancelled_before_acceptance() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client, admin) = install_contract(&env);

    let next_admin = Address::generate(&env);
    client.initiate_admin_transfer(&admin, &next_admin, &shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS);
    assert!(client.get_pending_admin_transfer().is_some());

    client.cancel_admin_transfer(&admin);
    assert_eq!(client.get_pending_admin_transfer(), None);

    env.ledger()
        .set_timestamp(env.ledger().timestamp() + shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS);
    let result = client.try_accept_admin_transfer(&next_admin);
    assert_eq!(result, Err(Ok(RegistryError::NoPendingAdminTransfer)));

    // Admin authority never moved.
    assert_eq!(client.get_upgrade_admin(), Some(admin));
}

#[test]
fn only_nominated_candidate_can_accept_admin_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client, admin) = install_contract(&env);

    let candidate = Address::generate(&env);
    let impostor = Address::generate(&env);
    client.initiate_admin_transfer(&admin, &candidate, &shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS);

    env.ledger()
        .set_timestamp(env.ledger().timestamp() + shared_interface::MIN_ADMIN_TRANSFER_DELAY_SECS);
    let result = client.try_accept_admin_transfer(&impostor);
    assert_eq!(result, Err(Ok(RegistryError::NotAuthorized)));
}

// ============== Asset Allowlist Tests ==============

#[test]
fn set_asset_allowed_stores_info_and_emits_event() {
    let env = Env::default();
    let (contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let xlm = Address::generate(&env);

    client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &client, &admin),
        &default_payout_shares(&env),
    );

    assert!(!client.is_asset_allowed(&xlm));
    assert!(client.get_asset_info(&xlm).is_none());

    client.set_asset_allowed(&admin, &xlm, &AssetKind::Native, &true);
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
    let (_contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let usdc = Address::generate(&env);

    client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &client, &admin),
        &default_payout_shares(&env),
    );

    // Allow USDC, then immediately disable it.
    client.set_asset_allowed(&admin, &usdc, &AssetKind::Token, &true);
    client.set_asset_allowed(&admin, &usdc, &AssetKind::Token, &false);

    // Attempting to register a second material quoting the disabled asset must fail.
    let bad_quotes = vec![
        &env,
        AssetQuote {
            asset: usdc,
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
    let (_contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);

    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &client, &admin),
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
    let (_contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let intruder = Address::generate(&env);
    let asset = Address::generate(&env);

    client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &client, &admin),
        &default_payout_shares(&env),
    );

    let result = client.try_set_asset_allowed(&intruder, &asset, &AssetKind::Token, &true);
    assert_eq!(result, Err(Ok(RegistryError::NotAuthorized)));
}

#[test]
fn first_registration_still_enforces_asset_allowlist() {
    // (#462) The registry used to skip allowlist validation for whichever
    // material was registered first, since the upgrade-admin key didn't
    // exist yet at that point. Now that `initialize` establishes the admin
    // before any material can be registered, there is no more
    // before-the-first-registration state to bypass — even the very first
    // registration must use pre-approved assets.
    let env = Env::default();
    let (_contract_id, client, _admin) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let never_approved = Address::generate(&env);
    let quotes = vec![
        &env,
        AssetQuote {
            asset: never_approved,
            amount: 1_000_000,
        },
    ];

    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &quotes,
        &default_payout_shares(&env),
    );
    assert_eq!(result, Err(Ok(RegistryError::UnapprovedAsset)));
}

#[test]
fn initialize_can_pre_approve_assets_atomically() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(MaterialRegistry, ());
    let client = MaterialRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let xlm = Address::generate(&env);

    client.initialize(
        &admin,
        &vec![
            &env,
            InitialAssetPolicy {
                asset: xlm.clone(),
                kind: AssetKind::Native,
                enabled: true,
            },
        ],
    );

    assert!(client.is_asset_allowed(&xlm));

    let creator = Address::generate(&env);
    let quotes = vec![
        &env,
        AssetQuote {
            asset: xlm,
            amount: 1_000_000,
        },
    ];
    let result = client.try_register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &quotes,
        &default_payout_shares(&env),
    );
    assert!(result.is_ok());
}

// ============== Storage cost comparison (#255) ==============
//
// Sale-term/status updates are the most frequent write path in the registry
// (price changes, pausing, archiving), far outnumbering initial
// registrations over a material's lifetime. Prior to the MaterialCore /
// MaterialSaleState split, every one of those updates rewrote the *entire*
// record — creator, metadata_uri (up to 256 bytes), both 32-byte hashes, and
// created_ledger — none of which ever change after registration. This test
// measures the write cost of that legacy single-entry shape against the new
// split layout's update path, using the SDK's invocation cost metering.

/// Mirrors the pre-#255 combined storage entry: every field the registry
/// used to rewrite on every single call, including the redundant
/// `material_id` (already implied by the storage key).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct LegacyMaterialRecord {
    material_id: BytesN<32>,
    creator: Address,
    metadata_uri: String,
    metadata_hash: BytesN<32>,
    rights_hash: BytesN<32>,
    paused: bool,
    status: MaterialStatus,
    quotes: Vec<AssetQuote>,
    payout_shares: Vec<PayoutShare>,
    created_ledger: u32,
    updated_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
enum LegacyDataKey {
    Material(BytesN<32>),
}

#[test]
fn sale_term_update_write_cost_drops_at_least_20_percent_vs_legacy_layout() {
    let env = Env::default();
    let (contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &client, &admin),
        &default_payout_shares(&env),
    );

    let next_quotes = replacement_quotes(&env, &client, &admin);
    let tracked_asset = next_quotes.get_unchecked(0).asset.clone();
    let next_payout_shares = replacement_payout_shares(&env);
    // `replacement_quotes` already approved `tracked_asset` on the allowlist.

    // Baseline: cost of rewriting the legacy single-entry record shape, as
    // the pre-#255 `update_sale_terms` implementation used to do on every
    // sale-term update.
    let legacy_record = LegacyMaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        metadata_uri: metadata_uri(&env),
        metadata_hash: bytes32(&env, 1),
        rights_hash: bytes32(&env, 2),
        paused: false,
        status: MaterialStatus::Active,
        quotes: next_quotes.clone(),
        payout_shares: next_payout_shares.clone(),
        created_ledger: env.ledger().sequence(),
        updated_ledger: env.ledger().sequence(),
    };
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(
            &LegacyDataKey::Material(material_id.clone()),
            &legacy_record,
        );
    });
    let legacy_write_bytes = env.cost_estimate().resources().write_bytes;

    // New: cost of the actual `update_sale_terms` call, which now only
    // rewrites the MaterialSale entry.
    client.update_sale_terms(&material_id, &next_quotes, &next_payout_shares);
    let split_write_bytes = env.cost_estimate().resources().write_bytes;

    std::println!(
        "material-registry storage comparison — legacy single-entry write: {} bytes; \
         split MaterialSale-only write: {} bytes ({:.1}% reduction)",
        legacy_write_bytes,
        split_write_bytes,
        100.0 * (1.0 - (split_write_bytes as f64 / legacy_write_bytes as f64))
    );

    assert!(
        (split_write_bytes as f64) <= (legacy_write_bytes as f64) * 0.8,
        "expected at least a 20% reduction in write bytes: legacy={} split={}",
        legacy_write_bytes,
        split_write_bytes,
    );
}

// ============== TTL Renewal Tests (#464) ==============

/// Small, deterministic TTL window for these tests: large enough to clear
/// the network's minimum persistent-entry TTL, small enough that advancing
/// a few thousand ledgers is enough to cross the renewal threshold.
fn set_short_ttl_window(env: &Env) {
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 100;
        li.max_entry_ttl = 20_000;
    });
}

/// The test host advances the ledger sequence by a small amount between
/// separate top-level invocations, so a TTL measured a call or two after a
/// renewal can read a few ledgers below the exact `extend_to` value. Allow
/// a small tolerance rather than asserting an exact figure.
fn assert_ttl_renewed_to_max(ttl: u32) {
    assert!(
        (19_990..=20_000).contains(&ttl),
        "expected TTL near the 20_000 max, got {ttl}"
    );
}

#[test]
fn upgrade_admin_ttl_renews_on_every_touch_and_never_lapses() {
    let env = Env::default();
    let (contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let creator = Address::generate(&env);
    client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &client, &admin),
        &default_payout_shares(&env),
    );

    let initial_ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    assert_ttl_renewed_to_max(initial_ttl);

    // Advance well past the renewal threshold (half of max) without any
    // call touching admin state.
    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    // Any admin-touching call — here, a plain read — renews the instance
    // TTL straight back to the max, demonstrating admin state cannot expire
    // silently as long as the contract is used at all.
    assert_eq!(client.get_upgrade_admin(), Some(creator));

    let renewed_ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    assert_ttl_renewed_to_max(renewed_ttl);
}

#[test]
fn material_ttl_renews_on_read_after_partial_lapse() {
    let env = Env::default();
    let (contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let creator = Address::generate(&env);
    let material_id = client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &client, &admin),
        &default_payout_shares(&env),
    );

    let core_key = DataKey::MaterialCore(material_id.clone());
    let sale_key = DataKey::MaterialSale(material_id.clone());

    let initial_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&core_key)
    });
    assert_ttl_renewed_to_max(initial_ttl);

    // Advance past the renewal threshold without reading the material.
    env.ledger().with_mut(|li| li.sequence_number += 12_000);
    let lapsed_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&core_key)
    });
    assert!(
        (7_990..=8_000).contains(&lapsed_ttl),
        "expected TTL to have decayed to ~8_000, got {lapsed_ttl}"
    );

    // A plain read — the same lookup a buyer's purchase attempt performs —
    // renews both halves of the record back to the max, with no special
    // maintenance call required.
    let record = client.get_material(&material_id);
    assert_eq!(record.material_id, material_id);

    let renewed_core_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&core_key)
    });
    let renewed_sale_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&sale_key)
    });
    assert_ttl_renewed_to_max(renewed_core_ttl);
    assert_ttl_renewed_to_max(renewed_sale_ttl);
}

#[test]
fn allowed_asset_ttl_renews_on_write() {
    let env = Env::default();
    let (contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let creator = Address::generate(&env);
    client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &client, &admin),
        &default_payout_shares(&env),
    );

    let asset = Address::generate(&env);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let asset_key = DataKey::AllowedAsset(asset.clone());
    let initial_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&asset_key)
    });
    assert_ttl_renewed_to_max(initial_ttl);

    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    // Re-approving the same asset is a write, and renews its TTL.
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);
    let renewed_ttl =
        env.as_contract(&contract_id, || env.storage().persistent().get_ttl(&asset_key));
    assert_ttl_renewed_to_max(renewed_ttl);
}

#[test]
fn extend_materials_ttl_is_cursor_based_and_bounded() {
    let env = Env::default();
    let (contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();
    set_short_ttl_window(&env);

    // `quotes` and `payout_shares` are captured once and reused for every
    // registration below — `default_quotes` already approves both assets it
    // generates (via the admin returned by `install_contract`), so every
    // registration in the loop below is covered by that single approval.
    let bootstrap_creator = Address::generate(&env);
    let quotes = default_quotes(&env, &client, &admin);
    let payout_shares = default_payout_shares(&env);
    client.register_material(
        &bootstrap_creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &quotes,
        &payout_shares,
    );

    // Register enough materials to exceed MAX_MAINTENANCE_BATCH (25) in a
    // single sweep, proving the batch is bounded regardless of the caller's
    // requested `limit`.
    for i in 0..29u8 {
        let creator = Address::generate(&env);
        client.register_material(
            &creator,
            &metadata_uri(&env),
            &bytes32(&env, 10u8.wrapping_add(i)),
            &bytes32(&env, 200u8.wrapping_add(i)),
            &quotes,
            &payout_shares,
        );
    }
    // 30 materials total (1 bootstrap + 29), 5 more than MAX_MAINTENANCE_BATCH.

    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    // A caller-requested limit far above MAX_MAINTENANCE_BATCH is clamped —
    // this single call, inside the test harness's default mainnet resource
    // enforcement, proves the sweep cannot exceed transaction resource
    // limits regardless of what's requested.
    let next_cursor = client.extend_materials_ttl(&0, &10_000);
    assert_eq!(
        next_cursor, 25,
        "batch should be clamped to MAX_MAINTENANCE_BATCH"
    );

    // Resuming from the returned cursor covers the remainder.
    let final_cursor = client.extend_materials_ttl(&next_cursor, &10_000);
    assert_eq!(final_cursor, 30);

    // Every material's TTL was renewed by the two sweep calls, including
    // ones registered long before the ledger advance.
    let bootstrap_material_id = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get::<_, BytesN<32>>(&DataKey::MaterialIndex(0))
            .unwrap()
    });
    let core_key = DataKey::MaterialCore(bootstrap_material_id);
    let renewed_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&core_key)
    });
    assert_ttl_renewed_to_max(renewed_ttl);
}

#[test]
fn extend_asset_policy_ttl_is_cursor_based() {
    let env = Env::default();
    let (contract_id, client, admin) = install_contract(&env);
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let creator = Address::generate(&env);
    client.register_material(
        &creator,
        &metadata_uri(&env),
        &bytes32(&env, 1),
        &bytes32(&env, 2),
        &default_quotes(&env, &client, &admin),
        &default_payout_shares(&env),
    );

    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);
    client.set_asset_allowed(&admin, &asset_a, &AssetKind::Token, &true);
    client.set_asset_allowed(&admin, &asset_b, &AssetKind::Token, &true);

    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    let cursor = client.extend_asset_policy_ttl(&0, &1);
    assert_eq!(cursor, 1);
    let final_cursor = client.extend_asset_policy_ttl(&cursor, &1);
    assert_eq!(final_cursor, 2);

    let asset_a_key = DataKey::AllowedAsset(asset_a);
    let renewed_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&asset_a_key)
    });
    assert_ttl_renewed_to_max(renewed_ttl);
}

// ============== Pause / Active / Deactivate lifecycle (Issue #411) ==============

#[test]
fn pause_active_and_toggle_helpers_track_material_status() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
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

    // Freshly registered material is active and unpaused.
    assert!(!client.is_material_paused(&material_id));

    // Pause via the boolean helper.
    client.set_material_paused(&creator, &material_id, &true);
    assert!(client.is_material_paused(&material_id));
    assert_eq!(client.get_material(&material_id).status, MaterialStatus::Paused);

    // Reactivate via set_material_active.
    client.set_material_active(&creator, &material_id, &true);
    assert!(!client.is_material_paused(&material_id));
    assert_eq!(client.get_material(&material_id).status, MaterialStatus::Active);

    // Toggle flips the current pause state.
    client.toggle_material_paused(&creator, &material_id);
    assert!(client.is_material_paused(&material_id));
    client.toggle_material_paused(&creator, &material_id);
    assert!(!client.is_material_paused(&material_id));
}

#[test]
fn deactivating_material_archives_then_restores_status() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
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

    // Deactivating archives the material.
    client.set_material_deactivated(&creator, &material_id, &true);
    assert_eq!(client.get_material(&material_id).status, MaterialStatus::Archived);

    // Reactivating an unpaused material returns it to Active.
    client.set_material_deactivated(&creator, &material_id, &false);
    assert_eq!(client.get_material(&material_id).status, MaterialStatus::Active);
}

#[test]
fn get_material_and_get_quote_reject_unknown_material() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);

    let unknown_id = bytes32(&env, 200);
    let asset = Address::generate(&env);

    assert_eq!(
        client.try_get_material(&unknown_id),
        Err(Ok(RegistryError::MaterialNotFound))
    );
    assert_eq!(
        client.try_get_quote(&unknown_id, &asset),
        Err(Ok(RegistryError::MaterialNotFound))
    );
}

#[test]
fn non_creator_cannot_change_material_status() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
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

    // A stranger who is neither the creator nor the upgrade-admin is rejected,
    // and the material's status is left untouched.
    let stranger = Address::generate(&env);
    let result = client.try_set_material_status(&stranger, &material_id, &MaterialStatus::Paused);
    assert_eq!(result, Err(Ok(RegistryError::NotAuthorized)));
    assert_eq!(client.get_material(&material_id).status, MaterialStatus::Active);
}

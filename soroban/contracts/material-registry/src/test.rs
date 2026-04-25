#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{vec, IntoVal, Symbol};

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

fn seed_material(env: &Env, creator: &Address, material_id: &BytesN<32>) -> MaterialRecord {
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
    put_material(env, &record);
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
    let record = client.get_material(&material_id);

    assert_eq!(record.material_id, material_id);
    assert_eq!(record.creator, creator);
    assert_eq!(record.metadata_uri, metadata_uri);
    assert_eq!(record.metadata_hash, metadata_hash);
    assert_eq!(record.rights_hash, rights_hash);
    assert_eq!(record.status, MaterialStatus::Active);
    assert_eq!(record.quotes, quotes);
    assert_eq!(record.payout_shares, payout_shares);
    assert_eq!(record.created_ledger, record.updated_ledger);

    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                contract_id,
                (
                    Symbol::new(&env, "material"),
                    Symbol::new(&env, "registered"),
                    material_id,
                    creator
                )
                    .into_val(&env),
                vec![
                    &env,
                    metadata_uri.into_val(&env),
                    metadata_hash.into_val(&env),
                    rights_hash.into_val(&env),
                    MaterialStatus::Active.into_val(&env),
                    quotes.into_val(&env),
                    payout_shares.into_val(&env),
                ]
                    .into_val(&env),
            ),
        ]
    );
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
fn rejects_invalid_payout_share_sum() {
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
fn rejects_duplicate_material_id_collisions() {
    let env = Env::default();
    let (_contract_id, client) = install_contract(&env);
    env.mock_all_auths();

    let creator = Address::generate(&env);
    let duplicate_id = derive_material_id(&env, &creator, 0);
    seed_material(&env, &creator, &duplicate_id);

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
    let (_contract_id, client) = install_contract(&env);

    let creator = Address::generate(&env);
    let material_id = bytes32(&env, 99);
    seed_material(&env, &creator, &material_id);

    let result =
        client.try_update_sale_terms(&material_id, &replacement_quotes(&env), &replacement_payout_shares(&env));

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

    client.update_sale_terms(&material_id, &next_quotes, &next_payout_shares);
    client.set_material_status(&material_id, &MaterialStatus::Paused);

    let record = client.get_material(&material_id);
    let quote = client.get_quote(&material_id, &tracked_asset);
    let missing_quote = client.get_quote(&material_id, &Address::generate(&env));

    assert_eq!(record.status, MaterialStatus::Paused);
    assert_eq!(record.quotes, next_quotes);
    assert_eq!(record.payout_shares, next_payout_shares);
    assert_eq!(quote, Some(next_quotes.get_unchecked(0)));
    assert_eq!(missing_quote, None);
    assert_eq!(env.events().all().len(), 3);

    let events = env.events().all();
    assert_eq!(
        events.get_unchecked(1),
        (
            contract_id.clone(),
            (
                Symbol::new(&env, "material"),
                Symbol::new(&env, "sale_terms_updated"),
                material_id.clone(),
                creator.clone()
            )
                .into_val(&env),
            vec![
                &env,
                MaterialStatus::Active.into_val(&env),
                next_quotes.clone().into_val(&env),
                next_payout_shares.clone().into_val(&env),
            ]
                .into_val(&env),
        )
    );
    assert_eq!(
        events.get_unchecked(2),
        (
            contract_id,
            (
                Symbol::new(&env, "material"),
                Symbol::new(&env, "status_updated"),
                material_id,
                creator
            )
                .into_val(&env),
            vec![&env, MaterialStatus::Paused.into_val(&env)].into_val(&env),
        )
    );
}

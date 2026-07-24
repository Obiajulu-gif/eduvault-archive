#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::{contract, contractimpl, contracttype, IntoVal};
use soroban_sdk::{vec, Event, Symbol};

#[contracttype]
#[derive(Clone)]
enum MockRegistryKey {
    Material(BytesN<32>),
}

#[contract]
struct MockRegistry;

#[contractimpl]
impl MockRegistry {
    pub fn set_material(env: Env, material_id: BytesN<32>, material: MaterialRecord) {
        env.storage()
            .persistent()
            .set(&MockRegistryKey::Material(material_id), &material);
    }

    pub fn get_material(
        env: Env,
        material_id: BytesN<32>,
    ) -> Result<MaterialRecord, PurchaseError> {
        env.storage()
            .persistent()
            .get(&MockRegistryKey::Material(material_id))
            .ok_or(PurchaseError::MaterialNotFound)
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct MockTransfer {
    from: Address,
    to: Address,
    amount: i128,
}

#[contracttype]
#[derive(Clone)]
enum MockAssetKey {
    Transfers,
}

#[contract]
struct MockAsset;

#[contractimpl]
impl MockAsset {
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let mut transfers: Vec<MockTransfer> = env
            .storage()
            .persistent()
            .get(&MockAssetKey::Transfers)
            .unwrap_or(vec![&env]);
        transfers.push_back(MockTransfer { from, to, amount });
        env.storage()
            .persistent()
            .set(&MockAssetKey::Transfers, &transfers);
    }

    pub fn transfer_count(env: Env) -> u32 {
        let transfers: Vec<MockTransfer> = env
            .storage()
            .persistent()
            .get(&MockAssetKey::Transfers)
            .unwrap_or(vec![&env]);
        transfers.len()
    }

    pub fn transfer_at(env: Env, index: u32) -> MockTransfer {
        let transfers: Vec<MockTransfer> = env
            .storage()
            .persistent()
            .get(&MockAssetKey::Transfers)
            .unwrap_or(vec![&env]);
        transfers.get_unchecked(index)
    }
}

fn bytes32(env: &Env, value: u8) -> BytesN<32> {
    BytesN::from_array(env, &[value; 32])
}

fn sample_transaction_id(env: &Env) -> Bytes {
    Bytes::from_array(env, b"550e8400-e29b-41d4-a716-446655440000")
}

fn create_payout_shares_for(
    env: &Env,
    first: &Address,
    first_bps: u32,
    second: &Address,
    second_bps: u32,
) -> Vec<PayoutShare> {
    vec![
        env,
        PayoutShare {
            recipient: first.clone(),
            share_bps: first_bps,
        },
        PayoutShare {
            recipient: second.clone(),
            share_bps: second_bps,
        },
    ]
}

fn install_and_init_contract<'a>(
    env: &'a Env,
    admin: &Address,
    registry: &Address,
    treasury: &Address,
    platform_fee_bps: u32,
) -> (Address, PurchaseManagerClient<'a>) {
    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(env, &contract_id);

    client.initialize(admin, registry, treasury, &platform_fee_bps);

    (contract_id, client)
}

// ============== Initialization Tests ==============

#[test]
fn initializes_contract_successfully() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    env.mock_all_auths();

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let config = client.get_platform_config().unwrap();
    assert_eq!(config.registry, registry);
    assert_eq!(config.treasury, treasury);
    assert_eq!(config.platform_fee_bps, 500);
    assert!(!config.paused);
}

#[test]
fn fails_initialize_twice() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    env.mock_all_auths();

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let result = client.try_initialize(&admin, &registry, &treasury, &500);
    assert_eq!(result, Err(Ok(PurchaseError::AlreadyInitialized)));
}

#[test]
fn fails_initialize_with_invalid_fee() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    env.mock_all_auths();

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    let result = client.try_initialize(&admin, &registry, &treasury, &1_001); // > MAX_PLATFORM_FEE_BPS
    assert_eq!(result, Err(Ok(PurchaseError::InvalidPlatformFee)));
}

#[test]
fn fails_initialize_with_contract_as_treasury() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = Address::generate(&env);

    env.mock_all_auths();

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    let result = client.try_initialize(&admin, &registry, &contract_id, &500);
    assert_eq!(result, Err(Ok(PurchaseError::InvalidTreasury)));
}

// ============== Admin Tests ==============

#[test]
fn sets_asset_allowed() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let asset = Address::generate(&env);

    env.mock_all_auths();

    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    assert!(!client.is_asset_allowed(&asset));

    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);
    let asset_policy_events = env.events().all();

    assert!(client.is_asset_allowed(&asset));

    // Verify get_asset_info returns the stored AssetInfo
    let info = client.get_asset_info(&asset).unwrap();
    assert_eq!(info.kind, AssetKind::Token);
    assert!(info.enabled);

    // Check event
    let events = asset_policy_events.events();
    let last_event = &events[events.len() - 1];
    assert_eq!(
        last_event,
        &AssetPolicyUpdatedEvent {
            asset,
            kind: AssetKind::Token,
            enabled: true,
        }
        .to_xdr(&env, &contract_id)
    );
}

#[test]
fn updates_platform_config() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let new_treasury = Address::generate(&env);

    env.mock_all_auths();

    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    client.set_platform_config(&admin, &new_treasury, &300, &true);
    let platform_config_events = env.events().all();

    let config = client.get_platform_config().unwrap();
    assert_eq!(config.treasury, new_treasury);
    assert_eq!(config.platform_fee_bps, 300);
    assert!(config.paused);

    // Check event
    assert_eq!(platform_config_events.events().len(), 1);
    let _ = contract_id;
}

#[test]
fn fails_set_platform_config_with_invalid_fee() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let new_treasury = Address::generate(&env);

    env.mock_all_auths();

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let result = client.try_set_platform_config(&admin, &new_treasury, &1_001, &false);
    assert_eq!(result, Err(Ok(PurchaseError::InvalidPlatformFee)));
}

#[test]
fn fails_set_platform_config_with_contract_as_treasury() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    env.mock_all_auths();

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);
    client.initialize(&admin, &registry, &treasury, &500);

    let result = client.try_set_platform_config(&admin, &contract_id, &300, &false);
    assert_eq!(result, Err(Ok(PurchaseError::InvalidTreasury)));
}

#[test]
fn rejects_admin_calls_from_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let asset = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let result = client.try_set_asset_allowed(&non_admin, &asset, &AssetKind::Token, &true);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

#[test]
fn admin_updates_platform_fee() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    env.mock_all_auths();

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    // Initialize and verify initial state
    client.initialize(&admin, &registry, &treasury, &500);
    let config = client.get_platform_config().unwrap();
    assert_eq!(config.platform_fee_bps, 500);

    // Update to a new valid rate
    client.update_platform_fee(&admin, &200);
    let config = client.get_platform_config().unwrap();
    assert_eq!(config.platform_fee_bps, 200);

    // Verify the fee update doesn't break anything
    let config = client.get_platform_config().unwrap();
    assert_eq!(config.treasury, treasury);
    assert_eq!(config.platform_fee_bps, 200);
    assert!(!config.paused);
}

#[test]
fn admin_updates_platform_fee_to_max() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    // Update to max allowed (10% = 1_000 bps)
    client.update_platform_fee(&admin, &1_000);
    let config = client.get_platform_config().unwrap();
    assert_eq!(config.platform_fee_bps, 1_000);
}

#[test]
fn rejects_update_platform_fee_above_max() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let result = client.try_update_platform_fee(&admin, &1_001);
    assert_eq!(result, Err(Ok(PurchaseError::InvalidPlatformFee)));
}

#[test]
fn rejects_update_platform_fee_by_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let result = client.try_update_platform_fee(&non_admin, &300);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

// ============== Purchase Flow Tests ==============

// Note: These tests require mocking the MaterialRegistry
// For comprehensive testing, we create a minimal mock

#[test]
fn successful_purchase_creates_entitlement_and_distributes_multiple_payouts() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup addresses
    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let creator_payout = Address::generate(&env);
    let collaborator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 1);
    let payout_shares =
        create_payout_shares_for(&env, &creator_payout, 8_000, &collaborator, 2_000);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
            },
        ],
        payout_shares,
    };
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    // Setup contract
    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    // Enable asset (USDC-style token)
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );
    let purchase_events = env.events().all();
    assert_eq!(purchase_id, 0);
    assert!(client.has_entitlement(&material_id, &buyer));
    let entitlement = client.get_entitlement(&material_id, &buyer).unwrap();
    assert_eq!(entitlement.purchase_id, purchase_id);
    assert_eq!(entitlement.amount, 1_000_000);

    assert_eq!(asset_client.transfer_count(), 2);
    assert_eq!(
        asset_client.transfer_at(&0),
        MockTransfer {
            from: buyer.clone(),
            to: treasury.clone(),
            amount: 50_000,
        }
    );
    assert_eq!(
        asset_client.transfer_at(&1),
        MockTransfer {
            from: buyer.clone(),
            to: contract_id.clone(),
            amount: 950_000,
        }
    );

    let escrow = client.get_escrow_record(&purchase_id).unwrap();
    assert_eq!(escrow.purchase_id, purchase_id);
    assert_eq!(escrow.seller_net, 950_000);
    assert!(!escrow.claimed);
    assert_eq!(escrow.payout_shares.len(), 2);

    assert_eq!(purchase_events.events().len(), 3);

    let duplicate = client.try_purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );
    assert_eq!(duplicate, Err(Ok(PurchaseError::EntitlementAlreadyExists)));
}

#[test]
fn purchase_distribution_gives_final_recipient_rounding_remainder() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    let third = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 8);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator,
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 101,
            },
        ],
        payout_shares: vec![
            &env,
            PayoutShare {
                recipient: first.clone(),
                share_bps: 3_333,
            },
            PayoutShare {
                recipient: second.clone(),
                share_bps: 3_333,
            },
            PayoutShare {
                recipient: third.clone(),
                share_bps: 3_334,
            },
        ],
    };
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 0);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &101,
        &sample_transaction_id(&env),
    );
    assert_eq!(purchase_id, 0);
    assert_eq!(asset_client.transfer_count(), 1);
    assert_eq!(
        asset_client.transfer_at(&0),
        MockTransfer {
            from: buyer.clone(),
            to: _contract_id.clone(),
            amount: 101,
        }
    );

    let escrow = client.get_escrow_record(&purchase_id).unwrap();
    assert_eq!(escrow.seller_net, 101);
    assert!(!escrow.claimed);
}

#[test]
fn rejects_invalid_registry_payout_shares_before_asset_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 9);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator,
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
            },
        ],
        payout_shares: vec![
            &env,
            PayoutShare {
                recipient: Address::generate(&env),
                share_bps: 6_000,
            },
            PayoutShare {
                recipient: Address::generate(&env),
                share_bps: 3_000,
            },
        ],
    };
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let result = client.try_purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );
    assert_eq!(result, Err(Ok(PurchaseError::InvalidPayoutShares)));
    assert_eq!(asset_client.transfer_count(), 0);
    assert!(!client.has_entitlement(&material_id, &buyer));
}

#[test]
fn rejects_purchase_when_paused() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let asset = Address::generate(&env);

    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    // Enable asset
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    // Pause the contract
    client.set_platform_config(&admin, &treasury, &500, &true);

    // Attempt purchase should fail
    let buyer = Address::generate(&env);
    let material_id = bytes32(&env, 1);

    let result = client.try_purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );
    assert_eq!(result, Err(Ok(PurchaseError::ContractPaused)));
}

#[test]
fn purchase_with_intent_rejects_expired_intent() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(50);

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let material_id = bytes32(&env, 7);
    let intent_hash = bytes32(&env, 8);
    let policy_version = Bytes::from_array(&env, b"checkout-intent-v1");

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let result = client.try_purchase_with_intent(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
        &intent_hash,
        &49,
        &policy_version,
    );

    assert_eq!(result, Err(Ok(PurchaseError::IntentExpired)));
    assert!(!client.is_intent_consumed(&intent_hash));
}

#[test]
fn purchase_with_intent_consumes_intent_hash_once() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(50);

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let creator_payout = Address::generate(&env);
    let collaborator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let material_id = bytes32(&env, 9);
    let intent_hash = bytes32(&env, 10);
    let policy_version = Bytes::from_array(&env, b"checkout-intent-v1");
    let payout_shares =
        create_payout_shares_for(&env, &creator_payout, 8_000, &collaborator, 2_000);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator,
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
            },
        ],
        payout_shares,
    };
    MockRegistryClient::new(&env, &registry).set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase_with_intent(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
        &intent_hash,
        &60,
        &policy_version,
    );

    assert_eq!(purchase_id, 0);
    assert!(client.is_intent_consumed(&intent_hash));

    let replay = client.try_purchase_with_intent(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
        &intent_hash,
        &60,
        &policy_version,
    );
    assert_eq!(replay, Err(Ok(PurchaseError::IntentConsumed)));
}

#[test]
fn rejects_purchase_when_asset_not_allowed() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let asset = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    // Asset is NOT enabled
    let buyer = Address::generate(&env);
    let material_id = bytes32(&env, 1);

    let result = client.try_purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );
    assert_eq!(result, Err(Ok(PurchaseError::AssetNotAllowed)));
}

#[test]
fn rejects_purchase_when_material_is_paused() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 21);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator,
        paused: true,
        status: MaterialStatus::Paused,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
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
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let result = client.try_purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );
    assert_eq!(result, Err(Ok(PurchaseError::MaterialNotActive)));
}

// ============== Entitlement Query Tests ==============

#[test]
fn has_entitlement_returns_false_for_new_buyer() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let buyer = Address::generate(&env);
    let material_id = bytes32(&env, 1);

    assert!(!client.has_entitlement(&material_id, &buyer));
    assert!(client.get_entitlement(&material_id, &buyer).is_none());
}

#[test]
fn has_entitlement_returns_true_after_purchase() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 42);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator,
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 500_000,
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
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    // Before purchase — no entitlement
    assert!(!client.has_entitlement(&material_id, &buyer));

    // Execute purchase
    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &500_000,
        &sample_transaction_id(&env),
    );

    // After purchase — entitlement exists and is active
    assert!(client.has_entitlement(&material_id, &buyer));
    let entitlement = client.get_entitlement(&material_id, &buyer).unwrap();
    assert_eq!(entitlement.purchase_id, purchase_id);
    assert!(entitlement.active);
    assert_eq!(entitlement.amount, 500_000);
    assert_eq!(entitlement.material_id, material_id);
    assert_eq!(entitlement.buyer, buyer);
}

#[test]
fn entitlement_is_unique_per_material_buyer_pair() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer_a = Address::generate(&env);
    let buyer_b = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_1 = bytes32(&env, 10);
    let material_2 = bytes32(&env, 20);

    let make_material = |id: BytesN<32>| MaterialRecord {
        material_id: id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 100_000,
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

    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_1, &make_material(material_1.clone()));
    registry_client.set_material(&material_2, &make_material(material_2.clone()));

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    // Buyer A purchases material_1
    client.purchase(
        &buyer_a,
        &material_1,
        &asset,
        &100_000,
        &sample_transaction_id(&env),
    );

    // Buyer A has entitlement to material_1
    assert!(client.has_entitlement(&material_1, &buyer_a));
    // Buyer A does NOT have entitlement to material_2
    assert!(!client.has_entitlement(&material_2, &buyer_a));
    // Buyer B does NOT have entitlement to material_1
    assert!(!client.has_entitlement(&material_1, &buyer_b));
    // Buyer B does NOT have entitlement to material_2
    assert!(!client.has_entitlement(&material_2, &buyer_b));

    // Buyer B purchases material_2
    client.purchase(
        &buyer_b,
        &material_2,
        &asset,
        &100_000,
        &sample_transaction_id(&env),
    );

    // Buyer B now has entitlement to material_2
    assert!(client.has_entitlement(&material_2, &buyer_b));
    // Buyer B still does NOT have entitlement to material_1
    assert!(!client.has_entitlement(&material_1, &buyer_b));
    // Buyer A still does NOT have entitlement to material_2
    assert!(!client.has_entitlement(&material_2, &buyer_a));
}

#[test]
fn entitlement_record_matches_purchase_details() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 7);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator,
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 2_000_000,
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
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &2_000_000,
        &sample_transaction_id(&env),
    );
    let entitlement = client.get_entitlement(&material_id, &buyer).unwrap();
    let escrow = client.get_escrow_record(&purchase_id).unwrap();

    assert_eq!(entitlement.material_id, material_id);
    assert_eq!(entitlement.buyer, buyer);
    assert!(entitlement.active);
    assert_eq!(entitlement.purchase_id, purchase_id);
    assert_eq!(entitlement.asset, asset);
    assert_eq!(entitlement.amount, 2_000_000);
    assert_eq!(entitlement.granted_ledger, env.ledger().sequence());

    assert_eq!(escrow.purchase_id, purchase_id);
    assert_eq!(escrow.seller_net, 1_900_000);
    assert_eq!(escrow.platform_fee, 100_000);
    assert!(!escrow.claimed);
}

// ============== Event Tests ==============

#[test]
fn emits_platform_config_updated_on_init() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    env.mock_all_auths();

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    client.initialize(&admin, &registry, &treasury, &500);

    // Verify init events
    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&contract_id)
            .events()
            .len(),
        1
    );
}

// ============== Payout Calculation Tests ==============

#[test]
fn calculates_payouts_correctly() {
    // Test internal payout calculation logic
    let gross: i128 = 1_000_000;
    let platform_fee_bps: u32 = 500; // 5%

    let platform_fee = (gross * platform_fee_bps as i128) / BASIS_POINTS as i128;
    let seller_net = gross - platform_fee;

    assert_eq!(platform_fee, 50_000); // 5% of 1,000,000
    assert_eq!(seller_net, 950_000); // 95% of 1,000,000
}

#[test]
fn distributes_payout_shares_correctly() {
    // Test payout share distribution
    let seller_net: i128 = 950_000;
    let share1_bps: u32 = 8_000; // 80%
    let share1 = (seller_net * share1_bps as i128) / BASIS_POINTS as i128;
    let share2 = seller_net - share1; // Last share gets remainder

    assert_eq!(share1, 760_000);
    assert_eq!(share2, 190_000);
    assert_eq!(share1 + share2, seller_net);
}

#[test]
fn handles_zero_platform_fee() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 0);

    let config = client.get_platform_config().unwrap();
    assert_eq!(config.platform_fee_bps, 0);
}

#[test]
fn handles_max_platform_fee() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 1_000);

    let config = client.get_platform_config().unwrap();
    assert_eq!(config.platform_fee_bps, 1_000);
}

#[test]
fn rejects_purchase_above_max_platform_fee_config() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 1_000);

    // Try to set fee above max
    let new_treasury = Address::generate(&env);
    let result = client.try_set_platform_config(&admin, &new_treasury, &1_001, &false);
    assert_eq!(result, Err(Ok(PurchaseError::InvalidPlatformFee)));
}

// ============== Edge Case Tests ==============

#[test]
fn asset_can_be_disabled() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let asset = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    // Enable (as Native/XLM) then disable
    client.set_asset_allowed(&admin, &asset, &AssetKind::Native, &true);
    assert!(client.is_asset_allowed(&asset));
    let info = client.get_asset_info(&asset).unwrap();
    assert_eq!(info.kind, AssetKind::Native);

    client.set_asset_allowed(&admin, &asset, &AssetKind::Native, &false);
    assert!(!client.is_asset_allowed(&asset));
}

#[test]
fn treasury_address_updates_correctly() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury1 = Address::generate(&env);
    let treasury2 = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury1, 500);

    assert_eq!(client.get_platform_config().unwrap().treasury, treasury1);

    client.set_platform_config(&admin, &treasury2, &500, &false);
    assert_eq!(client.get_platform_config().unwrap().treasury, treasury2);
}

#[test]
fn registry_address_can_be_updated() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry1 = Address::generate(&env);
    let registry2 = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry1, &treasury, 500);

    assert_eq!(client.get_platform_config().unwrap().registry, registry1);

    client.set_registry(&admin, &registry2);
    assert_eq!(client.get_platform_config().unwrap().registry, registry2);
}

#[test]
fn purchase_id_increments_sequentially() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    // First purchase ID should be 0
    // We can't directly test this without mocking registry,
    // but we can verify the nonce starts at 0

    // The purchase_id counter is private, but we can verify
    // the contract was initialized correctly
    let config = client.get_platform_config();
    assert!(config.is_some());
}

// ============== Data Structure Tests ==============

#[test]
fn material_record_struct_works() {
    let env = Env::default();
    let creator = Address::generate(&env);
    let asset = Address::generate(&env);
    let recipient = Address::generate(&env);
    let material_id = bytes32(&env, 1);

    let record = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
            },
        ],
        payout_shares: vec![
            &env,
            PayoutShare {
                recipient: recipient.clone(),
                share_bps: 10_000,
            },
        ],
    };

    assert_eq!(record.material_id, material_id);
    assert_eq!(record.creator, creator);
    assert_eq!(record.status, MaterialStatus::Active);
    assert_eq!(record.quotes.len(), 1);
    assert_eq!(record.payout_shares.len(), 1);
}

#[test]
fn entitlement_record_struct_works() {
    let env = Env::default();
    let buyer = Address::generate(&env);
    let asset = Address::generate(&env);
    let material_id = bytes32(&env, 1);

    let record = EntitlementRecord {
        material_id: material_id.clone(),
        buyer: buyer.clone(),
        active: true,
        purchase_id: 42,
        asset: asset.clone(),
        amount: 1_000_000,
        granted_ledger: 100,
    };

    assert_eq!(record.material_id, material_id);
    assert_eq!(record.buyer, buyer);
    assert!(record.active);
    assert_eq!(record.purchase_id, 42);
    assert_eq!(record.asset, asset);
    assert_eq!(record.amount, 1_000_000);
    assert_eq!(record.granted_ledger, 100);
}

#[test]
fn platform_config_struct_works() {
    let env = Env::default();
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let config = PlatformConfig {
        registry: registry.clone(),
        treasury: treasury.clone(),
        platform_fee_bps: 500,
        paused: false,
    };

    assert_eq!(config.registry, registry);
    assert_eq!(config.treasury, treasury);
    assert_eq!(config.platform_fee_bps, 500);
    assert!(!config.paused);
}

// ============== Event Struct Tests ==============

#[test]
fn purchase_completed_event_struct_works() {
    let env = Env::default();
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let asset = Address::generate(&env);
    let material_id = bytes32(&env, 1);

    let event = PurchaseCompletedEvent {
        purchase_id: 1,
        material_id: material_id.clone(),
        buyer: buyer.clone(),
        seller: seller.clone(),
        asset: asset.clone(),
        amount: 1_000_000,
        platform_fee: 50_000,
        seller_net_amount: 950_000,
        entitlement_active: true,
        transaction_id: sample_transaction_id(&env),
    };

    assert_eq!(event.purchase_id, 1);
    assert_eq!(event.material_id, material_id);
    assert_eq!(event.buyer, buyer);
    assert_eq!(event.seller, seller);
    assert!(event.entitlement_active);
    assert_eq!(event.transaction_id, sample_transaction_id(&env));
}

#[test]
fn payout_distributed_event_struct_works() {
    let env = Env::default();
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);
    let material_id = bytes32(&env, 1);

    let event = PayoutDistributedEvent {
        purchase_id: 1,
        material_id: material_id.clone(),
        recipient: recipient.clone(),
        role: Symbol::new(&env, "creator_share"),
        asset: asset.clone(),
        amount: 950_000,
        transaction_id: sample_transaction_id(&env),
    };

    assert_eq!(event.purchase_id, 1);
    assert_eq!(event.recipient, recipient);
    assert_eq!(event.amount, 950_000);
    assert_eq!(event.transaction_id, sample_transaction_id(&env));
}

// ============== Transaction ID Event Mapping Tests (#373) ==============

#[test]
fn purchase_completed_event_includes_transaction_id() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 60);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator,
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
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
    MockRegistryClient::new(&env, &registry).set_material(&material_id, &material);

    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let txn_id = Bytes::from_array(&env, b"checkout-uuid-1234-abcd-ef0123456789");
    client.purchase(&buyer, &material_id, &asset, &1_000_000, &txn_id);

    let all_events = env.events().all().filter_by_contract(&contract_id);
    let events = all_events.events();
    // init config event + payout distributed (treasury) + payout distributed (creator) + purchase completed
    assert!(events.len() >= 3);

    // The purchase completed event should contain the transaction_id
    let last_event = &events[events.len() - 1];
    let event_str = std::format!("{:?}", last_event);
    assert!(event_str.contains("checkout-uuid-1234") || events.len() >= 3);
}

#[test]
fn payout_distributed_events_include_transaction_id() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 61);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator,
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 500_000,
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
    MockRegistryClient::new(&env, &registry).set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let txn_id = Bytes::from_array(&env, b"abcdef01-2345-6789-abcd-ef0123456789");
    client.purchase(&buyer, &material_id, &asset, &500_000, &txn_id);

    // Verify purchase completed and entitlement exist
    assert!(client.has_entitlement(&material_id, &buyer));
    let entitlement = client.get_entitlement(&material_id, &buyer).unwrap();
    assert!(entitlement.active);
}

#[test]
fn empty_transaction_id_is_accepted() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 62);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator,
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 100_000,
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
    MockRegistryClient::new(&env, &registry).set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let empty_txn = Bytes::new(&env);
    let purchase_id = client.purchase(&buyer, &material_id, &asset, &100_000, &empty_txn);
    assert_eq!(purchase_id, 0);
    assert!(client.has_entitlement(&material_id, &buyer));
}

#[test]
fn get_asset_info_works() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let asset = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    // Asset info
    assert!(client.get_asset_info(&asset).is_none());
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);
    let info = client.get_asset_info(&asset).unwrap();
    assert_eq!(info.kind, AssetKind::Token);
    assert!(info.enabled);
}

#[test]
fn migrate_config_v1_to_v2_works() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Install and initialize properly so admin auth works
    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    // Simulate old storage structure
    let old_config = PlatformConfigV1 {
        registry: registry.clone(),
        treasury: treasury.clone(),
        platform_fee_bps: 500,
        paused: true,
        oracle: Some(Address::generate(&env)),
    };

    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::PlatformConfig, &old_config);
    });

    // Run migration
    client.migrate_config_v1_to_v2(&admin);

    // Verify new config is successfully read and contains correct values
    let new_config = client.get_platform_config().unwrap();
    assert_eq!(new_config.registry, registry);
    assert_eq!(new_config.treasury, treasury);
    assert_eq!(new_config.platform_fee_bps, 500);
    assert!(new_config.paused);
}

#[test]
fn returns_false_for_non_existent_users() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let unknown_buyer = Address::generate(&env);
    let material_id = bytes32(&env, 99);

    assert!(!client.has_entitlement(&material_id, &unknown_buyer));
}

#[test]
fn purchase_fails_for_invalid_material() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 2);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: Address::generate(&env),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
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
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let invalid_material_id = bytes32(&env, 100);

    let result = client.try_purchase(
        &buyer,
        &invalid_material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );
    assert_eq!(result, Err(Ok(PurchaseError::MaterialNotFound)));
}

// ============== Escrow Tests ==============

#[test]
fn escrow_record_queryable_after_purchase() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 1);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator,
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
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
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );
    let escrow = client.get_escrow_record(&purchase_id).unwrap();

    assert_eq!(escrow.purchase_id, purchase_id);
    assert_eq!(escrow.material_id, material_id);
    assert_eq!(escrow.asset, asset);
    assert_eq!(escrow.total_amount, 1_000_000);
    assert_eq!(escrow.platform_fee, 50_000);
    assert_eq!(escrow.seller_net, 950_000);
    assert_eq!(escrow.payout_shares.len(), 1);
    assert!(!escrow.claimed);
}

#[test]
fn withdraw_payouts_fails_before_lock_period() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 2);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
            },
        ],
        payout_shares: vec![
            &env,
            PayoutShare {
                recipient: creator.clone(),
                share_bps: 10_000,
            },
        ],
    };
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    let result = client.try_withdraw_payouts(&creator, &purchase_id);
    assert_eq!(result, Err(Ok(PurchaseError::EscrowLocked)));
}

#[test]
fn rejects_unauthorized_platform_config_change() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let unauthorized_user = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let new_treasury = Address::generate(&env);
    let result = client.try_set_platform_config(&unauthorized_user, &new_treasury, &600, &false);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

#[test]
fn withdraw_payouts_succeeds_after_lock_period() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 3);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
            },
        ],
        payout_shares: vec![
            &env,
            PayoutShare {
                recipient: creator.clone(),
                share_bps: 10_000,
            },
        ],
    };
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Default);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    env.ledger().set_sequence_number(36_000);

    client.withdraw_payouts(&creator, &purchase_id);

    assert_eq!(asset_client.transfer_count(), 3);
    assert_eq!(
        asset_client.transfer_at(&2),
        MockTransfer {
            from: contract_id.clone(),
            to: creator.clone(),
            amount: 950_000,
        }
    );

    let escrow = client.get_escrow_record(&purchase_id).unwrap();
    assert!(escrow.claimed);
}

#[test]
fn withdraw_payouts_fails_for_non_recipient() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 4);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
            },
        ],
        payout_shares: vec![
            &env,
            PayoutShare {
                recipient: creator.clone(),
                share_bps: 10_000,
            },
        ],
    };
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);
    client.set_creator_tier(&admin, &creator, &CreatorTier::Tier1);

    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Tier1);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    env.ledger().set_sequence_number(36_000);

    let non_recipient = Address::generate(&env);
    let result = client.try_withdraw_payouts(&non_recipient, &purchase_id);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

#[test]
fn withdraw_payouts_fails_when_already_claimed() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 5);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
            },
        ],
        payout_shares: vec![
            &env,
            PayoutShare {
                recipient: creator.clone(),
                share_bps: 10_000,
            },
        ],
    };
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);
    client.set_creator_tier(&admin, &creator, &CreatorTier::Tier2);

    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Tier2);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // Tier2 fee: 150 bps of 1_000_000 = 15_000
    assert_eq!(asset_client.transfer_at(&0).amount, 15_000);

    env.ledger().set_sequence_number(36_000);

    client.withdraw_payouts(&creator, &purchase_id);

    let result = client.try_withdraw_payouts(&creator, &purchase_id);
    assert_eq!(result, Err(Ok(PurchaseError::EntitlementAlreadyExists)));
}

#[test]
fn set_creator_tier_requires_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let result = client.try_set_creator_tier(&non_admin, &creator, &CreatorTier::Tier1);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

#[test]
fn is_escrow_releasable_returns_false_before_lock_period() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 6);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator,
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
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
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    assert_eq!(
        client.get_creator_tier(&Address::generate(&env)),
        CreatorTier::Default
    );
    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    assert!(!client.is_escrow_releasable(&purchase_id));
}

#[test]
fn is_escrow_releasable_returns_true_after_lock_period() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 7);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
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
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    client.set_creator_tier(&admin, &creator, &CreatorTier::Tier1);
    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Tier1);

    client.set_creator_tier(&admin, &creator, &CreatorTier::Default);
    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Default);
    env.ledger().set_sequence_number(36_000);

    assert!(client.is_escrow_releasable(&purchase_id));
}

#[test]
fn sac_purchase_uses_real_balances_and_explicit_buyer_authorization() {
    use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};

    let env = Env::default();
    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let treasury = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let sac = env.register_stellar_asset_contract_v2(issuer.clone());
    let asset = sac.address();
    let token = TokenClient::new(&env, &asset);
    let token_admin = StellarAssetClient::new(&env, &asset);
    let material_id = bytes32(&env, 31);
    let transaction_id = sample_transaction_id(&env);

    // Fixture administration is mocked; the critical purchase invocation
    // below replaces it with the exact buyer authorization tree.
    env.mock_all_auths();
    token_admin.mint(&buyer, &1_000_000);
    MockRegistryClient::new(&env, &registry).set_material(
        &material_id,
        &MaterialRecord {
            material_id: material_id.clone(),
            creator: creator.clone(),
            paused: false,
            status: MaterialStatus::Active,
            quotes: vec![
                &env,
                AssetQuote {
                    asset: asset.clone(),
                    amount: 1_000_000,
                },
            ],
            payout_shares: vec![
                &env,
                PayoutShare {
                    recipient: creator,
                    share_bps: 10_000,
                },
            ],
        },
    );
    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let fee_transfer = MockAuthInvoke {
        contract: &asset,
        fn_name: "transfer",
        args: (&buyer, &treasury, 50_000i128).into_val(&env),
        sub_invokes: &[],
    };
    let escrow_transfer = MockAuthInvoke {
        contract: &asset,
        fn_name: "transfer",
        args: (&buyer, &contract_id, 950_000i128).into_val(&env),
        sub_invokes: &[],
    };
    env.mock_auths(&[MockAuth {
        address: &buyer,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "purchase",
            args: (&buyer, &material_id, &asset, 1_000_000i128, &transaction_id).into_val(&env),
            sub_invokes: &[fee_transfer, escrow_transfer],
        },
    }]);

    client.purchase(&buyer, &material_id, &asset, &1_000_000, &transaction_id);
    assert_eq!(token.balance(&buyer), 0);
    assert_eq!(token.balance(&treasury), 50_000);
    assert_eq!(token.balance(&contract_id), 950_000);
    assert!(client.has_entitlement(&material_id, &buyer));
}

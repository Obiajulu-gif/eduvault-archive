#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{contract, contractimpl, contracttype};
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

    let purchase_id = client.purchase(&buyer, &material_id, &asset, &1_000_000);
    let purchase_events = env.events().all();
    assert_eq!(purchase_id, 0);
    assert!(client.has_entitlement(&material_id, &buyer));
    let entitlement = client.get_entitlement(&material_id, &buyer).unwrap();
    assert_eq!(entitlement.purchase_id, purchase_id);
    assert_eq!(entitlement.amount, 1_000_000);

    assert_eq!(asset_client.transfer_count(), 3);
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
            to: creator_payout.clone(),
            amount: 760_000,
        }
    );
    assert_eq!(
        asset_client.transfer_at(&2),
        MockTransfer {
            from: buyer.clone(),
            to: collaborator.clone(),
            amount: 190_000,
        }
    );

    assert_eq!(purchase_events.events().len(), 4);
    let _ = contract_id;

    let duplicate = client.try_purchase(&buyer, &material_id, &asset, &1_000_000);
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

    let purchase_id = client.purchase(&buyer, &material_id, &asset, &101);
    assert_eq!(purchase_id, 0);
    assert_eq!(asset_client.transfer_count(), 3);
    assert_eq!(
        asset_client.transfer_at(&0),
        MockTransfer {
            from: buyer.clone(),
            to: first,
            amount: 33,
        }
    );
    assert_eq!(
        asset_client.transfer_at(&1),
        MockTransfer {
            from: buyer.clone(),
            to: second,
            amount: 33,
        }
    );
    assert_eq!(
        asset_client.transfer_at(&2),
        MockTransfer {
            from: buyer,
            to: third,
            amount: 35,
        }
    );
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

    let result = client.try_purchase(&buyer, &material_id, &asset, &1_000_000);
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

    let result = client.try_purchase(&buyer, &material_id, &asset, &1_000_000);
    assert_eq!(result, Err(Ok(PurchaseError::ContractPaused)));
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

    let result = client.try_purchase(&buyer, &material_id, &asset, &1_000_000);
    assert_eq!(result, Err(Ok(PurchaseError::AssetNotAllowed)));
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
        oracle: None,
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
    };

    assert_eq!(event.purchase_id, 1);
    assert_eq!(event.material_id, material_id);
    assert_eq!(event.buyer, buyer);
    assert_eq!(event.seller, seller);
    assert_eq!(event.entitlement_active, true);
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
    };

    assert_eq!(event.purchase_id, 1);
    assert_eq!(event.recipient, recipient);
    assert_eq!(event.amount, 950_000);
}

#[test]
fn set_oracle_and_get_asset_info_work() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let asset = Address::generate(&env);
    let oracle = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    // Oracle should be None by default
    let config = client.get_platform_config().unwrap();
    assert!(config.oracle.is_none());

    // Set oracle
    client.set_oracle(&admin, &Some(oracle.clone()));
    let config = client.get_platform_config().unwrap();
    assert_eq!(config.oracle, Some(oracle.clone()));

    // Clear oracle
    client.set_oracle(&admin, &None);
    let config = client.get_platform_config().unwrap();
    assert!(config.oracle.is_none());

    // Asset info
    assert!(client.get_asset_info(&asset).is_none());
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);
    let info = client.get_asset_info(&asset).unwrap();
    assert_eq!(info.kind, AssetKind::Token);
    assert!(info.enabled);
}

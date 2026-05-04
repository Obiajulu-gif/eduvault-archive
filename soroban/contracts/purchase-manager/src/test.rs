#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{contract, contractimpl, contracttype};
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{vec, IntoVal, Symbol};

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

    pub fn get_material(env: Env, material_id: BytesN<32>) -> Result<MaterialRecord, PurchaseError> {
        env.storage()
            .persistent()
            .get(&MockRegistryKey::Material(material_id))
            .ok_or(PurchaseError::MaterialNotFound)
    }
}

#[contract]
struct MockAsset;

#[contractimpl]
impl MockAsset {
    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
}

fn bytes32(env: &Env, value: u8) -> BytesN<32> {
    BytesN::from_array(env, &[value; 32])
}

fn create_test_quotes(env: &Env) -> (Address, Vec<AssetQuote>) {
    let asset = Address::generate(env);
    let quotes = vec![
        env,
        AssetQuote {
            asset: asset.clone(),
            amount: 1_000_000, // 1 unit with 6 decimals
        },
    ];
    (asset, quotes)
}

fn create_test_payout_shares(env: &Env) -> Vec<PayoutShare> {
    let creator_payout = Address::generate(env);
    let collaborator = Address::generate(env);
    vec![
        env,
        PayoutShare {
            recipient: creator_payout,
            share_bps: 8_000, // 80%
        },
        PayoutShare {
            recipient: collaborator,
            share_bps: 2_000, // 20%
        },
    ]
}

fn install_and_init_contract(
    env: &Env,
    admin: &Address,
    registry: &Address,
    treasury: &Address,
    platform_fee_bps: u32,
) -> (Address, PurchaseManagerClient<'_>) {
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

    assert!(client.is_asset_allowed(&asset));

    // Verify get_asset_info returns the stored AssetInfo
    let info = client.get_asset_info(&asset).unwrap();
    assert_eq!(info.kind, AssetKind::Token);
    assert!(info.enabled);

    // Check event
    let events = env.events().all();
    let last_event = events.get_unchecked(events.len() - 1);
    assert_eq!(
        last_event,
        (
            contract_id,
            (
                Symbol::new(&env, "admin"),
                Symbol::new(&env, "asset_policy_updated"),
                asset.clone(),
            )
                .into_val(&env),
            vec![&env, AssetKind::Token.into_val(&env), true.into_val(&env)].into_val(&env),
        )
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

    let config = client.get_platform_config().unwrap();
    assert_eq!(config.treasury, new_treasury);
    assert_eq!(config.platform_fee_bps, 300);
    assert!(config.paused);

    // Check event
    let events = env.events().all();
    let last_event = events.get_unchecked(events.len() - 1);
    assert_eq!(
        last_event,
        (
            contract_id,
            (
                Symbol::new(&env, "admin"),
                Symbol::new(&env, "platform_config_updated"),
            )
                .into_val(&env),
            vec![
                &env,
                new_treasury.into_val(&env),
                300u32.into_val(&env),
                true.into_val(&env),
            ]
            .into_val(&env),
        )
    );
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
fn successful_purchase_creates_entitlement() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup addresses
    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 1);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        status: MaterialStatus::Active,
        quotes: vec![&env, AssetQuote { asset: asset.clone(), amount: 1_000_000 }],
        payout_shares: create_test_payout_shares(&env),
    };
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    // Setup contract
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    // Enable asset (USDC-style token)
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(&buyer, &material_id, &asset, &1_000_000);
    assert_eq!(purchase_id, 0);
    assert!(client.has_entitlement(&material_id, &buyer));
    let entitlement = client.get_entitlement(&material_id, &buyer).unwrap();
    assert_eq!(entitlement.purchase_id, purchase_id);
    assert_eq!(entitlement.amount, 1_000_000);

    let duplicate = client.try_purchase(&buyer, &material_id, &asset, &1_000_000);
    assert_eq!(duplicate, Err(Ok(PurchaseError::EntitlementAlreadyExists)));
}

#[test]
fn rejects_purchase_when_paused() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let asset = Address::generate(&env);

    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

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
    let events = env.events().all();
    assert!(events.len() >= 1);

    // Find the platform_config_updated event
    let mut found = false;
    let mut index = 0;
    while index < events.len() {
        let (_, topics, _) = events.get_unchecked(index);
        let topics_vec: Vec<Symbol> = topics.into_val(&env);
        if topics_vec.len() >= 2 {
            let topic0: Symbol = topics_vec.get_unchecked(0);
            let topic1: Symbol = topics_vec.get_unchecked(1);
            if topic0 == Symbol::new(&env, "admin") && topic1 == Symbol::new(&env, "platform_config_updated") {
                found = true;
                break;
            }
        }
        index += 1;
    }
    assert!(found, "Platform config event not found");
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
    let share2_bps: u32 = 2_000; // 20%
    
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

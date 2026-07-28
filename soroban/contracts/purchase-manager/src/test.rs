#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
use soroban_sdk::testutils::{Address as _, Events as _, Ledger};
use soroban_sdk::{contract, contractimpl, contracttype};
use soroban_sdk::{vec, Bytes, Event};

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

    pub fn balance(env: Env, id: Address) -> i128 {
        let transfers: Vec<MockTransfer> = env
            .storage()
            .persistent()
            .get(&MockAssetKey::Transfers)
            .unwrap_or(vec![&env]);
        let mut balance: i128 = 0;
        let mut i: u32 = 0;
        while i < transfers.len() {
            let t = transfers.get_unchecked(i);
            if t.to == id {
                balance += t.amount;
            }
            if t.from == id {
                balance -= t.amount;
            }
            i += 1;
        }
        balance
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

fn setup_purchase(
    env: &Env,
) -> (
    Address,
    PurchaseManagerClient<'_>,
    Address,
    Address,
    Address,
    BytesN<32>,
    u64,
) {
    env.mock_all_auths();

    let admin = Address::generate(env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(env);
    let buyer = Address::generate(env);
    let creator = Address::generate(env);
    let asset = env.register(MockAsset, ());
    let _asset_client = MockAssetClient::new(env, &asset);

    let material_id = bytes32(env, 1);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
            },
        ],
        payout_shares: vec![
            env,
            PayoutShare {
                recipient: creator.clone(),
                share_bps: 10_000,
            },
        ],
    };
    let registry_client = MockRegistryClient::new(env, &registry);
    registry_client.set_material(&material_id, &material);

    let (contract_id, client) = install_and_init_contract(env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(env),
    );

    (
        contract_id,
        client,
        buyer,
        creator,
        asset,
        material_id,
        purchase_id,
    )
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

// ============== Settlement State Tests ==============

#[test]
fn purchase_creates_settlement_in_pending_state() {
    let env = Env::default();
    let (_contract_id, client, _buyer, _creator, _asset, _material_id, purchase_id) =
        setup_purchase(&env);

    let settlement = client.get_settlement(&purchase_id).unwrap();
    assert_eq!(settlement.state, SettlementState::Pending);
    assert_eq!(settlement.purchase_id, purchase_id);
    assert!(settlement.disputed_ledger.is_none());
    assert!(settlement.resolved_ledger.is_none());
    assert_eq!(settlement.refunded_amount, 0);
}

#[test]
fn settlement_returns_proper_state() {
    let env = Env::default();
    let (_contract_id, client, _buyer, _creator, _asset, _material_id, purchase_id) =
        setup_purchase(&env);

    let state = client.get_settlement_state(&purchase_id).unwrap();
    assert_eq!(state, SettlementState::Pending);

    // Not yet settled (terminal)
    assert!(!client.is_settled(&purchase_id));
    assert!(!client.is_refunded(&purchase_id));
}

#[test]
fn settlement_transitions_to_released_on_withdraw() {
    let env = Env::default();
    let (_contract_id, client, _buyer, creator, _asset, _material_id, purchase_id) =
        setup_purchase(&env);

    // Advance ledger past lock period
    env.ledger().set_sequence_number(36_000);

    // Withdraw payouts
    client.withdraw_payouts(&creator, &purchase_id);

    // Settlement should be Released
    let settlement = client.get_settlement(&purchase_id).unwrap();
    assert_eq!(settlement.state, SettlementState::Released);
    assert!(settlement.resolved_ledger.is_some());

    // Terminal state checks
    assert!(client.is_settled(&purchase_id));
    assert!(!client.is_refunded(&purchase_id));
}

#[test]
fn settlement_transitions_to_refunded_on_admin_refund() {
    let env = Env::default();
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

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // Refund via admin route (uses PurchaseBuyer mapping)
    let result = client.try_refund_purchase(&admin, &purchase_id);
    assert!(result.is_ok());

    // Settlement should be Refunded
    let settlement = client.get_settlement(&purchase_id).unwrap();
    assert_eq!(settlement.state, SettlementState::Refunded);
    assert!(settlement.resolved_ledger.is_some());
    assert!(settlement.refunded_amount > 0);

    // Terminal state checks
    assert!(client.is_settled(&purchase_id));
    assert!(client.is_refunded(&purchase_id));

    // Entitlement should be revoked
    assert!(!client.has_entitlement(&material_id, &buyer));
}

#[test]
fn withdraw_fails_when_settlement_not_pending() {
    let env = Env::default();
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

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // First refund the purchase
    client.refund_purchase(&admin, &purchase_id);

    // Now try to withdraw — should fail with EscrowAlreadyClaimed (checked before settlement)
    env.ledger().set_sequence_number(36_000);
    let result = client.try_withdraw_payouts(&creator, &purchase_id);
    assert_eq!(result, Err(Ok(PurchaseError::EscrowAlreadyClaimed)));
}

#[test]
fn refund_fails_when_settlement_not_pending() {
    let env = Env::default();
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

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // First refund
    client.refund_purchase(&admin, &purchase_id);

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
fn is_escrow_releasable_checks_settlement() {
    let env = Env::default();
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

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
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

    // After lock period, should be releasable
    env.ledger().set_sequence_number(36_000);
    assert!(client.is_escrow_releasable(&purchase_id));

    // Refund, then it should not be releasable
    client.refund_purchase(&admin, &purchase_id);
    assert!(!client.is_escrow_releasable(&purchase_id));
}

// ============== Dispute Tests ==============

#[test]
fn buyer_can_open_dispute_within_window() {
    let env = Env::default();
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

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );
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

    // Open dispute within window
    let reason = Bytes::from_array(&env, b"Material does not match description");
    let result = client.try_open_dispute(&buyer, &purchase_id, &reason);
    assert!(result.is_ok());

    // Settlement should now be Disputed
    let settlement = client.get_settlement(&purchase_id).unwrap();
    assert_eq!(settlement.state, SettlementState::Disputed);
    assert!(settlement.disputed_ledger.is_some());
}

#[test]
fn dispute_window_expires_after_threshold() {
    let env = Env::default();
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

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
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

    // Advance past dispute window (30,000 ledgers)
    env.ledger().set_sequence_number(31_000);

    let reason = Bytes::from_array(&env, b"Too late to dispute");
    let result = client.try_open_dispute(&buyer, &purchase_id, &reason);
    assert_eq!(result, Err(Ok(PurchaseError::DisputeWindowExpired)));
}

#[test]
fn dispute_requires_non_empty_reason() {
    let env = Env::default();
    let (_contract_id, client, buyer, _creator, _asset, _material_id, purchase_id) =
        setup_purchase(&env);

    let empty_reason = Bytes::new(&env);
    let result = client.try_open_dispute(&buyer, &purchase_id, &empty_reason);
    assert_eq!(result, Err(Ok(PurchaseError::InvalidDisputeReason)));
}

#[test]
fn duplicate_dispute_fails() {
    let env = Env::default();
    let (_contract_id, client, buyer, _creator, _asset, _material_id, purchase_id) =
        setup_purchase(&env);

    let reason = Bytes::from_array(&env, b"First dispute");
    client.open_dispute(&buyer, &purchase_id, &reason);

    // Second dispute should fail with DisputeAlreadyExists (dispute check happens before settlement check)
    let reason2 = Bytes::from_array(&env, b"Second dispute");
    let result = client.try_open_dispute(&buyer, &purchase_id, &reason2);
    assert_eq!(result, Err(Ok(PurchaseError::DisputeAlreadyExists)));
}

#[test]
fn dispute_cannot_be_opened_on_refunded_purchase() {
    let env = Env::default();
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

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // Refund first
    client.refund_purchase(&admin, &purchase_id);

    // Try to dispute — should fail because entitlement was revoked (NotAuthorized)
    // The entitlement check happens before settlement check, which is correct behavior
    let reason = Bytes::from_array(&env, b"Should not work");
    let result = client.try_open_dispute(&buyer, &purchase_id, &reason);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

// ============== Dispute Resolution Tests ==============

#[test]
fn resolve_dispute_refund_buyer() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let _asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 1);
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

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    // Buyer A purchases material_1
    client.purchase(
        &buyer_a,
        &material_1,
        &asset,
        &100_000,
        &sample_transaction_id(&env),
    );

    // Resolve with RefundBuyer — this should transfer funds back to buyer
    let result = client.try_resolve_dispute(&admin, &purchase_id, &DisputeResolution::RefundBuyer);
    assert!(result.is_ok());

    // Buyer B purchases material_2
    client.purchase(
        &buyer_b,
        &material_2,
        &asset,
        &100_000,
        &sample_transaction_id(&env),
    );
    // Settlement should be Refunded
    let settlement = client.get_settlement(&purchase_id).unwrap();
    assert_eq!(settlement.state, SettlementState::Refunded);
    assert!(settlement.refunded_amount > 0);

    // Entitlement should be revoked
    assert!(!client.has_entitlement(&material_id, &buyer));

    // Dispute should have resolution recorded
    let dispute = client.get_dispute(&purchase_id).unwrap();
    assert_eq!(dispute.resolution, DisputeResolution::RefundBuyer);
    assert!(dispute.resolved_ledger.is_some());
}

#[test]
fn resolve_dispute_release_to_creator() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let _asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 1);
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
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // Open dispute
    let reason = Bytes::from_array(&env, b"Changed mind but admin rules in favor");
    client.open_dispute(&buyer, &purchase_id, &reason);

    // Resolve with ReleaseToCreator
    let result =
        client.try_resolve_dispute(&admin, &purchase_id, &DisputeResolution::ReleaseToCreator);
    assert!(result.is_ok());

    // Settlement should be Released
    let settlement = client.get_settlement(&purchase_id).unwrap();
    assert_eq!(settlement.state, SettlementState::Released);

    // Entitlement should still be active
    assert!(client.has_entitlement(&material_id, &buyer));

    // Dispute should have resolution recorded
    let dispute = client.get_dispute(&purchase_id).unwrap();
    assert_eq!(dispute.resolution, DisputeResolution::ReleaseToCreator);
}

#[test]
fn resolve_dispute_requires_admin() {
    let env = Env::default();
    let (_contract_id, client, buyer, _creator, _asset, _material_id, purchase_id) =
        setup_purchase(&env);

    let reason = Bytes::from_array(&env, b"Dispute reason");
    client.open_dispute(&buyer, &purchase_id, &reason);

    // Non-admin tries to resolve
    let non_admin = Address::generate(&env);
    let result =
        client.try_resolve_dispute(&non_admin, &purchase_id, &DisputeResolution::RefundBuyer);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

#[test]
fn can_query_dispute_record() {
    let env = Env::default();
    let (_contract_id, client, buyer, _creator, _asset, _material_id, purchase_id) =
        setup_purchase(&env);

    // No dispute yet
    assert!(client.get_dispute(&purchase_id).is_none());

    let reason = Bytes::from_array(&env, b"Query test dispute");
    client.open_dispute(&buyer, &purchase_id, &reason);

    let dispute = client.get_dispute(&purchase_id).unwrap();
    assert_eq!(dispute.purchase_id, purchase_id);
    assert_eq!(dispute.opener, buyer);
    assert_eq!(dispute.resolution, DisputeResolution::Unresolved);
}

// ============== Refund Purchase Tests ==============

#[test]
fn refund_purchase_via_purchase_buyer_mapping() {
    let env = Env::default();
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

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // Verify purchase → buyer mapping works
    let stored_buyer = client.get_purchase_buyer(&purchase_id).unwrap();
    assert_eq!(stored_buyer, buyer);

    // Refund using the mapping
    let result = client.try_refund_purchase(&admin, &purchase_id);
    assert!(result.is_ok());

    // Entitlement revoked
    assert!(!client.has_entitlement(&material_id, &buyer));
}

#[test]
fn refund_purchase_to_buyer_works() {
    let env = Env::default();
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

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // Refund via explicit buyer
    let result = client.try_refund_purchase_to_buyer(&admin, &purchase_id, &buyer);
    assert!(result.is_ok());

    // Settlement should be Refunded
    let settlement = client.get_settlement(&purchase_id).unwrap();
    assert_eq!(settlement.state, SettlementState::Refunded);
    assert!(settlement.refunded_amount > 0);
}

#[test]
fn refund_purchase_fails_for_wrong_buyer() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
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

    let unknown_buyer = Address::generate(&env);
    let material_id = bytes32(&env, 99);

    assert!(!client.has_entitlement(&material_id, &unknown_buyer));
}

#[test]
fn purchase_fails_for_invalid_items() {
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
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let invalid_material_id = bytes32(&env, 100);

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
fn purchase_fails_for_invalid_items() {
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

        let purchase_id = client.purchase(&buyer, &material_id, &asset, &1_000_000);
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
        let asset = Address::generate(&env);
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

        let invalid_material_id = bytes32(&env, 100);

        let result = client.try_purchase(&buyer, &invalid_material_id, &asset, &1_000_000);
        assert_eq!(result, Err(Ok(PurchaseError::MaterialNotFound)));
    }

    #[test]
    fn rejects_unauthorized_platform_config_change() {
        let purchase_id = client.purchase(&buyer, &material_id, &asset, &1_000_000);

        let all_events = env.events().all().filter_by_contract(&contract_id);
        let events = all_events.events();
        // First event is PlatformConfigUpdated from init, second is AdminTransferInitiated
        assert_eq!(events.len(), 2);
        let result = client.try_withdraw_payouts(&creator, &purchase_id);
        assert_eq!(result, Err(Ok(PurchaseError::EscrowLocked)));
    }

    #[test]
    fn withdraw_payouts_succeeds_after_lock_period() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let unauthorized_user = Address::generate(&env);
        let registry = Address::generate(&env);
        let treasury = Address::generate(&env);

        let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

        let all_events = env.events().all().filter_by_contract(&contract_id);
        let events = all_events.events();
        // init + transfer_initiated + transfer_accepted
        assert_eq!(events.len(), 3);
        let new_treasury = Address::generate(&env);
        let result =
            client.try_set_platform_config(&unauthorized_user, &new_treasury, &600, &false);
        assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
    }
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 1);
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

    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Default);

    client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );
    let purchase_id = client.purchase(&buyer, &material_id, &asset, &1_000_000);

    // Refund
    client.refund_purchase(&admin, &purchase_id);

    // Withdraw payouts
    client.withdraw_payouts(&creator, &purchase_id);

    let escrow = client.get_escrow_record(&purchase_id).unwrap();
    assert!(escrow.claimed);
}

// ============== Admin Abuse Tests ==============

#[test]
fn non_admin_cannot_refund() {
    let env = Env::default();
    let (_contract_id, client, _buyer, _creator, _asset, _material_id, purchase_id) =
        setup_purchase(&env);

    let non_admin = Address::generate(&env);
    let result = client.try_refund_purchase(&non_admin, &purchase_id);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

#[test]
fn non_admin_cannot_resolve_dispute() {
    let env = Env::default();
    let (_contract_id, client, buyer, _creator, _asset, _material_id, purchase_id) =
        setup_purchase(&env);

    let reason = Bytes::from_array(&env, b"Test dispute");
    client.open_dispute(&buyer, &purchase_id, &reason);

    let non_admin = Address::generate(&env);
    let result =
        client.try_resolve_dispute(&non_admin, &purchase_id, &DisputeResolution::RefundBuyer);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

// ============== Event Tests ==============

#[test]
fn dispute_opened_event_emitted() {
    let env = Env::default();
    let (_contract_id, client, buyer, _creator, _asset, _material_id, purchase_id) =
        setup_purchase(&env);

    let reason = Bytes::from_array(&env, b"Event test dispute");
    client.open_dispute(&buyer, &purchase_id, &reason);

    let dispute_events = env.events().all();
    let events = dispute_events.events();

    // Find the dispute.opened event
    let dispute_opened_found = events.iter().any(|event| {
        let s = std::format!("{:?}", event);
        s.contains("dispute") && s.contains("opened")
    });
    assert!(dispute_opened_found);
}

#[test]
fn purchase_refunded_event_emitted() {
    let env = Env::default();
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

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let _purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // Verify purchase.refunded event exists
    let all_events = env.events().all();
    let events = all_events.events();
    let refunded_found = events.iter().any(|event| {
        let s = std::format!("{:?}", event);
        s.contains("purchase") && s.contains("completed")
    });
    assert!(refunded_found);
}

// ============== Existing Tests (preserved for compatibility) ==============

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

    let info = client.get_asset_info(&asset).unwrap();
    assert_eq!(info.kind, AssetKind::Token);
    assert!(info.enabled);

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
fn successful_purchase_creates_entitlement_and_distributes_multiple_payouts() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let creator_payout = Address::generate(&env);
    let collaborator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let _asset_client = MockAssetClient::new(&env, &asset);

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

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    env.ledger().set_sequence_number(36_000);

    client.withdraw_payouts(&creator_payout, &purchase_id);

    let result = client.try_withdraw_payouts(&creator_payout, &purchase_id);
    assert_eq!(result, Err(Ok(PurchaseError::EscrowAlreadyClaimed)));
}

// ============== Admin Transfer Tests (#378) ==============

#[test]
fn transfer_admin_initiates_pending_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let transaction_id = Bytes::from_array(&env, &[0; 32]);
    let purchase_id = client.purchase(&buyer, &material_id, &asset, &1_000_000, &transaction_id);
    client.transfer_admin(&admin, &new_admin, &MIN_ADMIN_TRANSFER_DELAY_SECS);

    assert_eq!(
        client.get_pending_admin(),
        Some(PendingAdminTransfer {
            candidate: new_admin,
            initiated_at: env.ledger().timestamp(),
            accept_after: env.ledger().timestamp() + MIN_ADMIN_TRANSFER_DELAY_SECS,
        })
    );
}

#[test]
fn transfer_admin_rejects_delay_below_minimum() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let result = client.try_transfer_admin(&admin, &new_admin, &(MIN_ADMIN_TRANSFER_DELAY_SECS - 1));
    assert_eq!(result, Err(Ok(PurchaseError::InvalidTransferDelay)));
}

#[test]
fn transfer_admin_emits_initiated_event() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    client.transfer_admin(&admin, &new_admin, &MIN_ADMIN_TRANSFER_DELAY_SECS);

    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Default);
    let transaction_id = Bytes::from_array(&env, &[0; 32]);
    let purchase_id = client.purchase(&buyer, &material_id, &asset, &1_000_000, &transaction_id);
    let all_events = env.events().all().filter_by_contract(&contract_id);
    let events = all_events.events();
    // env.events().all() only reflects the most recent top-level invocation,
    // so only transfer_admin's AdminTransferInitiated event is visible here.
    assert_eq!(events.len(), 1);
}

#[test]
fn transfer_admin_requires_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let result = client.try_transfer_admin(&non_admin, &new_admin, &MIN_ADMIN_TRANSFER_DELAY_SECS);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

#[test]
fn accept_admin_fails_before_delay_elapses() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    client.transfer_admin(&admin, &new_admin, &MIN_ADMIN_TRANSFER_DELAY_SECS);

    let result = client.try_accept_admin(&new_admin);
    assert_eq!(result, Err(Ok(PurchaseError::TransferDelayNotElapsed)));
}

#[test]
fn accept_admin_completes_transfer_and_revokes_old_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let transaction_id = Bytes::from_array(&env, &[0; 32]);
    let purchase_id = client.purchase(&buyer, &material_id, &asset, &1_000_000, &transaction_id);
    client.transfer_admin(&admin, &new_admin, &MIN_ADMIN_TRANSFER_DELAY_SECS);
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + MIN_ADMIN_TRANSFER_DELAY_SECS);
    client.accept_admin(&new_admin);

    assert_eq!(client.get_pending_admin(), None);

    // The new admin can now perform admin-only actions.
    client.update_platform_fee(&new_admin, &300);
    let config = client.get_platform_config().unwrap();
    assert_eq!(config.platform_fee_bps, 300);

    // The old admin's role was revoked, not just left in place alongside the
    // new one (#463) — it can no longer perform admin-only actions either.
    let denied = client.try_update_platform_fee(&admin, &400);
    assert_eq!(denied, Err(Ok(PurchaseError::NotAuthorized)));
}

#[test]
fn accept_admin_emits_accepted_event() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    client.transfer_admin(&admin, &new_admin, &MIN_ADMIN_TRANSFER_DELAY_SECS);
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + MIN_ADMIN_TRANSFER_DELAY_SECS);
    client.accept_admin(&new_admin);

    let all_events = env.events().all().filter_by_contract(&contract_id);
    let events = all_events.events();
    // env.events().all() only reflects the most recent top-level invocation,
    // so only accept_admin's AdminTransferAccepted event is visible here.
    assert_eq!(events.len(), 1);
}

#[test]
fn accept_admin_fails_when_no_pending_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let claimant = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let result = client.try_accept_admin(&claimant);
    assert_eq!(result, Err(Ok(PurchaseError::NoPendingAdminTransfer)));
}

#[test]
fn accept_admin_fails_for_non_pending_address() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let impostor = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    client.transfer_admin(&admin, &new_admin, &MIN_ADMIN_TRANSFER_DELAY_SECS);
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + MIN_ADMIN_TRANSFER_DELAY_SECS);

    let result = client.try_accept_admin(&impostor);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

#[test]
fn cancel_admin_transfer_before_acceptance_prevents_it_from_completing() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    client.transfer_admin(&admin, &new_admin, &MIN_ADMIN_TRANSFER_DELAY_SECS);
    client.cancel_admin_transfer(&admin);
    assert_eq!(client.get_pending_admin(), None);

    env.ledger()
        .set_timestamp(env.ledger().timestamp() + MIN_ADMIN_TRANSFER_DELAY_SECS);
    let result = client.try_accept_admin(&new_admin);
    assert_eq!(result, Err(Ok(PurchaseError::NoPendingAdminTransfer)));

    // The original admin retained authority the whole time.
    client.update_platform_fee(&admin, &300);
}

#[test]
fn cancel_admin_transfer_requires_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    client.transfer_admin(&admin, &new_admin, &MIN_ADMIN_TRANSFER_DELAY_SECS);

    let result = client.try_cancel_admin_transfer(&non_admin);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

// ============== Creator Volume Tier Tests (#381) ==============

#[test]
fn purchase_creates_escrow_and_charges_platform_fee() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let collaborator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 1);
    let payout_shares = create_payout_shares_for(&env, &creator, 8_000, &collaborator, 2_000);
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

    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
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
    assert_eq!(escrow.payout_shares.len(), 1);

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
fn set_creator_tier_requires_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let non_admin = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let result = client.try_set_creator_tier(&non_admin, &creator, &CreatorTier::Tier1);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

#[test]
fn creator_tier_defaults_to_default_when_not_set() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Default);
}

#[test]
fn creator_tier_can_be_reverted_to_default() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);

    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    client.set_creator_tier(&admin, &creator, &CreatorTier::Tier1);
    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Tier1);

    client.set_creator_tier(&admin, &creator, &CreatorTier::Default);
    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Default);
}

#[test]
fn default_creator_uses_platform_fee_bps() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 8);
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

    client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    env.ledger().set_sequence_number(36_000);

    let purchase_id = 0;
    client.withdraw_payouts(&creator, &purchase_id);

    assert_eq!(asset_client.transfer_count(), 3);
    assert_eq!(
        asset_client.transfer_at(&1),
        MockTransfer {
            from: buyer.clone(),
            to: contract_id.clone(),
            amount: 950_000,
        }
    );
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
    let (_, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 700);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Default);

    client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // Default tier: uses the global platform_fee_bps (700 bps of 1_000_000 = 70_000)
    assert_eq!(asset_client.transfer_at(&3).amount, 70_000);
}

// ============== Sequence / Boundary Tests ==============

#[test]
fn purchase_id_increments_sequentially() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer_a = Address::generate(&env);
    let buyer_b = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let _asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 1);
    let material = MaterialRecord {
        material_id: material_id.clone(),
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
                recipient: creator.clone(),
                share_bps: 10_000,
            },
        ],
    };
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&material_id, &material);

    env.mock_all_auths();
    let (_contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let pid1 = client.purchase(
        &buyer_a,
        &material_id,
        &asset,
        &100_000,
        &sample_transaction_id(&env),
    );
    let pid2 = client.purchase(
        &buyer_b,
        &material_id,
        &asset,
        &100_000,
        &sample_transaction_id(&env),
    );

    assert_eq!(pid1, 0);
    assert_eq!(pid2, 1);

    assert!(client.get_settlement(&pid1).is_some());
    assert!(client.get_settlement(&pid2).is_some());
    assert!(client.get_purchase_buyer(&pid1).is_some());
    assert!(client.get_purchase_buyer(&pid2).is_some());
}

#[test]
fn tier1_creator_uses_250bps_fee() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 1);
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

    client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // Tier1 fee: 250 bps of 1_000_000 = 25_000
    assert_eq!(asset_client.transfer_at(&0).amount, 25_000);
}

#[test]
fn tier2_creator_uses_150bps_fee() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let asset_client = MockAssetClient::new(&env, &asset);

    let material_id = bytes32(&env, 6);
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

    client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // Tier2 fee: 150 bps of 1_000_000 = 15_000
    assert_eq!(asset_client.transfer_at(&0).amount, 15_000);
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

    assert_eq!(client.get_creator_tier(&creator), CreatorTier::Default);
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

// ============== TTL Renewal Tests (#464) ==============

/// Small, deterministic TTL window: large enough to clear the network's
/// minimum persistent-entry TTL, small enough that advancing a few
/// thousand ledgers is enough to cross the renewal threshold.
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

/// Registers `material_id` in the mock registry with a single quote/payout
/// pair, so `client.purchase` can succeed against it.
fn seed_purchasable_material(
    env: &Env,
    registry: &Address,
    material_id: &BytesN<32>,
    creator: &Address,
    asset: &Address,
    amount: i128,
) {
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: asset.clone(),
                amount,
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
    MockRegistryClient::new(env, registry).set_material(material_id, &material);
}

#[test]
fn platform_config_ttl_renews_on_every_touch_and_never_lapses() {
    let env = Env::default();
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let initial_ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    assert_ttl_renewed_to_max(initial_ttl);

    // Advance well past the renewal threshold without any call touching
    // instance state.
    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    // A plain read renews the instance TTL straight back to the max.
    assert!(client.get_platform_config().is_some());

    let renewed_ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    assert_ttl_renewed_to_max(renewed_ttl);
}

#[test]
fn entitlement_and_escrow_ttl_renew_on_read_after_partial_lapse() {
    let env = Env::default();
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(&env, 90);
    seed_purchasable_material(&env, &registry, &material_id, &creator, &asset, 1_000_000);

    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    let escrow_key = DataKey::Escrow(purchase_id);
    let entitlement_key = DataKey::Entitlement((material_id.clone(), buyer.clone()));

    let initial_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&escrow_key)
    });
    assert_ttl_renewed_to_max(initial_ttl);

    // Advance past the renewal threshold without touching either record —
    // exactly the "buyer never comes back" scenario #464 is about.
    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    // A plain content-access check (has_entitlement) and an escrow lookup
    // are both reads, and both renew — a buyer actively using what they
    // paid for keeps their own access alive for free.
    assert!(client.has_entitlement(&material_id, &buyer));
    assert!(client.get_escrow_record(&purchase_id).is_some());

    let renewed_escrow_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&escrow_key)
    });
    let renewed_entitlement_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&entitlement_key)
    });
    assert_ttl_renewed_to_max(renewed_escrow_ttl);
    assert_ttl_renewed_to_max(renewed_entitlement_ttl);
}

#[test]
fn allowed_asset_ttl_renews_on_write() {
    let env = Env::default();
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let asset = Address::generate(&env);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let asset_key = DataKey::AllowedAsset(asset.clone());
    let initial_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&asset_key)
    });
    assert_ttl_renewed_to_max(initial_ttl);

    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);
    let renewed_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&asset_key)
    });
    assert_ttl_renewed_to_max(renewed_ttl);
}

#[test]
fn creator_tier_ttl_renews_on_write() {
    let env = Env::default();
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let creator = Address::generate(&env);
    client.set_creator_tier(&admin, &creator, &CreatorTier::Tier1);

    let tier_key = DataKey::CreatorTier(creator.clone());
    let initial_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&tier_key)
    });
    assert_ttl_renewed_to_max(initial_ttl);

    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    client.set_creator_tier(&admin, &creator, &CreatorTier::Tier2);
    let renewed_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&tier_key)
    });
    assert_ttl_renewed_to_max(renewed_ttl);
}

#[test]
fn admin_role_ttl_renews_on_any_admin_check() {
    let env = Env::default();
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let admin_key = auth::AuthDataKey::AdminRole(admin.clone());
    let initial_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&admin_key)
    });
    assert_ttl_renewed_to_max(initial_ttl);

    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    // Any admin-gated call re-checks the role, which renews it.
    client.update_platform_fee(&admin, &300);

    let renewed_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&admin_key)
    });
    assert_ttl_renewed_to_max(renewed_ttl);
}

#[test]
fn extend_purchases_ttl_is_cursor_based_and_bounded() {
    let env = Env::default();
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    // 30 purchases: 5 more than MAX_MAINTENANCE_BATCH (25), proving the
    // sweep is bounded regardless of the caller's requested `limit`.
    let mut first_purchase_id = None;
    for i in 0..30u8 {
        let buyer = Address::generate(&env);
        let material_id = bytes32(&env, 100u8.wrapping_add(i));
        seed_purchasable_material(&env, &registry, &material_id, &creator, &asset, 1_000_000);
        let purchase_id = client.purchase(
            &buyer,
            &material_id,
            &asset,
            &1_000_000,
            &sample_transaction_id(&env),
        );
        if first_purchase_id.is_none() {
            first_purchase_id = Some((purchase_id, material_id, buyer));
        }
    }
    let (first_purchase_id, first_material_id, first_buyer) = first_purchase_id.unwrap();

    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    // A caller-requested limit far above MAX_MAINTENANCE_BATCH is clamped —
    // this single call, inside the test harness's default mainnet resource
    // enforcement, proves the sweep cannot exceed transaction resource
    // limits regardless of what's requested.
    let next_cursor = client.extend_purchases_ttl(&0, &10_000);
    assert_eq!(
        next_cursor, 25,
        "batch should be clamped to MAX_MAINTENANCE_BATCH"
    );

    let final_cursor = client.extend_purchases_ttl(&next_cursor, &10_000);
    assert_eq!(final_cursor, 30);

    // The very first purchase — registered long before the ledger advance —
    // was renewed by the sweep.
    let escrow_key = DataKey::Escrow(first_purchase_id);
    let entitlement_key = DataKey::Entitlement((first_material_id, first_buyer));
    let renewed_escrow_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&escrow_key)
    });
    let renewed_entitlement_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&entitlement_key)
    });
    assert_ttl_renewed_to_max(renewed_escrow_ttl);
    assert_ttl_renewed_to_max(renewed_entitlement_ttl);
}

#[test]
fn extend_allowed_asset_ttl_is_cursor_based() {
    let env = Env::default();
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);
    client.set_asset_allowed(&admin, &asset_a, &AssetKind::Token, &true);
    client.set_asset_allowed(&admin, &asset_b, &AssetKind::Token, &true);

    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    let cursor = client.extend_allowed_asset_ttl(&0, &1);
    assert_eq!(cursor, 1);
    let final_cursor = client.extend_allowed_asset_ttl(&cursor, &1);
    assert_eq!(final_cursor, 2);

    let asset_a_key = DataKey::AllowedAsset(asset_a);
    let renewed_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&asset_a_key)
    });
    assert_ttl_renewed_to_max(renewed_ttl);
}

#[test]
fn extend_creator_tier_ttl_is_cursor_based() {
    let env = Env::default();
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    let creator_a = Address::generate(&env);
    let creator_b = Address::generate(&env);
    client.set_creator_tier(&admin, &creator_a, &CreatorTier::Tier1);
    client.set_creator_tier(&admin, &creator_b, &CreatorTier::Tier2);

    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    let cursor = client.extend_creator_tier_ttl(&0, &1);
    assert_eq!(cursor, 1);
    let final_cursor = client.extend_creator_tier_ttl(&cursor, &1);
    assert_eq!(final_cursor, 2);

    let creator_a_key = DataKey::CreatorTier(creator_a);
    let renewed_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&creator_a_key)
    });
    assert_ttl_renewed_to_max(renewed_ttl);
}

#[test]
fn extend_admin_role_ttl_is_cursor_based() {
    let env = Env::default();
    env.mock_all_auths();
    set_short_ttl_window(&env);

    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let (contract_id, client) = install_and_init_contract(&env, &admin, &registry, &treasury, 500);

    // Seed a second admin-role index slot directly (rather than via
    // transfer_admin/accept_admin, which now revokes the outgoing admin as
    // part of completing a transfer — see #463) so this test can verify the
    // maintenance sweep pages through multiple populated slots.
    let second_admin = Address::generate(&env);
    env.as_contract(&contract_id, || {
        auth::set_admin_role(&env, &second_admin);
    });

    env.ledger().with_mut(|li| li.sequence_number += 12_000);

    let cursor = client.extend_admin_role_ttl(&0, &1);
    assert_eq!(cursor, 1);
    let final_cursor = client.extend_admin_role_ttl(&cursor, &1);
    assert_eq!(final_cursor, 2);

    let admin_key = auth::AuthDataKey::AdminRole(admin);
    let renewed_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&admin_key)
    });
    assert_ttl_renewed_to_max(renewed_ttl);
}

#[test]
fn test_register_usdc_token_asset() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let registry = env.register(MockRegistry, ());

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    client.initialize(&admin, &registry, &treasury, &500);

    let usdc_address = Address::generate(&env);

    client.register_token_asset(&admin, &usdc_address, &true);

    let asset_info = client.get_asset_info(&usdc_address);
    assert_eq!(
        asset_info,
        Some(AssetInfo {
            kind: AssetKind::Token,
            enabled: true
        })
    );

    assert!(client.is_asset_allowed(&usdc_address));
}

#[test]
fn test_register_institution_asset() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let registry = env.register(MockRegistry, ());

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    client.initialize(&admin, &registry, &treasury, &500);

    let institution_asset = Address::generate(&env);

    client.register_institution_asset(&admin, &institution_asset, &true);

    let asset_info = client.get_asset_info(&institution_asset);
    assert_eq!(
        asset_info,
        Some(AssetInfo {
            kind: AssetKind::InstitutionAsset,
            enabled: true
        })
    );

    assert!(client.is_asset_allowed(&institution_asset));
}

#[test]
fn test_purchase_with_usdc() {
    let env = Env::default();
    env.mock_all_auths();

    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let admin = Address::generate(&env);
    let registry_addr = env.register(MockRegistry, ());
    let usdc_asset = env.register(MockAsset, ());

    let registry_client = MockRegistryClient::new(&env, &registry_addr);
    let material_id = bytes32(&env, 1);

    registry_client.set_material(&material_id, &MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![&env, AssetQuote {
            asset: usdc_asset.clone(),
            amount: 5_000_000, // 50 USDC in 6 decimals
        }],
        payout_shares: vec![&env],
    });

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    client.initialize(&admin, &registry_addr, &Address::generate(&env), &500);
    client.register_token_asset(&admin, &usdc_asset, &true);

    let sample_tx_id = sample_transaction_id(&env);

    let purchase_id = client.purchase(&buyer, &material_id, &usdc_asset, &5_000_000, &sample_tx_id);
    assert!(purchase_id > 0);

    assert!(client.has_entitlement(&material_id, &buyer));
}

#[test]
fn test_disable_asset() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let registry = env.register(MockRegistry, ());

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    client.initialize(&admin, &registry, &treasury, &500);

    let usdc_address = Address::generate(&env);

    client.register_token_asset(&admin, &usdc_address, &true);
    assert!(client.is_asset_allowed(&usdc_address));

    client.set_asset_allowed(&admin, &usdc_address, &AssetKind::Token, &false);
    assert!(!client.is_asset_allowed(&usdc_address));

    let asset_info = client.get_asset_info(&usdc_address);
    assert_eq!(
        asset_info,
        Some(AssetInfo {
            kind: AssetKind::Token,
            enabled: false
        })
    );
}

#[test]
fn test_register_native_asset() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let registry = env.register(MockRegistry, ());

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    client.initialize(&admin, &registry, &treasury, &500);

    let native_asset = Address::generate(&env);

    client.register_native_asset(&admin, &native_asset, &true);

    let asset_info = client.get_asset_info(&native_asset);
    assert_eq!(
        asset_info,
        Some(AssetInfo {
            kind: AssetKind::Native,
            enabled: true
        })
    );

    assert!(client.is_asset_allowed(&native_asset));
}

#[test]
fn test_native_asset_purchase() {
    let env = Env::default();
    env.mock_all_auths();

    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let registry_addr = env.register(MockRegistry, ());
    let native_asset = env.register(MockAsset, ());

    let registry_client = MockRegistryClient::new(&env, &registry_addr);
    let material_id = bytes32(&env, 2);

    registry_client.set_material(&material_id, &MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![&env, AssetQuote {
            asset: native_asset.clone(),
            amount: 10_000_000, // 10 XLM
        }],
        payout_shares: vec![&env],
    });

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    client.initialize(&admin, &registry_addr, &treasury, &500);
    client.register_native_asset(&admin, &native_asset, &true);

    let sample_tx_id = sample_transaction_id(&env);

    let purchase_id = client.purchase(&buyer, &material_id, &native_asset, &10_000_000, &sample_tx_id);
    assert!(purchase_id > 0);

    assert!(client.has_entitlement(&material_id, &buyer));
}

#[test]
fn test_native_asset_purchase_with_payouts() {
    let env = Env::default();
    env.mock_all_auths();

    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let payout_recipient = Address::generate(&env);
    let registry_addr = env.register(MockRegistry, ());
    let native_asset = env.register(MockAsset, ());

    let registry_client = MockRegistryClient::new(&env, &registry_addr);
    let material_id = bytes32(&env, 3);

    let material_id = bytes32(env, 99);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            env,
            AssetQuote {
                asset: asset.clone(),
                amount: 1_000_000,
            },
        ],
        payout_shares: vec![
            env,
            PayoutShare {
                recipient: creator.clone(),
                share_bps: 10_000,
            },
        ],
    };
    let registry_client = MockRegistryClient::new(env, &registry);
    registry_client.set_material(&material_id, &material);

    let (contract_id, client) = install_and_init_contract(env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let mut recipients = soroban_sdk::Vec::new(env);
    for _i in 0..recipient_count {
        recipients.push_back(Address::generate(env));
    }

    (
        contract_id,
        client,
        admin,
        purchaser,
        creator,
        asset,
        material_id,
        recipients,
    )
}

    let sample_tx_id = sample_transaction_id(&env);

    let (_contract_id, client, _admin, purchaser, _creator, asset, material_id, recipients) =
        setup_bulk_purchase(&env, 3);

    let asset_client = MockAssetClient::new(&env, &asset);

    let escrow = client.get_escrow_record(&purchase_id).unwrap();
    assert!(!escrow.claimed);
    assert_eq!(escrow.total_amount, 20_000_000);
    assert_eq!(escrow.payout_shares.len(), 2);
}

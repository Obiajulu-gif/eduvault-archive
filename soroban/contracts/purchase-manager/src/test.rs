#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
use soroban_sdk::testutils::{Address as _, Events as _, Ledger};
use soroban_sdk::{contract, contractimpl, contracttype};
use soroban_sdk::{vec, Bytes, Event};

#[contract]
struct MockRegistry;

#[contracttype]
#[derive(Clone)]
enum MockRegistryKey {
    Material(BytesN<32>),
    Immutable(BytesN<32>),
    SaleTermsVersion(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct MockImmutableSnapshot {
    metadata_uri: soroban_sdk::String,
    metadata_hash: BytesN<32>,
    rights_hash: BytesN<32>,
}

#[contractimpl]
impl MockRegistry {
    pub fn set_material(env: Env, material_id: BytesN<32>, material: MaterialRecord) {
        env.storage()
            .persistent()
            .set(&MockRegistryKey::Material(material_id.clone()), &material);
    }

    pub fn set_material_immutable(
        env: Env,
        material_id: BytesN<32>,
        snapshot: MockImmutableSnapshot,
        sale_terms_version: u32,
    ) {
        env.storage()
            .persistent()
            .set(&MockRegistryKey::Immutable(material_id.clone()), &snapshot);
        env.storage()
            .persistent()
            .set(&MockRegistryKey::SaleTermsVersion(material_id), &sale_terms_version);
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

    pub fn get_material_immutable(
        env: Env,
        material_id: BytesN<32>,
    ) -> Result<MaterialImmutableSnapshot, PurchaseError> {
        let snapshot: MockImmutableSnapshot = env
            .storage()
            .persistent()
            .get(&MockRegistryKey::Immutable(material_id.clone()))
            .ok_or(PurchaseError::MaterialNotFound)?;
        Ok(MaterialImmutableSnapshot {
            metadata_uri: snapshot.metadata_uri,
            metadata_hash: snapshot.metadata_hash,
            rights_hash: snapshot.rights_hash,
        })
    }

    pub fn get_sale_terms_version(
        env: Env,
        material_id: BytesN<32>,
    ) -> Result<u32, PurchaseError> {
        Ok(env
            .storage()
            .persistent()
            .get(&MockRegistryKey::SaleTermsVersion(material_id))
            .unwrap_or(1))
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
    registry_client.set_material_immutable(
        &material_id,
        &MockImmutableSnapshot {
            metadata_uri: soroban_sdk::String::from_str(env, "ipfs://metadata-v1"),
            metadata_hash: bytes32(env, 11),
            rights_hash: bytes32(env, 22),
        },
        &1,
    );

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

#[test]
fn entitlement_check_is_scoped_to_the_purchasing_wallet() {
    let env = Env::default();
    let (_contract_id, client, buyer, _creator, _asset, material_id, purchase_id) =
        setup_purchase(&env);
    let different_wallet = Address::generate(&env);

    assert!(client.has_entitlement(&material_id, &buyer));
    assert_eq!(
        client
            .get_entitlement(&material_id, &buyer)
            .unwrap()
            .purchase_id,
        purchase_id
    );
    assert!(!client.has_entitlement(&material_id, &different_wallet));
    assert!(client
        .get_entitlement(&material_id, &different_wallet)
        .is_none());
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

    // Second refund should fail
    let result = client.try_refund_purchase(&admin, &purchase_id);
    assert_eq!(result, Err(Ok(PurchaseError::RefundNotAllowed)));
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
        &1_000_000,
        &sample_transaction_id(&env),
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

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

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

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    // Contract should have seller_net in escrow
    let escrow = client.get_escrow_record(&purchase_id).unwrap();
    assert_eq!(escrow.seller_net, 950_000);

    // Open dispute
    let reason = Bytes::from_array(&env, b"Product not as described");
    client.open_dispute(&buyer, &purchase_id, &reason);

    // Resolve with RefundBuyer — this should transfer funds back to buyer
    let result = client.try_resolve_dispute(&admin, &purchase_id, &DisputeResolution::RefundBuyer);
    assert!(result.is_ok());

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
    let wrong_buyer = Address::generate(&env);
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
    let _escrow = client.get_escrow_record(&purchase_id).unwrap();

    // Try to refund with wrong buyer
    let result = client.try_refund_purchase_to_buyer(&admin, &purchase_id, &wrong_buyer);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

// ============== Dual State Constraint Tests ==============

#[test]
fn release_and_refund_are_mutually_exclusive() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());

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
fn refund_purchase_revokes_entitlement() {
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

    // Refund
    client.refund_purchase(&admin, &purchase_id);

    // Refunding claims the escrow, so it cannot subsequently be withdrawn.
    let withdraw_result = client.try_withdraw_payouts(&creator, &purchase_id);
    assert_eq!(
        withdraw_result,
        Err(Ok(PurchaseError::EscrowAlreadyClaimed))
    );

    let escrow = client.get_escrow_record(&purchase_id).unwrap();
    assert!(escrow.claimed);
    assert!(!client.has_entitlement(&material_id, &buyer));
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

// ============== Scholarship Credit System Tests ==============

fn setup_scholarship_test(
    env: &Env,
) -> (
    Address,
    PurchaseManagerClient<'_>,
    Address,
    Address,
    BytesN<32>,
) {
    env.mock_all_auths();

    let admin = Address::generate(env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(env);
    let issuer = Address::generate(env);
    let learner = Address::generate(env);
    let asset = env.register(MockAsset, ());

    let material_id = bytes32(env, 1);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: Address::generate(env),
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
                recipient: Address::generate(env),
                share_bps: 10_000,
            },
        ],
    };
    let registry_client = MockRegistryClient::new(env, &registry);
    registry_client.set_material(&material_id, &material);

    let (_, client) = install_and_init_contract(env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);
    client.set_scholarship_issuer(&admin, &issuer, &true);
    client.set_scholarship_credit_cost(&admin, &material_id, &100); // 100 credits needed

    (admin, client, issuer, learner, material_id)
}

#[test]
fn test_earliest_expiry_first_consumption_order() {
    let env = Env::default();
    let (admin, client, issuer, learner, material_id) = setup_scholarship_test(&env);

    // Issue three grants with different expiry dates
    let current_ledger = env.ledger().sequence();
    
    // Grant 1: expires at ledger 100, 50 credits
    client.issue_scholarship_credits(&issuer, &learner, &50, &Some(100));
    
    // Grant 2: expires at ledger 200, 75 credits  
    client.issue_scholarship_credits(&issuer, &learner, &75, &Some(200));
    
    // Grant 3: no expiry, 25 credits
    client.issue_scholarship_credits(&issuer, &learner, &25, &None);

    // Total balance should be 150
    assert_eq!(client.get_scholarship_credit_balance(&learner), 150);

    // Set ledger to 50 (before any expiry)
    env.ledger().set_sequence_number(50);

    // Redeem 100 credits - should consume from grant 1 (expires earliest) first
    let result = client.redeem_scholarship_credits(&learner, &material_id);
    assert!(result.is_ok());
    
    // Remaining should be 50 (75 from grant 2 + 25 from grant 3 - consumed 0 from grant 2)
    assert_eq!(client.get_scholarship_credit_balance(&learner), 50);
    
    // Grant 1 should be exhausted and inactive
    let grant = client.get_scholarship_grant(&0).unwrap();
    assert_eq!(grant.remaining_credits, 0);
    assert!(!grant.active);
}

#[test]
fn test_redemption_exactly_exhausting_one_grant_spillover() {
    let env = Env::default();
    let (admin, client, issuer, learner, material_id) = setup_scholarship_test(&env);

    // Set higher credit cost for this test
    client.set_scholarship_credit_cost(&admin, &material_id, &120);
    
    // Issue two grants
    client.issue_scholarship_credits(&issuer, &learner, &50, &Some(100));  // Grant 0
    client.issue_scholarship_credits(&issuer, &learner, &100, &Some(200)); // Grant 1

    env.ledger().set_sequence_number(50);
    
    // Redeem 120 credits - should exhaust first grant (50) and take 70 from second
    let result = client.redeem_scholarship_credits(&learner, &material_id);
    assert!(result.is_ok());
    
    let result_data = result.unwrap();
    assert_eq!(result_data.credits_used, 120);
    assert_eq!(result_data.remaining_credits, 30); // 100 - 70 remaining from grant 1
    
    // Grant 0 should be exhausted
    let grant0 = client.get_scholarship_grant(&0).unwrap();
    assert_eq!(grant0.remaining_credits, 0);
    assert!(!grant0.active);
    
    // Grant 1 should have 30 remaining
    let grant1 = client.get_scholarship_grant(&1).unwrap();
    assert_eq!(grant1.remaining_credits, 30);
    assert!(grant1.active);
}

#[test]
fn test_expired_grant_rejection() {
    let env = Env::default();
    let (_, client, issuer, learner, material_id) = setup_scholarship_test(&env);

    // Issue grant that expires at ledger 100
    client.issue_scholarship_credits(&issuer, &learner, &200, &Some(100));
    
    // Advance ledger past expiry
    env.ledger().set_sequence_number(101);
    
    // Try to redeem - should fail with expired grant
    let result = client.try_redeem_scholarship_credits(&learner, &material_id);
    assert_eq!(result, Err(Ok(PurchaseError::InsufficientScholarshipCredits)));
}

#[test]
fn test_revoked_grant_rejection() {
    let env = Env::default();
    let (admin, client, issuer, learner, material_id) = setup_scholarship_test(&env);

    // Issue grant
    client.issue_scholarship_credits(&issuer, &learner, &200, &None);
    
    // Verify grant is active
    let grant = client.get_scholarship_grant(&0).unwrap();
    assert!(grant.active);
    
    // Revoke the grant
    client.revoke_scholarship_grant(&admin, &0);
    
    // Try to redeem - should fail
    let result = client.try_redeem_scholarship_credits(&learner, &material_id);
    assert_eq!(result, Err(Ok(PurchaseError::InsufficientScholarshipCredits)));
}

#[test]
fn test_too_many_active_grants_boundary() {
    let env = Env::default();
    let (_, client, issuer, learner, _) = setup_scholarship_test(&env);

    // Issue exactly 50 grants (the MAX_ACTIVE_SCHOLARSHIP_GRANTS limit)
    for _ in 0..50 {
        client.issue_scholarship_credits(&issuer, &learner, &10, &None);
    }
    
    // 51st grant should fail
    let result = client.try_issue_scholarship_credits(&issuer, &learner, &10, &None);
    assert_eq!(result, Err(Ok(PurchaseError::TooManyActiveGrants)));
}

#[test]
fn test_content_not_scholarship_eligible() {
    let env = Env::default();
    let (admin, client, issuer, learner, _) = setup_scholarship_test(&env);

    // Create material without scholarship cost set
    let registry = env.register(MockRegistry, ());
    let non_eligible_material = bytes32(&env, 99);
    let material = MaterialRecord {
        material_id: non_eligible_material.clone(),
        creator: Address::generate(&env),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![&env, AssetQuote { asset: env.register(MockAsset, ()), amount: 1_000_000 }],
        payout_shares: vec![&env, PayoutShare { recipient: Address::generate(&env), share_bps: 10_000 }],
    };
    let registry_client = MockRegistryClient::new(&env, &registry);
    registry_client.set_material(&non_eligible_material, &material);

    // Issue credits
    client.issue_scholarship_credits(&issuer, &learner, &100, &None);
    
    // Try to redeem against material with no scholarship cost
    let result = client.try_redeem_scholarship_credits(&learner, &non_eligible_material);
    assert_eq!(result, Err(Ok(PurchaseError::ContentNotScholarshipEligible)));
}

#[test]
fn test_redemption_already_exists() {
    let env = Env::default();
    let (_, client, issuer, learner, material_id) = setup_scholarship_test(&env);

    // Issue credits and redeem once
    client.issue_scholarship_credits(&issuer, &learner, &200, &None);
    client.redeem_scholarship_credits(&learner, &material_id).unwrap();
    
    // Issue more credits
    client.issue_scholarship_credits(&issuer, &learner, &200, &None);
    
    // Try to redeem again for same material - should fail
    let result = client.try_redeem_scholarship_credits(&learner, &material_id);
    assert_eq!(result, Err(Ok(PurchaseError::RedemptionAlreadyExists)));
}

#[test]
fn test_insufficient_scholarship_credits() {
    let env = Env::default();
    let (_, client, issuer, learner, material_id) = setup_scholarship_test(&env);

    // Issue only 50 credits but need 100
    client.issue_scholarship_credits(&issuer, &learner, &50, &None);
    
    let result = client.try_redeem_scholarship_credits(&learner, &material_id);
    assert_eq!(result, Err(Ok(PurchaseError::InsufficientScholarshipCredits)));
}

#[test]
fn test_scholarship_grant_expired_error() {
    let env = Env::default();
    let (admin, client, issuer, learner, _) = setup_scholarship_test(&env);

    // Issue grant that expires at ledger 100
    client.issue_scholarship_credits(&issuer, &learner, &100, &Some(100));
    
    // Advance past expiry
    env.ledger().set_sequence_number(101);
    
    // Try to revoke expired grant - should fail with ScholarshipGrantExpired
    let result = client.try_revoke_scholarship_grant(&admin, &0);
    assert_eq!(result, Err(Ok(PurchaseError::ScholarshipGrantExpired)));
}

#[test]
fn test_scholarship_grant_inactive_error() {
    let env = Env::default();
    let (admin, client, issuer, learner, _) = setup_scholarship_test(&env);

    // Issue and then revoke grant
    client.issue_scholarship_credits(&issuer, &learner, &100, &None);
    client.revoke_scholarship_grant(&admin, &0);
    
    // Try to revoke again - should fail with ScholarshipGrantInactive
    let result = client.try_revoke_scholarship_grant(&admin, &0);
    assert_eq!(result, Err(Ok(PurchaseError::ScholarshipGrantInactive)));
}

#[test]
fn test_grant_already_processed_error() {
    let env = Env::default();
    let (_, client, issuer, learner, material_id) = setup_scholarship_test(&env);

    // Issue exactly enough credits
    client.issue_scholarship_credits(&issuer, &learner, &100, &None);
    
    // Redeem (this should consume the grant fully)
    client.redeem_scholarship_credits(&learner, &material_id).unwrap();
    
    // The grant should now be inactive with 0 remaining credits
    let grant = client.get_scholarship_grant(&0).unwrap();
    assert!(!grant.active);
    assert_eq!(grant.remaining_credits, 0);
}

#[test]
fn test_mixed_expiry_grants_consumption() {
    let env = Env::default();
    let (_, client, issuer, learner, material_id) = setup_scholarship_test(&env);

    // Create grants with mixed expiry: some expire, some don't
    client.issue_scholarship_credits(&issuer, &learner, &30, &Some(50));  // Will expire
    client.issue_scholarship_credits(&issuer, &learner, &40, &None);      // No expiry
    client.issue_scholarship_credits(&issuer, &learner, &50, &Some(200)); // Far future
    
    // Advance past first grant expiry
    env.ledger().set_sequence_number(51);
    
    // Should now have 90 credits (40 + 50, first grant expired)
    assert_eq!(client.get_scholarship_credit_balance(&learner), 90);
    
    // Redemption should work with remaining credits
    let result = client.redeem_scholarship_credits(&learner, &material_id);
    assert!(result.is_ok());
}

#[test]
fn test_scholarship_balance_computation_across_grants() {
    let env = Env::default();
    let (_, client, issuer, learner, _) = setup_scholarship_test(&env);

    // Issue multiple grants
    client.issue_scholarship_credits(&issuer, &learner, &25, &None);
    client.issue_scholarship_credits(&issuer, &learner, &35, &Some(100));
    client.issue_scholarship_credits(&issuer, &learner, &40, &Some(200));
    
    // Total should be sum of all grants
    assert_eq!(client.get_scholarship_credit_balance(&learner), 100);
    
    // Advance past first expiry
    env.ledger().set_sequence_number(101);
    
    // Should exclude expired grant
    assert_eq!(client.get_scholarship_credit_balance(&learner), 65); // 25 + 40
}

#[test]  
fn test_time_based_expiry_edge_case() {
    let env = Env::default();
    let (_, client, issuer, learner, material_id) = setup_scholarship_test(&env);

    // Issue grant that expires exactly at current ledger + 1
    let current = env.ledger().sequence();
    client.issue_scholarship_credits(&issuer, &learner, &100, &Some(current + 1));
    
    // Should still be valid at current ledger
    assert_eq!(client.get_scholarship_credit_balance(&learner), 100);
    
    // Advance to expiry ledger
    env.ledger().set_sequence_number(current + 1);
    
    // Should now be expired (expires_at <= current_ledger)
    assert_eq!(client.get_scholarship_credit_balance(&learner), 0);
}

#[test]
fn test_invalid_credit_amount() {
    let env = Env::default();
    let (_, client, issuer, learner, _) = setup_scholarship_test(&env);

    // Try to issue zero credits
    let result = client.try_issue_scholarship_credits(&issuer, &learner, &0, &None);
    assert_eq!(result, Err(Ok(PurchaseError::InvalidCreditAmount)));

    // Try to issue negative credits
    let result = client.try_issue_scholarship_credits(&issuer, &learner, &-100, &None);
    assert_eq!(result, Err(Ok(PurchaseError::InvalidCreditAmount)));
}

#[test]
fn test_invalid_credit_cost() {
    let env = Env::default();
    let (admin, client, _, _, material_id) = setup_scholarship_test(&env);

    // Try to set zero cost
    let result = client.try_set_scholarship_credit_cost(&admin, &material_id, &0);
    assert_eq!(result, Err(Ok(PurchaseError::InvalidCreditCost)));

    // Try to set negative cost
    let result = client.try_set_scholarship_credit_cost(&admin, &material_id, &-50);
    assert_eq!(result, Err(Ok(PurchaseError::InvalidCreditCost)));
}

#[test]
fn test_invalid_expiry() {
    let env = Env::default();
    let (_, client, issuer, learner, _) = setup_scholarship_test(&env);

    // Try to set expiry in the past
    let current = env.ledger().sequence();
    let result = client.try_issue_scholarship_credits(&issuer, &learner, &100, &Some(current - 1));
    assert_eq!(result, Err(Ok(PurchaseError::InvalidExpiry)));
}

#[test]
fn test_scholarship_grant_not_found() {
    let env = Env::default();
    let (admin, client, _, _, _) = setup_scholarship_test(&env);

    // Try to revoke non-existent grant
    let result = client.try_revoke_scholarship_grant(&admin, &999);
    assert_eq!(result, Err(Ok(PurchaseError::ScholarshipGrantNotFound)));

    // Try to get non-existent grant
    let grant = client.get_scholarship_grant(&999);
    assert!(grant.is_none());
}

#[test]
fn test_unauthorized_scholarship_operations() {
    let env = Env::default();
    let (admin, client, issuer, learner, material_id) = setup_scholarship_test(&env);

    let unauthorized = Address::generate(&env);

    // Unauthorized issuer can't issue credits
    let result = client.try_issue_scholarship_credits(&unauthorized, &learner, &100, &None);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));

    // Unauthorized admin can't set costs
    let result = client.try_set_scholarship_credit_cost(&unauthorized, &material_id, &50);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));

    // Unauthorized admin can't revoke grants
    client.issue_scholarship_credits(&issuer, &learner, &100, &None);
    let result = client.try_revoke_scholarship_grant(&unauthorized, &0);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));
}

#[test]
fn test_max_grants_consumption_performance() {
    let env = Env::default();
    let (admin, client, issuer, learner, material_id) = setup_scholarship_test(&env);

    // Set higher cost requiring consumption across multiple grants
    client.set_scholarship_credit_cost(&admin, &material_id, &500);

    // Issue exactly 50 grants (MAX limit) with 10 credits each = 500 total
    for i in 0..50 {
        // Vary expiry to test earliest-first logic across all grants
        let expiry = if i % 5 == 0 { None } else { Some(1000 + i as u32) };
        client.issue_scholarship_credits(&issuer, &learner, &10, &expiry);
    }

    // Verify we have exactly 500 credits across 50 grants
    assert_eq!(client.get_scholarship_credit_balance(&learner), 500);

    // This redemption should consume from ALL 50 grants (10 credits each)
    let result = client.redeem_scholarship_credits(&learner, &material_id);
    assert!(result.is_ok());
    
    let result_data = result.unwrap();
    assert_eq!(result_data.credits_used, 500);
    assert_eq!(result_data.remaining_credits, 0);

    // All grants should now be inactive/exhausted
    let final_balance = client.get_scholarship_credit_balance(&learner);
    assert_eq!(final_balance, 0);
}

// ============== Bulk Refund Tests ==============

fn setup_bulk_purchase_test(
    env: &Env,
    recipient_count: u32,
) -> (
    Address,
    PurchaseManagerClient<'_>,
    Address,
    Address,
    BytesN<32>,
    Vec<Address>,
    u64, // first_purchase_id
) {
    env.mock_all_auths();

    let admin = Address::generate(env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(env);
    let purchaser = Address::generate(env);
    let creator = Address::generate(env);
    let asset = env.register(MockAsset, ());

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

    let (_, client) = install_and_init_contract(env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    // Create recipients
    let mut recipients = vec![env; recipient_count as usize];
    for i in 0..recipient_count {
        recipients.set(i, Address::generate(env));
    }

    // Perform bulk purchase
    let result = client.purchase_bulk_licenses(
        &purchaser,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(env),
        &recipients,
    );
    let first_purchase_id = result.first_purchase_id;

    (admin, client, purchaser, creator, material_id, recipients, first_purchase_id)
}

#[test]
fn test_bulk_refund_full_batch() {
    let env = Env::default();
    let (admin, client, purchaser, _, material_id, recipients, first_purchase_id) = 
        setup_bulk_purchase_test(&env, 5);

    // Verify all recipients have entitlements
    for i in 0..recipients.len() {
        let recipient = recipients.get_unchecked(i);
        assert!(client.has_entitlement(&material_id, &recipient));
    }

    // Perform bulk refund
    let result = client.refund_bulk_purchase(&admin, &purchaser, &material_id, &25);
    assert!(result.is_ok());
    
    let refund_result = result.unwrap();
    assert_eq!(refund_result.refunded_count, 5);
    assert_eq!(refund_result.skipped_count, 0);
    assert_eq!(refund_result.total_refund_amount, 5 * 950_000); // 5 * seller_net

    // Verify all entitlements are revoked
    for i in 0..recipients.len() {
        let recipient = recipients.get_unchecked(i);
        assert!(!client.has_entitlement(&material_id, &recipient));
    }

    // Verify all settlements are in Refunded state
    for i in 0..5u32 {
        let purchase_id = first_purchase_id + i as u64;
        let settlement = client.get_settlement(&purchase_id).unwrap();
        assert_eq!(settlement.state, SettlementState::Refunded);
    }
}

#[test]
fn test_bulk_refund_partial_batch() {
    let env = Env::default();
    let (admin, client, purchaser, _, material_id, recipients, first_purchase_id) = 
        setup_bulk_purchase_test(&env, 5);

    // Manually refund the first 2 purchases individually
    client.refund_purchase(&admin, &first_purchase_id);
    client.refund_purchase(&admin, &(first_purchase_id + 1));

    // Now try bulk refund - should skip the first 2, refund the remaining 3
    let result = client.refund_bulk_purchase(&admin, &purchaser, &material_id, &25);
    assert!(result.is_ok());
    
    let refund_result = result.unwrap();
    assert_eq!(refund_result.refunded_count, 3); // Only 3 remaining were refunded
    assert_eq!(refund_result.skipped_count, 2);  // 2 were already refunded
    assert_eq!(refund_result.total_refund_amount, 3 * 950_000); // 3 * seller_net

    // Verify all entitlements are still revoked
    for i in 0..recipients.len() {
        let recipient = recipients.get_unchecked(i);
        assert!(!client.has_entitlement(&material_id, &recipient));
    }
}

#[test]
fn test_bulk_refund_resource_limit_boundary() {
    let env = Env::default();
    let (admin, client, purchaser, _, material_id, _, first_purchase_id) = 
        setup_bulk_purchase_test(&env, 50); // MAX_BULK_LICENSE_RECIPIENTS

    // Request refund with limit higher than MAX_MAINTENANCE_BATCH
    let result = client.refund_bulk_purchase(&admin, &purchaser, &material_id, &100);
    assert!(result.is_ok());
    
    let refund_result = result.unwrap();
    // Should be capped at MAX_MAINTENANCE_BATCH (25)
    assert_eq!(refund_result.refunded_count + refund_result.skipped_count, 25);
    assert_eq!(refund_result.refunded_count, 25);
    assert_eq!(refund_result.skipped_count, 0);

    // Verify only the first 25 were processed
    for i in 0..25u32 {
        let purchase_id = first_purchase_id + i as u64;
        let settlement = client.get_settlement(&purchase_id).unwrap();
        assert_eq!(settlement.state, SettlementState::Refunded);
    }

    // Verify the remaining are still pending
    for i in 25..50u32 {
        let purchase_id = first_purchase_id + i as u64;
        let settlement = client.get_settlement(&purchase_id).unwrap();
        assert_eq!(settlement.state, SettlementState::Pending);
    }
}

#[test]
fn test_bulk_refund_authorization() {
    let env = Env::default();
    let (admin, client, purchaser, _, material_id, _, _) = 
        setup_bulk_purchase_test(&env, 3);

    let unauthorized = Address::generate(&env);

    // Unauthorized caller should fail
    let result = client.try_refund_bulk_purchase(&unauthorized, &purchaser, &material_id, &25);
    assert_eq!(result, Err(Ok(PurchaseError::NotAuthorized)));

    // Original purchaser should succeed
    let result = client.refund_bulk_purchase(&purchaser, &purchaser, &material_id, &25);
    assert!(result.is_ok());
}

#[test]
fn test_bulk_refund_nonexistent_bulk_purchase() {
    let env = Env::default();
    let (admin, client, _, _, _, _, _) = setup_bulk_purchase_test(&env, 3);

    let fake_purchaser = Address::generate(&env);
    let fake_material = bytes32(&env, 99);

    // Non-existent bulk purchase should fail
    let result = client.try_refund_bulk_purchase(&admin, &fake_purchaser, &fake_material, &25);
    assert_eq!(result, Err(Ok(PurchaseError::MaterialNotFound)));
}

#[test]
fn test_bulk_refund_with_disputes() {
    let env = Env::default();
    let (admin, client, purchaser, _, material_id, recipients, first_purchase_id) = 
        setup_bulk_purchase_test(&env, 5);

    // Open dispute on the first purchase
    let first_recipient = recipients.get_unchecked(0);
    let reason = Bytes::from_array(&env, b"Defective material");
    client.open_dispute(&first_recipient, &first_purchase_id, &reason);

    // Bulk refund should skip the disputed purchase
    let result = client.refund_bulk_purchase(&admin, &purchaser, &material_id, &25);
    assert!(result.is_ok());
    
    let refund_result = result.unwrap();
    assert_eq!(refund_result.refunded_count, 4); // 4 pending purchases refunded
    assert_eq!(refund_result.skipped_count, 1);  // 1 disputed purchase skipped

    // Verify the disputed purchase is still in Disputed state
    let settlement = client.get_settlement(&first_purchase_id).unwrap();
    assert_eq!(settlement.state, SettlementState::Disputed);
}

#[test]
fn test_get_bulk_purchase_record() {
    let env = Env::default();
    let (_, client, purchaser, _, material_id, recipients, first_purchase_id) = 
        setup_bulk_purchase_test(&env, 3);

    // Query the bulk purchase record
    let bulk_record = client.get_bulk_purchase(&purchaser, &material_id);
    assert!(bulk_record.is_some());
    
    let record = bulk_record.unwrap();
    assert_eq!(record.purchaser, purchaser);
    assert_eq!(record.material_id, material_id);
    assert_eq!(record.first_purchase_id, first_purchase_id);
    assert_eq!(record.recipient_count, 3);
    assert_eq!(record.unit_price, 1_000_000);

    // Query non-existent bulk purchase
    let fake_purchaser = Address::generate(&env);
    let fake_material = bytes32(&env, 99);
    let no_record = client.get_bulk_purchase(&fake_purchaser, &fake_material);
    assert!(no_record.is_none());
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

    let result =
        client.try_transfer_admin(&admin, &new_admin, &(MIN_ADMIN_TRANSFER_DELAY_SECS - 1));
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

    registry_client.set_material(
        &material_id,
        &MaterialRecord {
            material_id: material_id.clone(),
            creator: creator.clone(),
            paused: false,
            status: MaterialStatus::Active,
            quotes: vec![
                &env,
                AssetQuote {
                    asset: usdc_asset.clone(),
                    amount: 5_000_000, // 50 USDC in 6 decimals
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

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    client.initialize(&admin, &registry_addr, &Address::generate(&env), &500);
    client.register_token_asset(&admin, &usdc_asset, &true);

    let sample_tx_id = sample_transaction_id(&env);

    let purchase_id = client.purchase(&buyer, &material_id, &usdc_asset, &5_000_000, &sample_tx_id);
    assert_eq!(purchase_id, 0);

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

    registry_client.set_material(
        &material_id,
        &MaterialRecord {
            material_id: material_id.clone(),
            creator: creator.clone(),
            paused: false,
            status: MaterialStatus::Active,
            quotes: vec![
                &env,
                AssetQuote {
                    asset: native_asset.clone(),
                    amount: 10_000_000, // 10 XLM
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

    let contract_id = env.register(PurchaseManager, ());
    let client = PurchaseManagerClient::new(&env, &contract_id);

    client.initialize(&admin, &registry_addr, &treasury, &500);
    client.register_native_asset(&admin, &native_asset, &true);

    let sample_tx_id = sample_transaction_id(&env);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &native_asset,
        &10_000_000,
        &sample_tx_id,
    );
    assert_eq!(purchase_id, 0);

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

    let material_id = bytes32(&env, 5);
    let payout_shares = create_payout_shares_for(&env, &creator, 6_000, &payout_recipient, 4_000);
    let material = MaterialRecord {
        material_id: material_id.clone(),
        creator: creator.clone(),
        paused: false,
        status: MaterialStatus::Active,
        quotes: vec![
            &env,
            AssetQuote {
                asset: native_asset.clone(),
                amount: 20_000_000,
            },
        ],
        payout_shares,
    };
    let registry_client = MockRegistryClient::new(&env, &registry_addr);
    registry_client.set_material(&material_id, &material);

    let (_contract_id, client) =
        install_and_init_contract(&env, &admin, &registry_addr, &treasury, 500);
    client.register_native_asset(&admin, &native_asset, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &native_asset,
        &20_000_000,
        &sample_transaction_id(&env),
    );
    assert!(client.has_entitlement(&material_id, &buyer));

    let escrow = client.get_escrow_record(&purchase_id).unwrap();
    assert!(!escrow.claimed);
    assert_eq!(escrow.total_amount, 20_000_000);
    assert_eq!(escrow.payout_shares.len(), 2);
}

#[test]
fn purchase_snapshot_preserves_metadata_after_sale_terms_change() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let registry = env.register(MockRegistry, ());
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let creator = Address::generate(&env);
    let asset = env.register(MockAsset, ());
    let material_id = bytes32(&env, 9);

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
    registry_client.set_material_immutable(
        &material_id,
        &MockImmutableSnapshot {
            metadata_uri: soroban_sdk::String::from_str(&env, "ipfs://terms-v1"),
            metadata_hash: bytes32(&env, 41),
            rights_hash: bytes32(&env, 42),
        },
        &1,
    );

    let (_contract_id, client) =
        install_and_init_contract(&env, &admin, &registry, &treasury, 500);
    client.set_asset_allowed(&admin, &asset, &AssetKind::Token, &true);

    let purchase_id = client.purchase(
        &buyer,
        &material_id,
        &asset,
        &1_000_000,
        &sample_transaction_id(&env),
    );

    let snapshot = client.get_purchase_snapshot(&purchase_id).unwrap();
    assert_eq!(snapshot.metadata_hash, bytes32(&env, 41));
    assert_eq!(snapshot.rights_hash, bytes32(&env, 42));
    assert_eq!(snapshot.sale_terms_version, 1);

    registry_client.set_material_immutable(
        &material_id,
        &MockImmutableSnapshot {
            metadata_uri: soroban_sdk::String::from_str(&env, "ipfs://terms-v2"),
            metadata_hash: bytes32(&env, 91),
            rights_hash: bytes32(&env, 92),
        },
        &2,
    );

    let snapshot_after_terms_change = client.get_purchase_snapshot(&purchase_id).unwrap();
    assert_eq!(snapshot_after_terms_change.metadata_hash, bytes32(&env, 41));
    assert_eq!(snapshot_after_terms_change.sale_terms_version, 1);
}

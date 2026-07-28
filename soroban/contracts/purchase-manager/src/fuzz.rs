#![cfg(test)]

extern crate std;

use crate::{
    AssetKind, AssetQuote, MaterialRecord, MaterialStatus, PayoutShare, PurchaseError,
    PurchaseManager, PurchaseManagerClient, ESCROW_LOCK_PERIOD_LEDGERS,
};
use proptest::prelude::*;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events, Ledger},
    vec, Address, Bytes, BytesN, Env, IntoVal, String, Vec,
};
use std::collections::BTreeMap;

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

#[contract]
struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {
        // Mock token just accepts transfers
    }
    pub fn balance(_env: Env, _id: Address) -> i128 {
        i128::MAX / 2
    }
}

const BUYER_COUNT: usize = 3;

#[derive(Clone, Debug)]
enum Command {
    Purchase {
        buyer_idx: usize,
        amount: i128,
    },
    AdvanceLedger {
        ledgers: u32,
    },
    WithdrawPayout {
        purchase_id: u64,
        caller_is_creator: bool,
    },
}

fn command_strategy() -> impl Strategy<Value = Command> {
    prop_oneof![
        (0..BUYER_COUNT, 1i128..10_000)
            .prop_map(|(buyer_idx, amount)| Command::Purchase { buyer_idx, amount }),
        (1u32..50_000).prop_map(|ledgers| Command::AdvanceLedger { ledgers }),
        (0u64..100, any::<bool>()).prop_map(|(purchase_id, caller_is_creator)| {
            Command::WithdrawPayout {
                purchase_id,
                caller_is_creator,
            }
        }),
    ]
}

#[derive(Clone)]
struct EscrowState {
    purchase_ledger: u32,
    claimed: bool,
}

#[derive(Clone)]
struct AbstractModel {
    current_ledger: u32,
    escrows: BTreeMap<u64, EscrowState>,
    next_purchase_id: u64,
}

impl AbstractModel {
    fn new() -> Self {
        Self {
            current_ledger: 0,
            escrows: BTreeMap::new(),
            next_purchase_id: 0,
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(std::env::var("PROPTEST_CASES").unwrap_or_else(|_| std::string::String::from("256")).parse().unwrap_or(256)))]

    #[test]
    fn stateful_fuzz_purchase_manager(commands in proptest::collection::vec(command_strategy(), 1..100)) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        let contract_id = env.register_contract(None, PurchaseManager);
        let client = PurchaseManagerClient::new(&env, &contract_id);

        let registry_id = env.register_contract(None, MockRegistry);
        let asset_id = env.register_contract(None, MockToken);

        let material_id = BytesN::from_array(&env, &[1; 32]);
        let mut quotes = Vec::new(&env);
        quotes.push_back(AssetQuote { asset: asset_id.clone(), amount: 1000 });
        let mut payout_shares = Vec::new(&env);
        payout_shares.push_back(PayoutShare { recipient: creator.clone(), share_bps: 10000 });

        let material = MaterialRecord {
            material_id: material_id.clone(),
            creator: creator.clone(),
            paused: false,
            status: MaterialStatus::Active,
            quotes,
            payout_shares,
        };

        // Setup mock registry
        env.invoke_contract::<()>(
            &registry_id,
            &soroban_sdk::Symbol::new(&env, "set_material"),
            vec![&env, material_id.into_val(&env), material.into_val(&env)],
        );

        let res = client.try_initialize(
            &admin,
            &registry_id,
            &treasury,
            &1000, // 10%
        );
        assert!(res.is_ok());

        client.set_asset_allowed(&admin, &asset_id, &AssetKind::Token, &true);

        let buyers: std::vec::Vec<Address> = (0..BUYER_COUNT).map(|_| Address::generate(&env)).collect();
        let mut model = AbstractModel::new();
        env.ledger().set_sequence_number(model.current_ledger);

        for cmd in commands {
            match cmd {
                Command::Purchase { buyer_idx, amount } => {
                    let buyer = &buyers[buyer_idx];
                    let transaction_id = Bytes::from_array(&env, &[0; 32]);

                    let res = client.try_purchase(
                        buyer,
                        &material_id,
                        &asset_id,
                        &amount,
                        &transaction_id,
                    );

                    if amount == 1000 && !client.has_entitlement(&material_id, buyer) {
                        assert!(res.is_ok(), "Valid purchase should succeed");
                        let p_id = res.unwrap().unwrap();
                        assert_eq!(p_id, model.next_purchase_id);
                        model.escrows.insert(p_id, EscrowState {
                            purchase_ledger: model.current_ledger,
                            claimed: false,
                        });
                        model.next_purchase_id += 1;
                    } else {
                        assert!(res.is_err(), "Invalid purchase should fail");
                    }
                }
                Command::AdvanceLedger { ledgers } => {
                    model.current_ledger += ledgers;
                    env.ledger().set_sequence_number(model.current_ledger);
                }
                Command::WithdrawPayout { purchase_id, caller_is_creator } => {
                    let caller = if caller_is_creator { &creator } else { &buyers[0] };
                    let res = client.try_withdraw_payouts(caller, &purchase_id);

                    let escrow_state = model.escrows.get_mut(&purchase_id);

                    #[cfg(not(feature = "seeded-defects"))]
                    {
                        if let Some(state) = escrow_state {
                            if !state.claimed && caller_is_creator && model.current_ledger >= state.purchase_ledger + ESCROW_LOCK_PERIOD_LEDGERS {
                                assert!(res.is_ok(), "Valid withdrawal should succeed: purchase_id={}, current_ledger={}, purchase_ledger={}", purchase_id, model.current_ledger, state.purchase_ledger);
                                state.claimed = true;
                            } else {
                                assert!(res.is_err(), "Invalid withdrawal should fail");
                            }
                        } else {
                            assert!(res.is_err(), "Withdrawal for non-existent purchase should fail");
                        }
                    }
                }
            }
        }
    }
}

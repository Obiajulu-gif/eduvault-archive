#![cfg(test)]

extern crate std;

use crate::{
    AssetKind, AssetQuote, MaterialRegistry, MaterialRegistryClient, MaterialStatus, PayoutShare,
    RegistryError,
};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, BytesN, Env, String, Vec,
};
use std::collections::BTreeMap;

const ACTOR_COUNT: usize = 3;
const ASSET_COUNT: usize = 2;

#[derive(Clone, Debug)]
enum Command {
    SetAssetAllowed {
        admin_idx: usize,
        asset_idx: usize,
        enabled: bool,
    },
    RegisterMaterial {
        creator_idx: usize,
        asset_idx: usize,
        price: i128,
        payout_recipient_idx: usize,
    },
    SetMaterialStatus {
        actor_idx: usize,
        material_idx: usize,
        status: MaterialStatus,
    },
}

fn command_strategy() -> impl Strategy<Value = Command> {
    prop_oneof![
        (0..ACTOR_COUNT, 0..ASSET_COUNT, any::<bool>()).prop_map(
            |(admin_idx, asset_idx, enabled)| Command::SetAssetAllowed {
                admin_idx,
                asset_idx,
                enabled,
            }
        ),
        (
            0..ACTOR_COUNT,
            0..ASSET_COUNT,
            // boundaries of i128, but strictly positive amounts are valid for pricing
            prop_oneof![Just(1i128), Just(i128::MAX), Just(-1i128), any::<i128>(),],
            0..ACTOR_COUNT,
        )
            .prop_map(|(creator_idx, asset_idx, price, payout_recipient_idx)| {
                Command::RegisterMaterial {
                    creator_idx,
                    asset_idx,
                    price,
                    payout_recipient_idx,
                }
            }),
        (
            0..ACTOR_COUNT,
            0..100usize, // Material idx: intentionally larger to test missing
            prop_oneof![
                Just(MaterialStatus::Active),
                Just(MaterialStatus::Paused),
                Just(MaterialStatus::Archived),
            ],
        )
            .prop_map(
                |(actor_idx, material_idx, status)| Command::SetMaterialStatus {
                    actor_idx,
                    material_idx,
                    status,
                }
            ),
    ]
}

#[derive(Clone)]
struct AbstractModel {
    upgrade_admin: Option<usize>,
    allowed_assets: BTreeMap<usize, bool>,
    materials: std::vec::Vec<(usize, MaterialStatus)>, // creator_idx, status
}

impl AbstractModel {
    fn new() -> Self {
        Self {
            upgrade_admin: None,
            allowed_assets: BTreeMap::new(),
            materials: std::vec::Vec::new(),
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(std::env::var("PROPTEST_CASES").unwrap_or_else(|_| std::string::String::from("256")).parse().unwrap_or(256)))]

    #[test]
    fn stateful_fuzz_material_registry(commands in proptest::collection::vec(command_strategy(), 1..100)) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, MaterialRegistry);
        let client = MaterialRegistryClient::new(&env, &contract_id);

        let actors: std::vec::Vec<Address> = (0..ACTOR_COUNT).map(|_| Address::generate(&env)).collect();
        let assets: std::vec::Vec<Address> = (0..ASSET_COUNT).map(|_| Address::generate(&env)).collect();

        let mut material_ids: std::vec::Vec<BytesN<32>> = std::vec::Vec::new();
        let mut model = AbstractModel::new();

        for cmd in commands {
            match cmd {
                Command::SetAssetAllowed { admin_idx, asset_idx, enabled } => {
                    let admin = &actors[admin_idx];
                    let asset = &assets[asset_idx];
                    let res = client.try_set_asset_allowed(admin, asset, &AssetKind::Token, &enabled);

                    if let Some(real_admin) = model.upgrade_admin {
                        if admin_idx == real_admin {
                            assert!(res.is_ok(), "Admin should be able to allow/disallow assets");
                            model.allowed_assets.insert(asset_idx, enabled);
                        } else {
                            assert!(res.is_err(), "Non-admin should not be able to set asset allowed");
                        }
                    } else {
                        // First registration sets admin
                        assert!(res.is_err(), "Cannot set asset allowed before admin is initialized");
                    }
                }
                Command::RegisterMaterial { creator_idx, asset_idx, price, payout_recipient_idx } => {
                    let creator = &actors[creator_idx];
                    let asset = &assets[asset_idx];
                    let payout_recipient = &actors[payout_recipient_idx];

                    let metadata_uri = String::from_str(&env, "ipfs://test");
                    let metadata_hash = BytesN::from_array(&env, &[1; 32]);
                    let rights_hash = BytesN::from_array(&env, &[2; 32]);

                    let mut quotes = Vec::new(&env);
                    quotes.push_back(AssetQuote { asset: asset.clone(), amount: price });

                    let mut payout_shares = Vec::new(&env);
                    payout_shares.push_back(PayoutShare { recipient: payout_recipient.clone(), share_bps: 10000 });

                    let res = client.try_register_material(
                        creator,
                        &metadata_uri,
                        &metadata_hash,
                        &rights_hash,
                        &quotes,
                        &payout_shares,
                    );

                    let mut expected_ok = true;
                    if price <= 0 { expected_ok = false; }

                    if expected_ok {
                        // If it's the first registration or admin is already set
                        if model.upgrade_admin.is_some() {
                            let is_allowed = model.allowed_assets.get(&asset_idx).copied().unwrap_or(false);
                            if !is_allowed { expected_ok = false; }
                        }
                    }

                    if expected_ok {
                        assert!(res.is_ok(), "Valid registration should succeed");
                        let id = res.unwrap();
                        material_ids.push(id.unwrap());
                        model.materials.push((creator_idx, MaterialStatus::Active));
                        if model.upgrade_admin.is_none() {
                            model.upgrade_admin = Some(creator_idx);
                        }
                    } else {
                        assert!(res.is_err(), "Invalid registration should fail");
                    }
                }
                Command::SetMaterialStatus { actor_idx, material_idx, status } => {
                    if material_idx >= material_ids.len() {
                        continue;
                    }
                    let actor = &actors[actor_idx];
                    let id = &material_ids[material_idx];

                    let res = client.try_set_material_status(actor, id, &status);
                    let (creator_idx, _current_status) = model.materials[material_idx];

                    #[cfg(not(feature = "seeded-defects"))]
                    {
                        let is_authorized = actor_idx == creator_idx || Some(actor_idx) == model.upgrade_admin;
                        if is_authorized {
                            assert!(res.is_ok(), "Authorized actor should be able to change status");
                            model.materials[material_idx].1 = status;
                        } else {
                            assert!(res.is_err(), "Unauthorized actor should fail to change status");
                        }
                    }
                }
            }
        }
    }
}

# Soroban Upgrade Pattern (EduVault)

This document defines the upgrade strategy used by EduVault Soroban contracts.

## Pattern Selected

EduVault uses **admin-gated Wasm hash replacement** through:

- `env.deployer().update_current_contract_wasm(new_wasm_hash)`

This keeps the **same contract ID and storage**, while updating executable logic.

## Security Controls

- `purchase-manager` stores a persistent `Admin` key during `initialize`.
- `material-registry` bootstraps `UpgradeAdmin` on first registration and allows controlled transfer via `set_upgrade_admin`.
- Upgrade entrypoints require:
  - explicit signer auth (`admin.require_auth()`)
  - persistent admin match checks (`NotAuthorized` on mismatch)

## State Compatibility Rules

To keep upgrades safe:

1. Never reorder or rename `DataKey` variants already in use.
2. Only append new variants and fields in backward-compatible ways.
3. Keep storage value layouts stable across upgrades.
4. Add migration hooks (if required) behind admin-only endpoints.

## Operational Rollout

1. Build and verify new Wasm in CI (`cargo test`, release build).
2. Run pre-upgrade checklist (state schema compatibility + tests).
3. Submit admin-authorized upgrade transaction with new Wasm hash.
4. Validate post-upgrade contract behavior using integration tests and read checks.

## Why This Approach

- No proxy indirection overhead.
- Contract ID remains stable for app integrations.
- Works with Soroban-native deployment flow.
- Enables future governance hardening (e.g., multisig admin account).

# Soroban Upgrade Pattern (EduVault)

This document defines the upgrade strategy used by EduVault Soroban contracts.

## Pattern Selected

EduVault uses **admin-gated Wasm hash replacement** through:

- `env.deployer().update_current_contract_wasm(new_wasm_hash)`

This keeps the **same contract ID and storage**, while updating executable logic.

## Implementation

### `purchase-manager`

```rust
pub fn upgrade(
    env: Env,
    admin: Address,
    new_wasm_hash: BytesN<32>,
) -> Result<(), PurchaseError> {
    auth::require_admin(&env, &admin)?;
    env.deployer().update_current_contract_wasm(new_wasm_hash);
    Ok(())
}
```

- The admin role is stored persistently during `initialize` (see `auth::has_admin_role`).
- `auth::require_admin` calls `caller.require_auth()` and then checks the caller holds the admin role, returning `NotAuthorized` on either failure.
- Only an admin account can invoke `upgrade`.

### `material-registry`

Uses the same pattern under a dedicated `UpgradeAdmin` key bootstrapped on first registration. The upgrade admin can be transferred via `set_upgrade_admin`.

## Security Controls

- Upgrade entrypoints require:
  - explicit signer auth (`admin.require_auth()` / `caller.require_auth()`)
  - persistent admin match checks (`NotAuthorized` on mismatch)
- Non-admin callers receive `PurchaseError::NotAuthorized` / `RegistryError::NotAuthorized`.
- `upgrade_rejected_for_non_admin` and `upgrade_requires_admin_auth` cover both properties for both contracts, in each contract's own `src/test.rs` (#677).

### What's not tested, and why (#677)

`state_preserved_after_upgrade` — proving stored data survives an actual Wasm swap — is **not** implemented. A real version of that test needs a second, already-compiled Wasm binary: `Deployer::update_current_contract_wasm` requires a hash already uploaded via `Deployer::upload_contract_wasm`, which performs a full parse-and-link pass and rejects anything that isn't a genuinely valid, linkable Soroban module. `env.register(ContractType, ())` — used by every other test in both files, for speed — registers the contract natively as a Rust type with no Wasm bytes in-process to reuse.

Getting a real second Wasm blob requires `soroban/build.sh` (or an equivalent step) to run *before* `cargo test`, producing a compiled artifact the test can pull in via `include_bytes!`. `soroban/run-tests.sh` currently runs bare `cargo test --lib` with no such prior build step. Until that pipeline change happens, this specific claim — "state preserved after an upgrade" — is architecturally asserted (storage isn't touched by `update_current_contract_wasm` itself; only the next invocation's executable changes) but not independently verified by a test in this repo.

## State Compatibility Rules

To keep upgrades safe:

1. Never reorder or rename `DataKey` variants already in use.
2. Only append new variants and fields in backward-compatible ways.
3. Keep storage value layouts stable across upgrades.
4. Add migration hooks (if required) behind admin-only endpoints.

## Operational Rollout

1. Build and verify new Wasm in CI (`cargo test`, release build) — see `.github/workflows/soroban-contract-tests.yml`. **As of this writing, `purchase-manager` fails both `cargo build --release` and `cargo test` on `main`** (pre-existing, unrelated to the upgrade pattern itself — see the note above and #677's PR for the specific errors); this CI job cannot currently pass on any PR touching `soroban/**` until that's fixed separately.
2. Run pre-upgrade checklist (state schema compatibility + tests).
3. Submit admin-authorized upgrade transaction with new Wasm hash.
4. Validate post-upgrade contract behavior using integration tests and read checks.

## Why This Approach

- No proxy indirection overhead.
- Contract ID remains stable for app integrations.
- Works with Soroban-native deployment flow.
- Enables future governance hardening (e.g., multisig admin account).

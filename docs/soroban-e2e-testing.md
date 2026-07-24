# Soroban end-to-end contract tests

Critical purchase tests must use a registered Stellar Asset Contract rather
than `MockAsset`. Mint through `StellarAssetClient`, authorize the buyer with a
precise `MockAuthInvoke` tree, and assert buyer, treasury, and escrow balances.
`mock_all_auths` is permitted for fixture administration but not for the
purchase invocation being tested.

Run `cargo test -p purchase-manager` from `soroban/`. CI should retain event
snapshots and budget snapshots so contract schema or resource regressions are
reviewed intentionally.

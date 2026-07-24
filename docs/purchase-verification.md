# Purchase verification

The purchase API grants entitlements only after `getTransaction` reports a
successful, finalized transaction and the configured PurchaseManager emits a
matching `purchase.completed` event. The event must bind the authenticated
wallet, material id, quoted asset, and exact integer amount.

Signed XDR is deliberately not accepted as settlement evidence. `NOT_FOUND`
is returned as pending, failed transactions and mismatched events are rejected,
and the normalized ledger receipt is stored with the purchase for audit. A
transaction hash remains the idempotency/replay key; deployments should retain
the existing unique purchase indexes during migration.

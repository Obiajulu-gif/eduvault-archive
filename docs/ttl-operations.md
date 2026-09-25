# Soroban Storage TTL: Renewal, Maintenance & Restoration (#464)

This document is the operator reference for the TTL (time-to-live) renewal policy implemented in `material-registry` and `purchase-manager`. It covers why the policy exists, what runs automatically, what an operator needs to run on a schedule, and how to recover a record that lapses anyway.

---

## 1. The problem

Every Soroban persistent ledger entry has an independent TTL. When it reaches zero the entry is **archived** — reads and writes against it fail at the host level until it is explicitly **restored** (a paid, client-side operation). Neither contract extended any TTL before #464, so registry records, allowlists, entitlements, and escrow were all exposed to this on a long enough timeline, with no maintenance path to prevent it.

The risk isn't uniform. Some records get "renewed for free" just by being used; others — most importantly a purchase's `Entitlement` and `Escrow` — can sit completely untouched for as long as a buyer doesn't come back, while still being the thing gating their paid access or holding their creator's payout.

---

## 2. Storage tiers

| Tier | Keys | Storage | Renewal |
|---|---|---|---|
| A — critical singletons | `UpgradeAdmin` (registry); `PlatformConfig`, `PurchaseNonce`, `PendingAdmin` (purchase-manager) | `instance()` | Extended on every touch of any of these keys — in practice, on almost every contract call. Instance TTL covers all instance-stored keys in one call. |
| B — policy/allowlist | `AllowedAsset` (both contracts); `CreatorTier`, `auth::AdminRole` (purchase-manager) | `persistent()` | Extended on every read and write, plus covered by a maintenance sweep. |
| C — hot per-entity | `MaterialCore` / `MaterialSale`, `CreatorNonce` (registry) | `persistent()` | Extended on every read and write (a purchase attempt reads these), plus a maintenance sweep for long-tail materials nobody's buying. |
| D — cold per-transaction, highest stakes | `Entitlement`, `Escrow` (purchase-manager) | `persistent()` | Extended on every read and write. A buyer accessing their purchased material renews their own entitlement for free. Backstopped by a maintenance sweep for entitlements/escrows nobody's re-checked. |

Renewal policy for every persistent key: when its remaining TTL drops below half of the network's current maximum (`env.storage().max_ttl()`), extend it back out to that maximum. This is `extend_persistent_ttl`/`extend_instance_ttl` in each contract's `lib.rs`.

---

## 3. What runs automatically (no operator action)

Nothing extra to do here — this is just "use the contract normally":

- Any call that touches `UpgradeAdmin` / `PlatformConfig` / `PurchaseNonce` / `PendingAdmin` renews the whole instance.
- `get_material` / a purchase attempt renews `MaterialCore`, `MaterialSale`, `AllowedAsset`, `CreatorTier`.
- `has_entitlement` / `get_entitlement` / `get_escrow_record` — i.e. a buyer accessing their content, or anyone querying an escrow — renew those specific records.

This covers everything that's actively being used. It does **not** cover records nobody is touching — that's what the maintenance entrypoints are for.

---

## 4. Maintenance entrypoints (run on a schedule)

Each entrypoint is **permissionless** (pure keep-alive, no business-state mutation — safe for anyone to call, including a third-party keeper) and **cursor-based**: pass the cursor you got back last time to resume where you left off. `limit` is clamped server-side to `MAX_MAINTENANCE_BATCH` (25 in both contracts) regardless of what you request, so a single call can never exceed the network's per-invocation footprint limit — verified directly by `extend_materials_ttl_is_cursor_based_and_bounded` and `extend_purchases_ttl_is_cursor_based_and_bounded` in each contract's test suite.

**material-registry**
- `extend_materials_ttl(cursor, limit) -> next_cursor` — renews `MaterialCore` + `MaterialSale` for a page of materials.
- `extend_asset_policy_ttl(cursor, limit) -> next_cursor` — renews the asset allowlist.

**purchase-manager**
- `extend_purchases_ttl(cursor, limit) -> next_cursor` — renews `Escrow` + `Entitlement` together for a page of purchases. **This is the highest-priority one to schedule** — it's the entrypoint protecting paid access and escrowed funds.
- `extend_allowed_asset_ttl(cursor, limit) -> next_cursor`
- `extend_creator_tier_ttl(cursor, limit) -> next_cursor`
- `extend_admin_role_ttl(cursor, limit) -> next_cursor`

### Renewal cadence

Run a full pass (looping calls until `next_cursor` stops advancing, then wrapping back to cursor `0`) at an interval no longer than:

```
network min_persistent_entry_ttl  ×  0.5   (safety margin)
```

The natural operator for this is a scheduled job in the off-chain indexer (`scripts/run-stellar-indexer.mjs` / `src/lib/indexer`, #257), since it already tracks every material and purchase id and is the logical place to add a keeper loop. It is not yet wired up as of this PR — this doc is the contract-side half of that follow-up.

### Alert thresholds

Alert if either of these is true for any record a monitoring pass cares about:
- Remaining TTL on a spot-checked key falls below `MAX_MAINTENANCE_BATCH`-sized-sweep-interval worth of ledgers (i.e. the maintenance job is running behind schedule).
- A maintenance call's returned cursor stops advancing on repeated calls with the same `cursor`/`limit` inputs (indicates the index count itself may not be growing as expected, or all remaining slots are pointing at already-archived data — see restoration below).

---

## 5. Restoration, when something lapses anyway

If maintenance genuinely stops running for the network's full max-TTL window, a persistent entry can still archive. This is a real possibility the design accepts rather than hides (see the design proposal for #464) — it is **not** something contract code can detect or fix on its own:

- Reading or writing an archived entry traps at the host/VM layer *before* any contract logic (including a plain `Option`/`Result` check) runs. There is no graceful in-contract fallback.
- The maintenance sweeps `has()`-check before extending, so one archived slot is skipped rather than aborting the rest of the batch — but that skip is a signal, not a fix.

**To restore an archived entry:** the client (wallet SDK / any tool constructing the transaction) must include a `RestoreFootprintOp` for the specific ledger key(s) in the transaction's footprint, before or alongside the operation that needs to read it. This pays a fee proportional to the entry's size and resets its TTL. This is standard Stellar SDK functionality (e.g. `stellar-sdk`'s `Operation.restoreFootprint()` plus a simulate-then-restore flow) — it is not something either contract exposes as a custom entrypoint, because it isn't a contract-level operation.

Practical flow when a call fails with an archived-entry error:
1. Simulate the failing transaction against RPC to confirm the failure is footprint/archival-related (not a genuine contract error).
2. Build and submit a restoration transaction for the affected key(s).
3. Retry the original operation.

---

## 6. Reference: DataKey inventory

See the `DataKey` enum (and, in purchase-manager, `auth::AuthDataKey`) in each contract's `lib.rs` for the authoritative, commented list — every variant is annotated with which tier it belongs to and why.

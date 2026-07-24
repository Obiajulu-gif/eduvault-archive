# Immutable Double-Entry Ledger and Stellar Reconciliation

Issue #28. This subsystem introduces an append-only accounting ledger that
proves EduVault's money-related views reconcile against Stellar settlement and
the operational collections, so reprocessing events or changing business rules
can never silently alter balances, duplicate revenue, or produce creator
statements that disagree with the chain.

Location: `src/lib/ledger/`.

## Design principles

- **Integer stroop math, never floating point.** Every amount is a BigInt count
  of stroops (7 fractional digits, matching Stellar). Decimal input is parsed
  straight into integer stroops (`money.js`); over-precise, scientific-notation,
  and non-integer numeric inputs are rejected. Amounts persist as base-10
  strings.
- **Balanced per asset.** A journal transaction is a set of debit/credit lines
  that must sum equal, per asset (`journal.assertBalanced`). Unbalanced sets are
  rejected at construction.
- **Immutable.** Posted transactions are frozen. There is no update or delete of
  posted history in either repository. Corrections are new **reversal**
  (direction-swapped) or **adjustment** (manual balanced) transactions.
- **Idempotent.** Every posting has a deterministic key derived from
  `(network, txHash, opIndex, eventType)`. Off-chain events require an explicit
  `businessRef`. Re-posting the same source event is a no-op.
- **Derived, not counted.** Creator earnings, platform revenue, refund
  liabilities, and available/pending balances are computed from the immutable
  lines (`balances.js`), never from mutable counters.
- **Versioned posting rules.** The rule version that produced a transaction is
  stored on it, so changing fee/discount/payout policy never re-interprets
  history (`postingRules.js`).

## Chart of accounts

| Account | Type | Normal side |
| :--- | :--- | :--- |
| `settlement` | asset | debit |
| `creator_payable` (per-creator subaccount) | liability | credit |
| `platform_fee_revenue` | revenue | credit |
| `refunds_payable` | liability | credit |
| `platform_discount_expense` | expense | debit |

## Posting rules

- **Purchase `purchase.v1-net-fee`**: fee charged on the discounted (net) price.
  `settlement += net`, `platform_fee_revenue += fee`, `creator_payable += net - fee`.
- **Purchase `purchase.v2-platform-discount`**: platform funds the discount;
  creator is paid on gross and the discount is booked as expense.
- **Refund `refund.v1-proportional`**: proportional clawback of proceeds and fee
  for the refunded amount; the flooring remainder (dust) stays with the platform
  fee so `proceeds_portion + fee_portion == refund_amount` exactly. The credit
  goes to `settlement` when already paid on-chain, or `refunds_payable` when
  accrued but not yet settled.

Fee division floors and returns its remainder (`money.mulDivFloor`), so value is
conserved: `settlement in == fee + proceeds`. Note that many small partial
refunds can move a few stroops of rounding dust between `platform_fee_revenue`
and `creator_payable`; the ledger stays globally balanced
(`platform_revenue + creator_earnings == settlement`) and reconciliation only
flags material drift.

## Reconciliation (`reconciliation.js`)

`reconcile()` matches settlement-affecting ledger transactions to finalized
Stellar operations by source identity and classifies divergence:
`missing_in_ledger`, `missing_on_chain`, `amount_mismatch`, `duplicate_in_ledger`,
`unverifiable`. It returns replay candidates; because posting is idempotent,
re-posting a missing entry cannot duplicate an existing one.

## Backfill (`backfill.js`)

`runBackfillBatch()` posts legacy purchases in deterministic, checkpointed
batches so a crash resumes without reprocessing. `dryRun` reports what would be
posted without writing. Rows missing an amount, asset, creator, or settlement
hash are flagged **ambiguous** and never guessed.

## Periods (`period.js`)

`closePeriod()` snapshots balances as of a boundary and hashes them; the digest
is reproducible from the immutable log (`verifySnapshot`). After a close,
`detectLateEvents()` surfaces transactions whose business time falls inside the
closed period but which posted after the close, so they are handled with a
visible adjustment rather than a silent restatement.

## Repositories

- `InMemoryLedgerRepository` — synchronous, append-only, idempotent. Used by
  tests and local dev.
- `MongoLedgerRepository` — same contract, backed by `ledger_transactions` (with
  a unique index on `idempotencyKey`), `ledger_checkpoints`, and
  `ledger_period_snapshots`. Duplicate-key inserts are idempotent no-ops.
  Construction opens no connection.

## Integration

`service.js` exposes `recordPurchase`, `recordRefund`, `recordRefundSettlement`,
and `recordReversal`, each taking a Mongo `Db` explicitly. Call them from the
purchase/refund flows (ideally in the same session/transaction as the
operational write). Run `ensureLedgerIndexes(db)` once during migration. Wiring
the live analytics reads (`src/lib/analytics`, `src/app/api/creator/analytics`,
`src/app/api/purchase`) to derive from the ledger is the follow-up rollout;
the derivation functions in `balances.js` are the drop-in source.

## Tests

`src/lib/ledger/__tests__/`:

- `core.test.js` — money precision, balancing, idempotency keys, immutability,
  reversal, posting rules, derivation.
- `properties.test.js` — fast-check invariants: decimal round-trip, division
  conserves value, purchases always balance, and a purchase followed by
  arbitrary partial refunds keeps a zero trial balance with
  `revenue + earnings == settlement`.
- `subsystems.test.js` — reconciliation classifications and replay, backfill
  checkpoint/restart/dry-run/ambiguous, reproducible period snapshots and late
  events, append-only repository.
- `scenarios.test.js` — end-to-end purchase/refund, duplicate and out-of-order
  idempotency, multi-asset independence, reversal to zero, available vs pending,
  concurrent posting.

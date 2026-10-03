# Balance Reconciliation

Read-only reconciliation between the ledger (source of truth), the database
projections, and the cached user-facing balances. It produces a dry-run report
of drift; it **never mutates data** and never auto-repairs.

Issue: [#783](https://github.com/Obiajulu-gif/eduvault-archive/issues/783).

## Invariants

For every `account` / `asset` pair there is one authoritative net amount. It
can be derived independently from three views:

1. **Ledger** — the append-only journal (`src/lib/backend/creatorJournal.js`,
   `src/lib/backend/auditLedger.js`). Net = credits − debits.
2. **Database projections** — materialised rows such as `purchases` /
   `payouts` that reference a ledger entry.
3. **User-facing balances** — cached balances shown in the UI.

The invariants the reconciler checks:

- Every ledger entry has exactly one database projection.
- Every database record references an existing ledger entry.
- A ledger/operation id is unique in both the ledger and the projections.
- Pending projection rows progress within their stale threshold; cached
  balances are refreshed alongside the ledger head.
- Ledger net == database net == user-facing balance for each account/asset.

## Reading the report

The report groups findings into four categories (the same shape used by the
[data integrity monitor](./data-integrity-monitor.md)):

| Category | Meaning |
| --- | --- |
| `missing` | A ledger entry has no database projection, or a projection references an absent ledger entry. |
| `duplicate` | A ledger id or ledger reference appears more than once in a view. |
| `stale` | A pending projection or a cached balance has not progressed within its threshold. |
| `inconsistent` | Ledger, database, and user-facing balances disagree on the net amount; or a matched row disagrees on amount/asset/account. |

Each finding carries the ids/amounts (`ledger`, `db`, `balance`) and a
human-readable `repairHint`. Categories are always present (count `0` when
clean) so downstream tooling can rely on a stable shape. Findings are ordered
by category, then kind, then id, so two runs over the same inputs produce an
identical report.

## Running (dry-run only)

The reconciler is pure and accepts injected inputs, so it runs in CI without a
database. The CLI reads a JSON snapshot or, when `MONGODB_URI` is set, the
collections directly — both read-only.

```bash
# From a JSON fixture (no database required)
node scripts/reconcile-balances.mjs --input fixtures/recon.json

# Structured JSON report (CI-friendly)
node scripts/reconcile-balances.mjs --input fixtures/recon.json --json

# Against a live replica, read-only
MONGODB_URI="mongodb://..." node scripts/reconcile-balances.mjs
```

Exit code is `0` when clean and `1` when drift is found.

Input JSON shape:

```json
{
  "ledgerEntries": [ { "id": "led-1", "account": "alice", "asset": "USDC", "amount": 100, "timestamp": "2026-01-01T12:00:00Z" } ],
  "dbRecords":     [ { "id": "db-1", "ledgerId": "led-1", "account": "alice", "asset": "USDC", "amount": 100, "status": "confirmed", "updatedAt": "2026-01-01T12:00:00Z" } ],
  "userBalances":  [ { "account": "alice", "asset": "USDC", "balance": 100, "updatedAt": "2026-01-01T12:00:00Z" } ]
}
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | — | Enables reading from MongoDB when `--input` is not used. |
| `MONGODB_DB` | `eduvault` | Database name. |
| `RECON_LEDGER_COLLECTION` | `creator_journal` | Ledger collection. |
| `RECON_DB_COLLECTION` | `purchases` | Projection collection. |
| `RECON_BALANCE_COLLECTION` | `user_balances` | Cached user-balance collection. |
| `RECON_STALE_PENDING_HOURS` | `24` | Pending projection stale threshold. |
| `RECON_STALE_SNAPSHOT_HOURS` | `1` | Cached-balance freshness threshold relative to the ledger head. |
| `RECON_NOW` | current time | ISO clock override for deterministic runs. |

## Repair guidance

The reconciler is **diagnostic only**. Take a backup, rehearse on a restore,
and repair through the owning domain path — never by editing derived documents
by hand. `repairGuidance` mirrors the table below; every finding also embeds a
specific hint.

| Category | Likely cause | Remediation |
| --- | --- | --- |
| `missing` | A projection write failed/was skipped, or the ledger entry was pruned/rolled back. | Backfill the projection from the ledger. If the *ledger* entry is absent, first confirm whether it was pruned or rolled back — do not invent a ledger row. |
| `duplicate` | A retry that bypassed the idempotency key, or a partial migration. | Keep the canonical row (lowest sequence), merge references onto it, then enforce the unique index. Leave the ledger entry intact. |
| `stale` | A stalled confirmation path or a cache that stopped refreshing. | Investigate the confirmation/worker backlog and re-run the payment reconciler (`src/lib/purchases/paymentReconciler.js`); rebuild cached balances from the ledger. Do not mark a purchase confirmed without ledger proof. |
| `inconsistent` | A partial write, a dropped field, or a code path that skipped validation. | Treat the ledger as the source of truth, correct the projection via the domain repair path, then rebuild the cached balance. Fix the producer so it cannot recur. |

## Tests

Fixture-driven tests live in
[`src/lib/reconciliation/__tests__/balanceReconciler.test.js`](../src/lib/reconciliation/__tests__/balanceReconciler.test.js).
They cover the four drift categories, a clean run, and read-only/deterministic
behaviour:

```bash
npx vitest run src/lib/reconciliation/__tests__/balanceReconciler.test.js
```

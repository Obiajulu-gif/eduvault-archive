# Source-of-Truth vs Projection Reconciliation Runbook (#963)

## Overview
EduVault maintains derived read projections and bounded caches (such as `entitlement_cache` and `search_index`) to maximize query throughput and lower latencies. Over time, asynchronous processing interruptions, outbox lag, network blips, or manual emergency database interventions can introduce drift between primary source-of-truth collections and these projections.

This reconciliation service continuously detects discrepancies, categorizes root-cause hints, and provides a guaranteed **dry-run-first** repair workflow.

## Monitored Projections

| Domain | Primary Source of Truth | Cached / Derived Projection | Drift Risk |
|---|---|---|---|
| **Entitlements** | `purchases` | `entitlement_cache` | Missing active access, revoked purchase still marked active |
| **Search / Catalog** | `materials` | `search_index` | Missing public items, revoked/archived items still visible in search |
| **Creator Earnings** | `creator_journal` (ledger) | `user_balances` / projections | Stale payout calculations or double-counted entries |

## Drift Taxonomy & Root-Cause Hints

1. **`MISSING_PROJECTION`**:
   - *Condition*: Primary record exists and is active, but missing from projection collection.
   - *Root Cause Hint*: Event lost or delayed during outbox asynchronous fanout; primary write succeeded but projection worker was interrupted.
   - *Repair Action*: `UPSERT_PROJECTION`.
2. **`ORPHAN_PROJECTION`**:
   - *Condition*: Projection entry exists, but primary record has been deleted, archived, merged, or revoked.
   - *Root Cause Hint*: Primary source record was soft-deleted, revoked, or archived directly bypassing projection invalidation hooks.
   - *Repair Action*: `PRUNE_ORPHAN`.
3. **`STALE_PROJECTION`**:
   - *Condition*: Projection version or timestamp is behind primary source of truth.
   - *Root Cause Hint*: Projection update lagged behind primary transaction or failed on optimistic concurrency retry; clock skew or TTL misconfiguration.
   - *Repair Action*: `RESYNC_FIELDS`.
4. **`DATA_DIVERGENCE`**:
   - *Condition*: Critical state fields mismatch (e.g. `settlementState` is Refunded in SoT, but cache still claims active).
   - *Root Cause Hint*: Discrepancy in critical fields; possible race condition or unhandled refund/dispute transition.
   - *Repair Action*: `RESYNC_FIELDS`.

## Operational Workflow

### 1. Verification / Dry-Run (Default)
By default, the job executes in dry-run mode and never mutates data:
```bash
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/reconcile-projections.mjs --scope=all
```
Output:
```
=== Projection Reconciliation Report ===
Mode:            DRY-RUN (Safe, no writes)
Scope:           all
Drift Detected:  3
  - Missing:     1
  - Orphan:      1
  - Stale:       0
  - Divergence:  1

Discrepancies:
- [ENTITLEMENTS] MISSING_PROJECTION on mat-1:gbuyer1
  Action: UPSERT_PROJECTION
  Root Cause Hint: Event lost or delayed during outbox asynchronous fanout...
```

### 2. Repair Execution
To apply idempotent repairs, supply `--execute`:
```bash
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/reconcile-projections.mjs --execute --scope=all
```
All executed mutations are recorded to `auditLedger` (`reconciliation.projections_repaired`).

### 3. Edge Cases & Invariants
- **Fails Closed**: If the database connection drops or queries fail, the reconciler aborts without partial corruptions.
- **Idempotent**: Re-running the execution multiple times produces the same clean state.
- **Zero Downtime**: Repairs are non-blocking atomic upserts and prunes per document.

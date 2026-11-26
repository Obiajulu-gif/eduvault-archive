# Dry-run repair plans with checkpoints (#1084)

`runResumableRepair` and `scripts/repair-materials.mjs` (#886) could preview a
repair, but nothing tied what an operator *reviewed* to what was later
*written*. An apply run re-detected issues against live data, overwrote fields
without checking they were unchanged, and kept no before-image to roll back
from.

Repair plans split a repair into three resumable phases:

```
planRepair ──► (operator reviews report + planHash) ──► applyRepairPlan ──► rollbackRepairPlan (if needed)
```

Implementation: [`src/lib/maintenance/repairPlan.js`](../src/lib/maintenance/repairPlan.js).
Material rules: [`src/lib/maintenance/materialRepairRules.js`](../src/lib/maintenance/materialRepairRules.js).

## Phases

| Phase | Writes to target? | Checkpoint | Idempotency |
| --- | --- | --- | --- |
| `planRepair` (dry-run) | Never | `repair_plans.checkpoint.lastScannedId` after every batch | Item ids are `<planId>:<targetId>` (upsert). Re-running a finished plan returns the stored report. |
| `applyRepairPlan` | Compare-and-set per item | Item `status` (`pending` → `applied` / `skipped_stale` / `failed`) | Items already holding their after-values are marked applied. Failed items are retried until `maxAttempts`. |
| `rollbackRepairPlan` | Compare-and-set per item | Item `status` (`applied` → `rolled_back` / `rollback_conflict`) | Re-running skips restored items. |

### What a plan item stores

```json
{
  "_id": "plan-2026-11-19:\"mat-5\"",
  "planId": "plan-2026-11-19",
  "targetId": "mat-5",
  "changes": [
    { "field": "storageKey", "beforeExists": false, "before": null, "afterExists": true, "after": "ipfs://e" },
    { "field": "visibility", "beforeExists": true, "before": "private", "afterExists": true, "after": "public" }
  ],
  "guards": [{ "field": "fileUrl", "exists": true, "value": "ipfs://e" }, { "field": "price", "exists": true, "value": 0 }],
  "reason": "missing-storage-key,private-without-price",
  "status": "pending",
  "attempts": 0
}
```

- `changes` are exact per-field before/after values, so the change can be
  applied and reversed field by field.
- `guards` are fields the rule *read* to decide (e.g. `price` for "private
  without a price"). They are pinned too: if a creator sets a price after the
  dry-run, the item is skipped as stale instead of forcing the listing public.
- `planHash` is a SHA-256 over all items (`targetId`, `changes`, `guards`).
  `applyRepairPlan` requires the hash the operator reviewed, so a plan cannot
  be changed between review and apply.

## Authorization

- By default every phase requires the `operations:repair` permission. Admins
  hold it through `*`. The actor must carry an id, because every write is
  attributed (`createdBy`, `appliedBy`, `rolledBackBy`).
- An explicit `authorize(actor)` callback can be passed instead, using the same
  contract as `runResumableRepair`.
- `requireSeparateApprover: true` enforces four-eyes: the plan author may not
  apply their own plan.
- The CLI treats the database credential in `MONGODB_URI` as its authorization
  boundary. `--operator <id>` (or `REPAIR_OPERATOR`) is still mandatory so runs
  are attributable.

## Operator runbook (materials)

```bash
export MONGODB_URI=... REPAIR_OPERATOR=ops-jane

# 1. Dry-run. Resumable: re-run the same command after an interruption.
node scripts/repair-materials.mjs --plan mat-repair-2026-11-19

# 2. Review the report: counts, samples, planHash.
node scripts/repair-materials.mjs --plan-status mat-repair-2026-11-19

# 3. Apply exactly what was reviewed. Re-run to resume or retry failures.
node scripts/repair-materials.mjs --apply-plan mat-repair-2026-11-19 --plan-hash <planHash>

# 4. If needed, roll back.
node scripts/repair-materials.mjs --rollback-plan mat-repair-2026-11-19 --reason "rule too broad"
```

The legacy direct mode (`--apply`, `--target`) is unchanged.

## Audit

Through `appendAuditRecord` (hash-chained ledger), with deterministic operation
ids so retries do not duplicate entries:

| Action | When |
| --- | --- |
| `repair.planned` | Dry-run finished (includes `planHash`, counts, rule version) |
| `repair.apply_started` | Before the first write. **Fail closed:** if the ledger is unavailable, nothing is written. |
| `repair.applied` | Apply finished (`success` or `partial`) |
| `repair.rollback_started` / `repair.rolled_back` | Rollback started / finished |

Per-record evidence (exact before/after values) lives in `repair_plan_items`.

## Edge cases and failure modes

| Situation | Behaviour |
| --- | --- |
| Dry-run interrupted (crash, deploy, `maxBatches`) | Status stays `planning`. Re-run `planRepair` with the same `planId` to continue from the checkpoint. The resulting plan hash equals an uninterrupted run. |
| Crash between writing items and the checkpoint | Items are upserted by deterministic id, so the re-scan rewrites the same items. No duplicates. |
| Same `planId` reused with a different collection or query | `409 REPAIR_PLAN_CONFLICT`. Choose a new id. |
| Detector proposes `_id`, dotted paths, `$` keys, or both set and unset on one field | `400`. Nothing is planned for the run. |
| Record changed after the dry-run (planned field or guard) | Item is `skipped_stale`. The record is never overwritten. Plan ends as `partially_applied`. Create a new plan to re-evaluate. |
| Write fails (network, primary step-down) | Item is `failed` with `lastError` and is retried on the next apply, up to `maxAttempts` (default 3). Plan stays `applying` while retries remain. |
| Crash after a record write, before its item update | On retry the CAS no longer matches, the record already holds the after-values, so the item is marked `applied` (counted as `alreadyApplied`). |
| Apply with the wrong or missing `planHash` | `409 REPAIR_PLAN_HASH_MISMATCH`. Nothing is written. |
| Apply before the dry-run finished | `409 REPAIR_PLAN_INCOMPLETE` |
| Record edited after the repair, then rolled back | Item becomes `rollback_conflict` and the record is untouched. Plan ends as `rolled_back_with_conflicts`. Reconcile those records by hand using the item's `changes`. |
| Field did not exist before the repair | Rollback `$unset`s it, restoring the original shape exactly. |

## Rollback and recovery

- **Undo a repair:** `rollbackRepairPlan` / `--rollback-plan`. It is
  conflict-safe and idempotent. It requires a reason.
- **Abandon a plan before applying:** do nothing. A `planned` plan never touches
  the target collection. Old plans can be deleted from `repair_plans` and
  `repair_plan_items` by `planId`.
- **Stop a running apply:** stop the process. Item status is the checkpoint, and
  the next apply resumes.

## Migration and compatibility

- New collections only: `repair_plans`, `repair_plan_items`. No indexes are
  required for correctness. For large plans, add
  `repair_plan_items: { planId: 1, status: 1 }`.
- `runResumableRepair`, `repairMaterial`, `findInconsistencies` and the legacy
  CLI flags keep their contracts.
- `scripts/repair-materials.mjs` fixes:
  - The missing `MongoClient` import, which made the CLI throw a `ReferenceError`.
  - The `isDirectCli` check, which also matched `repair-materials.test.mjs` and
    made that suite exit before running.
  - `auditRecordId`, which is now taken from the driver's `insertedId`.

## Verification

```bash
npx tsx --test tests/backend/repair-plan-checkpoints.test.mjs tests/backend/repair-materials.test.mjs
```

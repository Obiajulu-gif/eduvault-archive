# Restore Invariant Verification

`src/lib/ops/restoreVerification.js` + `scripts/verify-restore.mjs`

Companion to `scripts/restore-verification.mjs` (archive structure, required
fields, entitlement decisions — issue #715). This layer catches the restores
that *pass* that script but are still unsafe to promote:

1. **Derived-view invariants**
   - `entitlement_cache` must reconcile with completed `purchases`
     (every purchase has an active entry; no active entry without a completed
     purchase; no entry contradicting its purchase).
   - `material_search_documents` must reconcile with `materials` (searchable
     materials projected at their current version; non-searchable materials
     must not have a live projection).
2. **Index integrity** — every index in `REQUIRED_INDEXES` (and TTL index in
   `TTL_INDEXES`) exists. A restore that drops indexes still "works" until
   queries melt down under load.
3. **Audit-chain integrity** — the hash-chained `audit_ledger` verifies from
   sequence 0 with no gaps. A break is evidence of tampering or a partial
   restore and is never auto-repaired.

Every violation maps to an explicit repair step (`buildRepairSteps`), printed
with the exact command to run. `runRestoreVerification` returns
`{ ok, violations, checks, metrics, repairSteps }`; `ok === false` must block
promotion.

## Usage

```bash
# Read-only verification (safe on a restored snapshot):
MONGODB_URI="$STAGING_URI" npm run verify:restore

# Rebuild derived views + recreate missing indexes, then re-verify:
MONGODB_URI="$STAGING_URI" node scripts/verify-restore.mjs --repair
MONGODB_URI="$STAGING_URI" node scripts/verify-restore.mjs --repair=entitlements
MONGODB_URI="$STAGING_URI" node scripts/verify-restore.mjs --repair=search
MONGODB_URI="$STAGING_URI" node scripts/verify-restore.mjs --repair=indexes
```

| Option / env | Default | Meaning |
| --- | --- | --- |
| `--repair[=all\|entitlements\|search\|indexes]` | none | Apply scoped repairs, then re-verify |
| `--sample-limit=N` | 25 | Violation samples per check |
| `--max-scan=N` | 5000 | Materials scanned for projection drift |
| `--ignore-collection=NAME` | — | Skip a collection (repeatable, for fresh deploys) |
| `DRY_RUN=true` | — | `--repair` computes but does not write |
| `MONGODB_URI`, `MONGODB_DB` | —, `eduvault` | Connection settings |

Exit codes: `0` clean (or repaired and clean), `1` violations remain /
crash, `2` invalid `--repair` target.

Recommended DR pipeline position (see `docs/disaster-recovery.md` §5):

```
mongorestore → scripts/restore-verification.mjs → scripts/verify-restore.mjs → promote
```

## What each repair does

| Violation | Repair | Notes |
| --- | --- | --- |
| `entitlement_missing` / `_extra` / `_mismatched` | `--repair=entitlements` (or `scripts/rebuild-entitlement-cache.mjs --rebuild`) | Drops and rebuilds `entitlement_cache` from `purchases`. Destructive to the cache only — the cache is derived, so this is the designed recovery path. |
| `search_projection_missing` / `_stale` / `_unauthorized` | `--repair=search` | Idempotent reconciliation via `reconcileMaterialSearch`; projection versions only move forward; writes a reconciliation audit row. |
| `index_missing` / `ttl_index_missing` / `collection_missing` | `--repair=indexes` | Creates **only** the missing indexes from the registry. Never run `scripts/setup-db-indexes.js` on a restored production DB — it also seeds sample marketplace data. |
| `audit_chain_broken` | none (manual) | Preserve `audit_ledger` + `audit_checkpoints` as evidence; investigate from `brokenAtSequence`. Restoring an older snapshot over a valid chain or editing records both show up here. |

## Operational edge cases

| Case | Behaviour | Operator note |
| --- | --- | --- |
| Fresh/empty deployment | Collections may legitimately not exist | Use `--ignore-collection` or expect `collection_missing` violations |
| Huge `materials` collection | Search check scans up to `--max-scan` documents | Raise with `--max-scan=N` or accept the sample for a large fleet |
| Huge audit ledger | Verification caps at 100k records and reports `truncated: true` | The verified prefix is still meaningful; raise `auditLimit` in code for full-history drills |
| Cache rebuilt, versions differ | Rebuild sets `state: "finalized"`, `active: true`, `source: "restore-rebuild"` | The purchase route later re-derives per-entry state on read; cache is a fast path, not the truth |
| TTL collection not provisioned | TTL check is skipped for non-existent collections | Avoids false failures on new deployments |
| Outbox has expired leases | Reported as a metric, not a violation | Growing `expiredLeases` means workers are not running |

## Failure modes and diagnosis

- **Mismatches fail loudly**: violations print individually (capped sample) and
  every code has a repair command; the script exits 1 so a promotion pipeline
  halts.
- **Repairs that do not converge**: the script re-runs verification after
  repairs; if violations remain it exits 1 and lists the still-failing codes.
- **Audit-chain breakage**: deliberately not repairable — the chain is the
  evidence trail. Follow the printed investigation command.
- **Restore of an *older* snapshot**: expect `entitlement_extra` (cache rows
  for purchases not in the snapshot) and projection drift; repairs converge
  the derived views back to the snapshot's source data.

## Rollback / recovery

1. This tool is read-only unless `--repair` is passed; a failed verification
   leaves the database untouched.
2. Repairs touch derived collections only (`entitlement_cache`,
   `material_search_documents`, missing indexes). Source collections
   (`purchases`, `materials`, `audit_ledger`) are never rewritten.
3. If a repair makes things worse, re-run the same repair — all repairs are
   idempotent; or drop the derived collection and re-run
   `scripts/rebuild-entitlement-cache.mjs --rebuild`.
4. Keep the pre-repair report JSON (stdout is structured JSON lines) attached
   to the incident record; it is the evidence for the RPO/RTO review.

## Tests

`tests/backend/restoreInvariants.test.mjs` — missing/extra/mismatched
entitlements, missing/stale/unauthorized projections, missing required/TTL
indexes, scoped index repair, intact vs tampered audit chains, rebuild
convergence, and full-orchestration pass/fail-with-repair-steps behaviour.

Run: `npx tsx --test tests/backend/restoreInvariants.test.mjs`

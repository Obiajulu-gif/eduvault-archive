# Data Integrity Monitor

Read-only monitor that reports records violating core consistency rules for
EduVault's MongoDB collections. It is intended to run after a restore, after a
migration, or on a schedule as a safety check before promoting data to
production.

Issue: [#831](https://github.com/Obiajulu-gif/eduvault-archive/issues/831).

## What it checks

The monitor groups failures into five categories:

| Category | Meaning |
| --- | --- |
| `missing` | A row references a foreign key that does not exist (broken reference). |
| `orphaned` | A child/history row was left behind after its parent was deleted. |
| `duplicate` | Two or more rows violate a uniqueness invariant (wallet address, UUID). |
| `stale` | A row's timestamp/status shows it should have progressed but has not. |
| `inconsistent` | A row violates a data invariant (not a reference): missing creator, no storage key, entitlement without purchase, etc. |

The declarative rules live in [`scripts/lib/integrity-rules.mjs`](../scripts/lib/integrity-rules.mjs).

## Running the monitor

The monitor is **read-only by default and always** — the monitor code path
never writes to the database.

```bash
# Human-readable per-category report (default)
MONGODB_URI="mongodb://..." node scripts/integrity-monitor.mjs

# Structured JSON report (machine-readable, CI-friendly)
MONGODB_URI="mongodb://..." node scripts/integrity-monitor.mjs --json
```

Exit code is `0` when clean and `1` when any violation is found, so it can gate
CI or a deployment step.

The restore-validation entrypoint shares the same rules and can also emit the
category report:

```bash
# Full restore validation report (read-only)
MONGODB_URI="mongodb://..." node scripts/validate-restore-integrity.mjs

# Same checks, per-category JSON
MONGODB_URI="mongodb://..." node scripts/validate-restore-integrity.mjs --report-json
```

### Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | — (required) | MongoDB connection string. |
| `MONGODB_DB` | `eduvault` | Database name. |
| `INTEGRITY_STALE_PENDING_PURCHASE_HOURS` | `24` | A `pending` purchase older than this is stale. |
| `INTEGRITY_STALE_DEADLETTER_DAYS` | `7` | An unresolved dead-letter event older than this is stale. |
| `INTEGRITY_NOW` | current time | ISO timestamp treated as "now" (useful for deterministic runs/fixtures). |

## Report shape

`--json` / `--report-json` emits a stable structure. Every category is always
present (count `0` when clean) and includes sample document ids:

```json
{
  "timestamp": "2026-01-01T00:00:00.000Z",
  "readOnly": true,
  "clean": false,
  "totalChecks": 16,
  "passed": 13,
  "failed": 3,
  "categories": {
    "missing":      { "count": 1, "severityBreakdown": { "critical": 1 }, "checks": ["purchases_missing_material"], "sampleIds": ["..."] },
    "orphaned":     { "count": 0, "severityBreakdown": {}, "checks": [], "sampleIds": [] },
    "duplicate":    { "count": 0, "severityBreakdown": {}, "checks": [], "sampleIds": [] },
    "stale":        { "count": 1, "severityBreakdown": { "warning": 1 }, "checks": ["stale_pending_purchases"], "sampleIds": ["..."] },
    "inconsistent": { "count": 1, "severityBreakdown": { "critical": 1 }, "checks": ["purchase_without_buyer"], "sampleIds": ["..."] }
  }
}
```

## Remediation guide

The monitor **never repairs**. For each category, investigate the likely cause
first, then use the dedicated repair path. Always take a backup and rehearse on
a restore before touching production.

| Category | Likely cause | Remediation |
| --- | --- | --- |
| `missing` | A restore/migration copied child rows but not the referenced parent, or a parent was hard-deleted without cascading. | Re-import the missing parent, or decide the child is obsolete and remove it. Re-run the monitor. Never recreate a parent with a fresh `_id` — preserve the original id so references resolve. |
| `orphaned` | Intentional parent deletion (e.g. a taken-down material) left history/saves behind, or a partial migration. | For `material_history`/`saved_materials`, confirm whether retention policy requires keeping history. If not intentional, restore the parent or delete the orphan. Use the material repair tooling for canonical fixes. |
| `duplicate` | Repeated import, a race that bypassed the unique index, or a botched merge. | Identify the canonical row (oldest/most complete), merge its references onto it, delete the rest, then ensure the uniqueness index exists (`scripts/setup-db-indexes.js`). Re-run the monitor. |
| `stale` | A stalled background worker/indexer backlog, a stuck `pending` purchase, or an entitlement whose expiry was never reflected in the cache. | Inspect the indexer/worker backlog and unblock it. For dead letters use `node scripts/indexer-deadletter.mjs list`, then `retry`/`quarantine`. For the entitlement cache rebuild it from the source of truth with `node scripts/rebuild-entitlement-cache.mjs`. Adjust thresholds only when the current dwell time is expected. |
| `inconsistent` | A partial write, a migration that dropped fields, or a code path that skipped validation. | Repair the specific record through the owning domain script or API rather than editing documents by hand (e.g. `scripts/repair-materials.mjs` for materials). Confirm the migration/import that produced it is fixed so it cannot recur. |

### Read-only vs repair

- **Monitor / validation** (`scripts/integrity-monitor.mjs`,
  `scripts/validate-restore-integrity.mjs`): read-only. Safe to run any time,
  including against production replicas.
- **Repair**: use the domain-specific scripts referenced above. They are
  separate from the monitor on purpose so a read-only check can never mutate
  data. `validate-restore-integrity.mjs` accepts `--auto-repair` for CLI
  compatibility, but the validation path remains read-only; perform repairs via
  the dedicated scripts and re-run the monitor to confirm.

## Tests

Fixture-driven tests live in
[`tests/backend/integrity-monitor.test.mjs`](../tests/backend/integrity-monitor.test.mjs).
They seed fixtures that trigger every category and assert the monitor detects
each one and mutates nothing:

```bash
npx tsx --test tests/backend/integrity-monitor.test.mjs
```

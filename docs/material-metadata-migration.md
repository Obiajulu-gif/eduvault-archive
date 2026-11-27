# Versioned Material Metadata Migration & Rollback

## Overview

This subsystem provides a **versioned, snapshot-backed, rollback-safe migration engine** for material metadata (`metadataVersion` and `metadata.*`) in the `materials` collection.

- **Core engine:** [`src/lib/migrations/materialMetadataMigration.js`](../src/lib/migrations/materialMetadataMigration.js)
- **Admin API:** [`src/app/api/admin/migrations/material-metadata/route.js`](../src/app/api/admin/migrations/material-metadata/route.js)
- **CLI runner:** [`scripts/migrations/migrate-material-metadata.mjs`](../scripts/migrations/migrate-material-metadata.mjs)
- **Automated tests:** [`tests/backend/material-metadata-migration.test.mjs`](../tests/backend/material-metadata-migration.test.mjs)

---

## Contract Preservation & Migration Plan

Existing catalog contracts (`schemaVersion` v1/v2, `pricingTier`, `sorobanEntitlementConfig`, `rightsMetadata`, and top-level fields such as `title`, `price`, `category`, `subject`, `level`, `tags`) are **strictly preserved**:

1. **Additive Versioning:** Metadata migrations track their own monotonic integer `metadataVersion` (defaulting to `1` when absent) and write structured fields under `metadata.*` without mutating or deleting legacy top-level fields.
2. **Dual-Read Support:** `readMaterialMetadata(doc, { targetVersion })` projects legacy or unversioned documents to the requested metadata version in memory without mutating stored records.
3. **Version History:**
   - **v1 (Legacy / Unversioned):** Existing documents without `metadataVersion`.
   - **v2 (`v2_normalized_taxonomy_and_tags`):** Adds `metadata.tags` (deduplicated, trimmed lowercase), `metadata.language` (default `"en"`), and `metadata.taxonomy` (`{ category, subject, level }`).
   - **v3 (`v3_structured_licensing_and_checksum`):** Adds `metadata.licensing` (`{ licenseType, attributionRequired, commercialAllowed, distributionAllowed }`) and a deterministic SHA-256 `metadata.checksum`.
4. **Rollout Sequence:**
   - Run `--dry-run` to preview diffs and catch validation issues with zero database writes.
   - Execute forward migration in batches (`--target-version=3 --batch-size=100`).
   - Verify version distribution with `--status`.
   - If regressions appear, execute `--rollback --run-id=<runId>` to restore exact pre-migration document shapes.

---

## Authorization

All mutating and recovery operations (`migrate`, `rollback`, `retry`) enforce pre-flight authorization:

- **Engine / CLI:** `assertMetadataMigrationAuthorized(actor)` delegates to `checkDeploymentAuthorization`, permitting only `admin`, `deployer`, `release_engineer`, or explicit `system:migrate` / `system:release` permissions. Unauthorized callers receive `AppError("AUTH_FORBIDDEN")` (HTTP `403`) before any collection is accessed.
- **Admin HTTP API:** Enforces `requireAdmin(request)` (returns `401` if unauthenticated, `403` if authenticated without admin privileges).

---

## State Machine & Persistence

Migration runs and per-document snapshots are stored in:
- `material_metadata_migration_runs`
- `material_metadata_migration_snapshots` (keyed by `${runId}:${materialId}`)

| Run State | Meaning | Blocks New Runs? | Recovery Action |
| --- | --- | --- | --- |
| `running` | Forward migration actively executing | Yes (`409 CONFLICT_IN_PROGRESS`) | Wait for completion |
| `rolling_back` | Rollback actively executing | Yes (`409 CONFLICT_IN_PROGRESS`) | Wait for completion |
| `completed` | All eligible documents migrated | No | Optional explicit `rollback` |
| `failed` | Forward migration halted (`autoRollback: false`) | Yes (`409 CONFLICT_STATE`) | `retry` to resume or `rollback` to revert |
| `rolled_back` | All applied snapshots cleanly reverted | No | Safe to start a new run |
| `partially_rolled_back` | Rollback skipped documents with post-migration edits or deletions | Yes (`409 CONFLICT_STATE`) | Inspect conflicts; `retry` with `force: true` if overwrite is intended |
| `rollback_failed` | Transient/outage error interrupted rollback | Yes (`409 CONFLICT_STATE`) | Restore DB health, then `retry` the `runId` |

---

## Edge Cases & Recovery Behavior

1. **Mid-Batch Transform or Validation Failure:**
   - With `autoRollback: true` (default), every document already migrated in the run is automatically restored from its pre-migration snapshot (including removing `metadataVersion` / `metadata` keys that did not exist before).
   - With `autoRollback: false`, the run enters `failed` state, blocking new unrelated runs until an operator either calls `retryMaterialMetadataMigration` (resuming only remaining unmigrated documents) or `rollbackMaterialMetadataMigration`.
2. **Transient Database Failures:**
   - Individual document reads, snapshot writes, material replacements, and rollback restores are wrapped in bounded exponential backoff (`maxRetries`, `retryDelayMs`).
   - Validation errors and errors marked `retryable: false` fail fast without useless retries.
3. **Concurrent Post-Migration Edits (Drift Guard):**
   - Each snapshot records `postMigrationHash` (SHA-256 of `{ metadataVersion, metadata }` right after migration).
   - During rollback, if a material's metadata was modified after migration, rollback **refuses to silently overwrite** the newer edit, records a `metadata_modified_after_migration` conflict, and marks the run `partially_rolled_back`.
   - Operators can inspect conflicts and explicitly re-run rollback/retry with `force: true` to override.
4. **Deleted Documents During Rollback:**
   - If a migrated document was deleted before rollback, rollback records `document_deleted_after_migration` in `conflicts` instead of crashing or recreating a deleted listing.
5. **Idempotency:**
   - Re-invoking `migrateMaterialMetadata` with the `runId` of a `completed` run returns `{ replayed: true }` without rewriting documents.
   - Re-invoking `rollbackMaterialMetadataMigration` or `retryMaterialMetadataMigration` on a `rolled_back` (or `completed`) run is a safe no-op returning `{ replayed: true }`.
6. **Overlapping Runs:**
   - Concurrent forward runs are rejected with `CONFLICT_IN_PROGRESS`, and starting a new run while a previous run is unresolved (`failed`, `rollback_failed`, `partially_rolled_back`) is rejected with `CONFLICT_STATE`.

---

## Operator Runbook

### CLI Usage

```bash
# 1. Inspect current metadata version distribution
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/migrations/migrate-material-metadata.mjs --status --json

# 2. Preview migration without writing
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/migrations/migrate-material-metadata.mjs --dry-run

# 3. Execute forward migration to v3
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/migrations/migrate-material-metadata.mjs --target-version=3 --batch-size=100

# 4. Retry a failed migration or failed rollback
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/migrations/migrate-material-metadata.mjs --retry --run-id=<RUN_ID>

# 5. Explicitly roll back a completed or failed run
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/migrations/migrate-material-metadata.mjs --rollback --run-id=<RUN_ID>
```

### Automated Verification

```bash
node --test tests/backend/material-metadata-migration.test.mjs
```

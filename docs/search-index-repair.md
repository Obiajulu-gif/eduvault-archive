# Search-Index Repair for Archived and Permission-Changed Materials (#1181)

## Overview

Educational materials undergo lifecycle transitions (archived, restored, visibility changed to `private` or `restricted`, creator suspension, or content moderation).
If a background projection is delayed, dropped, or executed out-of-order, stale documents can remain exposed in `material_search_documents` — causing unauthorized listings or dead links to appear in public search.

The search-index repair engine (`src/lib/backend/searchIndexRepair.js`) and CLI tool (`scripts/repair-search-index.mjs`) provide automated detection, repair, retry, and rollback capabilities.

---

## Architecture & Repair Actions

The engine inspects both `material_search_documents` and the authoritative `materials` collection:

| Finding | Meaning | Action | State After Repair |
|---|---|---|---|
| `unauthorized` | An archived, private, restricted, deleted, or suspended material is present in search | `remove_unauthorized` | Projection deleted from `material_search_documents`; tombstone written to `material_search_tombstones`. |
| `orphan` | Search projection exists with no source document in `materials` | `remove_orphan` | Projection deleted; tombstone recorded to prevent resurrection. |
| `stale` | Projection version lags source `searchVersion`, or `projectedAt` exceeds `SEARCH_INDEX_MAX_AGE_MS` | `refresh_stale` | Document re-projected from authoritative `materials` collection. |
| `missing` | An active, public material has no projection in search | `index_missing` | New projection generated and indexed via `applyMaterialSearchProjection`. |

---

## CLI Usage

```bash
# 1. Dry run (default: inspect and report findings without database writes)
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/repair-search-index.mjs

# 2. Apply repairs
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/repair-search-index.mjs --apply

# 3. Target a single material ID
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/repair-search-index.mjs --target <materialId> --apply

# 4. Rollback a previous repair run
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/repair-search-index.mjs --rollback <runId>

# 5. Output JSON summary (for monitoring / alerts)
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/repair-search-index.mjs --json
```

Or via npm scripts:
```bash
npm run repair:search        # dry-run
npm run repair:search:apply  # apply
```

---

## Security & Authorization

- **Authorization check**: `validateRepairAuthorization(actor)` requires:
  - CLI execution (`{ isCli: true }`), or
  - Role: `admin`, `deployer`, `maintainer`, `release_engineer`, or
  - Permissions: `system:repair`, `admin:manage`, or `catalog:manage`.
- Unauthorized requests throw `AUTH_FORBIDDEN` (`403`) or `AUTH_UNAUTHENTICATED` (`401`) before any reads or writes.

---

## Reliability, Failure Handling & Retries

1. **Exponential Backoff**:
   - Individual document mutations are attempted with up to `maxRetries` (default 3) and exponential backoff to handle transient MongoDB connection drops.
2. **Quarantine / Failure Collection**:
   - If an item fails repeatedly, it is recorded in `material_search_repair_failures` with the error message and run context.
   - The job continues processing the remainder of the batch rather than aborting.
3. **Audit Trail**:
   - Every apply run records an entry in `material_search_repair_audit` with `runId`, `actor`, `scanned`, `repaired`, `actions`, and pre-repair snapshots (`previousState`).

---

## Rollback Behavior

- When `--rollback <runId>` is invoked, `rollbackSearchIndexRepair` retrieves the audit record:
  - If a projection was removed, the `previousState` is restored into `material_search_documents` and its tombstone is cleared.
  - If a projection was inserted, it is deleted.
- Rollbacks are idempotent and guard against duplicate execution (`CONFLICT` error if already rolled back).

---

## Edge Cases

- **Concurrent mutations**: If a material is updated while the repair is in-flight, `applyMaterialSearchProjection` utilizes monotonic version checks (`projectionVersion`) to ensure that a newer write cannot be overwritten by an older repair snapshot.
- **Permanent Legal Tombstones**: Materials with `legalTombstone: true` are permanently locked; repair will always tombstone them and block any resurrection attempts.

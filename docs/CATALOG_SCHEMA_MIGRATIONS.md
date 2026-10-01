# Zero-Downtime Catalog Schema Migration Framework

## 1. Problem & Architecture
The catalog collection (`materials`) is a high-traffic, read-heavy collection in EduVault. Running ad hoc, in-place migration scripts on live databases introduces read inconsistency and potential downtime.

To achieve **zero-downtime**:
1. **Document Versioning**: Every document includes a `schemaVersion` integer field (v1 for legacy unversioned documents, v2+ for migrated documents).
2. **Dual-Read Transition Window**:
   - `readCatalogMaterial(doc)`: Application readers transparently map pre-migration document shapes to post-migration shapes dynamically in-memory. If an in-flight backfill has not yet reached a document, the API layer still delivers the v2 schema shape.
3. **Dual-Write Concurrency**:
   - `prepareCatalogWrite(doc)`: New listings and updates created while a backfill is running are stamped with `schemaVersion: 2` and write both new fields and backward-compatible legacy fields.
4. **Resumable Batched Checkpointing**:
   - Migration jobs process unmigrated documents in discrete batches ordered by `_id`.
   - Checkpoints (`lastProcessedId`, `processedCount`) are saved to `migration_checkpoints`. Interrupted migrations resume from the exact checkpoint without skipping or duplicating documents.
5. **Documented Rollback Plan**:
   - Every migration defines a reversible `down(doc)` transformation.

> These catalog migrations are also the `materials` entry in the general
> [versioned record & API compatibility layer](SCHEMA_COMPATIBILITY.md), which
> adds read/write transforms, `X-Schema-Version` negotiation, and explicit
> unsupported-version handling on top of them.

---

## 2. Concrete Migration: v2 Soroban Entitlements & Pricing Tiers
- **Target Version**: 2
- **Fields Added**:
  - `pricingTier`: Categorized as `"free"`, `"standard"`, or `"premium"` based on asset valuation.
  - `sorobanEntitlementConfig`: Soroban smart contract identifier, standard (`SEP-0041`), and transferability flags.
  - `rightsMetadata`: Commercial usage, educational license flags.

---

## 3. Operations & Runbook

### Pre-Flight Dry Run
Validates document schemas against sample data without database writes:
```bash
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/migrations/migrate-catalog-collection.mjs --dry-run
```

### Run Migration
```bash
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/migrations/migrate-catalog-collection.mjs --batch-size=200
```

### Rollback Procedure
If unexpected regressions occur, execute rollback to safely restore the previous schema:
```bash
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/migrations/migrate-catalog-collection.mjs --rollback
```

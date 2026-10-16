/**
 * Snapshot restore verification for critical data and derived indexes.
 *
 * `scripts/restore-verification.mjs` (#715) already validates archive
 * structure, required fields, and entitlement decisions. This module covers
 * the gaps that let a *silently corrupted* restore pass those checks:
 *
 * 1. Derived-view invariants — the entitlement cache must reconcile with
 *    `purchases`, and the `material_search_documents` projection must
 *    reconcile with `materials`. A restore that rebuilt one but not the other
 *    serves stale access decisions or stale listings.
 * 2. Index integrity — `REQUIRED_INDEXES`/`TTL_INDEXES` are the registry the
 *    app's `ensureIndexes()` drives from; a restore that drops indexes still
 *    "works" until queries melt down under load.
 * 3. Audit-trail integrity — the hash-chained `audit_ledger` must verify from
 *    sequence 0 with no gaps; a broken chain is evidence of tampering or a
 *    partial restore and must fail loudly.
 *
 * Every violating check emits an explicit repair step (command + rationale)
 * so the operator never has to guess the remediation — see
 * `docs/restore-invariant-verification.md`.
 */

import { COLLECTIONS, REQUIRED_INDEXES, TTL_INDEXES } from "../backend/schemaContracts.js";
import {
  MATERIAL_SEARCH_COLLECTION,
  evaluateMaterialSearchAccess,
  getMaterialSearchVersion,
} from "../backend/materialSearchProjection.js";
import { readAuditRecords, verifyAuditRecords } from "../backend/auditLedger.js";
import { reconcileMaterialSearch } from "../backend/materialSearchProjection.js";

export const ACTIVE_PURCHASE_STATUSES = Object.freeze(["confirmed", "settled", "completed"]);

export const RESTORE_VIOLATION_CODES = Object.freeze({
  ENTITLEMENT_MISSING: "entitlement_missing",
  ENTITLEMENT_EXTRA: "entitlement_extra",
  ENTITLEMENT_MISMATCHED: "entitlement_mismatched",
  SEARCH_MISSING: "search_projection_missing",
  SEARCH_STALE: "search_projection_stale",
  SEARCH_UNAUTHORIZED: "search_projection_unauthorized",
  INDEX_MISSING: "index_missing",
  TTL_INDEX_MISSING: "ttl_index_missing",
  COLLECTION_MISSING: "collection_missing",
  AUDIT_CHAIN_BROKEN: "audit_chain_broken",
});

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function entitlementKey(buyerAddress, materialId) {
  return `${lower(buyerAddress)}::${String(materialId)}`;
}

/**
 * Invariant 1a: every completed purchase has an active entitlement, every
 * active entitlement traces back to a completed purchase, and no cache entry
 * contradicts its purchase.
 */
export async function verifyEntitlementDerivedView(db, { sampleLimit = 25 } = {}) {
  const source = new Map();
  const purchasesCursor = db.collection(COLLECTIONS.purchases).find({
    status: { $in: ACTIVE_PURCHASE_STATUSES },
    buyerAddress: { $exists: true },
    materialId: { $exists: true },
  });
  for await (const purchase of purchasesCursor) {
    source.set(entitlementKey(purchase.buyerAddress, purchase.materialId), {
      buyerAddress: lower(purchase.buyerAddress),
      materialId: String(purchase.materialId),
      purchaseId: purchase.purchaseId || String(purchase._id ?? ""),
      status: purchase.status,
    });
  }

  const missing = [];
  const extra = [];
  const mismatched = [];
  const cacheKeys = new Set();

  const cacheCursor = db.collection(COLLECTIONS.entitlementCache).find({});
  for await (const cached of cacheCursor) {
    const key = entitlementKey(cached.buyerAddress || cached.walletAddress, cached.materialId);
    cacheKeys.add(key);
    const sourceEntry = source.get(key);
    const isActive = cached.active !== false;

    if (!sourceEntry) {
      if (isActive) {
        extra.push({ key, buyerAddress: lower(cached.buyerAddress || cached.walletAddress), materialId: String(cached.materialId) });
      }
      continue;
    }

    if (!isActive) {
      mismatched.push({
        key,
        buyerAddress: sourceEntry.buyerAddress,
        materialId: sourceEntry.materialId,
        expected: true,
        actual: false,
        purchaseStatus: sourceEntry.status,
      });
    }
  }

  for (const [key, sourceEntry] of source) {
    if (!cacheKeys.has(key)) {
      missing.push({ key, buyerAddress: sourceEntry.buyerAddress, materialId: sourceEntry.materialId, purchaseStatus: sourceEntry.status });
    }
  }

  const violations = [
    ...missing.map((item) => ({ code: RESTORE_VIOLATION_CODES.ENTITLEMENT_MISSING, ...item })),
    ...extra.map((item) => ({ code: RESTORE_VIOLATION_CODES.ENTITLEMENT_EXTRA, ...item })),
    ...mismatched.map((item) => ({ code: RESTORE_VIOLATION_CODES.ENTITLEMENT_MISMATCHED, ...item })),
  ];

  return {
    check: "entitlement_derived_view",
    ok: violations.length === 0,
    sourceEntitlements: source.size,
    cachedEntries: cacheKeys.size,
    missing: missing.length,
    extra: extra.length,
    mismatched: mismatched.length,
    violations: violations.slice(0, sampleLimit),
  };
}

/**
 * Invariant 1b: the search projection reconcilies with `materials` —
 * searchable materials must be projected at their current version, and
 * non-searchable materials must not have a live projection.
 */
export async function verifySearchProjection(db, { sampleLimit = 25, maxScan = 5000 } = {}) {
  const violations = [];
  let scanned = 0;
  let missing = 0;
  let stale = 0;
  let unauthorized = 0;

  const materials = await db.collection(COLLECTIONS.materials).find({}).limit(maxScan).toArray();
  for (const material of materials) {
    scanned += 1;
    const materialId = String(material._id ?? material.materialId ?? "");
    if (!materialId) continue;
    const access = evaluateMaterialSearchAccess(material);
    const projection = await db.collection(MATERIAL_SEARCH_COLLECTION).findOne({ _id: materialId });

    if (!access.searchable) {
      if (projection) {
        unauthorized += 1;
        violations.push({
          code: RESTORE_VIOLATION_CODES.SEARCH_UNAUTHORIZED,
          materialId,
          reason: access.reason,
          projectionVersion: projection.projectionVersion ?? null,
        });
      }
      continue;
    }

    const expectedVersion = getMaterialSearchVersion(material);
    if (!projection) {
      missing += 1;
      violations.push({ code: RESTORE_VIOLATION_CODES.SEARCH_MISSING, materialId, expectedVersion });
    } else if (Number(projection.projectionVersion || 0) < expectedVersion) {
      stale += 1;
      violations.push({
        code: RESTORE_VIOLATION_CODES.SEARCH_STALE,
        materialId,
        expectedVersion,
        actualVersion: projection.projectionVersion ?? null,
      });
    }
  }

  return {
    check: "search_projection",
    ok: violations.length === 0,
    scanned,
    projectedOk: scanned - violations.length,
    missing,
    stale,
    unauthorized,
    violations: violations.slice(0, sampleLimit),
  };
}

function keyPatternTuple(keyPattern) {
  return Object.entries(keyPattern || {})
    .map(([field, direction]) => `${field}:${direction}`)
    .join(",");
}

async function listIndexTuples(db, collectionName) {
  try {
    const cursor = db.collection(collectionName).listIndexes();
    const indexes = typeof cursor?.toArray === "function" ? await cursor.toArray() : await cursor;
    const tuples = new Set();
    let ttlPresent = false;
    for (const index of indexes || []) {
      tuples.add(keyPatternTuple(index.key));
      if (index.expireAfterSeconds !== undefined) ttlPresent = true;
    }
    // MongoDB always returns the _id index; a collection that exists but has
    // only _id still counts as existing.
    return { exists: true, tuples, ttlPresent };
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") {
      return { exists: false, tuples: new Set(), ttlPresent: false };
    }
    throw error;
  }
}

/**
 * Invariant 2: every collection in `REQUIRED_INDEXES` has its indexes, and
 * every declared TTL index exists on collections that are present.
 */
export async function verifyIndexes(db, { sampleLimit = 50, ignoreCollections = [] } = {}) {
  const violations = [];
  const ignore = new Set(ignoreCollections);
  let collectionsChecked = 0;
  let indexesRequired = 0;

  for (const [collectionName, required] of Object.entries(REQUIRED_INDEXES)) {
    if (ignore.has(collectionName)) continue;
    collectionsChecked += 1;
    const { exists, tuples } = await listIndexTuples(db, collectionName);

    if (!exists) {
      violations.push({ code: RESTORE_VIOLATION_CODES.COLLECTION_MISSING, collection: collectionName });
      continue;
    }

    for (const index of required) {
      indexesRequired += 1;
      if (!tuples.has(keyPatternTuple(index.keys))) {
        violations.push({
          code: RESTORE_VIOLATION_CODES.INDEX_MISSING,
          collection: collectionName,
          keys: index.keys,
          name: index.options?.name || keyPatternTuple(index.keys),
          unique: index.options?.unique === true,
        });
      }
    }
  }

  for (const [collectionName, ttl] of Object.entries(TTL_INDEXES)) {
    if (ignore.has(collectionName)) continue;
    const { exists, tuples } = await listIndexTuples(db, collectionName);
    if (!exists) continue; // declared TTL collection may not be provisioned yet
    if (!tuples.has(keyPatternTuple(ttl.keys))) {
      violations.push({ code: RESTORE_VIOLATION_CODES.TTL_INDEX_MISSING, collection: collectionName, keys: ttl.keys });
    }
  }

  return {
    check: "indexes",
    ok: violations.length === 0,
    collectionsChecked,
    indexesRequired,
    violations: violations.slice(0, sampleLimit),
  };
}

/**
 * Invariant 3: the hash-chained audit ledger verifies from sequence 0 with no
 * gaps. `truncated` is reported when the export limit was hit (the verified
 * prefix is still meaningful; the operator should re-run with a higher cap).
 */
export async function verifyAuditLedger(db, { limit = 100_000 } = {}) {
  const records = await readAuditRecords(db, { limit });
  const result = verifyAuditRecords(records);
  return {
    check: "audit_ledger",
    ok: result.valid,
    records: records.length,
    truncated: records.length >= limit,
    brokenAtSequence: result.brokenAtSequence ?? null,
    violations: result.valid
      ? []
      : [
          {
            code: RESTORE_VIOLATION_CODES.AUDIT_CHAIN_BROKEN,
            brokenAtSequence: result.brokenAtSequence,
            reason: "audit_ledger hash chain failed verification — evidence of tampering or a partial restore",
          },
        ],
  };
}

/**
 * Create only the required indexes that are missing. Scoped on purpose:
 * `scripts/setup-db-indexes.js` also seeds sample marketplace data, which must
 * never run against a restored production database.
 */
export async function repairIndexes(db, { ignoreCollections = [] } = {}) {
  const ignore = new Set(ignoreCollections);
  const created = [];

  for (const [collectionName, required] of Object.entries(REQUIRED_INDEXES)) {
    if (ignore.has(collectionName)) continue;
    const { exists, tuples } = await listIndexTuples(db, collectionName);
    for (const index of required) {
      if (exists && tuples.has(keyPatternTuple(index.keys))) continue;
      await db.collection(collectionName).createIndex(index.keys, index.options || {});
      created.push({ collection: collectionName, name: index.options?.name || keyPatternTuple(index.keys) });
    }
  }

  for (const [collectionName, ttl] of Object.entries(TTL_INDEXES)) {
    if (ignore.has(collectionName)) continue;
    const { exists, tuples } = await listIndexTuples(db, collectionName);
    if (!exists) continue; // do not provision collections that may not be in use yet
    if (!tuples.has(keyPatternTuple(ttl.keys))) {
      await db.collection(collectionName).createIndex(ttl.keys, ttl.options || {});
      created.push({ collection: collectionName, name: ttl.options?.name || keyPatternTuple(ttl.keys) });
    }
  }

  return { created };
}

/** Informational metrics that aid triage without failing the restore. */
export async function collectRestoreMetrics(db, { now = new Date() } = {}) {
  const outbox = db.collection("side_effect_outbox");
  const [pending, leased, deadLetterPending] = await Promise.all([
    countSafely(outbox, { status: "pending" }),
    countSafely(outbox, { status: "leased", leaseExpiresAt: { $lte: now } }),
    countSafely(db.collection(COLLECTIONS.deadLetterEvents), { status: "pending" }),
  ]);
  return {
    outbox: {
      pending,
      expiredLeases: leased,
      deadLetterPending,
      note: "expired leases are reclaimable by the next worker pass; a growing count means workers are not running",
    },
  };
}

async function countSafely(collection, query) {
  try {
    if (typeof collection.countDocuments === "function") return await collection.countDocuments(query);
    const docs = await collection.find(query).toArray();
    return docs.length;
  } catch {
    return null;
  }
}

/**
 * Rebuild the derived entitlement cache from `purchases` (source of truth).
 * Mirrors `scripts/rebuild-entitlement-cache.mjs` semantics so both paths
 * converge on the same state.
 */
export async function rebuildEntitlementCache(db, { now = new Date(), batchSize = 500 } = {}) {
  const source = new Map();
  const cursor = db.collection(COLLECTIONS.purchases).find({
    status: { $in: ACTIVE_PURCHASE_STATUSES },
    buyerAddress: { $exists: true },
    materialId: { $exists: true },
  });
  for await (const purchase of cursor) {
    const key = entitlementKey(purchase.buyerAddress, purchase.materialId);
    source.set(key, {
      buyerAddress: lower(purchase.buyerAddress),
      materialId: String(purchase.materialId),
      purchaseId: purchase.purchaseId || String(purchase._id ?? ""),
    });
  }

  const deleteResult = await db.collection(COLLECTIONS.entitlementCache).deleteMany({});
  const deleted = deleteResult?.deletedCount ?? 0;
  let inserted = 0;
  let batch = [];
  for (const entry of source.values()) {
    batch.push({
      buyerAddress: entry.buyerAddress,
      materialId: entry.materialId,
      active: true,
      state: "finalized",
      source: "restore-rebuild",
      purchaseId: entry.purchaseId,
      rebuiltAt: now,
      updatedAt: now,
      createdAt: now,
    });
    if (batch.length >= batchSize) {
      inserted += (await db.collection(COLLECTIONS.entitlementCache).insertMany(batch)).insertedCount;
      batch = [];
    }
  }
  if (batch.length) {
    inserted += (await db.collection(COLLECTIONS.entitlementCache).insertMany(batch)).insertedCount;
  }
  return { deleted, rebuilt: source.size, inserted };
}

/**
 * Rebuild search projections via the existing reconciliation primitive in
 * repair mode. Idempotent: projection versions only move forward.
 */
export async function rebuildSearchProjections(db, { batchSize = 200, maxBatches = 100, now = new Date() } = {}) {
  let cursor = null;
  let batches = 0;
  let checked = 0;
  let repaired = 0;
  const runIds = [];
  while (batches < maxBatches) {
    const result = await reconcileMaterialSearch({ db, cursor, batchSize, repair: true, now });
    runIds.push(result.runId);
    checked += result.checked;
    repaired += result.diff.length;
    batches += 1;
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return { batches, checked, repaired, runIds };
}

/**
 * Map verification violations to explicit operator repair steps. Read-only
 * commands are listed first; destructive rebuilds state what they replace.
 */
export function buildRepairSteps({ entitlements, search, indexes, audit } = {}) {
  const steps = [];
  if (entitlements && !entitlements.ok) {
    steps.push({
      code: "repair_entitlement_cache",
      description:
        "Entitlement cache disagrees with purchases. Rebuild it from the source of truth, then re-run verification.",
      command: "node scripts/rebuild-entitlement-cache.mjs --rebuild",
      alternativeCommand: "node scripts/verify-restore.mjs --repair=entitlements",
      destructive: true,
      requiresRerun: true,
    });
  }
  if (search && !search.ok) {
    steps.push({
      code: "repair_search_projection",
      description:
        "Material search projections are missing/stale/unauthorized. Reconcile them from materials (idempotent, version-monotonic).",
      command: "node scripts/verify-restore.mjs --repair=search",
      destructive: false,
      requiresRerun: true,
    });
  }
  if (indexes && !indexes.ok) {
    steps.push({
      code: "repair_indexes",
      description:
        "Required indexes are missing. Recreate only the missing ones (a full app restart also re-runs ensureIndexes, but this is scoped and auditable).",
      command: "node scripts/verify-restore.mjs --repair=indexes",
      destructive: false,
      requiresRerun: true,
    });
  }
  if (audit && !audit.ok) {
    steps.push({
      code: "investigate_audit_chain",
      description:
        "Do NOT auto-repair the audit chain: it is the evidence trail. Preserve audit_ledger and audit_checkpoints, then investigate from the broken sequence.",
      command:
        "mongosh \"$MONGODB_URI\" --eval 'db.audit_ledger.find({sequence:{$gte:<brokenAtSequence-5>}}).sort({sequence:1})'",
      destructive: false,
      requiresRerun: false,
    });
  }
  return steps;
}

/**
 * Full restore verification: runs every invariant, flattens violations, and
 * returns the repair plan. `ok === false` must block promotion of the restore.
 */
export async function runRestoreVerification({ db, options = {} } = {}) {
  const { sampleLimit = 25, maxScan = 5000, auditLimit = 100_000, ignoreCollections = [], includeMetrics = true } = options;
  if (!db) throw new Error("runRestoreVerification requires a db handle");

  const entitlements = await verifyEntitlementDerivedView(db, { sampleLimit });
  const search = await verifySearchProjection(db, { sampleLimit, maxScan });
  const indexes = await verifyIndexes(db, { sampleLimit, ignoreCollections });
  const audit = await verifyAuditLedger(db, { limit: auditLimit });
  const metrics = includeMetrics ? await collectRestoreMetrics(db) : null;

  const violations = [
    ...entitlements.violations,
    ...search.violations,
    ...indexes.violations,
    ...audit.violations,
  ];

  const checks = { entitlements, search, indexes, audit };
  const repairSteps = buildRepairSteps(checks);

  return {
    ok: violations.length === 0,
    verifiedAt: new Date().toISOString(),
    violationCount: violations.length,
    violations,
    checks,
    metrics,
    repairSteps,
  };
}

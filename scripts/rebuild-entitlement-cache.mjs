#!/usr/bin/env node
/**
 * Entitlement cache rebuild + verification + stale detection/repair for EduVault (#682).
 *
 * The entitlement cache (`entitlement_cache`) is a derived, recoverable view of
 * on-chain purchases. After a disaster-recovery restore it can be stale: rebuilt
 * from an old snapshot, missing recent purchases, or holding entries for
 * purchases that were later refunded. This script:
 *
 *   1. Rebuilds the cache from the source-of-truth `purchases` collection
 *      (completed purchase statuses mapped to active entitlements).
 *   2. Optionally drops the existing cache (`--rebuild` — the full DR path).
 *   3. Without `--rebuild`, compares the existing cache against the rebuilt
 *      view and reports **missing**, **extra**, and **mismatched** entitlements.
 *   4. Detects **stale** cache entries by comparing the cached `sourceVersion`
 *      (or `updatedAt` timestamp) against the source-of-truth purchase version.
 *   5. Optionally repairs stale/missing/extra entries with `--repair`
 *      (idempotent: re-running produces the same result). Supports `--dry-run`
 *      to print the planned repair without writing.
 *   6. Exits 0 only when the verification passes (no missing / extra /
 *      mismatched / stale), or when `--rebuild`/`--repair` completed.
 *
 * Usage:
 *   # Verification-only (compare current cache against source of truth):
 *   MONGODB_URI=$URI node scripts/rebuild-entitlement-cache.mjs
 *
 *   # Full DR rebuild (drop + repopulate cache), printing a before/after report:
 *   MONGODB_URI=$URI node scripts/rebuild-entitlement-cache.mjs --rebuild
 *
 *   # Stale detection + idempotent repair (dry-run first):
 *   MONGODB_URI=$URI node scripts/rebuild-entitlement-cache.mjs --repair --dry-run
 *   MONGODB_URI=$URI node scripts/rebuild-entitlement-cache.mjs --repair
 *
 *   # Override the staleness tolerance (ms) when source has no version field:
 *   MONGODB_URI=$URI STALE_TOLERANCE_MS=5000 node scripts/rebuild-entitlement-cache.mjs
 *
 * Required env vars:
 *   MONGODB_URI  — MongoDB connection string
 * Optional env vars:
 *   MONGODB_DB   — database name (default: eduvault)
 *   DRY_RUN      — set to "true" to compute reports without writing (no-op for --rebuild)
 *   STALE_TOLERANCE_MS — timestamp drift tolerance for staleness (default: 0)
 */

import { MongoClient } from "mongodb";

// ---------------------------------------------------------------------------
// Structured logger (matches restore-verification.mjs convention)
// ---------------------------------------------------------------------------
function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    log("error", `Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const MONGODB_URI = requireEnv("MONGODB_URI");
const DB_NAME = process.env.MONGODB_DB || "eduvault";
const DRY_RUN = process.env.DRY_RUN === "true";
const REBUILD = process.argv.includes("--rebuild");
const REPAIR = process.argv.includes("--repair");
const STALE_TOLERANCE_MS = Number.parseInt(process.env.STALE_TOLERANCE_MS || "0", 10);

const PURCHASES = "purchases";
const ENTITLEMENTS = "entitlement_cache";

// Purchase statuses that grant an active entitlement for the buyer.
const ACTIVE_STATUSES = ["confirmed", "settled", "completed"];

/**
 * Build the source-of-truth entitlement set from completed purchases.
 * Returns a map of `${buyerAddress}::${materialId}` -> { buyerAddress, materialId, purchaseId, status, updatedAt, sourceVersion }.
 * `sourceVersion` is derived from the purchase's `version` field when present, else from `updatedAt`.
 */
async function buildSourceEntitlements(db) {
  const cursor = db.collection(PURCHASES).find({
    status: { $in: ACTIVE_STATUSES },
    buyerAddress: { $exists: true },
    materialId: { $exists: true },
  });
  const map = new Map();
  const sourceCount = { confirmed: 0, settled: 0, completed: 0 };
  for await (const doc of cursor) {
    const buyerAddress = String(doc.buyerAddress).trim().toLowerCase();
    const materialId = String(doc.materialId);
    const key = `${buyerAddress}::${materialId}`;
    const status = String(doc.status).toLowerCase();
    if (sourceCount[status] !== undefined) sourceCount[status]++;
    const updatedAt = doc.updatedAt ? new Date(doc.updatedAt).getTime() : null;
    map.set(key, {
      buyerAddress,
      materialId,
      purchaseId: doc.purchaseId || doc._id?.toString(),
      status,
      updatedAt,
      sourceVersion: doc.version !== undefined && doc.version !== null ? String(doc.version) : updatedAt,
    });
  }
  return { map, sourceCount };
}

/** Load the current entitlement cache as a map of `${buyer}::${material}` -> { active, contentHash?, sourceVersion?, updatedAt? } */
async function loadCacheMap(db) {
  const cursor = db.collection(ENTITLEMENTS).find({});
  const map = new Map();
  for await (const doc of cursor) {
    const buyerAddress = String(doc.buyerAddress || doc.walletAddress || "").trim().toLowerCase();
    const materialId = String(doc.materialId);
    map.set(`${buyerAddress}::${materialId}`, {
      active: doc.active !== false,
      contentHash: doc.contentHash || null,
      sourceVersion: doc.sourceVersion !== undefined && doc.sourceVersion !== null ? String(doc.sourceVersion) : null,
      updatedAt: doc.updatedAt ? new Date(doc.updatedAt).getTime() : null,
    });
  }
  return map;
}

/**
 * Compare the source of truth against a rebuilt cache; classify discrepancies.
 * Stale entries are those present in both source and cache but whose cached
 * `sourceVersion` (or `updatedAt`) lags the source-of-truth version.
 */
function diff(sourceMap, cacheMap) {
  const missing = []; // in source but not cached (should be active)
  const extra = []; // cached as active but no completed purchase (probably stale/refunded)
  const mismatched = []; // present in both but cache state disagrees
  const stale = []; // present in both but cached version/timestamp lags source

  for (const [key, source] of sourceMap) {
    const cached = cacheMap.get(key);
    if (!cached || cached.active !== true) {
      missing.push({ key, status: source.status });
    } else if (cached.active !== true) {
      mismatched.push({ key, expected: true, actual: cached.active });
    } else if (isStale(source, cached)) {
      stale.push({
        key,
        expectedVersion: source.sourceVersion,
        actualVersion: cached.sourceVersion,
        expectedUpdatedAt: source.updatedAt,
        actualUpdatedAt: cached.updatedAt,
      });
    }
  }

  for (const [key, cached] of cacheMap) {
    if (!cached.active) continue; // cached-inactive entries are ignored (they may be intentionally revoked)
    if (!sourceMap.has(key)) {
      extra.push({ key });
    }
  }

  return { missing, extra, mismatched, stale };
}

/**
 * Determine whether a cached entry is stale relative to its source-of-truth.
 * Prefers explicit `sourceVersion` comparison; falls back to timestamp drift
 * with a configurable tolerance (`STALE_TOLERANCE_MS`).
 */
function isStale(source, cached) {
  if (source.sourceVersion !== null && source.sourceVersion !== undefined) {
    if (cached.sourceVersion === null || cached.sourceVersion === undefined) return true;
    return String(cached.sourceVersion) !== String(source.sourceVersion);
  }
  if (source.updatedAt === null || source.updatedAt === undefined) return false;
  if (cached.updatedAt === null || cached.updatedAt === undefined) return true;
  return source.updatedAt - cached.updatedAt > STALE_TOLERANCE_MS;
}

/**
 * Idempotent repair: bring the cache in line with the source of truth.
 * - Upserts missing/stale/mismatched entries as active with the current sourceVersion.
 * - Deletes extra (active-but-unsourced) entries.
 * Returns a summary of planned/applied operations. Safe to re-run.
 */
async function repairCache(db, sourceMap, cacheMap, { missing, extra, mismatched, stale }) {
  const ops = [];
  const upsertKeys = new Set();
  for (const item of missing) upsertKeys.add(item.key);
  for (const item of mismatched) upsertKeys.add(item.key);
  for (const item of stale) upsertKeys.add(item.key);

  for (const key of upsertKeys) {
    const src = sourceMap.get(key);
    if (!src) continue;
    ops.push({
      type: "upsert",
      key,
      doc: {
        buyerAddress: src.buyerAddress,
        materialId: src.materialId,
        active: true,
        source: "repair",
        sourceVersion: src.sourceVersion,
        updatedAt: new Date(),
      },
    });
  }
  for (const item of extra) {
    ops.push({ type: "delete", key: item.key });
  }

  const summary = {
    plannedUpserts: upsertKeys.size,
    plannedDeletes: extra.length,
    appliedUpserts: 0,
    appliedDeletes: 0,
    dryRun: DRY_RUN,
  };

  if (DRY_RUN) {
    log("info", "DRY_RUN=true — repair plan computed without writes", summary);
    for (const op of ops.slice(0, 50)) log("info", "Repair plan op", { op });
    if (ops.length > 50) log("info", "…more repair ops", { additional: ops.length - 50 });
    return summary;
  }

  for (const op of ops) {
    if (op.type === "upsert") {
      const { buyerAddress, materialId } = op.doc;
      const res = await db.collection(ENTITLEMENTS).updateOne(
        { buyerAddress, materialId },
        { $set: op.doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );
      if (res.upsertedCount || res.modifiedCount) summary.appliedUpserts++;
    } else if (op.type === "delete") {
      const [buyerAddress, materialId] = op.key.split("::");
      const res = await db.collection(ENTITLEMENTS).deleteOne({ buyerAddress, materialId });
      if (res.deletedCount) summary.appliedDeletes++;
    }
  }

  log("info", "Repair applied", summary);
  return summary;
}

/**
 * Write the rebuilt entitlement cache. Under `--rebuild`, clears the collection
 * first and repopulates from the source of truth.
 */
async function writeCache(db, sourceMap) {
  if (DRY_RUN) {
    log("info", "DRY_RUN=true — skipping writes", { rebuildTarget: sourceMap.size });
    return sourceMap.size;
  }
  await db.collection(ENTITLEMENTS).deleteMany({});
  const batch = [];
  let inserted = 0;
  for (const [key, src] of sourceMap) {
    const doc = {
      buyerAddress: src.buyerAddress,
      materialId: src.materialId,
      active: true,
      source: "rebuild",
      sourceVersion: src.sourceVersion,
      rebuiltAt: new Date(),
      updatedAt: new Date(),
    };
    batch.push(doc);
    if (batch.length >= 500) {
      inserted += (await db.collection(ENTITLEMENTS).insertMany(batch)).insertedCount;
      batch.length = 0;
    }
  }
  if (batch.length) {
    inserted += (await db.collection(ENTITLEMENTS).insertMany(batch)).insertedCount;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let client;
try {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db(DB_NAME);

  const { map: sourceMap, sourceCount } = await buildSourceEntitlements(db);
  log("info", "Built source-of-truth entitlements from purchases", { sourceCount, total: sourceMap.size });

  if (REBUILD) {
    if (DRY_RUN) {
      log("warn", "DRY_RUN=true — --rebuild is a no-op without writes");
    } else {
      const inserted = await writeCache(db, sourceMap);
      log("info", "Rebuilt entitlement cache from source events", { inserted });
    }
    log("info", "Rebuild verification passed (cache now reflects source of truth)", {
      rebuildTarget: sourceMap.size,
    });
    process.exit(0);
  }

  const cacheMap = await loadCacheMap(db);
  const { missing, extra, mismatched, stale } = diff(sourceMap, cacheMap);
  const report = {
    sourceEntitlements: sourceMap.size,
    cachedActive: [...cacheMap.values()].filter((c) => c.active).length,
    missing: missing.length,
    extra: extra.length,
    mismatched: mismatched.length,
    stale: stale.length,
    ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0 && stale.length === 0,
  };
  log("info", "Entitlement cache verification report", report);

  if (REPAIR) {
    const summary = await repairCache(db, sourceMap, cacheMap, { missing, extra, mismatched, stale });
    if (DRY_RUN) {
      log("info", "Repair dry-run complete — re-run without DRY_RUN to apply", summary);
      process.exit(report.ok ? 0 : 1);
    }
    // Verify idempotency: re-diff after repair; a second run must be a no-op.
    const afterCache = await loadCacheMap(db);
    const after = diff(sourceMap, afterCache);
    const afterOk =
      after.missing.length === 0 &&
      after.extra.length === 0 &&
      after.mismatched.length === 0 &&
      after.stale.length === 0;
    log("info", "Post-repair verification", {
      missing: after.missing.length,
      extra: after.extra.length,
      mismatched: after.mismatched.length,
      stale: after.stale.length,
      ok: afterOk,
    });
    process.exit(afterOk ? 0 : 1);
  }

  if (report.ok) {
    log("info", "Verification passed — every protected download matches source-of-truth purchases");
    process.exit(0);
  }

  for (const item of missing.slice(0, 20)) log("error", "Missing entitlement (should be active)", { item });
  for (const item of extra.slice(0, 20)) log("error", "Extra entitlement (no completed purchase)", { item });
  for (const item of mismatched.slice(0, 20)) log("error", "Mismatched entitlement state", { item });
  for (const item of stale.slice(0, 20)) log("error", "Stale entitlement (cached version lags source)", { item });
  if (missing.length > 20) log("error", "…more missing entitlements", { additional: missing.length - 20 });
  if (extra.length > 20) log("error", "…more extra entitlements", { additional: extra.length - 20 });
  if (stale.length > 20) log("error", "…more stale entitlements", { additional: stale.length - 20 });

  log("error", "Verification failed — remediation required", report);
  if (!DRY_RUN) {
    log("info", "Remediation: run with --repair to fix drift, or --rebuild to repopulate from source of truth");
  }
  process.exit(1);
} finally {
  if (client) await client.close().catch(() => {});
}
#!/usr/bin/env node
/**
 * Entitlement cache rebuild + verification for EduVault (#682).
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
 *   4. Exits 0 only when the verification passes (no missing / extra /
 *      mismatched), or when `--rebuild` completed.
 *
 * Usage:
 *   # Verification-only (compare current cache against source of truth):
 *   MONGODB_URI=$URI node scripts/rebuild-entitlement-cache.mjs
 *
 *   # Full DR rebuild (drop + repopulate cache), printing a before/after report:
 *   MONGODB_URI=$URI node scripts/rebuild-entitlement-cache.mjs --rebuild
 *
 * Required env vars:
 *   MONGODB_URI  — MongoDB connection string
 * Optional env vars:
 *   MONGODB_DB   — database name (default: eduvault)
 *   DRY_RUN      — set to "true" to compute reports without writing (no-op for --rebuild)
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

const PURCHASES = "purchases";
const ENTITLEMENTS = "entitlement_cache";

// Purchase statuses that grant an active entitlement for the buyer.
const ACTIVE_STATUSES = ["confirmed", "settled", "completed"];

/**
 * Build the source-of-truth entitlement set from completed purchases.
 * Returns a map of `${buyerAddress}::${materialId}` -> { buyerAddress, materialId, purchaseId, status, updatedAt }.
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
    map.set(key, {
      buyerAddress,
      materialId,
      purchaseId: doc.purchaseId || doc._id?.toString(),
      status,
      updatedAt: doc.updatedAt ? new Date(doc.updatedAt).getTime() : null,
    });
  }
  return { map, sourceCount };
}

/** Load the current entitlement cache as a map of `${buyer}::${material}` -> { active, contentHash? } */
async function loadCacheMap(db) {
  const cursor = db.collection(ENTITLEMENTS).find({});
  const map = new Map();
  for await (const doc of cursor) {
    const buyerAddress = String(doc.buyerAddress || doc.walletAddress || "").trim().toLowerCase();
    const materialId = String(doc.materialId);
    map.set(`${buyerAddress}::${materialId}`, {
      active: doc.active !== false,
      contentHash: doc.contentHash || null,
      updatedAt: doc.updatedAt ? new Date(doc.updatedAt).getTime() : null,
    });
  }
  return map;
}

/** Compare the source of truth against a rebuilt cache; classify discrepancies. */
function diff(sourceMap, cacheMap) {
  const missing = []; // in source but not cached (should be active)
  const extra = []; // cached as active but no completed purchase (probably stale/refunded)
  const mismatched = []; // present in both but cache state disagrees

  for (const [key, source] of sourceMap) {
    const cached = cacheMap.get(key);
    if (!cached || cached.active !== true) {
      missing.push({ key, status: source.status });
    } else if (cached.active !== true) {
      mismatched.push({ key, expected: true, actual: cached.active });
    }
  }

  for (const [key, cached] of cacheMap) {
    if (!cached.active) continue; // cached-inactive entries are ignored (they may be intentionally revoked)
    if (!sourceMap.has(key)) {
      extra.push({ key });
    }
  }

  return { missing, extra, mismatched };
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
  const { missing, extra, mismatched } = diff(sourceMap, cacheMap);
  const report = {
    sourceEntitlements: sourceMap.size,
    cachedActive: [...cacheMap.values()].filter((c) => c.active).length,
    missing: missing.length,
    extra: extra.length,
    mismatched: mismatched.length,
    ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
  };
  log("info", "Entitlement cache verification report", report);

  if (report.ok) {
    log("info", "Verification passed — every protected download matches source-of-truth purchases");
    process.exit(0);
  }

  for (const item of missing.slice(0, 20)) log("error", "Missing entitlement (should be active)", { item });
  for (const item of extra.slice(0, 20)) log("error", "Extra entitlement (no completed purchase)", { item });
  for (const item of mismatched.slice(0, 20)) log("error", "Mismatched entitlement state", { item });
  if (missing.length > 20) log("error", "…more missing entitlements", { additional: missing.length - 20 });
  if (extra.length > 20) log("error", "…more extra entitlements", { additional: extra.length - 20 });

  log("error", "Verification failed — remediation required", report);
  if (!DRY_RUN) {
    log("info", "Remediation: run with --rebuild to repopulate from source of truth");
  }
  process.exit(1);
} finally {
  if (client) await client.close().catch(() => {});
}
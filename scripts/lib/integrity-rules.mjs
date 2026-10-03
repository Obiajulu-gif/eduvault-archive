/**
 * Data integrity rules for the EduVault integrity monitor (Issue #831).
 *
 * This module holds the declarative integrity constraints and the pure
 * validation runner shared by:
 *   - scripts/validate-restore-integrity.mjs (restore/migration validation)
 *   - scripts/integrity-monitor.mjs          (read-only monitor entrypoint)
 *
 * It has NO side effects on import so tests can import it directly.
 *
 * Failure categories (report keys):
 *   - missing       broken foreign-key references (referenced row absent)
 *   - orphaned      child rows left behind by a deleted/non-existent parent
 *   - duplicate     two or more rows violating a uniqueness invariant
 *   - stale         rows whose timestamp/status shows they should have
 *                   progressed but have not (thresholds are configurable)
 *   - inconsistent  rows violating a data invariant (not a reference)
 *
 * All checks are strictly read-only. `validateIntegrity` never writes.
 */

import { ObjectId } from "mongodb";

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------
export function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

// ---------------------------------------------------------------------------
// Stale thresholds
//
// Every stale rule is driven by a threshold that is (a) configurable via an
// environment variable and (b) injectable through `validateIntegrity`'s `now`
// so tests are fully deterministic.
// ---------------------------------------------------------------------------
export const STALE_THRESHOLD_ENV = {
  pendingPurchaseHours: "INTEGRITY_STALE_PENDING_PURCHASE_HOURS",
  deadLetterDays: "INTEGRITY_STALE_DEADLETTER_DAYS"
};

export const DEFAULT_STALE_THRESHOLDS = {
  // A `pending` purchase that has not progressed in this many hours is stale.
  pendingPurchaseHours: 24,
  // A dead-letter event still unresolved after this many days is stale.
  deadLetterDays: 7
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Resolve stale thresholds from an environment object (defaults to process.env).
 * Invalid/non-positive values fall back to the default and are reported.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ pendingPurchaseMs: number, deadLetterMs: number, pendingPurchaseHours: number, deadLetterDays: number, overrides: string[] }}
 */
export function resolveStaleThresholds(env = process.env) {
  const overrides = [];

  const pendingPurchaseHours = readPositiveNumber(
    env[STALE_THRESHOLD_ENV.pendingPurchaseHours],
    DEFAULT_STALE_THRESHOLDS.pendingPurchaseHours,
    STALE_THRESHOLD_ENV.pendingPurchaseHours,
    overrides
  );
  const deadLetterDays = readPositiveNumber(
    env[STALE_THRESHOLD_ENV.deadLetterDays],
    DEFAULT_STALE_THRESHOLDS.deadLetterDays,
    STALE_THRESHOLD_ENV.deadLetterDays,
    overrides
  );

  return {
    pendingPurchaseHours,
    deadLetterDays,
    pendingPurchaseMs: pendingPurchaseHours * HOUR_MS,
    deadLetterMs: deadLetterDays * DAY_MS,
    overrides
  };
}

function readPositiveNumber(raw, fallback, name, overrides) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  overrides.push(`${name}=${value}`);
  return value;
}

function toTime(value) {
  if (value === undefined || value === null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

// ---------------------------------------------------------------------------
// Validation Rule Configuration
// ---------------------------------------------------------------------------

/**
 * Defines integrity constraints for the database.
 * Each constraint specifies:
 * - collection: the collection to validate
 * - type: missing, orphaned, duplicate, stale, or inconsistent
 * - description: human-readable explanation
 * - check(db, ctx): validation logic function (read-only)
 * - severity: critical, error, warning
 */
export const INTEGRITY_CONSTRAINTS = [
  // 1. MISSING RECORDS (Broken foreign key references)
  {
    id: "purchases_missing_material",
    collection: "purchases",
    type: "missing",
    severity: "critical",
    description: "Purchase references non-existent material",
    async check(db) {
      const purchases = await db.collection("purchases").find({}).toArray();
      const materialIds = [...new Set(purchases.map(p => p.materialId).filter(Boolean))];

      const existingMaterials = await db.collection("materials")
        .find({ _id: { $in: materialIds.map(id => ObjectId.isValid(id) ? new ObjectId(id) : null).filter(Boolean) } })
        .project({ _id: 1 })
        .toArray();

      const existingSet = new Set(existingMaterials.map(m => m._id.toString()));

      return purchases
        .filter(p => p.materialId && !existingSet.has(String(p.materialId)))
        .map(p => ({
          purchaseId: p._id.toString(),
          materialId: p.materialId,
          buyerAddress: p.buyerAddress,
          reason: "Material does not exist in materials collection"
        }));
    }
  },

  {
    id: "entitlement_cache_missing_material",
    collection: "entitlement_cache",
    type: "missing",
    severity: "error",
    description: "Entitlement cache references non-existent material",
    async check(db) {
      const cache = await db.collection("entitlement_cache").find({ active: true }).toArray();
      const materialIds = [...new Set(cache.map(c => c.materialId).filter(Boolean))];

      const existingMaterials = await db.collection("materials")
        .find({ _id: { $in: materialIds.map(id => ObjectId.isValid(id) ? new ObjectId(id) : null).filter(Boolean) } })
        .project({ _id: 1 })
        .toArray();

      const existingSet = new Set(existingMaterials.map(m => m._id.toString()));

      return cache
        .filter(c => c.materialId && !existingSet.has(String(c.materialId)))
        .map(c => ({
          cacheId: c._id.toString(),
          materialId: c.materialId,
          buyerAddress: c.buyerAddress,
          reason: "Cached material does not exist"
        }));
    }
  },

  {
    id: "material_history_missing_material",
    collection: "material_history",
    type: "orphaned",
    severity: "warning",
    description: "Material history references deleted material",
    async check(db) {
      const history = await db.collection("material_history").find({}).toArray();
      const materialIds = [...new Set(history.map(h => h.materialId).filter(Boolean))];

      const existingMaterials = await db.collection("materials")
        .find({ _id: { $in: materialIds.map(id => ObjectId.isValid(id) ? new ObjectId(id) : null).filter(Boolean) } })
        .project({ _id: 1 })
        .toArray();

      const existingSet = new Set(existingMaterials.map(m => m._id.toString()));

      return history
        .filter(h => h.materialId && !existingSet.has(String(h.materialId)))
        .map(h => ({
          historyId: h._id.toString(),
          materialId: h.materialId,
          version: h.version,
          reason: "Referenced material no longer exists (may be intentional for deleted materials)"
        }));
    }
  },

  {
    id: "saved_materials_missing_material",
    collection: "saved_materials",
    type: "orphaned",
    severity: "warning",
    description: "Saved material references non-existent material",
    async check(db) {
      const saved = await db.collection("saved_materials").find({}).toArray();
      const materialIds = [...new Set(saved.map(s => s.materialId).filter(Boolean))];

      const existingMaterials = await db.collection("materials")
        .find({ _id: { $in: materialIds.map(id => ObjectId.isValid(id) ? new ObjectId(id) : null).filter(Boolean) } })
        .project({ _id: 1 })
        .toArray();

      const existingSet = new Set(existingMaterials.map(m => m._id.toString()));

      return saved
        .filter(s => s.materialId && !existingSet.has(String(s.materialId)))
        .map(s => ({
          savedId: s._id.toString(),
          materialId: s.materialId,
          walletAddress: s.walletAddress,
          reason: "Saved material no longer exists"
        }));
    }
  },

  // 2. DUPLICATED RECORDS (Unique constraint violations)
  {
    id: "duplicate_wallet_addresses",
    collection: "users",
    type: "duplicate",
    severity: "critical",
    description: "Multiple users with same wallet address",
    async check(db) {
      const pipeline = [
        { $group: { _id: "$walletAddress", count: { $sum: 1 }, ids: { $push: "$_id" } } },
        { $match: { count: { $gt: 1 } } }
      ];

      const duplicates = await db.collection("users").aggregate(pipeline).toArray();

      return duplicates.map(d => ({
        walletAddress: d._id,
        count: d.count,
        userIds: d.ids.map(id => id.toString()),
        reason: "Wallet address must be unique per user"
      }));
    }
  },

  {
    id: "duplicate_uuids",
    collection: "users",
    type: "duplicate",
    severity: "critical",
    description: "Multiple users with same UUID",
    async check(db) {
      const pipeline = [
        { $match: { uuid: { $exists: true, $ne: null } } },
        { $group: { _id: "$uuid", count: { $sum: 1 }, ids: { $push: "$_id" } } },
        { $match: { count: { $gt: 1 } } }
      ];

      const duplicates = await db.collection("users").aggregate(pipeline).toArray();

      return duplicates.map(d => ({
        uuid: d._id,
        count: d.count,
        userIds: d.ids.map(id => id.toString()),
        reason: "UUID must be unique per user"
      }));
    }
  },

  // 3. INCONSISTENT RECORDS (Data invariant violations)
  {
    id: "purchase_without_buyer",
    collection: "purchases",
    type: "inconsistent",
    severity: "critical",
    description: "Purchase record missing buyer address",
    async check(db) {
      const invalid = await db.collection("purchases")
        .find({
          $or: [
            { buyerAddress: { $exists: false } },
            { buyerAddress: null },
            { buyerAddress: "" }
          ]
        })
        .toArray();

      return invalid.map(p => ({
        purchaseId: p._id.toString(),
        materialId: p.materialId,
        status: p.status,
        reason: "Every purchase must have a buyerAddress"
      }));
    }
  },

  {
    id: "material_without_creator",
    collection: "materials",
    type: "inconsistent",
    severity: "critical",
    description: "Material missing creator address",
    async check(db) {
      const invalid = await db.collection("materials")
        .find({
          $or: [
            { userAddress: { $exists: false } },
            { userAddress: null },
            { userAddress: "" }
          ]
        })
        .toArray();

      return invalid.map(m => ({
        materialId: m._id.toString(),
        title: m.title,
        reason: "Every material must have a userAddress (creator)"
      }));
    }
  },

  {
    id: "protected_material_without_storage_key",
    collection: "materials",
    type: "inconsistent",
    severity: "error",
    description: "Protected material missing storage key/CID",
    async check(db) {
      const invalid = await db.collection("materials")
        .find({
          $or: [
            { price: { $gt: 0 } },
            { visibility: "private" }
          ],
          $and: [
            { storageKey: { $exists: false } },
            { ipfsCid: { $exists: false } },
            { cid: { $exists: false } },
            { fileHash: { $exists: false } }
          ]
        })
        .toArray();

      return invalid.map(m => ({
        materialId: m._id.toString(),
        title: m.title,
        price: m.price,
        visibility: m.visibility,
        reason: "Protected material must have storageKey, ipfsCid, cid, or fileHash"
      }));
    }
  },

  {
    id: "active_entitlement_without_purchase",
    collection: "entitlement_cache",
    type: "inconsistent",
    severity: "error",
    description: "Active entitlement without completed purchase",
    async check(db) {
      const activeCache = await db.collection("entitlement_cache")
        .find({ active: true })
        .toArray();

      const violations = [];

      for (const cache of activeCache) {
        const purchase = await db.collection("purchases").findOne({
          materialId: cache.materialId,
          buyerAddress: cache.buyerAddress,
          status: { $in: ["confirmed", "settled", "completed"] }
        });

        if (!purchase) {
          violations.push({
            cacheId: cache._id.toString(),
            materialId: cache.materialId,
            buyerAddress: cache.buyerAddress,
            reason: "Active entitlement exists without completed purchase"
          });
        }
      }

      return violations;
    }
  },

  // 4. SETTLEMENT REFERENCE CHAIN VALIDATION
  {
    id: "purchase_missing_transaction_hash",
    collection: "purchases",
    type: "inconsistent",
    severity: "warning",
    description: "Completed purchase missing transaction hash",
    async check(db) {
      const invalid = await db.collection("purchases")
        .find({
          status: { $in: ["confirmed", "settled", "completed"] },
          $or: [
            { transactionHash: { $exists: false } },
            { transactionHash: null },
            { transactionHash: "" }
          ]
        })
        .toArray();

      return invalid.map(p => ({
        purchaseId: p._id.toString(),
        materialId: p.materialId,
        buyerAddress: p.buyerAddress,
        status: p.status,
        reason: "Completed purchases should have transaction hash for verification"
      }));
    }
  },

  {
    id: "refund_without_original_purchase",
    collection: "refund_requests",
    type: "missing",
    severity: "critical",
    description: "Refund request references non-existent purchase",
    async check(db) {
      const refunds = await db.collection("refund_requests").find({}).toArray();
      const violations = [];

      for (const refund of refunds) {
        const purchase = await db.collection("purchases").findOne({
          _id: ObjectId.isValid(refund.purchaseId) ? new ObjectId(refund.purchaseId) : null
        });

        if (!purchase) {
          violations.push({
            refundId: refund._id.toString(),
            purchaseId: refund.purchaseId,
            reason: "Refund references non-existent purchase"
          });
        }
      }

      return violations;
    }
  },

  // 5. STALE RECORDS (should have progressed but did not)
  {
    id: "stale_pending_purchases",
    collection: "purchases",
    type: "stale",
    severity: "warning",
    description: "Purchase stuck in pending beyond the stale threshold",
    async check(db, ctx) {
      const { nowMs, thresholds } = ctx;
      const cutoff = nowMs - thresholds.pendingPurchaseMs;

      const pending = await db.collection("purchases")
        .find({ status: "pending" })
        .toArray();

      return pending
        .map(p => {
          const changedAt = toTime(p.updatedAt) ?? toTime(p.createdAt);
          return { p, changedAt };
        })
        .filter(({ changedAt }) => changedAt !== null && changedAt < cutoff)
        .map(({ p, changedAt }) => ({
          purchaseId: p._id.toString(),
          materialId: p.materialId,
          buyerAddress: p.buyerAddress,
          status: p.status,
          changedAt: new Date(changedAt).toISOString(),
          thresholdHours: thresholds.pendingPurchaseHours,
          reason: `Pending purchase has not progressed within ${thresholds.pendingPurchaseHours}h`
        }));
    }
  },

  {
    id: "stale_dead_letter_events",
    collection: "dead_letter_events",
    type: "stale",
    severity: "error",
    description: "Dead-letter event unresolved beyond the stale threshold",
    async check(db, ctx) {
      const { nowMs, thresholds } = ctx;
      const cutoff = nowMs - thresholds.deadLetterMs;

      const events = await db.collection("dead_letter_events")
        .find({ status: { $nin: ["resolved", "quarantined"] } })
        .toArray();

      return events
        .map(d => {
          const changedAt = toTime(d.lastAttemptedAt) ?? toTime(d.updatedAt) ?? toTime(d.createdAt);
          return { d, changedAt };
        })
        .filter(({ changedAt }) => changedAt !== null && changedAt < cutoff)
        .map(({ d, changedAt }) => ({
          deadLetterId: d._id.toString(),
          status: d.status,
          retryCount: d.retryCount,
          lastError: d.lastError,
          changedAt: new Date(changedAt).toISOString(),
          thresholdDays: thresholds.deadLetterDays,
          reason: `Unresolved dead-letter event is older than ${thresholds.deadLetterDays}d`
        }));
    }
  },

  {
    id: "stale_expired_entitlements_active",
    collection: "entitlement_cache",
    type: "stale",
    severity: "warning",
    description: "Entitlement past its expiry that is still marked active",
    async check(db, ctx) {
      const { nowMs } = ctx;

      const active = await db.collection("entitlement_cache")
        .find({ active: true })
        .toArray();

      return active
        .map(c => {
          const expiresAt = toTime(c.expiresAt) ?? toTime(c.validUntil);
          return { c, expiresAt };
        })
        .filter(({ expiresAt }) => expiresAt !== null && expiresAt < nowMs)
        .map(({ c, expiresAt }) => ({
          cacheId: c._id.toString(),
          materialId: c.materialId,
          buyerAddress: c.buyerAddress,
          expiresAt: new Date(expiresAt).toISOString(),
          reason: "Entitlement is expired but still active in the cache"
        }));
    }
  }
];

// ---------------------------------------------------------------------------
// Execute validation (read-only)
// ---------------------------------------------------------------------------

/**
 * Run every integrity constraint against `db`. Strictly read-only.
 *
 * @param {import('mongodb').Db} db
 * @param {object} [options]
 * @param {Date|number|string} [options.now=new Date()] injectable clock (deterministic tests)
 * @param {Record<string, string|undefined>} [options.env] env source for stale thresholds
 * @param {object} [options.thresholds] pre-resolved thresholds (overrides env)
 * @param {(level: string, message: string, extra?: object) => void} [options.logger]
 * @param {boolean} [options.autoRepair=false] accepted for CLI parity; this function never writes
 * @returns {Promise<object>} structured validation result
 */
export async function validateIntegrity(db, options = {}) {
  const {
    now = new Date(),
    env = process.env,
    logger = () => {},
    autoRepair = false
  } = options;

  const thresholds = options.thresholds || resolveStaleThresholds(env);
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const ctx = { now: nowDate, nowMs, thresholds };

  logger("info", "Starting restore integrity validation", {
    readOnly: true,
    autoRepair,
    now: nowDate.toISOString(),
    staleThresholds: {
      pendingPurchaseHours: thresholds.pendingPurchaseHours,
      deadLetterDays: thresholds.deadLetterDays
    }
  });

  const results = {
    timestamp: nowDate.toISOString(),
    readOnly: true,
    totalChecks: INTEGRITY_CONSTRAINTS.length,
    passed: 0,
    failed: 0,
    violations: [],
    summary: {
      critical: 0,
      error: 0,
      warning: 0
    }
  };

  for (const constraint of INTEGRITY_CONSTRAINTS) {
    try {
      logger("info", `Running check: ${constraint.id}`, {
        collection: constraint.collection,
        type: constraint.type,
        severity: constraint.severity
      });

      const violations = await constraint.check(db, ctx);

      if (violations.length > 0) {
        results.failed++;
        results.summary[constraint.severity]++;

        logger("warn", `Integrity violation detected: ${constraint.id}`, {
          count: violations.length,
          severity: constraint.severity,
          description: constraint.description
        });

        results.violations.push({
          id: constraint.id,
          collection: constraint.collection,
          type: constraint.type,
          severity: constraint.severity,
          description: constraint.description,
          count: violations.length,
          samples: violations.slice(0, 5) // Show first 5 violations
        });
      } else {
        results.passed++;
        logger("info", `Check passed: ${constraint.id}`);
      }
    } catch (error) {
      logger("error", `Check failed with error: ${constraint.id}`, {
        error: error.message,
        stack: error.stack
      });

      results.violations.push({
        id: constraint.id,
        collection: constraint.collection,
        type: "check_error",
        severity: "error",
        description: `Check failed: ${error.message}`,
        count: 1,
        samples: []
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Per-category report
// ---------------------------------------------------------------------------

export const REPORT_CATEGORIES = ["missing", "orphaned", "duplicate", "stale", "inconsistent"];

const SAMPLE_ID_KEYS = [
  "purchaseId", "cacheId", "historyId", "savedId", "refundId", "deadLetterId",
  "materialId", "userId", "userIds", "walletAddress", "uuid", "_id"
];

function extractSampleIds(samples) {
  const ids = [];
  for (const sample of samples) {
    for (const key of SAMPLE_ID_KEYS) {
      const value = sample[key];
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) ids.push(String(item));
      } else {
        ids.push(String(value));
      }
      break;
    }
  }
  return [...new Set(ids)];
}

/**
 * Aggregate raw validation results into a per-failure-category report.
 * Categories are always present (count 0 when clean) so downstream tooling
 * can rely on a stable shape.
 *
 * @param {object} results result from validateIntegrity()
 * @returns {{ timestamp: string, readOnly: true, clean: boolean, categories: Record<string, { severityBreakdown: object, count: number, checks: string[], sampleIds: string[] }> }}
 */
export function buildCategoryReport(results) {
  const categories = {};
  for (const type of REPORT_CATEGORIES) {
    categories[type] = { count: 0, severityBreakdown: {}, checks: [], sampleIds: [] };
  }

  for (const violation of results.violations) {
    const type = categories[violation.type] ? violation.type : "inconsistent";
    const bucket = categories[type];
    bucket.count += violation.count;
    bucket.checks.push(violation.id);
    bucket.severityBreakdown[violation.severity] =
      (bucket.severityBreakdown[violation.severity] || 0) + 1;
    for (const id of extractSampleIds(violation.samples)) {
      if (bucket.sampleIds.length < 10) bucket.sampleIds.push(id);
    }
  }

  // De-duplicate and keep the shape tidy.
  for (const type of REPORT_CATEGORIES) {
    categories[type].checks = [...new Set(categories[type].checks)];
    categories[type].sampleIds = [...new Set(categories[type].sampleIds)];
  }

  return {
    timestamp: results.timestamp,
    readOnly: true,
    clean: results.failed === 0,
    totalChecks: results.totalChecks,
    passed: results.passed,
    failed: results.failed,
    categories
  };
}

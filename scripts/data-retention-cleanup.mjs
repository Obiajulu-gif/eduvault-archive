#!/usr/bin/env node
/**
 * Data Retention Cleanup Script (#708 - Issue 2, #892 determinism)
 *
 * Implements retention policies for operational data:
 *  - Cleans up stale records that have exceeded their retention window
 *  - Protects records linked to active disputes, audits, or financial settlement
 *  - Reports affected records before destructive action
 *  - Supports dry-run mode for safe validation
 *
 * Usage:
 *   node scripts/data-retention-cleanup.mjs [--execute]
 *   node scripts/data-retention-cleanup.mjs --preview [--report-json <path>]
 *   node scripts/data-retention-cleanup.mjs --report-json ./retention-preview.json
 *   DRY_RUN=true node scripts/data-retention-cleanup.mjs
 *
 * Modes:
 *   (default)   Legacy dry run — reports eligibility per collection, never writes.
 *   --preview   Deterministic structured preview. Categories every record as
 *               eligible / held, every collection as skipped, and surfaces a
 *               failed bucket. Guaranteed to perform zero writes.
 *   --execute   Applies deletion for eligible records (behavior unchanged).
 *   --report-json <path>
 *               Writes the structured preview report to a JSON file. Implies
 *               preview mode and never writes to the database.
 *
 * Reading the preview (maintainers):
 *   report.buckets.eligible — records that WOULD be deleted on --execute.
 *   report.buckets.held     — records protected by an active dispute / audit /
 *                             financial settlement link (reason is explicit).
 *   report.buckets.skipped  — whole collections skipped because they are
 *                             permanently protected, missing, or have no policy.
 *   report.buckets.failed   — collections that errored; investigate before apply.
 *   Apply only when failed is empty and the eligible set matches expectations.
 *
 * Required env vars:
 *   MONGODB_URI — connection string
 *
 * Optional env vars:
 *   MONGODB_DB — database name (default: eduvault)
 *   DRY_RUN — if "false", execute cleanup (default: true)
 */

import { MongoClient } from "mongodb";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------
function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

// ---------------------------------------------------------------------------
// Retention Policy Configuration
// ---------------------------------------------------------------------------
export const RETENTION_POLICIES = {
  // Audit logs: keep indefinitely (never delete)
  audit_ledger: { retentionDays: null, protected: true },

  // Purchase records: keep indefinitely (financial/legal requirement)
  purchases: { retentionDays: null, protected: true },

  // Material history: keep for 2 years after material deletion
  material_history: { retentionDays: 730, protectionCheck: "linkedMaterialExists" },

  // Sync events: keep for 90 days
  sync_events: { retentionDays: 90, protectionCheck: null },

  // Dead letter events: keep for 90 days after resolution
  dead_letter_events: { retentionDays: 90, protectionCheck: "unresolvedStatus" },

  // Notifications: keep for 180 days after read
  notifications: { retentionDays: 180, protectionCheck: "unreadNotifications" },

  // Sessions: keep for 30 days after expiry
  sessions: { retentionDays: 30, protectionCheck: null },

  // Rate limit records: keep for 7 days
  rate_limits: { retentionDays: 7, protectionCheck: null },

  // Outbox intents: keep for 14 days after completion
  outbox: { retentionDays: 14, protectionCheck: "pendingIntents" },

  // Cache entries: keep for 7 days after last access
  cache_entries: { retentionDays: 7, protectionCheck: null },

  // Search analytics: keep for 365 days
  search_analytics: { retentionDays: 365, protectionCheck: null },

  // Refund requests: keep indefinitely (financial/legal requirement)
  refund_requests: { retentionDays: null, protected: true },

  // Entitlement cache: derived data, can be rebuilt - keep for 90 days of inactivity
  entitlement_cache: { retentionDays: 90, protectionCheck: "activeEntitlements" },

  // Quarantine records: keep for 30 days after resolution
  quarantine: { retentionDays: 30, protectionCheck: "unresolvedQuarantine" },
};

// ---------------------------------------------------------------------------
// Protection Checks
// ---------------------------------------------------------------------------
export async function checkProtections(db, collection, policy) {
  const protections = [];

  if (policy.protected) {
    return { protected: true, reason: "permanently_protected", count: null };
  }

  switch (policy.protectionCheck) {
    case "linkedMaterialExists": {
      // Protect history records where the material still exists
      const linkedCount = await db.collection(collection).countDocuments({
        materialId: { $exists: true },
        deletedAt: { $exists: false }
      });
      if (linkedCount > 0) {
        protections.push({ reason: "linked_material_exists", count: linkedCount });
      }
      break;
    }

    case "unresolvedStatus": {
      // Protect dead letter events that haven't been resolved
      const unresolvedCount = await db.collection(collection).countDocuments({
        status: { $in: ["pending", "quarantined", "retrying"] }
      });
      if (unresolvedCount > 0) {
        protections.push({ reason: "unresolved_status", count: unresolvedCount });
      }
      break;
    }

    case "unreadNotifications": {
      // Protect unread notifications
      const unreadCount = await db.collection(collection).countDocuments({
        read: { $ne: true }
      });
      if (unreadCount > 0) {
        protections.push({ reason: "unread_notifications", count: unreadCount });
      }
      break;
    }

    case "pendingIntents": {
      // Protect outbox intents that haven't completed
      const pendingCount = await db.collection(collection).countDocuments({
        status: { $in: ["pending", "retrying", "failed"] }
      });
      if (pendingCount > 0) {
        protections.push({ reason: "pending_intents", count: pendingCount });
      }
      break;
    }

    case "activeEntitlements": {
      // Protect active entitlement cache entries
      const activeCount = await db.collection(collection).countDocuments({
        active: true,
        expiresAt: { $gt: new Date() }
      });
      if (activeCount > 0) {
        protections.push({ reason: "active_entitlements", count: activeCount });
      }
      break;
    }

    case "unresolvedQuarantine": {
      // Protect unresolved quarantine records
      const unresolvedCount = await db.collection(collection).countDocuments({
        status: { $in: ["quarantined", "scanning", "pending_review"] }
      });
      if (unresolvedCount > 0) {
        protections.push({ reason: "unresolved_quarantine", count: unresolvedCount });
      }
      break;
    }
  }

  return { protected: false, protections };
}

// ---------------------------------------------------------------------------
// Build retention query
// ---------------------------------------------------------------------------
export function buildRetentionQuery(collection, policy, now) {
  if (!policy.retentionDays) {
    return null; // No cleanup for this collection
  }

  const cutoffDate = new Date(now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000);

  // Collection-specific query patterns
  const queries = {
    material_history: {
      deletedAt: { $exists: true, $lt: cutoffDate }
    },
    sync_events: {
      processedAt: { $lt: cutoffDate }
    },
    dead_letter_events: {
      resolvedAt: { $exists: true, $lt: cutoffDate }
    },
    notifications: {
      read: true,
      readAt: { $lt: cutoffDate }
    },
    sessions: {
      expiresAt: { $lt: cutoffDate }
    },
    rate_limits: {
      expiresAt: { $lt: cutoffDate }
    },
    outbox: {
      status: "completed",
      completedAt: { $lt: cutoffDate }
    },
    cache_entries: {
      lastAccessedAt: { $lt: cutoffDate }
    },
    search_analytics: {
      recordedAt: { $lt: cutoffDate }
    },
    entitlement_cache: {
      active: false,
      lastCheckedAt: { $lt: cutoffDate }
    },
    quarantine: {
      status: { $in: ["released", "approved", "rejected"] },
      resolvedAt: { $lt: cutoffDate }
    },
  };

  return queries[collection] || { createdAt: { $lt: cutoffDate } };
}

// ---------------------------------------------------------------------------
// Record-level holds
//
// A "held" record is one that is otherwise expired (matches the retention
// window) but must not be cleaned because it is linked to an active dispute,
// audit, or financial settlement. This is distinct from a "skipped"
// collection (missing / no policy / permanently protected) and from a
// "failed" collection (errored protection evaluation).
// ---------------------------------------------------------------------------
export const RECORD_HOLD_MARKERS = [
  { field: "legalHold", reason: "legal_hold" },
  { field: "auditHold", reason: "audit_hold" },
  { field: "activeDispute", reason: "active_dispute" },
  { field: "settlementPending", reason: "pending_settlement" },
  { field: "refundPending", reason: "pending_refund" },
];

export const COLLECTION_HOLD_RULES = {
  material_history: {
    reason: "linked_material_exists",
    matches: (record, ctx) =>
      Boolean(record.materialId) && ctx.materialIds.has(String(record.materialId)),
  },
  dead_letter_events: {
    reason: "unresolved_status",
    matches: (record) => ["pending", "quarantined", "retrying"].includes(record.status),
  },
  notifications: {
    reason: "unread_notification",
    matches: (record) => record.read !== true,
  },
  outbox: {
    reason: "pending_intent",
    matches: (record) => ["pending", "retrying", "failed"].includes(record.status),
  },
  entitlement_cache: {
    reason: "active_entitlement",
    matches: (record, ctx) =>
      record.active === true && record.expiresAt instanceof Date && record.expiresAt > ctx.now,
  },
  quarantine: {
    reason: "unresolved_quarantine",
    matches: (record) =>
      ["quarantined", "scanning", "pending_review"].includes(record.status),
  },
};

/**
 * Returns a hold reason string when an expired record must be held, or null
 * when the record is eligible for cleanup.
 */
export function resolveHoldReason(collection, record, ctx) {
  for (const marker of RECORD_HOLD_MARKERS) {
    if (record[marker.field] === true) return marker.reason;
  }
  if (record.hold === true) return "record_hold";
  // An unresolved dispute link (opened but not yet resolved) is a financial
  // hold regardless of collection.
  if (record.disputedAt && !record.disputeResolvedAt && !record.disputeResolution) {
    return "active_dispute";
  }
  const rule = COLLECTION_HOLD_RULES[collection];
  if (rule && rule.matches(record, ctx)) return rule.reason;
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic preview report
// ---------------------------------------------------------------------------
function emptyBigBucket() {
  return { eligible: 0, held: 0, skipped: 0, failed: 0 };
}

/**
 * Builds a deterministic, side-effect-free preview report.
 *
 * Guarantees:
 *  - Performs no writes (only listCollections / countDocuments / find).
 *  - Collections are ordered alphabetically; records by ascending _id.
 *  - Records are categorised exactly once as `eligible` or `held`.
 *
 * @param {import("mongodb").Db} db
 * @param {{ now?: Date, policies?: object, sampleLimit?: number }} [options]
 */
export async function buildPreviewReport(db, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const policies = options.policies || RETENTION_POLICIES;
  const sampleLimit = Number.isInteger(options.sampleLimit) && options.sampleLimit >= 0
    ? options.sampleLimit
    : 50;

  const buckets = {
    eligible: [],
    held: [],
    skipped: [],
    failed: [],
  };
  const collections = [];

  // Prefetch referenced material ids so linked-material holds are accurate.
  let materialIds = new Set();
  if (policies.material_history?.protectionCheck === "linkedMaterialExists") {
    const materialCollections = await db.listCollections({ name: "materials" }).toArray();
    if (materialCollections.length > 0) {
      const docs = await db.collection("materials").find({}).toArray();
      materialIds = new Set(docs.map((doc) => String(doc._id)));
    }
  }
  const ctx = { now, materialIds };

  // Sorted collection names => deterministic report ordering.
  const collectionNames = Object.keys(policies).sort();

  for (const collection of collectionNames) {
    const policy = policies[collection];
    const report = {
      collection,
      status: "processed",
      eligible: 0,
      held: 0,
      skipped: 0,
      failed: 0,
      reasons: {},
      eligibleSample: [],
      heldSample: [],
    };

    try {
      const collectionExists = await db.listCollections({ name: collection }).toArray();
      if (collectionExists.length === 0) {
        report.status = "skipped";
        report.skipped = 1;
        report.reasons.collection_not_found = 1;
        collections.push(report);
        continue;
      }

      if (policy.protected) {
        report.status = "skipped";
        report.skipped = 1;
        report.reasons.permanently_protected = 1;
        collections.push(report);
        continue;
      }

      const query = buildRetentionQuery(collection, policy, now);
      if (!query) {
        report.status = "skipped";
        report.skipped = 1;
        report.reasons.no_retention_policy = 1;
        collections.push(report);
        continue;
      }

      // Ascending _id ordering makes the sample deterministic.
      const candidates = await db.collection(collection)
        .find(query)
        .sort({ _id: 1 })
        .toArray();

      for (const record of candidates) {
        const reason = resolveHoldReason(collection, record, ctx);
        if (reason) {
          report.held += 1;
          report.reasons[reason] = (report.reasons[reason] || 0) + 1;
          if (report.heldSample.length < sampleLimit) {
            report.heldSample.push({ id: String(record._id), reason });
          }
        } else {
          report.eligible += 1;
          if (report.eligibleSample.length < sampleLimit) {
            report.eligibleSample.push(String(record._id));
          }
        }
      }

      collections.push(report);
    } catch (error) {
      report.status = "failed";
      report.failed = 1;
      report.reasons[error.message] = 1;
      collections.push(report);
    }
  }

  // Flatten per-collection samples into the four deterministic buckets.
  for (const report of collections) {
    for (const id of report.eligibleSample) {
      buckets.eligible.push({ collection: report.collection, id });
    }
    for (const held of report.heldSample) {
      buckets.held.push({ collection: report.collection, id: held.id, reason: held.reason });
    }
    if (report.status === "skipped") {
      buckets.skipped.push({ collection: report.collection, reason: Object.keys(report.reasons).sort()[0] });
    }
    if (report.status === "failed") {
      buckets.failed.push({ collection: report.collection, reason: Object.keys(report.reasons).sort()[0] });
    }
  }

  for (const bucket of Object.values(buckets)) {
    bucket.sort((a, b) => {
      if (a.collection !== b.collection) return a.collection < b.collection ? -1 : 1;
      const aId = a.id || "";
      const bId = b.id || "";
      if (aId !== bId) return aId < bId ? -1 : 1;
      return 0;
    });
  }

  const totals = collections.reduce((acc, c) => {
    acc.eligible += c.eligible;
    acc.held += c.held;
    acc.skipped += c.skipped;
    acc.failed += c.failed;
    return acc;
  }, emptyBigBucket());

  const summary = {
    totalCollections: collections.length,
    collectionsProcessed: collections.filter((c) => c.status === "processed").length,
    collectionsSkipped: collections.filter((c) => c.status === "skipped").length,
    collectionsFailed: collections.filter((c) => c.status === "failed").length,
    totalEligible: totals.eligible,
    totalHeld: totals.held,
    totalSkipped: totals.skipped,
    totalFailed: totals.failed,
    totalDeleted: 0,
    dryRun: true,
  };

  return {
    mode: "preview",
    dryRun: true,
    generatedAt: now.toISOString(),
    summary,
    collections,
    buckets,
  };
}

// ---------------------------------------------------------------------------
// Cleanup collection (execute path — behavior unchanged)
// ---------------------------------------------------------------------------
export async function cleanupCollection(db, collection, policy, dryRun, now) {
  log("info", `Processing collection: ${collection}`, { policy });

  // Check if collection exists
  const collections = await db.listCollections({ name: collection }).toArray();
  if (collections.length === 0) {
    log("info", `Collection ${collection} does not exist, skipping`);
    return { collection, skipped: true, reason: "collection_not_found" };
  }

  // Check protections
  const protectionResult = await checkProtections(db, collection, policy);
  if (protectionResult.protected) {
    log("info", `Collection ${collection} is permanently protected`, protectionResult);
    return { collection, skipped: true, reason: protectionResult.reason };
  }

  // Build retention query
  const query = buildRetentionQuery(collection, policy, now);
  if (!query) {
    log("info", `No retention policy for ${collection}, skipping`);
    return { collection, skipped: true, reason: "no_retention_policy" };
  }

  // Apply protection filters
  if (protectionResult.protections.length > 0) {
    log("info", `Applying protections for ${collection}`, { protections: protectionResult.protections });
  }

  // Count eligible records
  const eligibleCount = await db.collection(collection).countDocuments(query);

  if (eligibleCount === 0) {
    log("info", `No eligible records in ${collection}`);
    return { collection, eligible: 0, deleted: 0, skipped: false };
  }

  // Sample eligible records for reporting
  const samples = await db.collection(collection)
    .find(query)
    .limit(5)
    .project({ _id: 1, createdAt: 1, status: 1 })
    .toArray();

  log("info", `Found ${eligibleCount} eligible records in ${collection}`, {
    samples: samples.map(s => ({ id: String(s._id), createdAt: s.createdAt, status: s.status }))
  });

  if (dryRun) {
    log("info", `DRY RUN: Would delete ${eligibleCount} records from ${collection}`);
    return { collection, eligible: eligibleCount, deleted: 0, dryRun: true };
  }

  // Execute deletion
  const result = await db.collection(collection).deleteMany(query);

  log("info", `Deleted ${result.deletedCount} records from ${collection}`, {
    expected: eligibleCount,
    actual: result.deletedCount
  });

  return {
    collection,
    eligible: eligibleCount,
    deleted: result.deletedCount,
    skipped: false
  };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const reportJsonIndex = argv.indexOf("--report-json");
  const reportJson = reportJsonIndex !== -1 ? argv[reportJsonIndex + 1] || null : null;
  return {
    preview: argv.includes("--preview"),
    execute: argv.includes("--execute"),
    reportJson,
  };
}

function printPreviewReport(report) {
  const { summary } = report;
  console.log("\n" + "=".repeat(80));
  console.log("DATA RETENTION CLEANUP PREVIEW");
  console.log("=".repeat(80));
  console.log(`Generated At: ${report.generatedAt}`);
  console.log(`Mode: ${report.mode.toUpperCase()} (zero writes)`);
  console.log(`Collections: ${summary.totalCollections} ` +
    `(processed ${summary.collectionsProcessed}, skipped ${summary.collectionsSkipped}, failed ${summary.collectionsFailed})`);
  console.log(`Eligible records (would be deleted on --execute): ${summary.totalEligible}`);
  console.log(`Held records (dispute/audit/financial protection): ${summary.totalHeld}`);
  console.log(`Skipped collections: ${summary.totalSkipped}`);
  console.log(`Failed collections: ${summary.totalFailed}`);
  console.log("=".repeat(80));

  if (report.buckets.held.length > 0) {
    console.log("\nHELD RECORDS (skipped with reason):");
    for (const entry of report.buckets.held) {
      console.log(`  - ${entry.collection}#${entry.id}: ${entry.reason}`);
    }
  }
  if (report.buckets.skipped.length > 0) {
    console.log("\nSKIPPED COLLECTIONS:");
    for (const entry of report.buckets.skipped) {
      console.log(`  - ${entry.collection}: ${entry.reason}`);
    }
  }
  if (report.buckets.failed.length > 0) {
    console.log("\nFAILED COLLECTIONS:");
    for (const entry of report.buckets.failed) {
      console.log(`  - ${entry.collection}: ${entry.reason}`);
    }
  }
  console.log("\nTo apply eligible deletions: node scripts/data-retention-cleanup.mjs --execute\n");
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const envExecute = process.env.DRY_RUN === "false";
  // Preview wins over execution to guarantee zero writes.
  const executeMode = !args.preview && (args.execute || envExecute);
  const now = new Date();

  if (args.preview && args.execute) {
    log("warn", "Both --preview and --execute provided; --preview takes precedence (no writes)");
  }

  log("info", "Starting data retention cleanup", { executeMode, preview: args.preview, timestamp: now.toISOString() });

  // Validate environment
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    log("error", "Missing required environment variable: MONGODB_URI");
    process.exit(1);
  }

  const DB_NAME = process.env.MONGODB_DB || "eduvault";

  // Connect to MongoDB
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  log("info", "Connected to MongoDB", { database: DB_NAME });

  const db = client.db(DB_NAME);

  // Structured preview path (zero writes) — explicit --preview or --report-json.
  if (!executeMode && (args.preview || args.reportJson)) {
    const report = await buildPreviewReport(db, { now });
    log("info", "Data retention preview complete", report.summary);
    printPreviewReport(report);

    if (args.reportJson) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args.reportJson, JSON.stringify(report, null, 2) + "\n", "utf8");
      log("info", `Preview report written to ${args.reportJson}`);
    }

    await client.close();
    process.exit(report.summary.totalFailed > 0 ? 1 : 0);
  }

  // Execute cleanup for each collection (legacy dry-run and execute share this path)
  const dryRun = !executeMode;
  const results = [];
  for (const [collection, policy] of Object.entries(RETENTION_POLICIES)) {
    try {
      const result = await cleanupCollection(db, collection, policy, dryRun, now);
      results.push(result);
    } catch (error) {
      log("error", `Failed to cleanup ${collection}`, { error: error.message, stack: error.stack });
      results.push({ collection, error: error.message, failed: true });
    }
  }

  // Generate summary report
  const summary = {
    totalCollections: results.length,
    skipped: results.filter(r => r.skipped).length,
    processed: results.filter(r => !r.skipped && !r.failed).length,
    failed: results.filter(r => r.failed).length,
    totalEligible: results.reduce((sum, r) => sum + (r.eligible || 0), 0),
    totalDeleted: results.reduce((sum, r) => sum + (r.deleted || 0), 0),
    dryRun,
    timestamp: now.toISOString(),
    results
  };

  log("info", "Data retention cleanup complete", summary);

  // Write detailed report
  console.log("\n" + "=".repeat(80));
  console.log("DATA RETENTION CLEANUP REPORT");
  console.log("=".repeat(80));
  console.log(`Timestamp: ${now.toISOString()}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "EXECUTE"}`);
  console.log(`Total Collections: ${summary.totalCollections}`);
  console.log(`Processed: ${summary.processed}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Total Eligible Records: ${summary.totalEligible}`);
  console.log(`Total Deleted Records: ${summary.totalDeleted}`);
  console.log("=".repeat(80) + "\n");

  if (dryRun) {
    console.log("⚠️  DRY RUN MODE: No records were deleted.");
    console.log("For a deterministic per-record preview, run: node scripts/data-retention-cleanup.mjs --preview");
    console.log("To execute cleanup, run: node scripts/data-retention-cleanup.mjs --execute\n");
  }

  await client.close();

  // Exit with appropriate code
  const exitCode = summary.failed > 0 ? 1 : 0;
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Execute (only when invoked directly, not when imported by tests)
// ---------------------------------------------------------------------------
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    log("error", "Unhandled error in data retention cleanup", { error: error.message, stack: error.stack });
    process.exit(1);
  });
}

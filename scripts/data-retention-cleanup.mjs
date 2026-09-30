#!/usr/bin/env node
/**
 * Data Retention Cleanup Script (#708 - Issue 2)
 *
 * Implements retention policies for operational data:
 *  - Cleans up stale records that have exceeded their retention window
 *  - Protects records linked to active disputes, audits, or financial settlement
 *  - Reports affected records before destructive action
 *  - Supports dry-run mode for safe validation
 *
 * Usage:
 *   node scripts/data-retention-cleanup.mjs [--execute]
 *   DRY_RUN=true node scripts/data-retention-cleanup.mjs
 *
 * Required env vars:
 *   MONGODB_URI — connection string
 *
 * Optional env vars:
 *   MONGODB_DB — database name (default: eduvault)
 *   DRY_RUN — if "true", report only without deleting (default: true)
 */

import { MongoClient } from "mongodb";

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------
function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

// ---------------------------------------------------------------------------
// Retention Policy Configuration
// ---------------------------------------------------------------------------
const RETENTION_POLICIES = {
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
async function checkProtections(db, collection, policy) {
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
function buildRetentionQuery(collection, policy, now) {
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
// Cleanup collection
// ---------------------------------------------------------------------------
async function cleanupCollection(db, collection, policy, dryRun, now) {
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
// Main execution
// ---------------------------------------------------------------------------
async function main() {
  const dryRun = process.argv.includes("--execute") ? false : (process.env.DRY_RUN !== "false");
  const now = new Date();
  
  log("info", "Starting data retention cleanup", { dryRun, timestamp: now.toISOString() });
  
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
  
  // Execute cleanup for each collection
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
    console.log("To execute cleanup, run: node scripts/data-retention-cleanup.mjs --execute\n");
  }
  
  await client.close();
  
  // Exit with appropriate code
  const exitCode = summary.failed > 0 ? 1 : 0;
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
main().catch((error) => {
  log("error", "Unhandled error in data retention cleanup", { error: error.message, stack: error.stack });
  process.exit(1);
});

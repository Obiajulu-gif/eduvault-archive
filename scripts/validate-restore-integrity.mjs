#!/usr/bin/env node
/**
 * Enhanced Restore Integrity Validation Script (Issue #3 Enhancement)
 *
 * Validates database integrity after restore or migration:
 *  1. Detects missing records (broken foreign key references)
 *  2. Detects orphaned records (references to deleted/non-existent parents)
 *  3. Detects duplicated records (unique constraint violations)
 *  4. Detects inconsistent records (data invariant violations)
 *  5. Validates settlement reference chains
 *  6. Read-only by default
 *
 * Usage:
 *   node scripts/validate-restore-integrity.mjs [--auto-repair]
 *
 * Required env vars:
 *   MONGODB_URI — connection string
 *
 * Optional env vars:
 *   MONGODB_DB — database name (default: eduvault)
 */

import { MongoClient, ObjectId } from "mongodb";

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------
function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

// ---------------------------------------------------------------------------
// Validation Rules Configuration
// ---------------------------------------------------------------------------

/**
 * Defines integrity constraints for the database.
 * Each constraint specifies:
 * - collection: the collection to validate
 * - type: missing, orphaned, duplicate, or inconsistent
 * - description: human-readable explanation
 * - check: validation logic function
 * - severity: critical, error, warning
 */
const INTEGRITY_CONSTRAINTS = [
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
  }
];

// ---------------------------------------------------------------------------
// Execute validation
// ---------------------------------------------------------------------------
async function validateIntegrity(db, autoRepair = false) {
  log("info", "Starting restore integrity validation", { autoRepair });
  
  const results = {
    timestamp: new Date().toISOString(),
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
      log("info", `Running check: ${constraint.id}`, {
        collection: constraint.collection,
        type: constraint.type,
        severity: constraint.severity
      });
      
      const violations = await constraint.check(db);
      
      if (violations.length > 0) {
        results.failed++;
        results.summary[constraint.severity]++;
        
        log("warn", `Integrity violation detected: ${constraint.id}`, {
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
        log("info", `Check passed: ${constraint.id}`);
      }
    } catch (error) {
      log("error", `Check failed with error: ${constraint.id}`, {
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
// Main execution
// ---------------------------------------------------------------------------
async function main() {
  const autoRepair = process.argv.includes("--auto-repair");
  
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
  
  // Run validation
  const results = await validateIntegrity(db, autoRepair);
  
  // Print report
  console.log("\n" + "=".repeat(80));
  console.log("RESTORE INTEGRITY VALIDATION REPORT");
  console.log("=".repeat(80));
  console.log(`Timestamp: ${results.timestamp}`);
  console.log(`Total Checks: ${results.totalChecks}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(`\nViolations by Severity:`);
  console.log(`  Critical: ${results.summary.critical}`);
  console.log(`  Error: ${results.summary.error}`);
  console.log(`  Warning: ${results.summary.warning}`);
  console.log("=".repeat(80) + "\n");
  
  if (results.violations.length > 0) {
    console.log("VIOLATIONS DETECTED:\n");
    
    for (const violation of results.violations) {
      console.log(`[${violation.severity.toUpperCase()}] ${violation.id}`);
      console.log(`  Collection: ${violation.collection}`);
      console.log(`  Type: ${violation.type}`);
      console.log(`  Description: ${violation.description}`);
      console.log(`  Count: ${violation.count}`);
      
      if (violation.samples.length > 0) {
        console.log(`  Samples:`);
        violation.samples.forEach((sample, idx) => {
          console.log(`    ${idx + 1}. ${JSON.stringify(sample)}`);
        });
      }
      console.log();
    }
    
    console.log("=".repeat(80));
    console.log("❌ INTEGRITY VALIDATION FAILED");
    console.log("=".repeat(80));
    console.log("\nRecommendations:");
    console.log("1. Review violations above and determine root cause");
    console.log("2. For missing/orphaned records, consider running data cleanup");
    console.log("3. For duplicates, investigate merge or deletion strategy");
    console.log("4. For inconsistencies, verify data migration/import process");
    console.log("5. DO NOT restore to production until all CRITICAL violations are resolved\n");
    
    await client.close();
    process.exit(1);
  }
  
  console.log("=".repeat(80));
  console.log("✅ ALL INTEGRITY CHECKS PASSED");
  console.log("=".repeat(80));
  console.log("\nDatabase integrity validation successful.");
  console.log("All records, relationships, and invariants are consistent.\n");
  
  await client.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
main().catch((error) => {
  log("error", "Unhandled error in integrity validation", {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});

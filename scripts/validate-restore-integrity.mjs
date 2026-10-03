#!/usr/bin/env node
/**
 * Enhanced Restore Integrity Validation Script (Issue #3 Enhancement)
 *
 * Validates database integrity after restore or migration:
 *  1. Detects missing records (broken foreign key references)
 *  2. Detects orphaned records (references to deleted/non-existent parents)
 *  3. Detects duplicated records (unique constraint violations)
 *  4. Detects inconsistent records (data invariant violations)
 *  5. Detects stale records that should have progressed (Issue #831)
 *  6. Validates settlement reference chains
 *  7. Read-only by default — never writes to the database
 *
 * The rules and runner live in scripts/lib/integrity-rules.mjs so the
 * read-only monitor (scripts/integrity-monitor.mjs) and tests can reuse them.
 *
 * Usage:
 *   node scripts/validate-restore-integrity.mjs [--auto-repair] [--report-json]
 *
 * Required env vars:
 *   MONGODB_URI — connection string
 *
 * Optional env vars:
 *   MONGODB_DB — database name (default: eduvault)
 *   INTEGRITY_STALE_PENDING_PURCHASE_HOURS — stale pending purchase threshold (default: 24)
 *   INTEGRITY_STALE_DEADLETTER_DAYS        — stale dead-letter threshold (default: 7)
 */

import { MongoClient } from "mongodb";
import {
  buildCategoryReport,
  log,
  validateIntegrity
} from "./lib/integrity-rules.mjs";

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------
async function main() {
  const autoRepair = process.argv.includes("--auto-repair");
  const reportJson = process.argv.includes("--report-json");

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
  if (!reportJson) {
    log("info", "Connected to MongoDB", { database: DB_NAME });
  }

  const db = client.db(DB_NAME);

  // Run validation (read-only)
  const results = await validateIntegrity(db, {
    autoRepair,
    logger: reportJson ? () => {} : log
  });

  if (reportJson) {
    console.log(JSON.stringify(buildCategoryReport(results), null, 2));
    await client.close();
    process.exit(results.failed > 0 ? 1 : 0);
  }

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
    console.log("5. For stale records, check the indexer/worker backlog and thresholds");
    console.log("6. See docs/data-integrity-monitor.md for per-category remediation");
    console.log("7. DO NOT restore to production until all CRITICAL violations are resolved\n");

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

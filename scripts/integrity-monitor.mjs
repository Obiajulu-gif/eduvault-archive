#!/usr/bin/env node
/**
 * EduVault data integrity monitor (Issue #831).
 *
 * Read-only monitor that reports records violating core consistency rules.
 * It NEVER writes to the database — remediation is delegated to dedicated
 * repair scripts (see docs/data-integrity-monitor.md).
 *
 * Failure categories reported:
 *   - orphaned      child rows left behind by a deleted/non-existent parent
 *   - duplicate     rows violating a uniqueness invariant
 *   - stale         rows that should have progressed but have not
 *   - inconsistent  rows violating a data invariant
 *   - missing       broken foreign-key references (referenced row absent)
 *
 * Usage:
 *   node scripts/integrity-monitor.mjs [--json]
 *
 * Required env vars:
 *   MONGODB_URI — connection string
 *
 * Optional env vars:
 *   MONGODB_DB — database name (default: eduvault)
 *   INTEGRITY_STALE_PENDING_PURCHASE_HOURS — stale pending purchase threshold (default: 24)
 *   INTEGRITY_STALE_DEADLETTER_DAYS        — stale dead-letter threshold (default: 7)
 *   INTEGRITY_NOW — ISO timestamp used as "now" (default: current time; useful in tests)
 *
 * Exit code: 0 when clean, 1 when any violation is found (CI-friendly).
 */

import { MongoClient } from "mongodb";
import {
  buildCategoryReport,
  log,
  REPORT_CATEGORIES,
  resolveStaleThresholds,
  validateIntegrity
} from "./lib/integrity-rules.mjs";

function renderHuman(report, thresholds) {
  const lines = [];
  lines.push("");
  lines.push("=".repeat(72));
  lines.push("EDUVAULT DATA INTEGRITY MONITOR (read-only)");
  lines.push("=".repeat(72));
  lines.push(`Timestamp:        ${report.timestamp}`);
  lines.push(`Checks run:       ${report.totalChecks}`);
  lines.push(`Passed / failed:  ${report.passed} / ${report.failed}`);
  lines.push(
    `Stale thresholds: pending>${thresholds.pendingPurchaseHours}h, dead-letter>${thresholds.deadLetterDays}d`
  );
  lines.push("-".repeat(72));
  for (const category of REPORT_CATEGORIES) {
    const bucket = report.categories[category];
    const marker = bucket.count > 0 ? "!" : " ";
    lines.push(`${marker} ${category.padEnd(14)} count=${bucket.count}`);
    if (bucket.checks.length > 0) {
      lines.push(`    checks:     ${bucket.checks.join(", ")}`);
    }
    if (bucket.sampleIds.length > 0) {
      lines.push(`    sample ids: ${bucket.sampleIds.join(", ")}`);
    }
  }
  lines.push("-".repeat(72));
  lines.push(report.clean ? "RESULT: clean" : "RESULT: violations detected (read-only, nothing changed)");
  lines.push(`Remediation: see docs/data-integrity-monitor.md`);
  lines.push("=".repeat(72));
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const asJson = process.argv.includes("--json") || process.argv.includes("--report-json");

  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    log("error", "Missing required environment variable: MONGODB_URI");
    process.exit(1);
  }

  const DB_NAME = process.env.MONGODB_DB || "eduvault";
  const thresholds = resolveStaleThresholds(process.env);
  const now = process.env.INTEGRITY_NOW ? new Date(process.env.INTEGRITY_NOW) : new Date();

  if (Number.isNaN(now.getTime())) {
    log("error", "Invalid INTEGRITY_NOW value", { value: process.env.INTEGRITY_NOW });
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  if (!asJson) {
    log("info", "Connected to MongoDB (read-only monitor)", {
      database: DB_NAME,
      now: now.toISOString(),
      staleThresholdOverrides: thresholds.overrides
    });
  }

  let exitCode = 1;
  try {
    const db = client.db(DB_NAME);
    const results = await validateIntegrity(db, {
      now,
      thresholds,
      logger: asJson ? () => {} : log
    });
    const report = buildCategoryReport(results);

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderHuman(report, thresholds));
    }

    exitCode = report.clean ? 0 : 1;
  } finally {
    await client.close();
  }

  process.exit(exitCode);
}

main().catch((error) => {
  log("error", "Unhandled error in integrity monitor", {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});

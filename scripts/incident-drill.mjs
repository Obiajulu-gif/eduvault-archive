#!/usr/bin/env node
/**
 * Incident drill runner (#948) — the executable half of
 * docs/incident-drill-runbook.md.
 *
 * Runs every registered drill check and prints a PASS/FAIL/SKIPPED report.
 * Nothing here is destructive: database drills only read, and no kill
 * switch or signer is ever actually engaged — see
 * src/lib/ops/incidentDrill.js for what each check does and does not touch.
 *
 * Usage:
 *   node scripts/incident-drill.mjs                 # offline drills only
 *   MONGODB_URI="$URI" node scripts/incident-drill.mjs   # offline + database drills
 *   node scripts/incident-drill.mjs --report-json ./incident-drill.json
 *
 * Also runs two companion scripts' own report modes as additional drill
 * evidence, when a database is configured:
 *   - data-retention-cleanup.mjs --preview   (zero-write guarantee)
 *   - data-minimization-review.mjs           (operational metadata shape)
 *
 * Optional env vars:
 *   MONGODB_URI — when set, database-backed drills run instead of skipping
 *   MONGODB_DB  — database name (default: eduvault)
 */

import { MongoClient } from "mongodb";
import { pathToFileURL } from "node:url";
import { runIncidentDrill, DrillStatus } from "../src/lib/ops/incidentDrill.js";
import { buildPreviewReport } from "./data-retention-cleanup.mjs";
import { runDataMinimizationReview } from "../src/lib/privacy/dataMinimizationReview.js";

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

export function parseArgs(argv) {
  const reportJsonIndex = argv.indexOf("--report-json");
  return {
    reportJson: reportJsonIndex !== -1 ? argv[reportJsonIndex + 1] || null : null,
  };
}

function printDrillResult(result) {
  const marker = result.status === DrillStatus.PASSED ? "PASS" : result.status === DrillStatus.FAILED ? "FAIL" : "SKIP";
  console.log(`  [${marker}] ${result.id}: ${result.message}`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const MONGODB_URI = process.env.MONGODB_URI || null;
  const DB_NAME = process.env.MONGODB_DB || "eduvault";

  let client = null;
  let db = null;
  if (MONGODB_URI) {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    log("info", "Connected to MongoDB — database-backed drills enabled", { database: DB_NAME });
  } else {
    log("info", "MONGODB_URI not set — database-backed drills will be SKIPPED");
  }

  const drillReport = await runIncidentDrill({ db });

  let retentionPreview = null;
  let minimizationReview = null;
  if (db) {
    retentionPreview = await buildPreviewReport(db);
    minimizationReview = await runDataMinimizationReview(db);
  }

  console.log("\n" + "=".repeat(80));
  console.log("INCIDENT DRILL REPORT");
  console.log("=".repeat(80));
  console.log(`Ran At: ${drillReport.ranAt}`);
  console.log(`Checks: ${drillReport.summary.total} (passed ${drillReport.summary.passed}, failed ${drillReport.summary.failed}, skipped ${drillReport.summary.skipped})`);
  console.log("=".repeat(80));
  for (const result of drillReport.results) printDrillResult(result);

  let companionFailed = false;
  if (retentionPreview) {
    const ok = retentionPreview.summary.totalFailed === 0;
    companionFailed ||= !ok;
    console.log(`\n  [${ok ? "PASS" : "FAIL"}] data_retention_preview: zero-write preview — eligible ${retentionPreview.summary.totalEligible}, held ${retentionPreview.summary.totalHeld}, failed ${retentionPreview.summary.totalFailed}.`);
  }
  if (minimizationReview) {
    const ok = minimizationReview.summary.collectionsWithViolations === 0;
    companionFailed ||= !ok;
    console.log(`  [${ok ? "PASS" : "FAIL"}] data_minimization_review: ${minimizationReview.summary.collectionsWithViolations} collection(s) with unexpected fields.`);
  }
  console.log("");

  const fullReport = { ...drillReport, retentionPreview, minimizationReview };

  if (args.reportJson) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.reportJson, JSON.stringify(fullReport, null, 2) + "\n", "utf8");
    log("info", `Drill report written to ${args.reportJson}`);
  }

  if (client) await client.close();

  process.exit(drillReport.ok && !companionFailed ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    log("error", "Unhandled error in incident drill", { error: error.message, stack: error.stack });
    process.exit(1);
  });
}

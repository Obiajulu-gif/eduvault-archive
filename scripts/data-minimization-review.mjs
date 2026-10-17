#!/usr/bin/env node
/**
 * Data minimization review (#954) — companion to data-retention-cleanup.mjs.
 *
 * Retention enforces *how long* operational metadata is kept; this script
 * enforces *what shape* it is kept in. It samples each registered
 * operational metadata collection (src/lib/privacy/dataMinimizationReview.js)
 * and flags any top-level field that the collection's own writer does not
 * produce — a signal that a caller started persisting more than intended
 * (e.g. a raw IP, an email, a request body) into a log meant to stay minimal.
 *
 * This script never writes to the database.
 *
 * Usage:
 *   node scripts/data-minimization-review.mjs
 *   node scripts/data-minimization-review.mjs --report-json ./minimization-review.json
 *
 * Required env vars:
 *   MONGODB_URI — connection string
 *
 * Optional env vars:
 *   MONGODB_DB — database name (default: eduvault)
 *   REVIEW_SAMPLE_LIMIT — documents sampled per collection (default: 100)
 */

import { MongoClient } from "mongodb";
import { pathToFileURL } from "node:url";
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

function printReport(report) {
  console.log("\n" + "=".repeat(80));
  console.log("DATA MINIMIZATION REVIEW");
  console.log("=".repeat(80));
  console.log(`Generated At: ${report.generatedAt}`);
  console.log(`Collections: ${report.summary.totalCollections} ` +
    `(ok ${report.summary.collectionsOk}, violations ${report.summary.collectionsWithViolations}, skipped ${report.summary.collectionsSkipped})`);
  console.log("=".repeat(80));

  for (const entry of report.collections) {
    if (entry.status === "violations") {
      console.log(`\n${entry.collection}: UNEXPECTED FIELDS (sampled ${entry.sampled})`);
      for (const { field, count } of entry.unexpectedFields) {
        console.log(`  - ${field}: present in ${count} sampled document(s)`);
      }
    } else if (entry.status === "skipped") {
      console.log(`\n${entry.collection}: skipped (${entry.reason})`);
    } else {
      console.log(`\n${entry.collection}: ok (sampled ${entry.sampled}, no unexpected fields)`);
    }
  }
  console.log("");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    log("error", "Missing required environment variable: MONGODB_URI");
    process.exit(1);
  }
  const DB_NAME = process.env.MONGODB_DB || "eduvault";
  const limit = Number(process.env.REVIEW_SAMPLE_LIMIT || 100);

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  log("info", "Connected to MongoDB", { database: DB_NAME });

  const db = client.db(DB_NAME);
  const report = await runDataMinimizationReview(db, { limit });
  log("info", "Data minimization review complete", report.summary);
  printReport(report);

  if (args.reportJson) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.reportJson, JSON.stringify(report, null, 2) + "\n", "utf8");
    log("info", `Review report written to ${args.reportJson}`);
  }

  await client.close();
  process.exit(report.summary.collectionsWithViolations > 0 ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    log("error", "Unhandled error in data minimization review", { error: error.message, stack: error.stack });
    process.exit(1);
  });
}

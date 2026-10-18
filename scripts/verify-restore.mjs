#!/usr/bin/env node
/**
 * Restore invariant verification CLI — see docs/restore-invariant-verification.md.
 *
 * Runs after `scripts/restore-verification.mjs` (archive/schema/entitlement
 * decisions) and before promoting a restored database to production. It checks
 * the things that script does not:
 *
 *   1. Derived views reconcile with their sources (entitlement_cache ↔
 *      purchases, material_search_documents ↔ materials).
 *   2. Required/TTL indexes exist (REQUIRED_INDEXES + TTL_INDEXES registry).
 *   3. The hash-chained audit ledger verifies with no gaps.
 *
 * Mismatches fail loudly (exit 1) with explicit repair commands. With
 * `--repair`, derived views/indexes are rebuilt and verification re-runs.
 *
 * Usage:
 *   MONGODB_URI="$STAGING_URI" node scripts/verify-restore.mjs
 *   MONGODB_URI="$STAGING_URI" node scripts/verify-restore.mjs --repair=entitlements
 *   MONGODB_URI="$STAGING_URI" node scripts/verify-restore.mjs --repair           # entitlements + search + indexes
 *
 * Options:
 *   --repair[=all|entitlements|search|indexes]  Apply scoped repairs, then re-verify.
 *   --sample-limit=N                            Violation samples per check (default 25).
 *   --max-scan=N                                Materials scanned for projection drift (default 5000).
 *   --ignore-collection=NAME                    Skip a collection (repeatable; for fresh deploys).
 *
 * Environment:
 *   MONGODB_URI  — required
 *   MONGODB_DB   — database name (default: eduvault)
 *   DRY_RUN      — "true" makes --repair a no-op that logs the plan
 */

import { MongoClient } from "mongodb";
import {
  rebuildEntitlementCache,
  rebuildSearchProjections,
  repairIndexes,
  runRestoreVerification,
} from "../src/lib/ops/restoreVerification.js";

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

function parseArgs(argv) {
  const args = { repair: null, sampleLimit: 25, maxScan: 5000, ignoreCollections: [] };
  for (const arg of argv) {
    if (arg === "--repair") args.repair = "all";
    else if (arg.startsWith("--repair=")) args.repair = arg.slice("--repair=".length);
    else if (arg.startsWith("--sample-limit=")) args.sampleLimit = Number(arg.slice("--sample-limit=".length));
    else if (arg.startsWith("--max-scan=")) args.maxScan = Number(arg.slice("--max-scan=".length));
    else if (arg.startsWith("--ignore-collection=")) args.ignoreCollections.push(arg.slice("--ignore-collection=".length));
  }
  const validRepairs = new Set(["all", "entitlements", "search", "indexes"]);
  if (args.repair && !validRepairs.has(args.repair)) {
    log("error", `Invalid --repair target: ${args.repair}`, { valid: [...validRepairs] });
    process.exit(2);
  }
  return args;
}

function logViolations(report) {
  const samples = report.violations.slice(0, 20);
  for (const violation of samples) {
    log("error", "Restore invariant violation", violation);
  }
  if (report.violations.length > samples.length) {
    log("error", "…more violations", { additional: report.violations.length - samples.length });
  }
}

function logRepairPlan(report) {
  if (!report.repairSteps.length) return;
  for (const step of report.repairSteps) {
    log("warn", "REPAIR STEP", step);
  }
}

async function applyRepairs(db, target, { dryRun }) {
  const applied = {};
  if (dryRun) {
    log("warn", "DRY_RUN=true — repair plan was computed but no writes were made", { target });
    return applied;
  }

  if (target === "all" || target === "entitlements") {
    applied.entitlements = await rebuildEntitlementCache(db);
    log("info", "Rebuilt entitlement cache from purchases", applied.entitlements);
  }
  if (target === "all" || target === "search") {
    applied.search = await rebuildSearchProjections(db);
    log("info", "Reconciled material search projections", applied.search);
  }
  if (target === "all" || target === "indexes") {
    applied.indexes = await repairIndexes(db);
    log("info", "Recreated missing required indexes", applied.indexes);
  }
  return applied;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    log("error", "Missing required MONGODB_URI environment variable");
    process.exit(1);
  }
  const dryRun = process.env.DRY_RUN === "true";
  const dbName = process.env.MONGODB_DB || "eduvault";
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });

  try {
    await client.connect();
    const db = client.db(dbName);

    log("info", "Restore invariant verification starting", {
      db: dbName,
      repair: args.repair || "none",
      sampleLimit: args.sampleLimit,
      maxScan: args.maxScan,
      ignoreCollections: args.ignoreCollections,
    });

    let report = await runRestoreVerification({
      db,
      options: { sampleLimit: args.sampleLimit, maxScan: args.maxScan, ignoreCollections: args.ignoreCollections },
    });

    log("info", "Verification report", {
      ok: report.ok,
      violationCount: report.violationCount,
      checks: {
        entitlements: { ok: report.checks.entitlements.ok, missing: report.checks.entitlements.missing, extra: report.checks.entitlements.extra, mismatched: report.checks.entitlements.mismatched },
        search: { ok: report.checks.search.ok, missing: report.checks.search.missing, stale: report.checks.search.stale, unauthorized: report.checks.search.unauthorized },
        indexes: { ok: report.checks.indexes.ok, required: report.checks.indexes.indexesRequired, violations: report.checks.indexes.violations.length },
        audit: { ok: report.checks.audit.ok, records: report.checks.audit.records, brokenAtSequence: report.checks.audit.brokenAtSequence },
      },
      metrics: report.metrics,
    });

    if (report.ok) {
      log("info", "Restore invariant verification PASSED — derived views, indexes, and audit chain are consistent");
      process.exit(0);
    }

    logViolations(report);
    logRepairPlan(report);

    if (!args.repair) {
      log("error", "Restore invariant verification FAILED — restore must not be promoted. Apply the repair steps above (or re-run with --repair) and verify again.");
      process.exit(1);
    }

    const applied = await applyRepairs(db, args.repair, { dryRun });

    // Re-verify after repairs so the exit code reflects the final state.
    report = await runRestoreVerification({
      db,
      options: { sampleLimit: args.sampleLimit, maxScan: args.maxScan, ignoreCollections: args.ignoreCollections },
    });

    if (report.ok) {
      log("info", "Repairs applied and re-verification PASSED", { applied });
      process.exit(0);
    }

    logViolations(report);
    log("error", "Restore invariant verification STILL FAILING after repairs", {
      applied,
      violationCount: report.violationCount,
      repairable: report.repairSteps.map((step) => step.code),
      hint: "Audit-chain breakage is never auto-repaired — preserve evidence and investigate manually.",
    });
    process.exit(1);
  } catch (error) {
    log("error", "Restore invariant verification crashed", { error: String(error?.message || error) });
    process.exit(1);
  } finally {
    await client.close().catch(() => {});
  }
}

main();

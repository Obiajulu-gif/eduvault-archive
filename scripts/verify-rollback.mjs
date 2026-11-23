#!/usr/bin/env node
/**
 * Rollback verification CLI — see docs/rollback-verification.md.
 *
 * Use around a migration or deployment that is not driven through
 * runWithRollbackVerification (for example a platform deploy):
 *
 *   1. Before the change, capture a fingerprint of the data it can touch:
 *        node scripts/verify-rollback.mjs capture --targets=materials,purchases --out=pre-deploy.json
 *   2. If the change fails and you roll back, prove the data is back:
 *        node scripts/verify-rollback.mjs verify --before=pre-deploy.json
 *
 * Options:
 *   --targets=a,b           Collections to fingerprint (capture).
 *   --out=FILE              Fingerprint file to write (capture).
 *   --before=FILE           Fingerprint file to verify against (verify).
 *   --max-scan=N            Documents hashed per collection (capture, default 10000).
 *   --migration-id=ID       Also warn about checkpoints this migration left open (verify).
 *   --restore-invariants    Also run the restore invariants (entitlements, search, indexes, audit chain).
 *
 * Exit codes: 0 verified, 1 drift, 2 usage error, 3 could not verify (database unreadable).
 *
 * Environment: MONGODB_URI (required), MONGODB_DB (default: eduvault).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { captureFingerprint, verifyRollback, VerificationStatus } from "../src/lib/migrations/rollbackVerification.js";
import { runRestoreVerification } from "../src/lib/ops/restoreVerification.js";

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, targets: [], maxScan: 10_000, restoreInvariants: false };
  for (const arg of rest) {
    if (arg.startsWith("--targets=")) args.targets = arg.slice("--targets=".length).split(",").map((t) => t.trim()).filter(Boolean);
    else if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length);
    else if (arg.startsWith("--before=")) args.before = arg.slice("--before=".length);
    else if (arg.startsWith("--max-scan=")) args.maxScan = Number(arg.slice("--max-scan=".length));
    else if (arg.startsWith("--migration-id=")) args.migrationId = arg.slice("--migration-id=".length);
    else if (arg === "--restore-invariants") args.restoreInvariants = true;
  }
  const usageError = (message) => {
    log("error", message);
    process.exit(2);
  };
  if (!["capture", "verify"].includes(command)) usageError("First argument must be capture or verify");
  if (command === "capture" && (!args.targets.length || !args.out)) usageError("capture needs --targets and --out");
  if (command === "verify" && !args.before) usageError("verify needs --before");
  if (!Number.isInteger(args.maxScan) || args.maxScan <= 0) usageError("--max-scan must be a positive integer");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MONGODB_URI) {
    log("error", "Missing required MONGODB_URI environment variable");
    process.exit(2);
  }
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || "eduvault");

    if (args.command === "capture") {
      const fingerprint = await captureFingerprint(db, { targets: args.targets, maxScan: args.maxScan });
      writeFileSync(args.out, JSON.stringify(fingerprint, null, 2), "utf-8");
      log("info", "Fingerprint written", { out: args.out, collections: fingerprint.collections });
      process.exit(0);
    }

    const before = JSON.parse(readFileSync(args.before, "utf-8"));
    const invariants = args.restoreInvariants
      ? [{
          name: "restore-invariants",
          run: async () => {
            const report = await runRestoreVerification({ db });
            return { ok: report.ok, message: report.ok ? null : `${report.violationCount} violation(s)` };
          },
        }]
      : [];
    const result = await verifyRollback({ db, before, invariants, migrationId: args.migrationId });

    for (const difference of result.differences) log(difference.severity === "error" ? "error" : "warn", "Difference", difference);
    for (const invariant of result.invariants.filter((i) => !i.ok)) log("error", "Invariant failed", invariant);
    for (const warning of result.warnings) log("warn", warning);
    log(result.status === VerificationStatus.VERIFIED ? "info" : "error", `Rollback verification: ${result.status}`, { recommendation: result.recommendation });

    process.exit({ [VerificationStatus.VERIFIED]: 0, [VerificationStatus.DRIFT]: 1, [VerificationStatus.UNVERIFIABLE]: 3 }[result.status]);
  } catch (error) {
    log("error", "Rollback verification crashed", { error: String(error?.message || error) });
    process.exit(3);
  } finally {
    await client.close().catch(() => {});
  }
}

main();

#!/usr/bin/env node
/**
 * IPFS Content Repair Job with Gateway Quorum Checks — Issue #1204
 *
 * Verifies that material storageKeys (CIDs) satisfy an independent multi-gateway
 * availability quorum. Detects degraded pins, re-pins from reachable gateways to
 * restore redundancy, and quarantines unreachable assets.
 *
 * Usage:
 *   MONGODB_URI=$URI node scripts/repair-ipfs-content.mjs                       # dry-run
 *   MONGODB_URI=$URI node scripts/repair-ipfs-content.mjs --apply               # execute repair
 *   MONGODB_URI=$URI node scripts/repair-ipfs-content.mjs --quorum=2 --apply
 *   MONGODB_URI=$URI node scripts/repair-ipfs-content.mjs --target-cid=<cid>
 *   MONGODB_URI=$URI node scripts/repair-ipfs-content.mjs --target-material=<id>
 *   MONGODB_URI=$URI node scripts/repair-ipfs-content.mjs --json
 *
 * Environment variables:
 *   MONGODB_URI       — MongoDB connection string (required)
 *   MONGODB_DB        — Database name (default: eduvault)
 *   IPFS_GATEWAYS     — Comma-separated gateway base URLs
 *   REQUIRED_QUORUM   — Minimum responding gateways required (default: 2)
 *   DRY_RUN           — Set to "true" to force dry-run mode
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import {
  runIpfsContentRepairJob,
  DEFAULT_IPFS_GATEWAYS,
} from "../src/lib/storage/ipfsContentRepair.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env.local"), override: false });
config({ path: resolve(__dirname, "../.env"), override: false });

function log(level, message, extra = {}) {
  process.stdout.write(
    `${JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra })}\n`
  );
}

const args = process.argv.slice(2);
const isApply = args.includes("--apply") && process.env.DRY_RUN !== "true";
const isJson = args.includes("--json");

const quorumArg = args.find((a) => a.startsWith("--quorum="));
const requiredQuorum = quorumArg
  ? parseInt(quorumArg.split("=")[1], 10)
  : Number(process.env.REQUIRED_QUORUM || 2);

const cidArg = args.find((a) => a.startsWith("--target-cid="));
const targetCid = cidArg ? cidArg.split("=")[1] : null;

const matArg = args.find((a) => a.startsWith("--target-material="));
const targetMaterialId = matArg ? matArg.split("=")[1] : null;

const gatewaysEnv = process.env.IPFS_GATEWAYS
  ? process.env.IPFS_GATEWAYS.split(",").map((g) => g.trim())
  : DEFAULT_IPFS_GATEWAYS;

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "eduvault";

if (!MONGODB_URI) {
  log("error", "MONGODB_URI is required. Aborting.");
  process.exit(1);
}

async function main() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db(MONGODB_DB);

    log("info", "Starting IPFS content repair job with gateway quorum checks", {
      dryRun: !isApply,
      requiredQuorum,
      gatewaysCount: gatewaysEnv.length,
      targetCid,
      targetMaterialId,
    });

    const summary = await runIpfsContentRepairJob(db, {
      dryRun: !isApply,
      requiredQuorum,
      targetCid,
      targetMaterialId,
      gateways: gatewaysEnv,
      actor: { role: "system", isCli: true, id: "cli-operator" },
    });

    if (isJson) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } else {
      log("info", "IPFS content repair job completed", {
        runId: summary.runId,
        dryRun: summary.dryRun,
        scanned: summary.scanned,
        healthy: summary.healthy,
        degraded: summary.degraded,
        unreachable: summary.unreachable,
        repaired: summary.repaired,
        quarantined: summary.quarantined,
        failuresCount: summary.failures.length,
        durationMs: summary.durationMs,
      });

      if (summary.failures.length > 0) {
        log("warn", "Failures during IPFS repair", { failures: summary.failures });
      }
    }
  } catch (err) {
    log("error", "IPFS content repair job failed", { error: err.message, stack: err.stack });
    process.exit(1);
  } finally {
    await client.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

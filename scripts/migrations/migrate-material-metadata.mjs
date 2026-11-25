#!/usr/bin/env node
/**
 * Versioned Material Metadata Migration CLI Runner
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-material-metadata.mjs --dry-run
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-material-metadata.mjs --target-version=3
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-material-metadata.mjs --rollback --run-id=<id>
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-material-metadata.mjs --retry --run-id=<id>
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-material-metadata.mjs --status --json
 */

import { MongoClient } from "mongodb";
import {
  CURRENT_METADATA_VERSION,
  getMaterialMetadataMigrationStatus,
  migrateMaterialMetadata,
  retryMaterialMetadataMigration,
  rollbackMaterialMetadataMigration,
} from "../../src/lib/migrations/materialMetadataMigration.js";

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "eduvault";

if (!MONGODB_URI) {
  console.error("[migrate-material-metadata] ERROR: MONGODB_URI is required.");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rollback = args.includes("--rollback");
const retry = args.includes("--retry");
const statusOnly = args.includes("--status");
const force = args.includes("--force");
const noAutoRollback = args.includes("--no-auto-rollback");
const isJson = args.includes("--json");

function getArgValue(prefix) {
  const match = args.find((a) => a.startsWith(`${prefix}=`));
  return match ? match.slice(prefix.length + 1) : undefined;
}

const runId = getArgValue("--run-id");
const targetVersionArg = getArgValue("--target-version");
const targetVersion = targetVersionArg ? Number(targetVersionArg) : CURRENT_METADATA_VERSION;
const batchSizeArg = getArgValue("--batch-size");
const batchSize = batchSizeArg ? Number(batchSizeArg) : 100;

const actor = {
  id: process.env.ACTOR_ID || "cli-deployer",
  role: process.env.ACTOR_ROLE || "deployer",
};

async function main() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);

    let result;
    if (statusOnly) {
      result = await getMaterialMetadataMigrationStatus(db);
    } else if (rollback) {
      result = await rollbackMaterialMetadataMigration(db, {
        runId,
        actor,
        force,
      });
    } else if (retry) {
      result = await retryMaterialMetadataMigration(db, {
        runId,
        actor,
        batchSize,
        autoRollback: noAutoRollback ? false : undefined,
        force,
      });
    } else {
      result = await migrateMaterialMetadata(db, {
        actor,
        targetVersion,
        runId,
        dryRun,
        batchSize,
        autoRollback: !noAutoRollback,
      });
    }

    if (isJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      console.log("[migrate-material-metadata] Result:");
      console.dir(result, { depth: null });
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("[migrate-material-metadata] Fatal error:", err);
  process.exit(1);
});

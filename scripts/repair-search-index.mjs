#!/usr/bin/env node
/**
 * Search-index repair for archived, permission-changed, and stale materials — Issue #1181
 *
 * Implements the repair job documented in docs/marketplace-search-strategy.md:
 *   1. Scans material_search_documents for documents that are archived, deleted,
 *      revoked, private, or older than SEARCH_INDEX_MAX_AGE_MS.
 *   2. Reprojects the corresponding material from the authoritative materials collection
 *      or deletes the stale document and tombstones it when the material is no longer indexable.
 *   3. Scans indexable materials missing from the search collection and upserts them.
 *
 * Usage:
 *   MONGODB_URI=$URI node scripts/repair-search-index.mjs                    # dry-run
 *   MONGODB_URI=$URI node scripts/repair-search-index.mjs --apply            # apply repairs
 *   MONGODB_URI=$URI node scripts/repair-search-index.mjs --target <id>      # single item dry-run
 *   MONGODB_URI=$URI node scripts/repair-search-index.mjs --target <id> --apply
 *   MONGODB_URI=$URI node scripts/repair-search-index.mjs --rollback <runId> # rollback previous run
 *   MONGODB_URI=$URI node scripts/repair-search-index.mjs --json
 *
 * Environment variables:
 *   MONGODB_URI                — MongoDB connection string (required)
 *   MONGODB_DB                 — Database name (default: eduvault)
 *   SEARCH_INDEX_MAX_AGE_MS    — Max age threshold for stale projections (default: 3600000)
 *   SEARCH_INDEX_REPAIR_LIMIT  — Max documents to examine (default: 500)
 *   DRY_RUN                    — Force dry-run if "true"
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import {
  repairSearchIndex,
  rollbackSearchIndexRepair,
} from "../src/lib/backend/searchIndexRepair.js";

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
const targetIdx = args.indexOf("--target");
const targetId = targetIdx !== -1 && args[targetIdx + 1] ? args[targetIdx + 1] : null;
const rollbackIdx = args.indexOf("--rollback");
const rollbackRunId = rollbackIdx !== -1 && args[rollbackIdx + 1] ? args[rollbackIdx + 1] : null;

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "eduvault";
const maxAgeMs = Number(process.env.SEARCH_INDEX_MAX_AGE_MS || 3600000);
const limit = Number(process.env.SEARCH_INDEX_REPAIR_LIMIT || 500);

if (!MONGODB_URI) {
  log("error", "MONGODB_URI is required. Aborting.");
  process.exit(1);
}

async function main() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db(MONGODB_DB);

    if (rollbackRunId) {
      log("info", "Starting search-index repair rollback", { runId: rollbackRunId });
      const rollbackResult = await rollbackSearchIndexRepair(db, {
        runId: rollbackRunId,
        actor: { role: "system", isCli: true, id: "cli-operator" },
      });

      if (isJson) {
        process.stdout.write(`${JSON.stringify(rollbackResult)}\n`);
      } else {
        log("info", "Rollback completed successfully", rollbackResult);
      }
      return;
    }

    log("info", "Starting search-index repair job", {
      dryRun: !isApply,
      targetId,
      limit,
      maxAgeMs,
    });

    const summary = await repairSearchIndex(db, {
      dryRun: !isApply,
      targetId,
      limit,
      maxAgeMs,
      actor: { role: "system", isCli: true, id: "cli-operator" },
    });

    if (isJson) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } else {
      log("info", "Search-index repair completed", {
        runId: summary.runId,
        dryRun: summary.dryRun,
        scanned: summary.scanned,
        repaired: summary.repaired,
        removed: summary.removed,
        missing: summary.missing,
        stale: summary.stale,
        unauthorized: summary.unauthorized,
        orphaned: summary.orphaned,
        failuresCount: summary.failures.length,
        durationMs: summary.durationMs,
      });

      if (summary.failures.length > 0) {
        log("warn", "Encountered failures during repair", { failures: summary.failures });
      }
    }
  } catch (err) {
    log("error", "Search-index repair failed", { error: err.message, stack: err.stack });
    process.exit(1);
  } finally {
    await client.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

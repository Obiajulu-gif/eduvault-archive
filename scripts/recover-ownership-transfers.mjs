#!/usr/bin/env node
/**
 * Cron companion to recoverStuckTransfers in src/lib/ownership/ownershipTransfer.js:
 * expires overdue pending ownership-transfer offers and settles abandoned accepts.
 * Expiry is also enforced lazily on every read/write, so a missed run is safe;
 * the sweep is idempotent and may run from several workers.
 *
 * Usage:
 *   MONGODB_URI="$URI" node scripts/recover-ownership-transfers.mjs
 *
 * Environment:
 *   MONGODB_URI — required
 *   MONGODB_DB  — database name (default: eduvault)
 *   OWNERSHIP_RECOVERY_LIMIT — max transfers per state per sweep (default 100)
 */

import { MongoClient } from "mongodb";
import { recoverStuckTransfers } from "../src/lib/ownership/ownershipTransfer.js";

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

if (!process.env.MONGODB_URI) {
  log("error", "Missing required MONGODB_URI environment variable");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });

try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "eduvault");
  const summary = await recoverStuckTransfers(db, { limit: Number(process.env.OWNERSHIP_RECOVERY_LIMIT || 100) });
  log("info", "Ownership transfer recovery sweep complete", summary);
  process.exitCode = 0;
} catch (error) {
  log("error", "Ownership transfer recovery sweep failed", { error: String(error?.message || error) });
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}

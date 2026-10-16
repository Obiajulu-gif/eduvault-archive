#!/usr/bin/env node
/**
 * Expire stale support sessions — cron companion to
 * `src/lib/auth/supportAccess.js`.
 *
 * Sessions always carry an `expiresAt` that is enforced on every validation
 * (even if this script never runs), but the sweep keeps the
 * `support_sessions` collection statuses honest and writes one summary
 * `support.access_expired` record to the immutable audit ledger per batch.
 *
 * Usage:
 *   MONGODB_URI="$URI" node scripts/expire-support-sessions.mjs
 *   MONGODB_URI="$URI" DRY_RUN=true node scripts/expire-support-sessions.mjs
 *
 * Suggested schedule: every 15 minutes (support TTLs are 5–60 minutes).
 * Environment:
 *   MONGODB_URI — required
 *   MONGODB_DB  — database name (default: eduvault)
 *   DRY_RUN     — "true" counts expired sessions without writing
 *   SUPPORT_EXPIRY_LIMIT — max sessions per sweep (default 200)
 */

import { MongoClient } from "mongodb";
import { expireSupportSessions } from "../src/lib/auth/supportAccess.js";
import { COLLECTIONS } from "../src/lib/backend/schemaContracts.js";

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  log("error", "Missing required MONGODB_URI environment variable");
  process.exit(1);
}

const DB_NAME = process.env.MONGODB_DB || "eduvault";
const DRY_RUN = process.env.DRY_RUN === "true";
const LIMIT = Number(process.env.SUPPORT_EXPIRY_LIMIT || 200);

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });

try {
  await client.connect();
  const db = client.db(DB_NAME);
  const now = new Date();

  if (DRY_RUN) {
    const candidates = await db
      .collection(COLLECTIONS.supportSessions)
      .find({ status: "active", expiresAt: { $lte: now } })
      .limit(LIMIT)
      .toArray();
    log("info", "DRY_RUN=true — no writes performed", { expiredCandidates: candidates.length });
    process.exit(0);
  }

  const result = await expireSupportSessions({ db, now: () => now, limit: LIMIT });
  log("info", "Support session expiry sweep complete", result);
  process.exit(0);
} catch (error) {
  log("error", "Support session expiry sweep failed", { error: String(error?.message || error) });
  process.exit(1);
} finally {
  await client.close().catch(() => {});
}

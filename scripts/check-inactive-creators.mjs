/**
 * Background checker — inactive creator profiles
 *
 * Identifies creator profiles that have not been active for more than
 * INACTIVE_THRESHOLD_DAYS (default 180). For each inactive creator:
 *
 *   1. Sends an inactivity reminder email (at most once per run cycle).
 *   2. Flags their published materials as low-relevance so they rank
 *      lower in marketplace discovery results.
 *
 * Usage:
 *   node scripts/check-inactive-creators.mjs
 *
 * Environment variables:
 *   MONGODB_URI            — required; MongoDB connection string
 *   MONGODB_DB             — optional; database name (default: "eduvault")
 *   DRY_RUN                — optional; "true" to log matches without mutating
 *   INACTIVE_THRESHOLD_DAYS — optional; days before a profile is inactive (default: 180)
 *   SKIP_EMAIL             — optional; "true" to skip sending reminder emails
 *   BATCH_SIZE             — optional; users per query batch (default: 100)
 */

import { MongoClient } from "mongodb";
import { sendInactivityReminder } from "../src/lib/email/inactivityReminder.js";

// ── Config ────────────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "eduvault";
const DRY_RUN = process.env.DRY_RUN === "true";
const SKIP_EMAIL = process.env.SKIP_EMAIL === "true";
const INACTIVE_THRESHOLD_DAYS = Number(process.env.INACTIVE_THRESHOLD_DAYS ?? "180");
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "100");

if (!MONGODB_URI) {
  console.error("[check-inactive-creators] MONGODB_URI is not set. Aborting.");
  process.exit(1);
}

if (!Number.isFinite(INACTIVE_THRESHOLD_DAYS) || INACTIVE_THRESHOLD_DAYS <= 0) {
  console.error(`[check-inactive-creators] Invalid INACTIVE_THRESHOLD_DAYS: "${process.env.INACTIVE_THRESHOLD_DAYS}". Must be a positive number.`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cutoffDate(days = INACTIVE_THRESHOLD_DAYS) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function cutoffISO(days = INACTIVE_THRESHOLD_DAYS) {
  return cutoffDate(days).toISOString();
}

/**
 * Build the MongoDB query for inactive creators.
 *
 * A user is considered inactive when:
 *   - Their `updatedAt` is older than the threshold, OR
 *   - They have no `updatedAt` and their `createdAt` is older than the threshold
 *
 * We also exclude users who were already reminded within the current cycle
 * (tracked via `lastInactivityReminderAt`).
 */
function buildInactiveQuery(cutoff, reminderCutoff) {
  return {
    $or: [
      { updatedAt: { $lt: cutoff } },
      { updatedAt: { $exists: false }, createdAt: { $lt: cutoff } },
    ],
    // Skip users already reminded since the last cycle boundary
    $or: [
      { lastInactivityReminderAt: { $exists: false } },
      { lastInactivityReminderAt: { $lt: reminderCutoff } },
    ],
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const label = DRY_RUN ? "[DRY RUN] " : "";
  const thresholdCutoff = cutoffISO();
  // Reminder dedup boundary: use the same threshold so a user is only
  // reminded once per cycle (each run uses the current time as the cycle start).
  const reminderCutoff = new Date(0).toISOString();

  console.log(`[check-inactive-creators] ${label}Starting. Threshold: ${INACTIVE_THRESHOLD_DAYS} days (cutoff: ${thresholdCutoff})`);

  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const users = db.collection("users");
    const materials = db.collection("materials");

    const query = buildInactiveQuery(thresholdCutoff, reminderCutoff);
    const totalCount = await users.countDocuments(query);
    console.log(`[check-inactive-creators] ${label}Found ${totalCount} inactive creator(s).`);

    if (totalCount === 0) {
      console.log("[check-inactive-creators] Nothing to do.");
      return;
    }

    let processed = 0;
    let emailsSent = 0;
    let emailsFailed = 0;
    let materialsDemoted = 0;

    // Process in batches to avoid loading all users into memory
    const cursor = users.find(query).sort({ updatedAt: 1 }).batchSize(BATCH_SIZE);

    while (await cursor.hasNext()) {
      const user = await cursor.next();
      processed++;

      const userAddress = user.walletAddress || user.walletAddressLower || null;
      const userName = user.fullName || user.displayName || user.email || "Creator";
      const userEmail = user.email;

      // Calculate how long the user has been inactive
      const lastActivity = user.updatedAt
        ? new Date(user.updatedAt)
        : user.createdAt
          ? new Date(user.createdAt)
          : new Date(0);
      const inactiveDays = Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24));

      // Count the user's published materials
      const materialQuery = userAddress
        ? { userAddress, visibility: { $in: ["public", "unlisted"] } }
        : { $or: [{ userAddress: null }, { userAddress: { $exists: false } }], visibility: { $in: ["public", "unlisted"] } };

      const materialCount = await materials.countDocuments(materialQuery);

      if (materialCount === 0) {
        console.log(`[check-inactive-creators] ${label}Skipping ${userName} — no published materials.`);
        continue;
      }

      // Flag materials as low-relevance
      if (!DRY_RUN && materialCount > 0) {
        const demoteResult = await materials.updateMany(
          { ...materialQuery, relevanceStatus: { $ne: "low" } },
          { $set: { relevanceStatus: "low", relevanceFlaggedAt: new Date() } }
        );
        materialsDemoted += demoteResult.modifiedCount;
        console.log(`[check-inactive-creators] ${label}Flagged ${demoteResult.modifiedCount} material(s) as low-relevance for ${userName}.`);
      } else {
        materialsDemoted += materialCount;
        console.log(`[check-inactive-creators] ${label}Would flag ${materialCount} material(s) as low-relevance for ${userName}.`);
      }

      // Send reminder email
      if (!DRY_RUN && !SKIP_EMAIL && userEmail) {
        try {
          await sendInactivityReminder(userEmail, userName, inactiveDays, {
            materialCount,
            demotedCount: materialCount,
          });
          emailsSent++;
          console.log(`[check-inactive-creators] ${label}Sent reminder to ${userEmail}.`);

          // Mark the user as reminded to prevent duplicate emails in future runs
          await users.updateOne(
            { _id: user._id },
            { $set: { lastInactivityReminderAt: new Date() } }
          );
        } catch (err) {
          emailsFailed++;
          console.error(`[check-inactive-creators] Failed to send email to ${userEmail}:`, err.message);
        }
      } else if (DRY_RUN) {
        console.log(`[check-inactive-creators] ${label}Would send reminder to ${userEmail || "(no email)"}.`);
      } else if (SKIP_EMAIL) {
        console.log(`[check-inactive-creators] ${label}Email skipped (SKIP_EMAIL=true) for ${userName}.`);
      }
    }

    await cursor.close();

    console.log("\n[check-inactive-creators] ─── Summary ───");
    console.log(`  Inactive creators found:  ${totalCount}`);
    console.log(`  Processed (with materials): ${processed}`);
    console.log(`  Materials flagged low-relevance: ${materialsDemoted}`);
    if (!SKIP_EMAIL) {
      console.log(`  Emails sent:              ${emailsSent}`);
      console.log(`  Emails failed:            ${emailsFailed}`);
    }
    console.log("[check-inactive-creators] Done.");
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  console.error("[check-inactive-creators] Fatal error:", err);
  process.exit(1);
});

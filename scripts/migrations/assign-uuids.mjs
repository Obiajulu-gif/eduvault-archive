/**
 * Migration: Assign UUIDs to legacy users
 *
 * Finds all user documents in the `users` collection that are missing a `uuid`
 * field and backfills each with a freshly generated crypto.randomUUID() value.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/migrations/assign-uuids.mjs
 *
 * Safe to re-run — only touches documents where uuid is absent.
 * Requires Node 18+ for crypto.randomUUID().
 */

import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "eduvault";

if (!MONGODB_URI) {
  console.error("[assign-uuids] ERROR: MONGODB_URI environment variable is not set.");
  process.exit(1);
}

async function run() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log("[assign-uuids] Connected to MongoDB.");

    const db = client.db(DB_NAME);
    const users = db.collection("users");

    // Find all users missing a uuid field
    const cursor = users.find({ uuid: { $exists: false } });
    const total = await users.countDocuments({ uuid: { $exists: false } });

    if (total === 0) {
      console.log("[assign-uuids] No users are missing a uuid. Nothing to do.");
      return;
    }

    console.log(`[assign-uuids] Found ${total} user(s) without a uuid. Starting migration...`);

    let processed = 0;
    let failed = 0;

    for await (const user of cursor) {
      const uuid = crypto.randomUUID();
      try {
        await users.updateOne(
          { _id: user._id, uuid: { $exists: false } }, // guard against races
          { $set: { uuid } }
        );
        processed++;
        if (processed % 100 === 0) {
          console.log(`[assign-uuids] Progress: ${processed}/${total}`);
        }
      } catch (err) {
        console.error(`[assign-uuids] Failed to update user ${user._id}: ${err.message}`);
        failed++;
      }
    }

    console.log(
      `[assign-uuids] Done. Processed: ${processed}, Failed: ${failed}, Total: ${total}`
    );

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await client.close();
    console.log("[assign-uuids] MongoDB connection closed.");
  }
}

run().catch((err) => {
  console.error("[assign-uuids] Unhandled error:", err.message);
  process.exit(1);
});

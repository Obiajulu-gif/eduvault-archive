/**
 * Migration: assign-uuids
 *
 * Generates and writes RFC 4122 UUID v4 values to all user documents that
 * currently lack a `uuid` field. Safe to re-run — documents that already
 * have a `uuid` are skipped. No existing user metadata is deleted.
 *
 * Usage:
 *   node scripts/migrations/assign-uuids.js
 *
 * Required env: MONGODB_URI, MONGODB_DB
 */

import { MongoClient } from "mongodb";
import { v4 as uuidv4 } from "uuid";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "eduvault";

if (!uri) {
  console.error("Error: MONGODB_URI env var is required");
  process.exit(1);
}

async function run() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const users = db.collection("users");

  const cursor = users.find({ uuid: { $exists: false } }, { projection: { _id: 1 } });

  let updated = 0;
  let failed = 0;

  for await (const doc of cursor) {
    try {
      await users.updateOne(
        { _id: doc._id, uuid: { $exists: false } },
        { $set: { uuid: uuidv4(), updatedAt: new Date().toISOString() } }
      );
      updated++;
    } catch (err) {
      console.error(`Failed to update user ${doc._id}:`, err.message);
      failed++;
    }
  }

  await cursor.close();
  await client.close();

  console.log(`Migration complete: ${updated} updated, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

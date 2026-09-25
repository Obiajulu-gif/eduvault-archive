/**
 * Migration: Backfill previewImages for materials
 *
 * Finds all material documents in the `materials` collection that are missing a `previewImages`
 * field and backfills each with an empty array.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/migrations/backfill-preview-images.mjs
 *
 * Safe to re-run — only touches documents where previewImages is absent.
 */

import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "eduvault";

if (!MONGODB_URI) {
  console.error("[backfill-preview-images] ERROR: MONGODB_URI environment variable is not set.");
  process.exit(1);
}

async function run() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log("[backfill-preview-images] Connected to MongoDB.");

    const db = client.db(DB_NAME);
    const materials = db.collection("materials");

    // Find all materials missing a previewImages field
    const cursor = materials.find({ previewImages: { $exists: false } });
    const total = await materials.countDocuments({ previewImages: { $exists: false } });

    if (total === 0) {
      console.log("[backfill-preview-images] No materials are missing previewImages. Nothing to do.");
      return;
    }

    console.log(`[backfill-preview-images] Found ${total} material(s) without previewImages. Starting migration...`);

    let processed = 0;
    let failed = 0;

    for await (const material of cursor) {
      try {
        await materials.updateOne(
          { _id: material._id, previewImages: { $exists: false } }, // guard against races
          { $set: { previewImages: [] } }
        );
        processed++;
        if (processed % 100 === 0) {
          console.log(`[backfill-preview-images] Progress: ${processed}/${total}`);
        }
      } catch (err) {
        console.error(`[backfill-preview-images] Failed to update material ${material._id}: ${err.message}`);
        failed++;
      }
    }

    console.log(
      `[backfill-preview-images] Done. Processed: ${processed}, Failed: ${failed}, Total: ${total}`
    );

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await client.close();
    console.log("[backfill-preview-images] MongoDB connection closed.");
  }
}

run().catch((err) => {
  console.error("[backfill-preview-images] Unhandled error:", err.message);
  process.exit(1);
});

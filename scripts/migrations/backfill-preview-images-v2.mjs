/**
 * Operator-safe backfill: previewImages for materials.
 *
 * Same end state as `backfill-preview-images.mjs`, but built on
 * `scripts/lib/backfill-runner.mjs` so it is:
 *
 *   - dry-run by default -- pass --execute to actually write.
 *   - resumable -- a checkpoint file records the last processed _id, so a
 *     killed run picks up where it left off on the next invocation instead
 *     of rescanning from the start.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/migrations/backfill-preview-images-v2.mjs
 *       # dry-run: reports the diff, writes nothing
 *   MONGODB_URI=mongodb://... node scripts/migrations/backfill-preview-images-v2.mjs --execute
 *       # applies the backfill, resumable if interrupted
 *   MONGODB_URI=mongodb://... node scripts/migrations/backfill-preview-images-v2.mjs --execute --reset-checkpoint
 *       # ignores any existing checkpoint and starts over
 */

import { MongoClient } from 'mongodb';
import { existsSync, unlinkSync } from 'node:fs';
import { runBackfill, formatDiffReport } from '../lib/backfill-runner.mjs';

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'eduvault';
const CHECKPOINT_PATH = '.backfill-checkpoints/preview-images-v2.json';

if (!MONGODB_URI) {
  console.error('[backfill-preview-images-v2] ERROR: MONGODB_URI environment variable is not set.');
  process.exit(1);
}

const args = process.argv.slice(2);
const execute = args.includes('--execute');

if (args.includes('--reset-checkpoint') && existsSync(CHECKPOINT_PATH)) {
  unlinkSync(CHECKPOINT_PATH);
  console.log('[backfill-preview-images-v2] Checkpoint cleared.');
}

async function run() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    console.log(`[backfill-preview-images-v2] Connected to MongoDB. Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}.`);

    const db = client.db(DB_NAME);
    const materials = db.collection('materials');

    const result = await runBackfill({
      collection: materials,
      query: { previewImages: { $exists: false } },
      computeUpdate: () => ({ previewImages: [] }),
      checkpointPath: CHECKPOINT_PATH,
      execute,
      log: (line) => console.log(line),
    });

    console.log('[backfill-preview-images-v2] ' + formatDiffReport(result.diffs));
    console.log(
      `[backfill-preview-images-v2] Done. processed=${result.processed} ` +
        `updated=${result.updated} skipped=${result.skipped} failed=${result.failed}`,
    );

    if (!execute && result.updated > 0) {
      console.log('[backfill-preview-images-v2] Dry run only -- re-run with --execute to apply.');
    }

    if (result.failed > 0) {
      process.exitCode = 1;
    } else if (execute && existsSync(CHECKPOINT_PATH)) {
      // A fully successful execute run doesn't need its checkpoint anymore;
      // leaving it behind would make the *next* unrelated run of this same
      // script think it should resume mid-way through a job that already
      // finished.
      unlinkSync(CHECKPOINT_PATH);
    }
  } finally {
    await client.close();
    console.log('[backfill-preview-images-v2] MongoDB connection closed.');
  }
}

run().catch((err) => {
  console.error('[backfill-preview-images-v2] Unhandled error:', err.message);
  process.exit(1);
});

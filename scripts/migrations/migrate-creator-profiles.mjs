/**
 * Migration Runner: Creator Profiles Dual-Wallet Schema (v2)
 *
 * Implements Issue #747:
 * Idempotent, resumable batch migration populating dual-wallet fields
 * (Stellar + EVM) alongside legacy single-wallet fields.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-creator-profiles.mjs
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-creator-profiles.mjs --dry-run
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-creator-profiles.mjs --rollback
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-creator-profiles.mjs --batch-size=100
 */

import { MongoClient } from 'mongodb';
import { runProfileMigration } from '../../src/lib/migrations/profileMigration.js';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'eduvault';

if (!MONGODB_URI) {
  console.error('[migrate-creator-profiles] ERROR: MONGODB_URI is not set.');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rollback = args.includes('--rollback');
const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));
const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 50;

async function run() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    console.log(`[migrate-creator-profiles] Connected to MongoDB (DB: ${MONGODB_DB}).`);
    console.log(`[migrate-creator-profiles] Mode: ${dryRun ? 'DRY RUN' : rollback ? 'ROLLBACK' : 'MIGRATE'}`);
    console.log(`[migrate-creator-profiles] Batch Size: ${batchSize}`);

    const db = client.db(MONGODB_DB);
    const result = await runProfileMigration(db, {
      dryRun,
      rollback,
      batchSize,
    });

    console.log('\n[migrate-creator-profiles] Execution result:');
    console.dir(result, { depth: null });
  } finally {
    await client.close();
    console.log('[migrate-creator-profiles] Finished.');
  }
}

run().catch((err) => {
  console.error('[migrate-creator-profiles] Fatal error:', err);
  process.exit(1);
});

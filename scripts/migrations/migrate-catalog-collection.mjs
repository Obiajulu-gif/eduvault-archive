/**
 * Catalog Collection Schema Migration Runner
 *
 * Implements Issue #746:
 * Zero-downtime, idempotent, resumable batch migration for the catalog collection.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-catalog-collection.mjs
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-catalog-collection.mjs --dry-run
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-catalog-collection.mjs --rollback
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-catalog-collection.mjs --batch-size=200
 */

import { MongoClient } from 'mongodb';
import { runCatalogMigration, migrationV2 } from '../../src/lib/migrations/catalogMigrationFramework.js';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'eduvault';

if (!MONGODB_URI) {
  console.error('[migrate-catalog-collection] ERROR: MONGODB_URI is required.');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rollback = args.includes('--rollback');
const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));
const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 100;

async function run() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);

    console.log(`[migrate-catalog-collection] Connected to DB: ${MONGODB_DB}`);
    console.log(`[migrate-catalog-collection] Mode: ${dryRun ? 'DRY-RUN' : rollback ? 'ROLLBACK' : 'MIGRATE'}`);
    console.log(`[migrate-catalog-collection] Target Schema: v${migrationV2.version} (${migrationV2.name})`);

    const result = await runCatalogMigration(db, migrationV2, {
      batchSize,
      dryRun,
      rollback,
    });

    console.log('\n[migrate-catalog-collection] Migration execution result:');
    console.dir(result, { depth: null });
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  console.error('[migrate-catalog-collection] Fatal error:', err);
  process.exit(1);
});

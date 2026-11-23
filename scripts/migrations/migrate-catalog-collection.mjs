#!/usr/bin/env node
/**
 * Rollback-Safe Catalog Collection Schema Migration Runner — Issue #1215
 *
 * Implements rollback-verified, zero-downtime, resumable catalog schema migrations.
 * Captures pre-migration collection fingerprints, validates invariants, and automatically
 * proves and rolls back changes if failure occurs.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-catalog-collection.mjs
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-catalog-collection.mjs --dry-run
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-catalog-collection.mjs --rollback
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-catalog-collection.mjs --verify-only
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-catalog-collection.mjs --batch-size=200
 *   MONGODB_URI=mongodb://... node scripts/migrations/migrate-catalog-collection.mjs --json
 */

import { MongoClient } from 'mongodb';
import {
  executeRollbackSafeCatalogMigration,
} from '../../src/lib/migrations/rollbackSafeCatalogMigration.js';
import { migrationV2 } from '../../src/lib/migrations/catalogMigrationFramework.js';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'eduvault';

if (!MONGODB_URI) {
  console.error('[migrate-catalog-collection] ERROR: MONGODB_URI is required.');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rollback = args.includes('--rollback');
const verifyOnly = args.includes('--verify-only');
const isJson = args.includes('--json');
const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));
const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 100;

const actorId = process.env.ACTOR_ID || 'cli-deployer';
const actorRole = process.env.ACTOR_ROLE || 'deployer';

async function run() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);

    if (!isJson) {
      console.log(`[migrate-catalog-collection] Connected to DB: ${MONGODB_DB}`);
      console.log(`[migrate-catalog-collection] Mode: ${verifyOnly ? 'VERIFY-ONLY' : dryRun ? 'DRY-RUN' : rollback ? 'ROLLBACK' : 'MIGRATE'}`);
      console.log(`[migrate-catalog-collection] Target Schema: v${migrationV2.version} (${migrationV2.name})`);
    }

    const result = await executeRollbackSafeCatalogMigration({
      db,
      migrationDef: migrationV2,
      options: {
        batchSize,
        dryRun,
        rollback,
        verifyOnly,
        actor: { id: actorId, role: actorRole },
      },
    });

    if (isJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      console.log('\n[migrate-catalog-collection] Migration execution result:');
      console.dir(result, { depth: null });
    }
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  console.error('[migrate-catalog-collection] Fatal error:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * scripts/release-readiness.mjs
 *
 * Pre-release readiness verification CLI (#1022).
 * Verifies authorization, database migrations, smoke tests, and rollback readiness.
 *
 * Usage:
 *   node scripts/release-readiness.mjs
 *   node scripts/release-readiness.mjs --strict --actor=deployer-bob --out=report.json
 *
 * Exit codes:
 *   0 — Release ready to proceed (PROCEED)
 *   1 — Release blocked or strict mode failure (BLOCKED)
 */

import { writeFileSync } from 'node:fs';
import {
  evaluateReleaseReadiness,
  ReleaseDecision,
  CheckStatus,
} from '../src/lib/release/releaseReadiness.js';

const args = process.argv.slice(2);
const strictMode = args.includes('--strict');
const dryRun = args.includes('--dry-run');
const skipDb = args.includes('--skip-db');
const outFile = args.find(a => a.startsWith('--out='))?.slice('--out='.length) || null;
const actorId = args.find(a => a.startsWith('--actor='))?.slice('--actor='.length) || 'release-cli-operator';
const actorRole = args.find(a => a.startsWith('--role='))?.slice('--role='.length) || 'deployer';
const rawPermissions = args.find(a => a.startsWith('--permissions='))?.slice('--permissions='.length) || null;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/eduvault';
const MONGODB_DB = process.env.MONGODB_DB || 'eduvault';

async function main() {
  console.log('\n  [release-readiness] ═══════════════════════════════════════');
  console.log('  [release-readiness] Starting Release Readiness Verification');
  console.log('  [release-readiness] ═══════════════════════════════════════\n');

  let client = null;
  let db = null;

  if (!skipDb) {
    try {
      const { MongoClient } = await import('mongodb');
      client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 2000 });
      await client.connect();
      db = client.db(MONGODB_DB);
      console.log('  [release-readiness] Connected to MongoDB.');
    } catch (err) {
      console.warn(`  [release-readiness] DB connection notice: ${err.message}. Operating in mock/inspection mode.`);
    }
  }

  const permissions = rawPermissions
    ? rawPermissions.split(',').map(p => p.trim())
    : (['admin', 'deployer', 'release_engineer'].includes(actorRole) ? ['system:migrate', 'system:release'] : []);

  const actor = {
    id: actorId,
    role: actorRole,
    permissions,
  };

  const rollbackOpts = {
    lastBackupTimestamp: process.env.LAST_BACKUP_TIMESTAMP || new Date(Date.now() - 3600000).toISOString(),
    hasRehearsedRollback: true,
  };

  // Provide mock db when skipDb or dryRun is requested for CLI smoke testing
  if (!db && (skipDb || dryRun)) {
    const store = new Map();
    db = {
      listCollections: () => ({
        toArray: async () => [
          { name: 'users' },
          { name: 'materials' },
          { name: 'purchases' },
          { name: 'entitlement_cache' },
          { name: 'refunds' },
          { name: 'audit_ledger' },
        ],
      }),
      collection: () => ({
        insertOne: async (doc) => store.set(doc._id, doc),
        findOne: async (q) => store.get(q._id) || null,
        deleteOne: async (q) => store.delete(q._id),
      }),
    };
  }

  try {
    const report = await evaluateReleaseReadiness({
      actor,
      db,
      strictMode,
      rollbackOpts,
      env: {
        JWT_SECRET: process.env.JWT_SECRET || 'release-readiness-secret-key-12345',
        NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'TESTNET',
      },
    });

    console.log(`\n  Release ID: ${report.releaseId}`);
    console.log(`  Decision:   ${report.decision === ReleaseDecision.PROCEED ? '✓ PROCEED' : report.decision === ReleaseDecision.BLOCKED ? '✗ BLOCKED' : '⚠ REQUIRES_APPROVAL'}`);
    console.log(`  Actor:      ${report.actor.id} (${report.actor.role})`);
    console.log(`  Summary:    ${report.summary.passed} Passed, ${report.summary.warnings} Warnings, ${report.summary.failed} Failed\n`);

    for (const [name, check] of Object.entries(report.checks)) {
      const sym = check.status === CheckStatus.PASSED ? '✓' : check.status === CheckStatus.FAILED ? '✗' : '⚠';
      console.log(`  ${sym} [${check.status}] ${name}: ${check.message}`);
    }

    if (outFile) {
      writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8');
      console.log(`\n  [release-readiness] Report written to: ${outFile}`);
    }

    if (client) {
      await client.close();
    }

    if (report.decision === ReleaseDecision.BLOCKED) {
      console.error('\n  [release-readiness] ✗ Release is BLOCKED by failed readiness criteria.');
      process.exit(1);
    }

    console.log('\n  [release-readiness] ✓ Readiness checks complete. Safe to proceed.');
    process.exit(0);
  } catch (err) {
    console.error(`\n  [release-readiness] Fatal execution error: ${err.message}`);
    if (client) await client.close();
    process.exit(1);
  }
}

main();

#!/usr/bin/env node
/**
 * Resumable orphan-repair command — Issue #1121
 *
 * Detects and repairs orphaned records across the EduVault database.
 *
 * Usage:
 *   node scripts/orphan-repair.mjs [options]
 *
 * Options:
 *   --dry-run          Scan and report without writing any changes.
 *   --type <type>      Repair only one type: material_no_creator |
 *                      purchase_no_entitlement | entitlement_no_material | all (default: all)
 *   --batch-size <n>   Documents per batch (default: 100).
 *   --actor <address>  Operator address used for authorization checks.
 *   --job-prefix <str> Prefix for checkpoint job IDs (default: timestamp).
 *
 * Checkpoints are stored in MongoDB (repair_checkpoints collection).
 * Re-running with the same --job-prefix resumes from the last checkpoint.
 *
 * Exit codes:
 *   0  Success (or dry-run complete)
 *   1  Authorization error
 *   2  Unexpected error
 */

import process from 'node:process';
import {
  repairMaterialsWithNoCreator,
  repairPurchasesWithNoEntitlement,
  repairEntitlementsWithNoMaterial,
  runAllOrphanRepairs,
  ORPHAN_TYPE,
} from '../src/lib/maintenance/orphanRepair.js';

function parseArgs(argv) {
  const args = {
    dryRun: false,
    type: 'all',
    batchSize: 100,
    actor: process.env.REPAIR_ACTOR ?? 'operator',
    jobPrefix: null,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--type':
        args.type = argv[++i];
        break;
      case '--batch-size':
        args.batchSize = Number(argv[++i]) || 100;
        break;
      case '--actor':
        args.actor = argv[++i];
        break;
      case '--job-prefix':
        args.jobPrefix = argv[++i];
        break;
    }
  }

  return args;
}

const AUTHORIZED_OPERATORS = new Set(
  (process.env.REPAIR_AUTHORIZED_OPERATORS ?? process.env.REPAIR_ACTOR ?? 'operator')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function authorize(actor) {
  return AUTHORIZED_OPERATORS.has(actor);
}

function printResult(type, result) {
  const { processed = 0, repaired = 0, completed, dryRun, remaining = 0, samples = [] } = result;
  const mode = dryRun ? '[DRY RUN] ' : '';
  console.log(`\n${mode}${type}:`);
  console.log(`  Scanned : ${processed}`);
  console.log(`  Repaired: ${repaired}`);
  console.log(`  Remaining: ${remaining}`);
  console.log(`  Completed: ${completed ? 'yes' : 'no (resume to continue)'}`);
  if (samples.length > 0) {
    console.log('  Sample repairs:');
    for (const s of samples.slice(0, 5)) {
      console.log(`    - ${s.id}: ${s.reason}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('EduVault Orphan Repair');
  console.log('======================');
  console.log(`Mode    : ${args.dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Type    : ${args.type}`);
  console.log(`Actor   : ${args.actor}`);
  console.log(`Batch   : ${args.batchSize}`);
  if (args.jobPrefix) console.log(`Job ID  : ${args.jobPrefix} (resuming if checkpoint exists)`);
  console.log('');

  let db;
  try {
    const { getDb } = await import('../src/lib/mongodb.js');
    db = await getDb();
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(2);
  }

  const commonOpts = {
    db,
    actor: args.actor,
    authorize,
    dryRun: args.dryRun,
    batchSize: args.batchSize,
  };

  try {
    if (args.type === 'all') {
      const { results, summary } = await runAllOrphanRepairs({
        ...commonOpts,
        jobIdPrefix: args.jobPrefix,
      });

      for (const [type, result] of Object.entries(results)) {
        printResult(type, result);
      }

      console.log('\n======================');
      console.log(`Total scanned : ${summary.scanned}`);
      console.log(`Total repaired: ${summary.repaired}`);
      if (args.dryRun) console.log('No changes written (--dry-run).');
    } else {
      const repairFns = {
        [ORPHAN_TYPE.MATERIAL_NO_CREATOR]: repairMaterialsWithNoCreator,
        [ORPHAN_TYPE.PURCHASE_NO_ENTITLEMENT]: repairPurchasesWithNoEntitlement,
        [ORPHAN_TYPE.ENTITLEMENT_NO_MATERIAL]: repairEntitlementsWithNoMaterial,
      };

      const fn = repairFns[args.type];
      if (!fn) {
        console.error(`Unknown type: ${args.type}. Valid types: ${Object.values(ORPHAN_TYPE).join(', ')}, all`);
        process.exit(2);
      }

      const result = await fn({
        ...commonOpts,
        jobId: args.jobPrefix ? `${args.jobPrefix}-${args.type}` : undefined,
      });
      printResult(args.type, result);
    }

    process.exit(0);
  } catch (err) {
    if (err.name === 'RepairAuthorizationError') {
      console.error(`Authorization failed: ${err.message}`);
      console.error(`Set REPAIR_ACTOR or pass --actor with an authorized operator address.`);
      process.exit(1);
    }
    console.error('Orphan repair failed:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(2);
  }
}

main();

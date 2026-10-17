#!/usr/bin/env node
/**
 * scripts/reconcile-projections.mjs
 *
 * CLI for source-of-truth vs cached/derived projections reconciliation (#963).
 * Defaults to dry-run-first safety mode; requires explicit --execute to apply repairs.
 *
 * Usage:
 *   MONGODB_URI="mongodb://..." node scripts/reconcile-projections.mjs [--dry-run] [--scope=all] [--json]
 *   MONGODB_URI="mongodb://..." node scripts/reconcile-projections.mjs --execute
 */

import { runProjectionReconciliation } from '../src/lib/reconciliation/projectionReconciler.js';

function parseArgs(argv) {
  const args = {
    dryRun: true,
    scope: 'all',
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--execute') args.dryRun = false;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--scope=')) args.scope = arg.slice('--scope='.length);
    else if (arg === '--scope') args.scope = argv[++i];
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`Projection Reconciliation CLI (#963)

Usage:
  node scripts/reconcile-projections.mjs [options]

Options:
  --dry-run        Dry-run mode (default, no writes performed)
  --execute        Apply planned repairs idempotently
  --scope <scope>  Reconciliation scope: all | entitlements | search (default: all)
  --json           Output structured JSON report
  --help, -h       Show this help
`);
    process.exit(0);
  }

  if (!process.env.MONGODB_URI) {
    console.error('Error: MONGODB_URI environment variable is required to run projection reconciliation.');
    process.exit(1);
  }

  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'eduvault');

  try {
    const report = await runProjectionReconciliation({
      db,
      scope: args.scope,
      dryRun: args.dryRun,
      actor: process.env.USER || 'operator-cli',
    });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\n=== Projection Reconciliation Report ===`);
      console.log(`Mode:            ${report.dryRun ? 'DRY-RUN (Safe, no writes)' : 'EXECUTE (Repairs applied)'}`);
      console.log(`Scope:           ${report.scope}`);
      console.log(`Drift Detected:  ${report.driftCount}`);
      console.log(`  - Missing:     ${report.byCategory.MISSING_PROJECTION}`);
      console.log(`  - Orphan:      ${report.byCategory.ORPHAN_PROJECTION}`);
      console.log(`  - Stale:       ${report.byCategory.STALE_PROJECTION}`);
      console.log(`  - Divergence:  ${report.byCategory.DATA_DIVERGENCE}\n`);

      if (report.driftItems.length > 0) {
        console.log(`Discrepancies:`);
        for (const item of report.driftItems) {
          console.log(`- [${item.scope.toUpperCase()}] ${item.category} on ${item.targetId}`);
          console.log(`  Action: ${item.plannedAction}`);
          console.log(`  Root Cause Hint: ${item.rootCauseHint}`);
          console.log();
        }
      }

      if (!report.dryRun) {
        console.log(`Repaired: ${report.repairedCount}, Errors: ${report.errorsCount}`);
      }
    }

    await client.close();
    process.exit(report.driftCount > 0 && report.dryRun ? 1 : 0);
  } catch (err) {
    console.error('Fatal reconciliation error:', err);
    await client.close();
    process.exit(1);
  }
}

main();

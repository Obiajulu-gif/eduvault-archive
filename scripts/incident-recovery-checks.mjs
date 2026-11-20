#!/usr/bin/env node
/**
 * scripts/incident-recovery-checks.mjs
 *
 * CLI runner for executable incident recovery checks (#1110).
 *
 * Runs non-destructive health and recovery verification checks across
 * kill switches, signer caps, dead-letter queues, and audit chains.
 *
 * Usage:
 *   node scripts/incident-recovery-checks.mjs --dry-run
 *   node scripts/incident-recovery-checks.mjs --dry-run --json
 *   MONGODB_URI="$URI" node scripts/incident-recovery-checks.mjs
 *
 * Exit codes: 0 = all checks passed or warning, 1 = failure detected.
 */

import {
  runAllRecoveryChecks,
  RecoveryCheckStatus,
} from '../src/lib/ops/incidentRecoveryChecks.js';

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  let client = null;
  let db = null;

  if (!args.dryRun && process.env.MONGODB_URI) {
    const { MongoClient } = await import('mongodb');
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db(process.env.MONGODB_DB || 'eduvault');
  }

  try {
    const report = await runAllRecoveryChecks({
      db,
      env: process.env,
      actor: { role: 'operator' },
    });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('='.repeat(70));
      console.log('EDUVAULT INCIDENT RECOVERY CHECKS REPORT');
      console.log('='.repeat(70));
      console.log(`Timestamp: ${report.ranAt}`);
      console.log(`Status:    ${report.healthy ? 'HEALTHY' : 'INCIDENT RECOVERY ATTENTION REQUIRED'}`);
      console.log(`Summary:   Total: ${report.summary.total} | Passed: ${report.summary.passed} | Warnings: ${report.summary.warning} | Failed: ${report.summary.failed} | Skipped: ${report.summary.skipped}`);
      console.log('-'.repeat(70));

      for (const check of report.checks) {
        const tag = check.status === RecoveryCheckStatus.PASSED
          ? '[PASS]'
          : check.status === RecoveryCheckStatus.WARNING
            ? '[WARN]'
            : check.status === RecoveryCheckStatus.FAILED
              ? '[FAIL]'
              : '[SKIP]';
        console.log(`${tag} ${check.id}: ${check.message}`);
      }
      console.log('='.repeat(70));
    }

    process.exit(report.healthy ? 0 : 1);
  } finally {
    if (client) await client.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('incident-recovery-checks.mjs')) {
  main();
}


#!/usr/bin/env node
/**
 * scripts/feature-rollout-guard.mjs
 *
 * Operational CLI for feature-flag canary rollout and rollback verification (#964).
 *
 * Usage:
 *   node scripts/feature-rollout-guard.mjs --flag NEW_CHECKOUT --percentage 25 --check-principal GBUYER123
 *   node scripts/feature-rollout-guard.mjs --simulate-failure --json
 */

import { FeatureRolloutGuard, computePrincipalBucket } from '../src/lib/featureFlags/rolloutGuard.js';

function parseArgs(argv) {
  const args = {
    flag: 'CANARY_PAYOUT_V2',
    percentage: 10,
    checkPrincipal: null,
    simulateFailure: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--simulate-failure') args.simulateFailure = true;
    else if (arg.startsWith('--flag=')) args.flag = arg.slice('--flag='.length);
    else if (arg === '--flag') args.flag = argv[++i];
    else if (arg.startsWith('--percentage=')) args.percentage = parseInt(arg.slice('--percentage='.length), 10);
    else if (arg === '--percentage') args.percentage = parseInt(argv[++i], 10);
    else if (arg.startsWith('--check-principal=')) args.checkPrincipal = arg.slice('--check-principal='.length);
    else if (arg === '--check-principal') args.checkPrincipal = argv[++i];
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`Feature Flag Rollout Guard CLI (#964)

Usage:
  node scripts/feature-rollout-guard.mjs [options]

Options:
  --flag <key>             Feature flag key (default: CANARY_PAYOUT_V2)
  --percentage <0..100>    Rollout percentage (default: 10)
  --check-principal <id>   Evaluate bucket and enrollment for given principal
  --simulate-failure       Simulate consecutive failures triggering auto-rollback
  --json                   Output structured JSON
  --help, -h               Show this help
`);
    process.exit(0);
  }

  const guard = new FeatureRolloutGuard({
    flagKey: args.flag,
    rolloutPercentage: args.percentage,
    maxConsecutiveFailures: 3,
  });

  const report = {
    flagKey: args.flag,
    rolloutPercentage: args.percentage,
    status: guard.status,
  };

  if (args.checkPrincipal) {
    const bucket = computePrincipalBucket(args.flag, args.checkPrincipal);
    const enrolled = guard.isEnrolled(args.checkPrincipal);
    report.principalCheck = {
      principalId: args.checkPrincipal,
      bucket,
      enrolled,
    };
  }

  if (args.simulateFailure) {
    guard.rolloutPercentage = 100;
    let mockReservations = 3;
    await guard.execute({
      principalId: 'simulated_user_1',
      riskyOperation: async () => { throw new Error('Simulated upstream Soroban error 1'); },
      fallbackOperation: async () => ({ fallback: true }),
    });
    await guard.execute({
      principalId: 'simulated_user_2',
      riskyOperation: async () => { throw new Error('Simulated upstream Soroban error 2'); },
      fallbackOperation: async () => ({ fallback: true }),
    });
    await guard.execute({
      principalId: 'simulated_user_3',
      riskyOperation: async () => { throw new Error('Simulated upstream Soroban error 3 (threshold reached)'); },
      fallbackOperation: async () => ({ fallback: true }),
      rollbackCleanup: async () => {
        mockReservations = 0;
        return { released: 3 };
      },
      verifyConsistency: async () => ({ verified: true, orphanedRecordsCount: mockReservations }),
    });

    report.postRollbackStatus = guard.getStatus();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n=== Feature Flag Rollout Guard Report ===`);
    console.log(`Flag:       ${report.flagKey}`);
    console.log(`Rollout:    ${report.rolloutPercentage}%`);
    console.log(`Status:     ${report.status}`);

    if (report.principalCheck) {
      console.log(`\nPrincipal Check:`);
      console.log(`- ID:       ${report.principalCheck.principalId}`);
      console.log(`- Bucket:   ${report.principalCheck.bucket}/100`);
      console.log(`- Enrolled: ${report.principalCheck.enrolled ? 'YES' : 'NO'}`);
    }

    if (report.postRollbackStatus) {
      console.log(`\nSimulated Failure Auto-Rollback:`);
      console.log(`- New Status:    ${report.postRollbackStatus.status}`);
      console.log(`- Reason:        ${report.postRollbackStatus.rollbackReason}`);
      console.log(`- Verified Clean: ${report.postRollbackStatus.postRollbackVerification?.verifiedClean ? 'YES' : 'NO'}`);
    }
  }

  process.exit(0);
}

main();

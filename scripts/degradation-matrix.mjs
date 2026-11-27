#!/usr/bin/env node
/**
 * scripts/degradation-matrix.mjs
 *
 * Prints the dependency degradation matrix (#1081): for each dependency, the
 * fallback each operation takes right now.
 *
 * Usage:
 *   npm run health:matrix                       run live health checks
 *   npm run health:matrix -- --from report.json use a saved `health:check -- --json` report
 *   npm run health:matrix -- --json
 *
 * Exit code is 0 when every operation is allowed, 2 when any is degraded,
 * queued, or blocked (informational, so scripts can alert on it), 1 on error.
 */
import { readFileSync } from 'node:fs';
import { buildDegradationMatrix } from '../src/lib/degradation/dependencyFallbackPlanner.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const fromIndex = args.indexOf('--from');
const fromPath = args.find((a) => a.startsWith('--from='))?.slice('--from='.length) || (fromIndex >= 0 ? args[fromIndex + 1] : null);

try {
  let report;
  if (fromPath) {
    report = JSON.parse(readFileSync(fromPath, 'utf8'));
  } else {
    const { checkAllDependencies } = await import('../src/lib/health/dependencyChecker.js');
    report = await checkAllDependencies();
  }
  const matrix = buildDegradationMatrix(report);

  if (json) {
    console.log(JSON.stringify(matrix, null, 2));
  } else {
    for (const row of matrix) {
      const note = row.misconfigured ? ' (misconfigured)' : row.observed ? '' : ' (not observed)';
      console.log(`${row.service.padEnd(9)} ${row.state.toUpperCase()}${note}`);
      for (const op of row.operations) {
        const retry = op.retryable ? ` retry in ${op.retryAfterSeconds}s` : '';
        console.log(`  ${op.operation.padEnd(18)} ${op.action.padEnd(8)} ${op.httpStatus}${op.critical ? ' critical' : ''}${retry}`);
      }
    }
  }
  const impaired = matrix.some((row) => row.operations.some((op) => op.action !== 'allow'));
  process.exit(impaired ? 2 : 0);
} catch (error) {
  console.error(`[degradation-matrix] ${error.message}`);
  process.exit(1);
}

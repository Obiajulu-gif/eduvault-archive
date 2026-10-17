#!/usr/bin/env node
/**
 * scripts/check-dependency-health.mjs
 *
 * CLI tool for maintainers to check external dependency health and network assumptions (Issue #843).
 *
 * Usage:
 *   node scripts/check-dependency-health.mjs
 *   node scripts/check-dependency-health.mjs --json
 */

import { checkAllDependencies, formatMaintainerReport } from '../src/lib/health/dependencyChecker.js';

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  try {
    const report = await checkAllDependencies();

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatMaintainerReport(report));
    }

    if (report.status === 'unavailable' || report.status === 'misconfigured') {
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('[check-dependency-health] Fatal error executing health checks:', err.message);
    process.exit(1);
  }
}

main();

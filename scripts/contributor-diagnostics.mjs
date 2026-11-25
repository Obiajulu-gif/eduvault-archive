#!/usr/bin/env node
/**
 * scripts/contributor-diagnostics.mjs
 *
 * Local contributor diagnostics command for EduVault (#1154).
 * Checks node version, environment variables, dependencies, and connectivity.
 * Redacts all secrets and provides actionable remediation hints.
 */
import { runContributorDiagnostics } from '../src/lib/health/contributorDiagnostics.js';

function parseArgs(argv) {
  const args = {
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    quiet: argv.includes('--quiet'),
    help: argv.includes('--help') || argv.includes('-h'),
    retries: 0,
  };

  for (const arg of argv) {
    if (arg.startsWith('--retries=')) {
      args.retries = parseInt(arg.slice('--retries='.length), 10) || 0;
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
EduVault Contributor Diagnostics

Usage:
  node scripts/contributor-diagnostics.mjs [options]

Options:
  --json          Output diagnostic report in machine-readable JSON format
  --retries=<n>   Retry transient/unavailable network dependencies up to n times
  --strict        Fail with exit code 1 on degraded status as well as misconfigured
  --quiet         Minimal output (status summary only)
  --help, -h      Display this help message
`);
  process.exit(0);
}

try {
  const report = await runContributorDiagnostics({ retries: args.retries });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!args.quiet) {
    console.log(`\n=== EduVault Contributor Diagnostics ===`);
    console.log(`Status: ${report.status.toUpperCase()}`);
    console.log(`Node:   ${report.runtime.node} (${report.runtime.platform}/${report.runtime.arch})`);
    if (report.runtime.nodeCompatibility && !report.runtime.nodeCompatibility.compatible) {
      console.log(`[WARN]  ${report.runtime.nodeCompatibility.warning}`);
    }

    if (report.remediation && report.remediation.length > 0) {
      console.log(`\nRemediation Actions:`);
      for (const item of report.remediation) {
        console.log(`  - [${item.dependency}] ${item.hint}`);
      }
    } else {
      console.log(`\nAll checked dependencies and environment variables are satisfied.`);
    }
    console.log(``);
  } else {
    console.log(`Contributor diagnostics: ${report.status.toUpperCase()}`);
  }

  // Determine exit code
  if (report.status === 'misconfigured') {
    process.exit(1);
  }
  if (args.strict && report.status !== 'healthy') {
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(`Contributor diagnostics failed: ${error.message}`);
  process.exit(1);
}

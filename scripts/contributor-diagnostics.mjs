#!/usr/bin/env node
/**
 * scripts/contributor-diagnostics.mjs
 *
 * Local contributor diagnostics command for EduVault (#1154).
 * Checks node version, environment variables, dependencies, and connectivity.
 * Redacts all secrets and provides actionable remediation hints.
 */
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { runContributorDiagnostics } from '../src/lib/health/contributorDiagnostics.js';
import {
  buildSetupReport,
  checkLocalSetup,
  formatSetupReport,
  parseEnvFile,
  probeWithRetry,
} from '../src/lib/health/setupFailureDiagnostics.js';

function parseArgs(argv) {
  const args = {
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    quiet: argv.includes('--quiet'),
    setup: argv.includes('--setup'),
    offline: argv.includes('--offline'),
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

function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const done = (error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' })));
    socket.once('connect', () => done());
    socket.once('error', done);
  });
}

function mongoTarget(uri) {
  // Only plain mongodb:// URIs have a single host to probe; SRV records are
  // resolved by the driver and are left to the dependency check.
  const match = /^mongodb:\/\/(?:[^@/]+@)?([^/:,?]+)(?::(\d+))?/.exec(uri || '');
  return match ? { host: match[1], port: Number(match[2] || 27017) } : null;
}

// Local setup failures (#1079). Exit codes: 0 ready, 1 action required, 75 retry later.
async function runSetup() {
  const failures = checkLocalSetup({ rootDir: process.cwd(), env: process.env });
  const probes = [];
  if (!args.offline) {
    const fileEnv = existsSync('.env.local') ? parseEnvFile(readFileSync('.env.local', 'utf8')) : {};
    const target = mongoTarget(process.env.MONGODB_URI || fileEnv.MONGODB_URI);
    if (target) probes.push(await probeWithRetry('mongodb', () => tcpProbe(target.host, target.port)));
  }
  const report = buildSetupReport({ failures, probes });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatSetupReport(report));
  process.exit(report.exitCode);
}

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
  --setup         Check the local checkout (Node, lockfiles, node_modules, .env.local)
                  Exit codes: 0 ready, 1 action required, 75 retry later
  --offline       With --setup, skip the MongoDB connection probe
  --help, -h      Display this help message
`);
  process.exit(0);
}

try {
  if (args.setup) await runSetup();
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

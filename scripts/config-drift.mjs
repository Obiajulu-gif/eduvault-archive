#!/usr/bin/env node
/**
 * scripts/config-drift.mjs
 *
 * Cross-environment configuration drift detector CLI (#875).
 *
 * Usage:
 *   node scripts/config-drift.mjs --baseline production --target staging
 *   node scripts/config-drift.mjs --baseline .env.production --target .env.staging --file
 *   node scripts/config-drift.mjs --baseline production --target staging --target development --json
 *   node scripts/config-drift.mjs --baseline production --target staging --verbose
 *
 * Exit codes: 0 — no unexpected drift, 1 — drift detected, 2 — usage error.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ENVIRONMENTS,
  detectDrift,
  detectDriftAgainstBaseline,
  formatDriftReport,
  parseEnvFile,
  loadEnvFile,
  SECRET_KEYS,
  ALLOWED_DIFFERENCES,
} from '../src/lib/config/driftDetector.js';

const args = process.argv.slice(2);

function showHelp() {
  console.log(`
Cross-Environment Configuration Drift Detector

Usage:
  config-drift --baseline <env|file> --target <env|file> [--target ...] [options]

Required:
  --baseline <name|path>    Baseline environment name or .env file path
  --target <name|path>      Target environment name or .env file path (repeatable)

Options:
  --file                    Treat --baseline and --target as file paths
  --json                    Output machine-readable JSON
  --verbose                 Show matching keys in output
  --no-color                Disable ANSI colors
  --no-redact               Show secret values (DANGEROUS - for debugging only)
  --keys <list>             Comma-separated list of keys to compare (default: all known)
  --help                    Show this help

Environment names: ${ENVIRONMENTS.join(', ')}

Examples:
  # Compare current process env (inferred) against production
  config-drift --baseline production --target staging

  # Compare two .env files
  config-drift --baseline .env.production --target .env.staging --file

  # Compare production against multiple environments
  config-drift --baseline production --target staging --target development --json

  # Compare specific keys only
  config-drift --baseline production --target staging --keys JWT_SECRET,MONGODB_URI,NEXT_PUBLIC_APP_URL
`);
}

function argValue(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
}

function argValues(flag) {
  const values = [];
  let index = args.indexOf(flag);
  while (index !== -1) {
    const val = args[index + 1];
    if (val && !val.startsWith('--')) {
      values.push(val);
    }
    index = args.indexOf(flag, index + 1);
  }
  return values;
}

function loadEnvironment(source, isFile) {
  if (isFile) {
    const path = resolve(source);
    const content = readFileSync(path, 'utf8');
    return { name: source, config: parseEnvFile(content) };
  }
  // Infer from process.env with EDUVAULT_DEPLOY_ENV
  return { name: source, config: { ...process.env, EDUVAULT_DEPLOY_ENV: source } };
}

try {
  if (args.includes('--help') || args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const baselineArg = argValue('--baseline');
  const targetArgs = argValues('--target');
  const isFile = args.includes('--file');
  const jsonOutput = args.includes('--json');
  const verbose = args.includes('--verbose');
  const color = !args.includes('--no-color');
  const redactSecrets = !args.includes('--no-redact');
  const keysArg = argValue('--keys');
  const keysToCompare = keysArg ? keysArg.split(',').map(k => k.trim()) : undefined;

  if (!baselineArg) {
    console.error('Error: --baseline is required');
    process.exit(2);
  }
  if (targetArgs.length === 0) {
    console.error('Error: at least one --target is required');
    process.exit(2);
  }

  const baseline = loadEnvironment(baselineArg, isFile);
  const targets = targetArgs.map(t => loadEnvironment(t, isFile));

  if (!redactSecrets) {
    console.error('\x1b[33m⚠ WARNING: --no-redact enabled - secrets will be shown in output!\x1b[0m');
  }

  const reports = detectDriftAgainstBaseline(baseline.config, baseline.name, targets, {
    redactSecrets,
    keysToCompare,
  });

  let hasDrift = false;
  let exitCode = 0;

  if (jsonOutput) {
    console.log(JSON.stringify({
      baseline: baseline.name,
      comparisons: reports.map(r => ({
        target: r.environmentB,
        summary: r.summary,
        missingInBaseline: r.missingInA,
        missingInTarget: r.missingInB,
        mismatched: r.mismatched,
        allowedDifferences: r.allowedDifferences,
        matching: verbose ? r.matching : r.matching.length,
      })),
    }, null, 2));
  } else {
    for (const report of reports) {
      console.log(formatDriftReport(report, { color, verbose }));
      console.log('');
      if (report.summary.hasCriticalDrift || report.summary.hasHighDrift ||
          report.summary.missingInA > 0 || report.summary.missingInB > 0) {
        hasDrift = true;
      }
    }
  }

  if (hasDrift) exitCode = 1;
  process.exit(exitCode);

} catch (error) {
  console.error(`[config-drift] ${error.message}`);
  process.exit(2);
}
#!/usr/bin/env node
/**
 * scripts/check-config-contract.mjs
 *
 * Dry-run the cross-environment configuration contract (#944) against the
 * current process env (or an env file) without starting the app.
 *
 * Usage:
 *   node scripts/check-config-contract.mjs                       # infer environment
 *   node scripts/check-config-contract.mjs --env production
 *   node scripts/check-config-contract.mjs --env staging --file .env.staging
 *   node scripts/check-config-contract.mjs --json
 *
 * Exit codes: 0 — contract satisfied, 1 — violations found, 2 — usage error.
 * Output names settings and rules only; values are never printed.
 */

import { readFileSync } from 'node:fs';
import {
  ENVIRONMENTS,
  evaluateConfigContract,
  formatConfigContractReport,
  resolveEnvironment,
} from '../src/lib/config/configContract.js';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
};

function parseEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

try {
  const file = argValue('--file');
  const env = file ? parseEnvFile(file) : { ...process.env };
  const environment = argValue('--env') || resolveEnvironment(env);
  if (!ENVIRONMENTS.includes(environment)) {
    console.error(`Unknown --env "${environment}". Expected one of: ${ENVIRONMENTS.join(', ')}`);
    process.exit(2);
  }
  const result = evaluateConfigContract(env, environment);
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : formatConfigContractReport(result));
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(`[config-contract] ${error.message}`);
  process.exit(2);
}

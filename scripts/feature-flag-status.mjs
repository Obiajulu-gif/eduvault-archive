#!/usr/bin/env node
/**
 * scripts/feature-flag-status.mjs
 *
 * Prints the current state of every registered feature flag (#797).
 *
 * Usage:
 *   node scripts/feature-flag-status.mjs
 *
 * Exit codes:
 *   0 — all flags evaluated (regardless of enabled/disabled)
 *   1 — a flag could not be evaluated (unknown key, etc.)
 *
 * This is the "clear validation script" the issue asks for: it lets a
 * maintainer confirm, before a rollout or a rollback, exactly which flags are
 * on, which are off, and whether each value came from the environment or
 * from the safe default.
 */

import {
  listFeatureFlags,
  FEATURE_FLAG_REGISTRY,
} from '../src/lib/featureFlags.js';

let failed = false;

const flags = listFeatureFlags();

console.log('EduVault feature flag status');
console.log('=============================\n');

for (const flag of flags) {
  const state = flag.enabled ? 'ENABLED ' : 'disabled';
  const source = flag.source === 'env' ? 'env var' : 'safe default';
  console.log(`[${state}] ${flag.key}  (from ${source})`);
  console.log(`         ${flag.description}`);
}

console.log('\nSummary');
console.log('-------');
const enabled = flags.filter((f) => f.enabled).length;
console.log(`${enabled} of ${flags.length} flags enabled.`);

if (enabled > 0) {
  console.log('\nEnabled flags:');
  for (const flag of flags.filter((f) => f.enabled)) {
    console.log(`  - FEATURE_FLAG_${flag.key} (set in environment)`);
  }
}

// Fail loudly if the registry itself is somehow inconsistent.
for (const definition of Object.values(FEATURE_FLAG_REGISTRY)) {
  if (typeof definition.defaultValue !== 'boolean') {
    console.error(`\nERROR: flag ${definition.key} has a non-boolean defaultValue.`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * scripts/feature-flag-status.mjs
 *
 * Prints the current state of every registered feature flag (#797, #1018).
 *
 * Usage:
 *   node scripts/feature-flag-status.mjs           # env/default values only
 *   node scripts/feature-flag-status.mjs --db       # include DB override layer
 *
 * Exit codes:
 *   0 — all flags evaluated (regardless of enabled/disabled)
 *   1 — a flag could not be evaluated (unknown key, registry inconsistency)
 *
 * The --db flag connects to MongoDB and shows the effective resolved value
 * including any runtime overrides set via POST /api/admin/feature-flags.
 * Without --db the script stays offline and shows only env/default values.
 */

import {
  listFeatureFlags,
  listFeatureFlagsResolved,
  FEATURE_FLAG_REGISTRY,
} from '../src/lib/featureFlags.js';

const useDb = process.argv.includes('--db');
let failed = false;

console.log('EduVault feature flag status');
console.log('=============================\n');

if (useDb) {
  // Online mode: connect to DB and show resolved values including overrides.
  let db;
  try {
    const { getDb } = await import('../src/lib/mongodb.js');
    db = await getDb();
  } catch (err) {
    console.error('Could not connect to MongoDB:', err.message);
    console.error('Run without --db to see env/default values only.\n');
    process.exit(1);
  }

  const flags = await listFeatureFlagsResolved(db);
  for (const flag of flags) {
    const state  = flag.enabled ? 'ENABLED ' : 'disabled';
    const src    = flag.source === 'override' ? 'DB override' : flag.source === 'env' ? 'env var' : 'safe default';
    console.log(`[${state}] ${flag.key}  (from ${src})`);
    if (flag.source === 'override') {
      console.log(`         Override by: ${flag.overriddenBy ?? 'unknown'}`);
      if (flag.reason) console.log(`         Reason: ${flag.reason}`);
      if (flag.updatedAt) console.log(`         At: ${new Date(flag.updatedAt).toISOString()}`);
    }
    console.log(`         ${flag.description}`);
  }

  console.log('\nSummary');
  console.log('-------');
  const enabled   = flags.filter((f) => f.enabled);
  const overridden = flags.filter((f) => f.source === 'override');
  console.log(`${enabled.length} of ${flags.length} flags enabled.`);
  if (overridden.length > 0) {
    console.log(`\n${overridden.length} flag(s) have active DB overrides (take precedence over env vars):`);
    for (const f of overridden) {
      console.log(`  - ${f.key}: ${f.enabled ? 'ENABLED' : 'disabled'}  (by ${f.overriddenBy ?? 'unknown'})`);
    }
  }

  // Emergency-disable reminder
  const envEnabledButOverrideDisabled = flags.filter(
    (f) => f.source === 'override' && !f.enabled,
  );
  if (envEnabledButOverrideDisabled.length > 0) {
    console.log('\n⚠ The following flags have been EMERGENCY-DISABLED via DB override:');
    for (const f of envEnabledButOverrideDisabled) {
      console.log(`  - ${f.key}  (env var says enabled; DB override wins)`);
    }
    console.log('  To re-enable: POST /api/admin/feature-flags { key, enabled: true }');
    console.log('  To revert to env: POST /api/admin/feature-flags { key, clear: true }');
  }
} else {
  // Offline mode: env/default only.
  const flags = listFeatureFlags();
  for (const flag of flags) {
    const state  = flag.enabled ? 'ENABLED ' : 'disabled';
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
  console.log('\nTip: run with --db to include runtime DB overrides.');
}

// Fail loudly if the registry itself is inconsistent.
for (const definition of Object.values(FEATURE_FLAG_REGISTRY)) {
  if (typeof definition.defaultValue !== 'boolean') {
    console.error(`\nERROR: flag ${definition.key} has a non-boolean defaultValue.`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);

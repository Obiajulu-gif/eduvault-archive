/**
 * Maintainer Operational Health & Unresolved Exceptions Report
 *
 * Issue #798:
 * CLI report tool for maintainers summarizing system indicators,
 * unresolved exceptions, stale jobs, and reconciliation drift.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/maintainer-health-report.mjs
 */

import process from 'node:process';
import { MongoClient } from 'mongodb';
import { getOperationalHealth } from '../src/lib/backend/operationalHealth.js';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'eduvault';

if (!MONGODB_URI) {
  console.error('[maintainer-health-report] ERROR: MONGODB_URI is required.');
  process.exit(1);
}

/** @returns {Promise<void>} */
async function run() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);

    console.log('\n======================================================');
    console.log('       EDUVAULT MAINTAINER OPERATIONAL HEALTH         ');
    console.log('======================================================\n');

    const report = await getOperationalHealth(db);

    console.log(`Status:    ${report.status.toUpperCase()}`);
    console.log(`Timestamp: ${report.timestamp}\n`);

    console.log('--- Health Categories & Counts ---');
    console.table({
      'Unresolved Failures': {
        Total: report.indicators.unresolvedFailures.total,
        'Outbox Failed': report.indicators.unresolvedFailures.failedOutbox,
        'Deadletters': report.indicators.unresolvedFailures.unresolvedDeadletters,
        Deadletters: report.indicators.unresolvedFailures.unresolvedDeadletters,
        'Failed Refunds': report.indicators.unresolvedFailures.failedRefunds,
        Quarantine: report.indicators.unresolvedFailures.quarantinedFiles,
      },
      'Stale Jobs': {
        Total: report.indicators.staleJobs.total,
        'Stale Intents': report.indicators.staleJobs.staleIntents,
        'Stale Storage Jobs': report.indicators.staleJobs.staleStorageJobs,
      },
      'Reconciliation Drift': {
        Total: report.indicators.reconciliationDrift.total,
        'Purchase Drift': report.indicators.reconciliationDrift.purchaseDrift,
        'Unverified Pins': report.indicators.reconciliationDrift.unverifiedPins,
      },
      'Incidents / Impact': {
        Total: report.indicators.userImpactingIncidents.recentAccessDenials,
        'Access Denials (24h)': report.indicators.userImpactingIncidents.recentAccessDenials,
        'Suspended Accounts': report.indicators.userImpactingIncidents.suspendedUsers,
      },
    });

    if (report.alerts.length > 0) {
      console.log('\n--- Active Alerts ---');
      report.alerts.forEach((alert) => console.log(` [!] ${alert}`));
    }

    if (report.actionableItems.unresolvedExceptions.length > 0) {
      console.log('\n--- Unresolved Exceptions (Sample) ---');
      report.actionableItems.unresolvedExceptions.forEach((item) => {
        const lastError = redactSensitive(item.lastError);
        console.log(` - [${item.category}] ${item.description} (ID: ${item.id})`);
        console.log(`   Error: ${lastError}`);
        console.log(`   Link:  ${item.investigationUrl}`);
      });
    }

    console.log('\n======================================================\n');
  } finally {
    await client.close();
  }
}

/**
 * Redact sensitive details (credentials, tokens, PII) from error strings
 * before they are printed to the maintainer console.
 *
 * @param {unknown} value
 * @returns {string}
 */
function redactSensitive(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/(mongodb(?:\+srv)?:\/\/)[^\s@]+@/gi, '$1[redacted]@')
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]');
}

run().catch((err) => {
  console.error('[maintainer-health-report] Error:', err);
  process.exit(1);
});

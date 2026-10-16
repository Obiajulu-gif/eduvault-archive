/**
 * Maintainer Operational Health & Unresolved Exceptions Report
 *
 * Issue #798:
 * CLI report tool for maintainers summarizing system indicators,
 * unresolved exceptions, stale jobs, and reconciliation drift.
 *
 * Issue #799:
 * Historical trend aggregation for maintainer analytics. Adds deterministic
 * trend metrics over configurable windows (usage, failures, recovery actions,
 * domain activity) with a versioned export schema. Private data is aggregated
 * (counts only) or redacted before being included in the report.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/maintainer-health-report.mjs
 *   MONGODB_URI=mongodb://... node scripts/maintainer-health-report.mjs --trends
 *   MONGODB_URI=mongodb://... node scripts/maintainer-health-report.mjs --trends --window=7d --export=json
 */

import process from 'node:process';
import { MongoClient } from 'mongodb';
import { getOperationalHealth } from '../src/lib/backend/operationalHealth.js';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'eduvault';

/**
 * Schema version for the trend export payload. Bump when the shape of the
 * exported trend report changes in a backwards-incompatible way.
 */
export const TREND_SCHEMA_VERSION = '1.0.0';

/**
 * Supported aggregation windows. Each window is expressed in milliseconds so
 * that bucketing is deterministic and independent of wall-clock timezones.
 */
export const TREND_WINDOWS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
});

/**
 * Trend metric definitions. Each metric maps to a Mongo collection, a
 * timestamp field, and an optional filter. Metrics are intentionally
 * aggregate-only (counts) so that no private student data leaves the
 * aggregation pipeline.
 */
export const TREND_METRICS = Object.freeze([
  { key: 'usage.storageUploads', collection: 'storage_objects', timestampField: 'createdAt', category: 'usage' },
  { key: 'usage.marketplacePurchases', collection: 'purchases', timestampField: 'createdAt', category: 'usage' },
  { key: 'failures.outbox', collection: 'outbox', timestampField: 'createdAt', category: 'failures', filter: { status: 'failed' } },
  { key: 'failures.deadletters', collection: 'deadletters', timestampField: 'createdAt', category: 'failures' },
  { key: 'failures.refunds', collection: 'refunds', timestampField: 'createdAt', category: 'failures', filter: { status: 'failed' } },
  { key: 'recovery.retries', collection: 'outbox', timestampField: 'updatedAt', category: 'recovery', filter: { retryCount: { $gt: 0 } } },
  { key: 'recovery.reconciliations', collection: 'reconciliation_runs', timestampField: 'createdAt', category: 'recovery' },
  { key: 'activity.accessDenials', collection: 'access_events', timestampField: 'createdAt', category: 'activity', filter: { allowed: false } },
  { key: 'activity.suspensions', collection: 'account_events', timestampField: 'createdAt', category: 'activity', filter: { type: 'suspended' } },
]);

/**
 * Parse a window token (e.g. "7d") into milliseconds. Throws on unknown
 * tokens so callers fail fast rather than silently producing empty trends.
 */
export function parseWindow(token) {
  if (token == null) return TREND_WINDOWS['7d'];
  if (typeof token === 'number' && Number.isFinite(token) && token > 0) return token;
  const ms = TREND_WINDOWS[token];
  if (!ms) {
    throw new Error(`[maintainer-health-report] Unknown trend window: ${token}`);
  }
  return ms;
}

/**
 * Compute deterministic bucket boundaries for a window. Buckets are aligned
 * to the window start and are inclusive of `start` and exclusive of `end`.
 * `bucketCount` controls granularity; the default yields daily buckets for
 * multi-day windows and hourly buckets for the 24h window.
 */
export function computeBuckets({ now, windowMs, bucketCount }) {
  const end = now;
  const start = now - windowMs;
  const count = bucketCount || (windowMs <= TREND_WINDOWS['24h'] ? 24 : Math.ceil(windowMs / TREND_WINDOWS['24h']));
  const size = Math.floor(windowMs / count);
  const buckets = [];
  for (let i = 0; i < count; i += 1) {
    buckets.push({
      index: i,
      start: new Date(start + i * size),
      end: new Date(i === count - 1 ? end : start + (i + 1) * size),
    });
  }
  return { start: new Date(start), end: new Date(end), buckets };
}

/**
 * Aggregate a single metric into deterministic buckets. Only counts are
 * returned; no document identifiers or private fields are projected.
 */
export async function aggregateMetric(db, metric, { start, end, buckets }) {
  const collection = db.collection(metric.collection);
  const match = {
    [metric.timestampField]: { $gte: start, $lt: end },
    ...(metric.filter || {}),
  };
  const rows = await collection
    .aggregate([
      { $match: match },
      { $project: { _id: 0, ts: `$${metric.timestampField}` } },
    ])
    .toArray();

  const counts = new Array(buckets.length).fill(0);
  for (const row of rows) {
    const ts = row.ts instanceof Date ? row.ts.getTime() : new Date(row.ts).getTime();
    if (!Number.isFinite(ts)) continue;
    for (let i = 0; i < buckets.length; i += 1) {
      const b = buckets[i];
      if (ts >= b.start.getTime() && ts < b.end.getTime()) {
        counts[i] += 1;
        break;
      }
    }
  }

  const total = counts.reduce((acc, n) => acc + n, 0);
  return {
    key: metric.key,
    category: metric.category,
    total,
    buckets: counts.map((count, i) => ({
      start: buckets[i].start.toISOString(),
      end: buckets[i].end.toISOString(),
      count,
    })),
  };
}

/**
 * Build the full trend report. Deterministic for a fixed `now` and fixture
 * data. Private data is never included: only aggregate counts and metric
 * keys are emitted.
 */
export async function buildTrendReport(db, { now = new Date(), window = '7d', bucketCount } = {}) {
  const windowMs = parseWindow(window);
  const { start, end, buckets } = computeBuckets({ now: now.getTime(), windowMs, bucketCount });

  const metrics = [];
  for (const metric of TREND_METRICS) {
    metrics.push(await aggregateMetric(db, metric, { start, end, buckets }));
  }

  const byCategory = {};
  for (const m of metrics) {
    byCategory[m.category] = byCategory[m.category] || { total: 0, metrics: [] };
    byCategory[m.category].total += m.total;
    byCategory[m.category].metrics.push(m.key);
  }

  return {
    schemaVersion: TREND_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    window: { token: typeof window === 'string' ? window : `${window}ms`, start: start.toISOString(), end: end.toISOString(), bucketCount: buckets.length },
    categories: byCategory,
    metrics,
  };
}

/**
 * Parse CLI flags for the trend report. Kept small and dependency-free so the
 * script remains runnable in minimal environments.
 */
export function parseArgs(argv) {
  const args = { trends: false, window: '7d', export: 'text', bucketCount: undefined };
  for (const raw of argv) {
    if (raw === '--trends') args.trends = true;
    else if (raw.startsWith('--window=')) args.window = raw.slice('--window='.length);
    else if (raw.startsWith('--export=')) args.export = raw.slice('--export='.length);
    else if (raw.startsWith('--buckets=')) args.bucketCount = Number(raw.slice('--buckets='.length));
  }
  return args;
}

/**
 * Render the trend report as human-readable text. Counts only; no private
 * data is printed.
 */
export function renderTrendReport(report) {
  const lines = [];
  lines.push('\n--- Historical Trends ---');
  lines.push(`Schema:  ${report.schemaVersion}`);
  lines.push(`Window:  ${report.window.token} (${report.window.start} -> ${report.window.end})`);
  lines.push(`Buckets: ${report.window.bucketCount}\n`);
  for (const m of report.metrics) {
    lines.push(`[${m.category}] ${m.key}: total=${m.total}`);
    lines.push(`  ${m.buckets.map((b) => b.count).join(', ')}`);
  }
  return lines.join('\n');
}

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
    const args = parseArgs(process.argv.slice(2));

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

    if (args.trends) {
      const trendReport = await buildTrendReport(db, {
        now: new Date(),
        window: args.window,
        bucketCount: args.bucketCount,
      });
      if (args.export === 'json') {
        console.log(JSON.stringify(trendReport, null, 2));
      } else {
        console.log(renderTrendReport(trendReport));
      }
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

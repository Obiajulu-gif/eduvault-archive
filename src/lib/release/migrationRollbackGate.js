/**
 * src/lib/release/migrationRollbackGate.js
 *
 * Release readiness checks for migrations and rollback (#1080).
 *
 * The evidence gate (`readiness.js`, #978) checks that each migration has
 * `dryRunPassed` and `rollbackDocumented` set. This gate checks the plan
 * behind those flags, per migration:
 *
 *   1. ordering     ids are unique and `order` strictly increases
 *   2. dry run      passed recently against the release commit
 *   3. retry        a migration that needed more than one dry-run attempt
 *                   must be idempotent, otherwise a retried production run
 *                   can double-apply
 *   4. rollback     a concrete strategy:
 *                     - "down"             a down script, rehearsed recently
 *                     - "restore_snapshot" a verified snapshot taken recently
 *                     - "none"             irreversible: needs a second
 *                                          authorized approver (two-person rule)
 *   5. unresolved   any `rollback_verifications` run for the same migration
 *                   still in an unresolved state blocks the release
 *                   (see src/lib/migrations/rollbackVerification.js)
 *   6. authority    the actor running the gate must be authorized to release
 *
 * The gate is read-only. It never runs a migration or a rollback.
 * Plan format: release/migration-plan.example.json.
 */

import { CheckStatus, checkDeploymentAuthorization } from './releaseReadiness.js';
import { ROLLBACK_VERIFICATIONS_COLLECTION, UNRESOLVED_STATES } from '../migrations/rollbackVerification.js';

export const ROLLBACK_STRATEGY = Object.freeze({
  DOWN: 'down',
  RESTORE_SNAPSHOT: 'restore_snapshot',
  NONE: 'none',
});

export const GATE_DEFAULTS = Object.freeze({
  maxDryRunAgeDays: 7,
  maxRehearsalAgeDays: 30,
  maxSnapshotAgeHours: 24,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function parseTime(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function isAuthorized(approver) {
  return checkDeploymentAuthorization(approver).status === CheckStatus.PASSED;
}

/**
 * Checks one migration entry. Returns a list of blocker messages.
 */
export function checkMigrationEntry(migration, { now = new Date(), expectedCommit = null, requestedBy = null, ...limits } = {}) {
  const opts = { ...GATE_DEFAULTS, ...limits };
  const nowMs = now.getTime();
  const problems = [];

  // ── dry run ─────────────────────────────────────────────────────────────
  const dryRun = migration.dryRun || {};
  const dryRunAt = parseTime(dryRun.at);
  if (dryRun.status !== 'passed') {
    problems.push(`dry run must have status "passed", got "${dryRun.status ?? 'missing'}"`);
  } else if (dryRunAt === null || nowMs - dryRunAt > opts.maxDryRunAgeDays * DAY_MS) {
    problems.push(`dry run must be dated within the last ${opts.maxDryRunAgeDays} days`);
  } else if (dryRunAt > nowMs) {
    problems.push('dry run is dated in the future');
  } else if (expectedCommit && dryRun.commit && dryRun.commit !== expectedCommit) {
    problems.push(`dry run ran against ${dryRun.commit}, not the release commit ${expectedCommit}`);
  }

  // ── retry safety ────────────────────────────────────────────────────────
  const attempts = Number(dryRun.attempts ?? 1);
  if (attempts > 1 && migration.idempotent !== true) {
    problems.push(`dry run needed ${attempts} attempts but the migration is not marked idempotent, so a retried production run could double-apply`);
  }

  // ── rollback strategy ───────────────────────────────────────────────────
  const rollback = migration.rollback || {};
  switch (rollback.strategy) {
    case ROLLBACK_STRATEGY.DOWN: {
      const rehearsedAt = parseTime(rollback.rehearsedAt);
      if (!rollback.script) problems.push('rollback strategy "down" needs the down script path in rollback.script');
      if (rollback.rehearsalStatus !== 'passed') {
        problems.push(`rollback rehearsal must have status "passed", got "${rollback.rehearsalStatus ?? 'missing'}"`);
      } else if (rehearsedAt === null || nowMs - rehearsedAt > opts.maxRehearsalAgeDays * DAY_MS) {
        problems.push(`rollback rehearsal must be dated within the last ${opts.maxRehearsalAgeDays} days`);
      }
      break;
    }
    case ROLLBACK_STRATEGY.RESTORE_SNAPSHOT: {
      const snapshotAt = parseTime(rollback.snapshotAt);
      if (!rollback.snapshotId) problems.push('rollback strategy "restore_snapshot" needs rollback.snapshotId');
      if (rollback.snapshotVerified !== true) problems.push('snapshot must be restore-verified (rollback.snapshotVerified: true)');
      if (snapshotAt === null || nowMs - snapshotAt > opts.maxSnapshotAgeHours * HOUR_MS) {
        problems.push(`snapshot must be taken within the last ${opts.maxSnapshotAgeHours} hours`);
      }
      break;
    }
    case ROLLBACK_STRATEGY.NONE: {
      // Irreversible: require a second, authorized person to sign off.
      const approvals = Array.isArray(migration.approvals) ? migration.approvals : [];
      const valid = approvals.filter(
        (a) => a && isAuthorized(a) && a.id && a.id !== requestedBy && a.id !== migration.author
      );
      if (valid.length === 0) {
        problems.push('irreversible migration (rollback strategy "none") needs an approval from an authorized release role who is neither the author nor the requester');
      }
      break;
    }
    default:
      problems.push(`rollback.strategy must be one of ${Object.values(ROLLBACK_STRATEGY).join(', ')}`);
  }

  return problems;
}

/**
 * Loads unresolved rollback verification runs, grouped by migration name.
 * A database error is returned, not thrown, so the gate can fail closed.
 */
export async function loadUnresolvedRuns(db) {
  if (!db) return { runs: [], error: null };
  try {
    const runs = await db
      .collection(ROLLBACK_VERIFICATIONS_COLLECTION)
      .find({ state: { $in: UNRESOLVED_STATES } })
      .toArray();
    return { runs: runs.map((r) => ({ name: r.name, state: r.state, runId: String(r._id) })), error: null };
  } catch (error) {
    return { runs: [], error: error?.message || 'unknown error' };
  }
}

/**
 * Evaluates a migration plan for release.
 *
 * @param {object|null} plan             parsed release/migration-plan.json
 * @param {object} [options]
 * @param {object} [options.actor]       { id, role, permissions } running the gate
 * @param {string} [options.expectedCommit]
 * @param {Date}   [options.now]
 * @param {Array<{name: string, state: string}>} [options.unresolvedRuns]
 * @param {string|null} [options.unresolvedRunsError]  set when runs could not be read
 * @returns {{ ready: boolean, checked: string[], blockers: Array<{migration: string, message: string}> }}
 */
export function evaluateMigrationRollbackGate(plan, {
  actor = null,
  expectedCommit = null,
  now = new Date(),
  unresolvedRuns = [],
  unresolvedRunsError = null,
  ...limits
} = {}) {
  const blockers = [];
  const checked = [];
  const add = (migration, message) => blockers.push({ migration, message });

  const auth = checkDeploymentAuthorization(actor);
  if (auth.status !== CheckStatus.PASSED) add('*', auth.message);

  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.migrations)) {
    add('*', 'Migration plan must be an object with a migrations array (use [] when a release has none)');
    return { ready: false, checked, blockers };
  }

  if (unresolvedRunsError) {
    // Fail closed: if we cannot prove there is no half-rolled-back run, block.
    add('*', `Could not read ${ROLLBACK_VERIFICATIONS_COLLECTION}: ${unresolvedRunsError}`);
  }

  const seen = new Set();
  let previousOrder = -Infinity;
  for (const migration of plan.migrations) {
    const id = migration?.id;
    if (!id || typeof id !== 'string') {
      add('(unnamed)', 'every migration needs a string id');
      continue;
    }
    if (seen.has(id)) add(id, 'duplicate migration id');
    seen.add(id);

    const order = Number(migration.order);
    if (!Number.isFinite(order) || order <= previousOrder) {
      add(id, `order must be a number greater than the previous migration (${previousOrder})`);
    } else {
      previousOrder = order;
    }

    for (const message of checkMigrationEntry(migration, { now, expectedCommit, requestedBy: actor?.id, ...limits })) {
      add(id, message);
    }
    for (const run of unresolvedRuns.filter((r) => r.name === id)) {
      add(id, `previous run is unresolved (${run.state}); finish it with retryRollbackVerification before releasing`);
    }
    checked.push(id);
  }

  return { ready: blockers.length === 0, checked, blockers };
}

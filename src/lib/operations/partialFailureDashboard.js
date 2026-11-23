/**
 * src/lib/operations/partialFailureDashboard.js
 *
 * Operator dashboard for unresolved partial failures — Issue #1101.
 *
 * The repository already has a partial-failure service and a dashboard page.
 * This module supplies the missing *triage* layer: an unresolved-only view
 * model with age/SLA buckets and an explicit next action per failure, plus an
 * authorization-gated, audited action executor.
 *
 * Design notes:
 *   - Pure read path: `buildUnresolvedDashboard` never writes and accepts the
 *     output of `getPartialFailures` directly (no contract change).
 *   - Safety: a failure that needs user action or is not safely retryable can
 *     never be auto-retried through the dashboard, regardless of the handler.
 *   - Recovery: every recommendation documents its rollback behaviour, and
 *     every applied action records the actor and reason in the supplied audit
 *     hook. Retry handlers receive an idempotency key derived from the failure
 *     id and action.
 */

import crypto from 'node:crypto';
import { PARTIAL_FAILURE_STATUSES, SEVERITIES } from '../backend/partialFailures.js';

// ─── Constants ─────────────────────────────────────────────────────────────

export const DASHBOARD_ACTION = Object.freeze({
  ACKNOWLEDGE: 'ACKNOWLEDGE',
  RETRY: 'RETRY',
  RESOLVE: 'RESOLVE',
  ESCALATE: 'ESCALATE',
});

export const AGE_BUCKET = Object.freeze({
  FRESH: 'fresh',
  AGING: 'aging',
  STALE: 'stale',
  CRITICAL: 'critical_age',
});

export const DEFAULT_SLA_MS = Object.freeze({
  [SEVERITIES.CRITICAL]: 15 * 60 * 1000,
  [SEVERITIES.HIGH]: 60 * 60 * 1000,
  [SEVERITIES.MEDIUM]: 4 * 60 * 60 * 1000,
  [SEVERITIES.LOW]: 24 * 60 * 60 * 1000,
});

const SEVERITY_ORDER = Object.freeze({
  [SEVERITIES.CRITICAL]: 0,
  [SEVERITIES.HIGH]: 1,
  [SEVERITIES.MEDIUM]: 2,
  [SEVERITIES.LOW]: 3,
});

const OPEN_STATUSES = new Set([
  PARTIAL_FAILURE_STATUSES.UNRESOLVED,
  PARTIAL_FAILURE_STATUSES.RETRYING,
]);

// ─── Errors ────────────────────────────────────────────────────────────────

export class DashboardAuthError extends Error {
  constructor(message = 'Not authorized to act on partial failures.') {
    super(message);
    this.name = 'DashboardAuthError';
    this.code = 'DASHBOARD_AUTH_FORBIDDEN';
    this.status = 403;
  }
}

export class DashboardValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'DashboardValidationError';
    this.code = 'DASHBOARD_VALIDATION_ERROR';
    this.status = 400;
    this.details = details;
  }
}

export class DashboardActionError extends Error {
  constructor(message, { action, failureId, attempts, cause } = {}) {
    super(message);
    this.name = 'DashboardActionError';
    this.code = 'DASHBOARD_ACTION_FAILED';
    this.status = 502;
    this.action = action ?? null;
    this.failureId = failureId ?? null;
    this.attempts = attempts ?? null;
    this.cause = cause ?? null;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toMillis(value, fallback) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function groupCounts(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item) ?? 'unknown';
    const entry = map.get(key) ?? { key, count: 0, slaBreached: 0, critical: 0 };
    entry.count += 1;
    if (item.slaBreached) entry.slaBreached += 1;
    if (item.severity === SEVERITIES.CRITICAL) entry.critical += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

function stableFingerprint(items) {
  const normalized = items
    .map((item) => ({ id: item.failureId, status: item.status, nextAction: item.nextAction?.type ?? null }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

// ─── Triage view model ─────────────────────────────────────────────────────

/**
 * Choose the safest next action for a failure.
 */
export function recommendNextAction(failure, { ageMs = 0, slaBreached = false, now = Date.now() } = {}) {
  if (!failure || typeof failure !== 'object') {
    throw new DashboardValidationError('A failure record is required.');
  }

  if (failure.requiresUserAction) {
    return {
      type: DASHBOARD_ACTION.ESCALATE,
      label: 'Contact the user, then re-check',
      reason: failure.userActionGuidance || 'The operation cannot complete until the user takes an action.',
      rollback: 'Do not retry automatically; an automated retry would repeat the same user-dependent failure.',
    };
  }

  const attempts = Number(failure.errorCause?.retryCount ?? 0);
  const maxRetries = Number(failure.errorCause?.maxRetries ?? 3);

  if (!failure.canRetrySafely || attempts >= maxRetries) {
    return {
      type: DASHBOARD_ACTION.RESOLVE,
      label: 'Verify manually, then resolve',
      reason: !failure.canRetrySafely
        ? 'This failure is not marked as safely retryable.'
        : `Retry budget exhausted (${attempts}/${maxRetries}).`,
      rollback: 'If the operation completed out of band, mark resolved; otherwise escalate to an engineer.',
    };
  }

  if (slaBreached) {
    return {
      type: DASHBOARD_ACTION.ESCALATE,
      label: 'Escalate: SLA breached',
      reason: `Failure has been open for ${ageMs}ms, beyond its severity target.`,
      rollback: 'Escalation is informational only; no state is changed.',
    };
  }

  return {
    type: DASHBOARD_ACTION.RETRY,
    label: 'Safe idempotent retry',
    reason: `Failure is retryable (${attempts}/${maxRetries} attempts used).`,
    rollback: 'The retry is idempotent; if it fails again the failure stays unresolved for another attempt.',
  };
}

/**
 * Enrich a single failure for dashboard display.
 */
export function enrichFailure(failure, { now = () => Date.now(), slaTargets = DEFAULT_SLA_MS } = {}) {
  const current = typeof now === 'function' ? Number(now()) : Number(now);
  const createdAt = toMillis(failure.createdAt, current);
  const ageMs = Math.max(0, current - createdAt);
  const slaMs = slaTargets?.[failure.severity] ?? DEFAULT_SLA_MS[SEVERITIES.MEDIUM];
  const slaBreached = ageMs > slaMs;

  let ageBucket = AGE_BUCKET.CRITICAL;
  if (ageMs < 15 * 60 * 1000) ageBucket = AGE_BUCKET.FRESH;
  else if (ageMs < 60 * 60 * 1000) ageBucket = AGE_BUCKET.AGING;
  else if (ageMs < 4 * 60 * 60 * 1000) ageBucket = AGE_BUCKET.STALE;

  return {
    ...failure,
    ageMs,
    ageBucket,
    slaMs,
    slaBreached,
    retryAllowed: failure.canRetrySafely === true && failure.requiresUserAction !== true,
    nextAction: recommendNextAction(failure, { ageMs, slaBreached, now: current }),
  };
}

/**
 * Build the unresolved-only triage dashboard from `getPartialFailures` output.
 *
 * @param {Array|{items: Array}} input
 * @param {object} [options]
 * @param {Function|number} [options.now]
 * @param {object} [options.slaTargets]
 * @param {boolean} [options.includeResolved=false]
 * @param {number} [options.limit=200]
 */
export function buildUnresolvedDashboard(input, {
  now = () => Date.now(),
  slaTargets = DEFAULT_SLA_MS,
  includeResolved = false,
  limit = 200,
} = {}) {
  const raw = Array.isArray(input) ? input : input?.items;
  if (!Array.isArray(raw)) {
    throw new DashboardValidationError('Expected an array of failures or { items: [...] }.');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new DashboardValidationError('limit must be a positive integer.');
  }

  const open = raw.filter((failure) => includeResolved || OPEN_STATUSES.has(failure?.status));
  const items = open
    .map((failure) => enrichFailure(failure, { now, slaTargets }))
    .sort((a, b) => {
      const bySeverity = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
      return bySeverity || b.ageMs - a.ageMs;
    })
    .slice(0, limit);

  const summary = {
    total: items.length,
    byDomain: groupCounts(items, (item) => item.domain),
    bySeverity: groupCounts(items, (item) => item.severity),
    byAgeBucket: groupCounts(items, (item) => item.ageBucket),
    slaBreached: items.filter((item) => item.slaBreached).length,
    requiresUserAction: items.filter((item) => item.requiresUserAction).length,
    retryable: items.filter((item) => item.retryAllowed).length,
    oldestAgeMs: items.reduce((max, item) => Math.max(max, item.ageMs), 0),
  };

  const current = typeof now === 'function' ? Number(now()) : Number(now);

  return {
    generatedAt: Number.isFinite(current) ? new Date(current).toISOString() : new Date().toISOString(),
    fingerprint: stableFingerprint(items),
    summary,
    items,
  };
}

// ─── Action executor ───────────────────────────────────────────────────────

/**
 * Create an authorization-gated dashboard action executor.
 *
 * `handlers` maps DASHBOARD_ACTION values to async functions receiving
 * `{ failureId, principal, reason, idempotencyKey, failure }`. `audit` receives
 * a structured record for every applied preview/action.
 */
export function createDashboardActions({
  authorize = async () => false,
  handlers = {},
  audit = async () => {},
  maxAttempts = 3,
  retryDelayMs = 25,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  if (typeof authorize !== 'function' || typeof audit !== 'function') {
    throw new DashboardValidationError('authorize and audit must be functions.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new DashboardValidationError('maxAttempts must be a positive integer.');
  }

  const stats = { previews: 0, applied: 0, rejected: 0, unsafeBlocked: 0, retries: 0, failed: 0 };

  async function act({
    action,
    failure = null,
    failureId = failure?.failureId ?? null,
    principal = null,
    reason = '',
    dryRun = true,
  } = {}) {
    let allowed;
    try {
      allowed = await authorize(principal, action);
    } catch {
      allowed = false;
    }
    if (allowed !== true) {
      stats.rejected += 1;
      throw new DashboardAuthError();
    }
    if (!Object.values(DASHBOARD_ACTION).includes(action)) {
      throw new DashboardValidationError(`Unknown dashboard action "${action}".`);
    }
    if (!failureId) {
      throw new DashboardValidationError('failureId is required.');
    }

    // Safety invariant: never auto-retry a user-dependent or unsafe failure.
    if (action === DASHBOARD_ACTION.RETRY && failure) {
      if (failure.requiresUserAction || failure.canRetrySafely !== true) {
        stats.unsafeBlocked += 1;
        throw new DashboardValidationError('This failure cannot be safely retried automatically.', {
          failureId,
          requiresUserAction: Boolean(failure.requiresUserAction),
          canRetrySafely: Boolean(failure.canRetrySafely),
        });
      }
    }

    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`${action}:${failureId}:${reason || 'none'}`)
      .digest('hex');

    const plan = {
      action,
      failureId,
      actor: principal?.id ?? 'operator',
      reason: String(reason || '').slice(0, 500),
      idempotencyKey,
      dryRun: Boolean(dryRun),
      rollback: action === DASHBOARD_ACTION.RETRY
        ? 'Idempotent retry: if the attempt fails the failure remains unresolved.'
        : 'Audit-only action: no workflow state is mutated.',
    };

    if (dryRun) {
      stats.previews += 1;
      await audit({ ...plan, result: 'PREVIEWED' });
      return { ...plan, applied: false, attempts: 0 };
    }

    const handler = handlers[action] ?? null;
    let result = null;
    let lastError;
    let attempts = 0;

    // ACKNOWLEDGE and ESCALATE are audit-only by design.
    const totalAttempts = handler ? maxAttempts : 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      attempts = attempt;
      try {
        result = handler
          ? await handler({ failureId, principal, reason: plan.reason, idempotencyKey, failure })
          : { recorded: true };
        break;
      } catch (error) {
        lastError = error;
        if (error?.retryable === false || attempt === totalAttempts) break;
        stats.retries += 1;
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }

    if (result === null) {
      stats.failed += 1;
      throw new DashboardActionError(
        `Dashboard action ${action} failed for ${failureId} after ${attempts} attempt(s).`,
        { action, failureId, attempts, cause: lastError },
      );
    }

    stats.applied += 1;
    await audit({ ...plan, result: 'APPLIED', attempts, outcome: result });
    return { ...plan, applied: true, attempts, result, appliedAt: new Date(Number(now())).toISOString() };
  }

  function getStats() {
    return { ...stats };
  }

  return { act, stats: getStats };
}

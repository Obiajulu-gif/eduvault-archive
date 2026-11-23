/**
 * src/lib/status/degradedDependencyStatus.js
 *
 * User-facing status for degraded dependencies — Issue #1099.
 *
 * Bridges the operator-only dependency checker (`checkAllDependencies`) and
 * the subsystem state model (`publicStatusModel`) into a small, safe status
 * payload suitable for learners, buyers, and creators:
 *
 *   - Only user-visible feature impact is published. Internal dependency
 *     names, hostnames, credentials, remediation text, latencies, and raw
 *     error messages are deliberately dropped.
 *   - All free-form text passes through the existing `sanitizeText` helper.
 *   - Operator overrides require an authorization gate and may never make a
 *     status look better than what the dependency checker observed.
 *   - The public contract of `GET /api/status` is untouched; this module backs
 *     a new, additive endpoint.
 */

import { DEPENDENCY_STATUS } from '../health/dependencyChecker.js';
import { SYSTEM_STATE, sanitizeText } from './publicStatusModel.js';

// ─── Constants ─────────────────────────────────────────────────────────────

export const USER_STATUS = Object.freeze({
  OPERATIONAL: 'operational',
  DEGRADED: 'degraded',
  PARTIAL_OUTAGE: 'partial_outage',
  UNAVAILABLE: 'unavailable',
  MAINTENANCE: 'maintenance',
});

const STATUS_RANK = Object.freeze({
  [USER_STATUS.OPERATIONAL]: 0,
  [USER_STATUS.DEGRADED]: 1,
  [USER_STATUS.PARTIAL_OUTAGE]: 2,
  [USER_STATUS.UNAVAILABLE]: 3,
  [USER_STATUS.MAINTENANCE]: 3,
});

const BANNERS = Object.freeze({
  [USER_STATUS.OPERATIONAL]: null,
  [USER_STATUS.DEGRADED]: 'Some features may respond more slowly than usual. Most actions remain available while we monitor the service.',
  [USER_STATUS.PARTIAL_OUTAGE]: 'Some features are temporarily unavailable. Browsing still works; purchases, uploads, or downloads may be delayed.',
  [USER_STATUS.UNAVAILABLE]: 'We are temporarily unable to complete requests. Please try again shortly.',
  [USER_STATUS.MAINTENANCE]: 'Scheduled maintenance is in progress. Please try again shortly.',
});

/**
 * Public descriptions keyed by internal dependency name. The internal name is
 * never exposed: only `id`, `label`, and feature impact are published.
 */
export const DEPENDENCY_VIEWS = Object.freeze({
  database: {
    id: 'account-data',
    label: 'Account and purchase history',
    features: ['browsing', 'purchase history', 'account settings'],
    fallback: 'Recently viewed data may be shown from cache.',
    critical: true,
    retryAfterSeconds: 60,
  },
  stellar: {
    id: 'payments-and-licensing',
    label: 'Payments and licensing',
    features: ['checkout', 'creator payouts', 'license verification'],
    fallback: 'New purchases may be queued and completed once the network recovers.',
    critical: true,
    retryAfterSeconds: 120,
  },
  storage: {
    id: 'material-delivery',
    label: 'Material delivery',
    features: ['uploads', 'downloads', 'previews'],
    fallback: 'Previously downloaded materials may remain available offline.',
    critical: false,
    retryAfterSeconds: 120,
  },
  email: {
    id: 'email-notifications',
    label: 'Email notifications',
    features: ['receipts', 'account alerts'],
    fallback: 'Notifications will be delivered once the mail service recovers.',
    critical: false,
    retryAfterSeconds: 300,
  },
  contracts: {
    id: 'on-chain-licensing',
    label: 'On-chain licensing',
    features: ['license checks', 'payout settlement'],
    fallback: 'Existing entitlements continue to work from cached records.',
    critical: false,
    retryAfterSeconds: 300,
  },
});

// ─── Errors ────────────────────────────────────────────────────────────────

export class StatusAuthError extends Error {
  constructor(message = 'Not authorized to modify public status.') {
    super(message);
    this.name = 'StatusAuthError';
    this.code = 'STATUS_AUTH_FORBIDDEN';
    this.status = 403;
  }
}

export class StatusValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'StatusValidationError';
    this.code = 'STATUS_VALIDATION_ERROR';
    this.status = 400;
    this.details = details;
  }
}

// ─── Pure derivation ───────────────────────────────────────────────────────

function mapDependencyStatus(status, critical) {
  switch (status) {
    case DEPENDENCY_STATUS.HEALTHY:
      return USER_STATUS.OPERATIONAL;
    case DEPENDENCY_STATUS.DEGRADED:
      return USER_STATUS.DEGRADED;
    case DEPENDENCY_STATUS.UNAVAILABLE:
    case DEPENDENCY_STATUS.MISCONFIGURED:
      return critical ? USER_STATUS.UNAVAILABLE : USER_STATUS.PARTIAL_OUTAGE;
    default:
      return USER_STATUS.DEGRADED;
  }
}

function worst(statuses) {
  return statuses.reduce((acc, status) => (
    (STATUS_RANK[status] ?? 0) > (STATUS_RANK[acc] ?? 0) ? status : acc
  ), USER_STATUS.OPERATIONAL);
}

function messageFor(status, label) {
  switch (status) {
    case USER_STATUS.OPERATIONAL:
      return `${label} is working normally.`;
    case USER_STATUS.DEGRADED:
      return `${label} is responding slowly. Some actions may take longer than usual.`;
    case USER_STATUS.PARTIAL_OUTAGE:
      return `${label} is temporarily unavailable. Other parts of the site still work.`;
    case USER_STATUS.UNAVAILABLE:
      return `${label} is temporarily unavailable.`;
    case USER_STATUS.MAINTENANCE:
      return `${label} is undergoing scheduled maintenance.`;
    default:
      return `${label} may be limited right now.`;
  }
}

/**
 * Build a safe, user-facing status payload from dependency checker output.
 *
 * @param {object} options
 * @param {object} [options.dependencyReport]  Output of `checkAllDependencies`.
 * @param {object} [options.subsystemState]    Optional `{ state, reason }`.
 * @param {object} [options.overrides]         Map of internalName -> { status, message }.
 * @param {Function|Date} [options.now]        Injectable clock.
 * @returns {object} public status payload
 */
export function buildUserFacingStatus({
  dependencyReport = null,
  subsystemState = null,
  overrides = {},
  now = () => new Date(),
} = {}) {
  const timestamp = typeof now === 'function' ? now() : now;
  const moment = timestamp instanceof Date ? timestamp : new Date(Number(timestamp));
  const observedAt = Number.isNaN(moment.getTime()) ? new Date().toISOString() : moment.toISOString();

  const rawDependencies = dependencyReport?.dependencies && typeof dependencyReport.dependencies === 'object'
    ? dependencyReport.dependencies
    : {};

  const features = [];
  const allStatuses = [];
  let retryAfterSeconds = 0;

  for (const [internalName, view] of Object.entries(DEPENDENCY_VIEWS)) {
    const raw = rawDependencies[internalName] ?? null;
    const observed = mapDependencyStatus(raw?.status ?? DEPENDENCY_STATUS.DEGRADED, view.critical);
    const override = overrides?.[internalName];
    const effective = override?.status && STATUS_RANK[override.status] > STATUS_RANK[observed]
      ? override.status
      : observed;

    allStatuses.push(effective);

    const safeOverrideMessage = override?.message ? sanitizeText(override.message) : null;
    const userMessage = safeOverrideMessage || messageFor(effective, view.label);

    if (effective !== USER_STATUS.OPERATIONAL && view.retryAfterSeconds > retryAfterSeconds) {
      retryAfterSeconds = view.retryAfterSeconds;
    }

    for (const feature of view.features) {
      features.push({
        feature,
        status: effective,
        message: sanitizeText(userMessage),
        fallback: effective === USER_STATUS.OPERATIONAL ? null : sanitizeText(view.fallback),
      });
    }
  }

  let overall = worst(allStatuses);

  if (subsystemState?.state === SYSTEM_STATE.MAINTENANCE) {
    overall = USER_STATUS.MAINTENANCE;
  } else if (subsystemState?.state === SYSTEM_STATE.PAUSED && STATUS_RANK[USER_STATUS.PARTIAL_OUTAGE] > STATUS_RANK[overall]) {
    overall = USER_STATUS.PARTIAL_OUTAGE;
  } else if (subsystemState?.state === SYSTEM_STATE.DEGRADED && STATUS_RANK[USER_STATUS.DEGRADED] > STATUS_RANK[overall]) {
    overall = USER_STATUS.DEGRADED;
  }

  const impacted = features.filter((f) => f.status !== USER_STATUS.OPERATIONAL);
  const affectedAreas = [...new Set(impacted.map((f) => f.feature))];

  return {
    status: overall,
    banner: BANNERS[overall] ? sanitizeText(BANNERS[overall]) : null,
    affectedAreas,
    features,
    retryAfterSeconds: overall === USER_STATUS.OPERATIONAL || overall === USER_STATUS.MAINTENANCE ? 0 : retryAfterSeconds,
    canRetry: overall !== USER_STATUS.MAINTENANCE && overall !== USER_STATUS.UNAVAILABLE,
    updatedAt: observedAt,
    // HTTP hint; public routes may use it without re-deriving the status.
    suggestedStatus: overall === USER_STATUS.PARTIAL_OUTAGE || overall === USER_STATUS.UNAVAILABLE ? 503 : 200,
  };
}

/**
 * Verify that a payload contains no internal diagnostics. Used by the status
 * route tests and available to operators for regression checks.
 */
export function assertSafeForUsers(payload) {
  const json = JSON.stringify(payload ?? {});
  const safe = sanitizeText(json);
  if (safe !== json) return false;
  if (/ECONNREFUSED|ETIMEDOUT|MongoError|HorizonError|mongodb(?:\+srv)?:\/\//i.test(json)) return false;
  if (/\bat\s+\S+\s*\(/m.test(json)) return false;
  return true;
}

// ─── Status store with authorization-gated overrides ──────────────────────

/**
 * @param {object} options
 * @param {Function} options.dependenciesProvider  async () => dependency report
 * @param {Function} [options.subsystemProvider]   async () => { state, reason }
 * @param {Function} [options.authorize]           async (principal, action) => boolean
 * @param {Function} [options.now]                 Injectable clock
 */
export function createUserFacingStatusStore({
  dependenciesProvider,
  subsystemProvider = async () => null,
  authorize = async () => false,
  now = () => new Date(),
} = {}) {
  if (typeof dependenciesProvider !== 'function') {
    throw new StatusValidationError('dependenciesProvider must be a function.');
  }

  const overrides = new Map();
  const history = [];
  const MAX_HISTORY = 50;
  let lastSnapshot = null;

  async function get() {
    let report;
    try {
      report = await dependenciesProvider();
    } catch {
      // A failing health provider is itself a degraded condition. Never
      // surface the provider's error text to users.
      report = { dependencies: {} };
    }

    let subsystem = null;
    try {
      subsystem = await subsystemProvider();
    } catch {
      subsystem = null;
    }

    const overrideMap = Object.fromEntries(overrides.entries());
    lastSnapshot = buildUserFacingStatus({
      dependencyReport: report,
      subsystemState: subsystem,
      overrides: overrideMap,
      now,
    });
    history.unshift({ at: lastSnapshot.updatedAt, status: lastSnapshot.status, source: 'refresh' });
    if (history.length > MAX_HISTORY) history.pop();
    return lastSnapshot;
  }

  async function setOverride({ dependency, status, message = '', principal = null } = {}) {
    let allowed;
    try {
      allowed = await authorize(principal, 'status:override');
    } catch {
      allowed = false;
    }
    if (allowed !== true) throw new StatusAuthError();

    if (!Object.hasOwn(DEPENDENCY_VIEWS, dependency)) {
      throw new StatusValidationError(`Unknown dependency "${dependency}".`);
    }
    if (!Object.values(USER_STATUS).includes(status)) {
      throw new StatusValidationError(`Invalid status "${status}".`);
    }

    // Never let an operator mask a live outage as healthy. Overrides may only
    // escalate severity, and are cleared on the next explicit clearOverride().
    const fresh = await get();
    const current = fresh.features.find((f) => DEPENDENCY_VIEWS[dependency].features.includes(f.feature))?.status
      ?? USER_STATUS.OPERATIONAL;
    if (STATUS_RANK[status] < STATUS_RANK[current]) {
      throw new StatusValidationError('A public status override cannot report a healthier state than the observed status.');
    }

    overrides.set(dependency, {
      status,
      message: sanitizeText(String(message)).slice(0, 200),
      actor: principal?.id ?? 'operator',
    });
    return get();
  }

  async function clearOverride({ dependency, principal = null } = {}) {
    let allowed;
    try {
      allowed = await authorize(principal, 'status:override');
    } catch {
      allowed = false;
    }
    if (allowed !== true) throw new StatusAuthError();
    if (!Object.hasOwn(DEPENDENCY_VIEWS, dependency)) {
      throw new StatusValidationError(`Unknown dependency "${dependency}".`);
    }
    overrides.delete(dependency);
    return get();
  }

  function getOperatorView() {
    return {
      snapshot: lastSnapshot,
      overrides: Object.fromEntries(overrides.entries()),
      history: history.slice(0, 25),
    };
  }

  return { get, setOverride, clearOverride, getOperatorView };
}

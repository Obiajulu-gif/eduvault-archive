/**
 * src/lib/featureFlags.js
 *
 * Typed feature flag definitions with safe defaults (#797) and runtime
 * emergency-disablement overrides (#1018).
 *
 * Feature flags let maintainers stage rollout of risky behavior, compare
 * behavior between enabled/disabled cohorts, and disable a new path without a
 * redeploy (emergency rollback = flip the env var, not a code change).
 *
 * Design rules
 * ────────────
 * • Every flag has a hard-coded safe default. Missing or malformed
 *   configuration always falls back to that default — never to "enabled".
 * • Flags are read from `FEATURE_FLAG_<KEY>` environment variables so they
 *   can be changed per-environment (local / preview / production) without a
 *   code change.
 * • Runtime overrides (stored in MongoDB `feature_flag_overrides`) take
 *   precedence over env vars and are the basis for emergency disablement
 *   without a redeploy. Use `withFeatureGuard()` at route level to enforce.
 * • The registry below is the single source of truth. Adding a flag means
 *   adding one entry here; nothing else in the codebase needs to change.
 * • Synchronous `isFeatureFlagEnabled` is still safe in React components and
 *   contexts where a DB isn't available; async `resolveFeatureFlag` consults
 *   the override layer and is the correct choice for API route handlers.
 */

/**
 * @typedef {object} FeatureFlagDefinition
 * @property {string} key            - Registry key. The env var is `FEATURE_FLAG_<KEY>`.
 * @property {string} description    - What the flag controls, for operators.
 * @property {boolean} defaultValue  - Safe fallback when the env var is missing or malformed.
 * @property {string[]} [rolloutStages] - Ordered stage names for progressive rollout (informational).
 */

/**
 * The flag registry. Keys are UPPER_SNAKE_CASE; values carry the safe
 * default and a human-readable description.
 *
 * @type {Record<string, FeatureFlagDefinition>}
 */
export const FEATURE_FLAG_REGISTRY = Object.freeze({
  /**
   * Gates the critical lifecycle / recovery notifications (#776): purchase,
   * refund, entitlement, payout, suspension, and wallet-recovery events.
   * Default OFF — sending users notifications is new behavior, so it stays
   * off until a maintainer explicitly enables it per environment.
   */
  CRITICAL_LIFECYCLE_NOTIFICATIONS: {
    key: 'CRITICAL_LIFECYCLE_NOTIFICATIONS',
    description:
      'Sends in-app notifications for critical lifecycle and recovery events (purchases, refunds, entitlement changes, payouts, suspensions, wallet recovery).',
    defaultValue: false,
    rolloutStages: ['internal', 'beta', 'ga'],
  },

  /**
   * Gates the learner data export endpoint GET /api/learner-export (#790).
   * Default OFF — the export exposes purchase history and PII, so it stays
   * disabled until a maintainer explicitly enables it per environment.
   */
  LEARNER_DATA_EXPORT: {
    key: 'LEARNER_DATA_EXPORT',
    description:
      'Enables the authenticated learner data export endpoint (GET /api/learner-export).',
    defaultValue: false,
    rolloutStages: ['internal', 'beta', 'ga'],
  },

  /**
   * Gates the material archive/restore route (#1018).
   * Default OFF — archiving is new creator-facing behavior that changes
   * catalog visibility and search index state. Stays disabled until the
   * feature has been validated in a staging environment.
   *
   * Emergency disablement: set FEATURE_FLAG_ARCHIVE_MATERIAL=false in env,
   * or POST /api/admin/feature-flags with { key: "ARCHIVE_MATERIAL", enabled: false }
   * to override at runtime without a redeploy.
   */
  ARCHIVE_MATERIAL: {
    key: 'ARCHIVE_MATERIAL',
    description:
      'Enables the creator material archive/restore endpoint (POST /api/creator/materials/[id]/archive). Disabling immediately blocks new archive/restore operations without a redeploy.',
    defaultValue: false,
    rolloutStages: ['internal', 'beta', 'ga'],
  },
});

/** Env var prefix — a flag `FOO` is read from `FEATURE_FLAG_FOO`. */
const ENV_PREFIX = 'FEATURE_FLAG_';

/** Values treated as "enabled" (case-insensitive). */
const TRUTHY = new Set(['true', '1', 'yes', 'on']);
/** Values treated as "disabled" (case-insensitive). */
const FALSY = new Set(['false', '0', 'no', 'off']);

/**
 * Read a single flag's current value.
 *
 * Missing or malformed configuration falls back to the flag's safe default.
 * An unrecognized key throws — a typo in a call site should fail loudly at
 * development time rather than silently evaluating to a default.
 *
 * @param {string} key - Registry key (e.g. 'CRITICAL_LIFECYCLE_NOTIFICATIONS').
 * @returns {boolean}
 */
export function isFeatureFlagEnabled(key) {
  const definition = FEATURE_FLAG_REGISTRY[key];
  if (!definition) {
    throw new Error(`Unknown feature flag: ${key}`);
  }

  const raw = process.env[`${ENV_PREFIX}${key}`];
  if (raw === undefined || raw.trim() === '') {
    return definition.defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;

  // Malformed value — fall back to the safe default rather than guessing.
  return definition.defaultValue;
}

/**
 * Get the full definition plus the current evaluated value for one flag.
 *
 * @param {string} key
 * @returns {FeatureFlagDefinition & { enabled: boolean, source: 'env' | 'default' }}
 */
export function getFeatureFlag(key) {
  const definition = FEATURE_FLAG_REGISTRY[key];
  if (!definition) {
    throw new Error(`Unknown feature flag: ${key}`);
  }

  const raw = process.env[`${ENV_PREFIX}${key}`];
  const source = raw !== undefined && raw.trim() !== '' ? 'env' : 'default';
  return { ...definition, enabled: isFeatureFlagEnabled(key), source };
}

/**
 * List every registered flag with its current value. Used by the status
 * script and by tests.
 *
 * @returns {Array<FeatureFlagDefinition & { enabled: boolean, source: 'env' | 'default' }>}
 */
export function listFeatureFlags() {
  return Object.values(FEATURE_FLAG_REGISTRY).map((definition) =>
    getFeatureFlag(definition.key),
  );
}

// Rollout guard exports (#964)
export {
  FeatureRolloutGuard,
  ROLLOUT_STATUS,
  computePrincipalBucket,
} from './featureFlags/rolloutGuard.js';


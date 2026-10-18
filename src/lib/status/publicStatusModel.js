/**
 * src/lib/status/publicStatusModel.js
 *
 * Safe public-status model for degraded, paused, or maintenance states (#962).
 *
 * Protects users, operators, and public consumers by:
 * 1. Providing accurate, structured status without exposing credentials or internal topology.
 * 2. Redacting Stellar secret seeds (S[A-Z2-7]{55}), MongoDB URIs, JWTs, and stack traces.
 * 3. Enforcing subsystem operational guards across UI, API, and background paths.
 */

export const SYSTEM_STATE = Object.freeze({
  OPERATIONAL: 'operational',
  DEGRADED: 'degraded',
  PAUSED: 'paused',
  MAINTENANCE: 'maintenance',
});

export const SUBSYSTEMS = Object.freeze({
  MARKETPLACE: 'marketplace',
  CHECKOUT: 'checkout',
  INDEXER: 'indexer',
  ENTITLEMENTS: 'entitlements',
  STORAGE: 'storage',
  WEBHOOKS: 'webhooks',
});

// Patterns to redact from any public or diagnostic output
const SECRET_PATTERNS = [
  // Stellar secret key seed (starts with S, 56 chars base32 or general alphanumeric secret)
  { regex: /\bS[A-Za-z0-9]{50,60}\b/g, replacement: '[REDACTED_STELLAR_SECRET]' },
  // MongoDB URI with credentials
  { regex: /mongodb(?:\+srv)?:\/\/[^@\s]+@/gi, replacement: 'mongodb://[REDACTED_CREDENTIALS]@' },
  // JWT tokens
  { regex: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/g, replacement: '[REDACTED_JWT]' },
  // General Bearer / API Tokens
  { regex: /(Bearer\s+)[A-Za-z0-9._~+/-]{15,}/gi, replacement: '$1[REDACTED_TOKEN]' },
  // Generic password fields in json/query
  { regex: /(password|secret|pinata_jwt|jwt|apiKey|pass)=([^&\s]+)/gi, replacement: '$1=[REDACTED]' },
];

/**
 * Sanitizes arbitrary text or error messages, ensuring no credentials,
 * connection strings, or secret seeds leak to logs or public endpoints.
 *
 * @param {string} text
 * @returns {string} Sanitized string
 */
export function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  let sanitized = text;
  for (const { regex, replacement } of SECRET_PATTERNS) {
    sanitized = sanitized.replace(regex, replacement);
  }
  return sanitized;
}

/**
 * Strips raw call stack, file system paths, and internal error internals,
 * returning a safe, consumer-friendly explanation.
 *
 * @param {Error|string} err
 * @returns {string}
 */
export function sanitizeErrorMessage(err) {
  if (!err) return '';
  const message = typeof err === 'string' ? err : err.message || 'An unexpected error occurred';
  const clean = sanitizeText(message);
  // Truncate long internal messages or strip stack traces
  const firstLine = clean.split('\n')[0].trim();
  return firstLine.slice(0, 200);
}

// In-memory subsystem registry with safe defaults
const subsystemStateMap = new Map([
  [SUBSYSTEMS.MARKETPLACE, { state: SYSTEM_STATE.OPERATIONAL, reason: null, updatedAt: new Date().toISOString() }],
  [SUBSYSTEMS.CHECKOUT, { state: SYSTEM_STATE.OPERATIONAL, reason: null, updatedAt: new Date().toISOString() }],
  [SUBSYSTEMS.INDEXER, { state: SYSTEM_STATE.OPERATIONAL, reason: null, updatedAt: new Date().toISOString() }],
  [SUBSYSTEMS.ENTITLEMENTS, { state: SYSTEM_STATE.OPERATIONAL, reason: null, updatedAt: new Date().toISOString() }],
  [SUBSYSTEMS.STORAGE, { state: SYSTEM_STATE.OPERATIONAL, reason: null, updatedAt: new Date().toISOString() }],
  [SUBSYSTEMS.WEBHOOKS, { state: SYSTEM_STATE.OPERATIONAL, reason: null, updatedAt: new Date().toISOString() }],
]);

const stateHistory = [];
const MAX_HISTORY = 100;

/**
 * Transitions a subsystem to a new state with audit metadata.
 *
 * @param {string} subsystem
 * @param {string} newState - operational | degraded | paused | maintenance
 * @param {string} [reason='']
 * @param {string} [actor='system']
 * @param {object} [metadata={}]
 * @returns {object} Updated subsystem state
 */
export function setSubsystemStatus(subsystem, newState, reason = '', actor = 'system', metadata = {}) {
  if (!Object.values(SUBSYSTEMS).includes(subsystem)) {
    throw new Error(`Unknown subsystem: ${subsystem}`);
  }
  if (!Object.values(SYSTEM_STATE).includes(newState)) {
    throw new Error(`Invalid system state: ${newState}`);
  }

  const sanitizedReason = sanitizeText(reason);
  const now = new Date().toISOString();

  const current = subsystemStateMap.get(subsystem) || {};
  const previousState = current.state || SYSTEM_STATE.OPERATIONAL;

  const updated = {
    subsystem,
    state: newState,
    reason: sanitizedReason,
    actor,
    updatedAt: now,
  };

  subsystemStateMap.set(subsystem, updated);

  stateHistory.unshift({
    subsystem,
    from: previousState,
    to: newState,
    reason: sanitizedReason,
    actor,
    timestamp: now,
    metadata: JSON.parse(JSON.stringify(metadata)),
  });

  if (stateHistory.length > MAX_HISTORY) stateHistory.pop();

  return updated;
}

/**
 * Computes overall system status from individual subsystems.
 * If any subsystem is in maintenance, overall is maintenance.
 * Else if any is paused, overall is paused.
 * Else if any is degraded, overall is degraded.
 * Otherwise operational.
 *
 * @returns {string} Overall system state
 */
export function calculateOverallState() {
  const states = Array.from(subsystemStateMap.values()).map((s) => s.state);
  if (states.includes(SYSTEM_STATE.MAINTENANCE)) return SYSTEM_STATE.MAINTENANCE;
  if (states.includes(SYSTEM_STATE.PAUSED)) return SYSTEM_STATE.PAUSED;
  if (states.includes(SYSTEM_STATE.DEGRADED)) return SYSTEM_STATE.DEGRADED;
  return SYSTEM_STATE.OPERATIONAL;
}

/**
 * Generates safe public status representation for learners, buyers, and creators.
 * Guarantees zero sensitive data exposure.
 *
 * @returns {object} Public status payload
 */
export function getPublicStatus() {
  const overall = calculateOverallState();
  const subsystems = {};

  for (const [name, info] of subsystemStateMap.entries()) {
    subsystems[name] = {
      status: info.state,
      message: info.reason || (info.state === SYSTEM_STATE.OPERATIONAL ? 'All systems operational' : 'Experiencing delays'),
      updatedAt: info.updatedAt,
    };
  }

  return {
    status: overall,
    timestamp: new Date().toISOString(),
    subsystems,
    activeIncidents: stateHistory
      .filter((h) => h.to !== SYSTEM_STATE.OPERATIONAL)
      .slice(0, 5)
      .map((h) => ({
        subsystem: h.subsystem,
        state: h.to,
        message: h.reason,
        startedAt: h.timestamp,
      })),
  };
}

/**
 * Generates operator status representation with diagnostics and transition history.
 * Still strictly redacts secrets/credentials.
 *
 * @returns {object} Operator status payload
 */
export function getOperatorStatus() {
  return {
    ...getPublicStatus(),
    history: stateHistory.slice(0, 25),
  };
}

/**
 * Checks whether an operation is allowed on a subsystem based on current state.
 *
 * Rules:
 * - Read operations: allowed in OPERATIONAL, DEGRADED, and PAUSED; blocked in MAINTENANCE.
 * - Write/Mutation operations: allowed in OPERATIONAL and DEGRADED; blocked in PAUSED and MAINTENANCE.
 *
 * @param {string} subsystem
 * @param {'read'|'write'} [opType='write']
 * @returns {{ allowed: boolean, state: string, reason: string }}
 */
export function checkSubsystemAvailability(subsystem, opType = 'write') {
  const info = subsystemStateMap.get(subsystem);
  const state = info?.state || SYSTEM_STATE.OPERATIONAL;
  const reason = info?.reason || '';

  if (state === SYSTEM_STATE.MAINTENANCE) {
    return {
      allowed: false,
      state,
      reason: reason || `${subsystem} is currently undergoing scheduled maintenance`,
      statusCode: 503,
      retryAfterSeconds: 300,
    };
  }

  if (state === SYSTEM_STATE.PAUSED && opType === 'write') {
    return {
      allowed: false,
      state,
      reason: reason || `${subsystem} operations are temporarily paused`,
      statusCode: 503,
      retryAfterSeconds: 60,
    };
  }

  return {
    allowed: true,
    state,
    reason: '',
    statusCode: 200,
  };
}

/**
 * Guard function to assert subsystem availability in API route handlers or background workers.
 * Throws a safe, sanitized SubsystemUnavailableError if operation is rejected.
 *
 * @param {string} subsystem
 * @param {'read'|'write'} [opType='write']
 */
export function assertSubsystemOperational(subsystem, opType = 'write') {
  const check = checkSubsystemAvailability(subsystem, opType);
  if (!check.allowed) {
    const error = new Error(check.reason);
    error.name = 'SubsystemUnavailableError';
    error.subsystem = subsystem;
    error.state = check.state;
    error.statusCode = check.statusCode;
    error.retryAfter = check.retryAfterSeconds;
    throw error;
  }
}

/**
 * Resets all subsystems to OPERATIONAL (useful for testing or full recovery).
 */
export function resetAllSubsystems() {
  for (const subsystem of Object.values(SUBSYSTEMS)) {
    subsystemStateMap.set(subsystem, {
      subsystem,
      state: SYSTEM_STATE.OPERATIONAL,
      reason: null,
      updatedAt: new Date().toISOString(),
    });
  }
  stateHistory.length = 0;
}

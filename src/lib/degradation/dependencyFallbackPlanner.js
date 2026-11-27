/**
 * src/lib/degradation/dependencyFallbackPlanner.js
 *
 * Dependency degradation matrix and fallback behavior (#1081).
 *
 * `health/dependencyChecker.js` (#843) answers "what state is each dependency
 * in?" and `degradationMatrix.js` (#956) answers "what should an operation do
 * when a service is in state X?". This module connects them:
 *
 *   dependency health report ──► per-service state ──► per-operation decision
 *
 * and adds the parts neither module covers:
 *
 *   - misconfigured  a misconfigured dependency is treated as unavailable
 *                    (fail closed) but marked NOT retryable, so clients do not
 *                    retry against a config error forever.
 *   - retry          `runWithFallback` retries a handler only when the
 *                    decision allows it, then returns the matrix's user-safe
 *                    degraded response.
 *   - authorization  `applyOperatorOverride` lets an admin relax a queue or
 *                    degrade decision for a non-critical operation (for
 *                    example to drain an email backlog), or force a block as a
 *                    kill switch. Overrides need a reason and expire, and a
 *                    critical operation that is blocked can never be relaxed.
 *
 * Everything here is pure: decisions are computed from the report passed in,
 * without touching the process-wide fallback registry, so the matrix can be
 * rendered from a saved report (see scripts/degradation-matrix.mjs).
 */

import { SERVICE_STATE, FALLBACK_ACTION } from '../fallback.js';
import { DEGRADATION_MATRIX, DEPENDENCY_TIER, createDegradedApiResponse, getDegradationPolicy } from '../degradationMatrix.js';
import { DEPENDENCY_STATUS, REQUIRED_DEPENDENCIES } from '../health/dependencyChecker.js';
import { hasPermission } from '../auth/permissions.js';

/** Which matrix service each health-check dependency feeds. */
export const HEALTH_TO_MATRIX = Object.freeze({
  [REQUIRED_DEPENDENCIES.DATABASE]: 'mongodb',
  [REQUIRED_DEPENDENCIES.STORAGE]: 'pinata',
  [REQUIRED_DEPENDENCIES.STELLAR]: 'stellar',
  // Missing contract IDs make on-chain operations impossible, so they count
  // against the Stellar row.
  [REQUIRED_DEPENDENCIES.CONTRACTS]: 'stellar',
  [REQUIRED_DEPENDENCIES.EMAIL]: 'email',
});

export const OVERRIDE_PERMISSION = 'operations:override';
export const MAX_OVERRIDE_MS = 4 * 60 * 60 * 1000;

const SEVERITY = { [SERVICE_STATE.HEALTHY]: 0, [SERVICE_STATE.DEGRADED]: 1, [SERVICE_STATE.UNAVAILABLE]: 2 };

function toServiceState(status) {
  switch (status) {
    case DEPENDENCY_STATUS.HEALTHY:
      return { state: SERVICE_STATE.HEALTHY, misconfigured: false };
    case DEPENDENCY_STATUS.DEGRADED:
      return { state: SERVICE_STATE.DEGRADED, misconfigured: false };
    case DEPENDENCY_STATUS.MISCONFIGURED:
      return { state: SERVICE_STATE.UNAVAILABLE, misconfigured: true };
    case DEPENDENCY_STATUS.UNAVAILABLE:
    default:
      // Unknown statuses fail closed.
      return { state: SERVICE_STATE.UNAVAILABLE, misconfigured: false };
  }
}

/**
 * Reduces a dependency health report to one state per matrix service.
 * Services the report does not cover (webhooks) are reported as
 * `observed: false` and assumed healthy; they have their own circuit breaker.
 */
export function deriveServiceStates(report) {
  const states = {};
  for (const name of Object.keys(DEGRADATION_MATRIX)) {
    states[name] = { state: SERVICE_STATE.HEALTHY, misconfigured: false, observed: false, sources: [] };
  }
  for (const [dependency, check] of Object.entries(report?.dependencies || {})) {
    const service = HEALTH_TO_MATRIX[dependency];
    if (!service) continue;
    const next = toServiceState(check?.status);
    const current = states[service];
    current.observed = true;
    current.sources.push(dependency);
    if (SEVERITY[next.state] > SEVERITY[current.state]) current.state = next.state;
    current.misconfigured = current.misconfigured || next.misconfigured;
  }
  return states;
}

function operationsFor(service) {
  const config = DEGRADATION_MATRIX[service];
  return [...new Set([...Object.keys(config.operations), ...config.criticalActions])];
}

/**
 * Decision for one service/operation under a given derived state.
 */
export function decideOperation(service, operation, serviceState) {
  const config = DEGRADATION_MATRIX[service];
  if (!config) {
    return { service, operation, action: FALLBACK_ACTION.BLOCK, retryable: false, reason: 'unknown_service' };
  }
  const { state, misconfigured = false } = serviceState || { state: SERVICE_STATE.HEALTHY };
  const policy = getDegradationPolicy(service, operation, state);
  const critical = config.criticalActions.includes(operation);
  const impaired = state !== SERVICE_STATE.HEALTHY;
  return {
    service,
    operation,
    tier: config.tier,
    critical,
    state,
    action: policy.action,
    httpStatus: policy.httpStatus,
    clientAction: policy.clientAction,
    userMessage: policy.userMessage,
    // A config error does not heal by waiting.
    retryable: impaired && !misconfigured && policy.action !== FALLBACK_ACTION.ALLOW,
    retryAfterSeconds: impaired && !misconfigured ? policy.retryAfterSeconds : null,
    reason: misconfigured ? 'misconfigured' : `service_${state}`,
  };
}

/**
 * Full matrix for a health report: one row per service, one decision per
 * operation. Suitable for docs, dashboards, and the CLI.
 */
export function buildDegradationMatrix(report) {
  const states = deriveServiceStates(report);
  return Object.keys(DEGRADATION_MATRIX).map((service) => ({
    service,
    tier: DEGRADATION_MATRIX[service].tier,
    state: states[service].state,
    observed: states[service].observed,
    misconfigured: states[service].misconfigured,
    sources: states[service].sources,
    operations: operationsFor(service).map((op) => decideOperation(service, op, states[service])),
  }));
}

/**
 * Applies an operator override to a decision.
 *
 * @param {object} decision  from decideOperation
 * @param {object} options
 * @param {object} options.actor      { id, role }
 * @param {object} options.override   { action, reason, expiresAt }
 * @param {Date}   [options.now]
 * @returns {{ decision: object, applied: boolean, audit: object|null, error: string|null }}
 */
export function applyOperatorOverride(decision, { actor, override, now = new Date() } = {}) {
  const refuse = (error) => ({ decision, applied: false, audit: null, error });
  if (!override) return { decision, applied: false, audit: null, error: null };
  if (!hasPermission(actor, OVERRIDE_PERMISSION)) return refuse('forbidden: operator override requires an admin');
  if (!Object.values(FALLBACK_ACTION).includes(override.action)) return refuse('invalid override action');
  if (!override.reason || String(override.reason).trim().length < 10) return refuse('override reason must be at least 10 characters');

  const expiresAt = new Date(override.expiresAt);
  const remaining = expiresAt.getTime() - now.getTime();
  if (Number.isNaN(remaining) || remaining <= 0) return refuse('override has expired or has no valid expiresAt');
  if (remaining > MAX_OVERRIDE_MS) return refuse('override may last at most 4 hours');

  const tightening = override.action === FALLBACK_ACTION.BLOCK;
  if (!tightening) {
    if (decision.critical && decision.action === FALLBACK_ACTION.BLOCK) {
      return refuse('critical operations blocked by the matrix cannot be relaxed');
    }
    if (decision.tier === DEPENDENCY_TIER.TIER_1_CRITICAL && override.action === FALLBACK_ACTION.ALLOW && decision.state === SERVICE_STATE.UNAVAILABLE) {
      return refuse('tier 1 dependencies that are unavailable cannot be overridden to allow');
    }
  }

  const audit = {
    actor: String(actor.id || 'unknown'),
    service: decision.service,
    operation: decision.operation,
    from: decision.action,
    to: override.action,
    reason: String(override.reason).slice(0, 500),
    expiresAt: expiresAt.toISOString(),
    appliedAt: now.toISOString(),
  };
  return {
    decision: { ...decision, action: override.action, reason: 'operator_override', retryable: tightening ? false : decision.retryable },
    applied: true,
    audit,
    error: null,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `handler` under a decision.
 *
 *   BLOCK  -> handler is not called, user-safe 503-style body returned
 *   QUEUE  -> `onQueue` is called (if given), queued body returned
 *   ALLOW / DEGRADE -> handler runs; failures are retried up to `attempts`
 *                      only when the decision is retryable, then the matrix's
 *                      degraded response is returned. Raw errors never leak.
 */
export async function runWithFallback(decision, handler, { attempts = 3, baseDelayMs = 200, sleep = defaultSleep, onQueue } = {}) {
  const fallback = (state, rawError) =>
    createDegradedApiResponse(decision.service, decision.operation, { state, rawError }).body;

  if (decision.action === FALLBACK_ACTION.BLOCK) {
    return { ...fallback(SERVICE_STATE.UNAVAILABLE), ok: false, attempts: 0 };
  }
  if (decision.action === FALLBACK_ACTION.QUEUE) {
    if (onQueue) await onQueue();
    return { ...fallback(SERVICE_STATE.DEGRADED), attempts: 0 };
  }

  const max = decision.retryable ? Math.max(1, Math.floor(attempts)) : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= max; attempt += 1) {
    try {
      const result = await handler();
      return { ok: true, result, degraded: decision.action === FALLBACK_ACTION.DEGRADE, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < max) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  return { ...fallback(SERVICE_STATE.DEGRADED, lastError), ok: false, attempts: max };
}

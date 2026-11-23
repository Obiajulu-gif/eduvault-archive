/**
 * Dependency outage fallback and recovery UX (issue #1122).
 *
 * Provides a circuit-breaker / fallback wrapper for external dependency calls.
 * When a dependency (IPFS, Stellar RPC, payment gateway, etc.) starts failing:
 * 1. After `failureThreshold` consecutive errors the circuit opens (fast-fail).
 * 2. After `recoveryWindowMs` the circuit moves to half-open: one probe attempt.
 * 3. If the probe succeeds the circuit closes and normal operations resume.
 * 4. Callers may supply a `fallback` function whose result is returned while
 *    the circuit is open, keeping the UX degraded-but-functional.
 *
 * All state transitions emit telemetry so dashboards can alert on outages.
 */

import { recordMetric, ACTOR_TYPES, TELEMETRY_RESULT, ensureCorrelationId } from "../monitoring/telemetry.js";

export const CIRCUIT_STATE = Object.freeze({
  CLOSED: "closed",      // healthy — requests pass through
  OPEN: "open",          // unhealthy — requests fast-fail
  HALF_OPEN: "half_open", // probing — one request let through
});

export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_RECOVERY_WINDOW_MS = 30_000;
export const DEFAULT_SUCCESS_THRESHOLD = 1;

class CircuitOpenError extends Error {
  constructor(name) {
    super(`Circuit '${name}' is open — dependency is unavailable`);
    this.name = "CircuitOpenError";
    this.code = "CIRCUIT_OPEN";
  }
}

/**
 * Create a circuit breaker for a named dependency.
 *
 * @param {object} opts
 * @param {string} opts.name - Dependency name (e.g. "ipfs", "stellar-rpc").
 * @param {number} [opts.failureThreshold] - Consecutive failures before opening.
 * @param {number} [opts.recoveryWindowMs] - Ms before a half-open probe attempt.
 * @param {number} [opts.successThreshold] - Probe successes needed to close.
 * @param {Function} [opts.onStateChange] - Callback({from, to, name}).
 * @returns {object} - Circuit breaker instance.
 */
export function createCircuitBreaker({
  name,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  recoveryWindowMs = DEFAULT_RECOVERY_WINDOW_MS,
  successThreshold = DEFAULT_SUCCESS_THRESHOLD,
  onStateChange,
} = {}) {
  if (!name) throw new TypeError("Circuit breaker requires a name");

  let state = CIRCUIT_STATE.CLOSED;
  let consecutiveFailures = 0;
  let consecutiveSuccesses = 0;
  let openedAt = null;
  let probeInFlight = false;

  function transition(to) {
    const from = state;
    if (from === to) return;
    state = to;
    if (to === CIRCUIT_STATE.OPEN) openedAt = Date.now();
    if (to === CIRCUIT_STATE.CLOSED) {
      consecutiveFailures = 0;
      consecutiveSuccesses = 0;
      openedAt = null;
      probeInFlight = false;
    }

    recordMetric(`circuit.${to}`, { from, name }, {
      operation: `circuit_breaker.${to}`,
      actorType: ACTOR_TYPES.SYSTEM,
      result: to === CIRCUIT_STATE.OPEN ? TELEMETRY_RESULT.FAILURE : TELEMETRY_RESULT.SUCCESS,
    });

    if (typeof onStateChange === "function") {
      try { onStateChange({ from, to, name }); } catch { /* ignore */ }
    }
  }

  function shouldAllow() {
    if (state === CIRCUIT_STATE.CLOSED) return true;
    if (state === CIRCUIT_STATE.OPEN) {
      if (openedAt !== null && Date.now() - openedAt >= recoveryWindowMs) {
        if (!probeInFlight) {
          probeInFlight = true;
          transition(CIRCUIT_STATE.HALF_OPEN);
          return true;
        }
      }
      return false;
    }
    // HALF_OPEN: only the one probe in flight
    return false;
  }

  function recordSuccess() {
    consecutiveFailures = 0;
    if (state === CIRCUIT_STATE.HALF_OPEN) {
      consecutiveSuccesses += 1;
      if (consecutiveSuccesses >= successThreshold) {
        transition(CIRCUIT_STATE.CLOSED);
      }
    }
  }

  function recordFailure() {
    consecutiveSuccesses = 0;
    if (state === CIRCUIT_STATE.HALF_OPEN) {
      probeInFlight = false;
      transition(CIRCUIT_STATE.OPEN);
      return;
    }
    consecutiveFailures += 1;
    if (state === CIRCUIT_STATE.CLOSED && consecutiveFailures >= failureThreshold) {
      transition(CIRCUIT_STATE.OPEN);
    }
  }

  return {
    get state() { return state; },
    get consecutiveFailures() { return consecutiveFailures; },

    /**
     * Execute `fn` through the circuit. Throws `CircuitOpenError` when open.
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async execute(fn) {
      if (!shouldAllow()) {
        recordMetric("circuit.rejected", { name, state }, {
          operation: "circuit_breaker.rejected",
          actorType: ACTOR_TYPES.SYSTEM,
          result: TELEMETRY_RESULT.FAILURE,
        });
        throw new CircuitOpenError(name);
      }

      try {
        const result = await fn();
        recordSuccess();
        return result;
      } catch (err) {
        recordFailure();
        throw err;
      }
    },

    /** Force the circuit back to closed (useful for tests and manual recovery). */
    reset() {
      transition(CIRCUIT_STATE.CLOSED);
    },
  };
}

/**
 * Wrap a dependency call with a circuit breaker AND an optional fallback.
 *
 * @template T
 * @param {object} opts
 * @param {object} opts.circuit - A circuit breaker from `createCircuitBreaker`.
 * @param {() => Promise<T>} opts.call - The actual dependency call.
 * @param {(() => T | Promise<T>)|undefined} [opts.fallback] - Called when circuit is open.
 * @param {string} [opts.correlationId] - Attached to telemetry records.
 * @returns {Promise<{result: T, fromFallback: boolean}>}
 */
export async function callWithFallback({ circuit, call, fallback, correlationId } = {}) {
  if (!circuit || typeof circuit.execute !== "function") {
    throw new TypeError("callWithFallback requires a circuit breaker instance");
  }
  if (typeof call !== "function") {
    throw new TypeError("callWithFallback requires a call function");
  }

  try {
    const result = await circuit.execute(call);
    return { result, fromFallback: false };
  } catch (err) {
    if (err.code === "CIRCUIT_OPEN" && typeof fallback === "function") {
      recordMetric("circuit.fallback_used", {}, {
        operation: "circuit_breaker.fallback",
        actorType: ACTOR_TYPES.SYSTEM,
        result: TELEMETRY_RESULT.SUCCESS,
        correlationId: ensureCorrelationId(correlationId),
      });
      const result = await fallback(err);
      return { result, fromFallback: true };
    }
    throw err;
  }
}

/**
 * Build a degraded-mode JSON response body for use in API routes when a
 * dependency is unavailable.
 *
 * @param {string} dependency - Human-readable dependency name.
 * @param {string} [hint] - Optional recovery hint for the caller.
 * @returns {object}
 */
export function buildOutageResponse(dependency, hint) {
  return {
    status: "degraded",
    dependency,
    message: `The ${dependency} service is temporarily unavailable. Please try again shortly.`,
    ...(hint ? { hint } : {}),
    timestamp: new Date().toISOString(),
  };
}

export { CircuitOpenError };

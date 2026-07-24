/**
 * Concurrency limiter with backpressure — enforces bounded concurrency
 * per-route and globally, with queue-based admission control.
 *
 * When a route's concurrency limit is reached, new requests enter a bounded
 * queue. If the queue is also full, the request is rejected immediately
 * with a 503 overload response including retry guidance.
 */

import { getRouteBudget, buildOverloadResponse, SYSTEM_LIMITS } from './budgets.js';

// ── Optional telemetry hook (set by capacity/index.js after init) ────────────
let _metrics = null;

export function setMetricsHooks(metrics) {
  _metrics = metrics;
}

function emitGauge(name, labels, value) {
  try { _metrics?.setGauge?.(name, labels, value); } catch { /* noop */ }
}

function emitCounter(name, labels) {
  try { _metrics?.incrementCounter?.(name, labels); } catch { /* noop */ }
}

// ── In-flight Trackers ───────────────────────────────────────────────────────

/** Map<routeKey, number> — currently in-flight requests per route. */
const inFlight = new Map();

/** Map<routeKey, Array<{ resolve, reject, enqueuedAt }>> — waiting queue per route. */
const queues = new Map();

/** Set of active timeout timers — cleaned up on reset. */
const activeTimers = new Set();

/** Global in-flight counter across all routes. */
let globalInFlight = 0;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Try to acquire a concurrency slot for the given route.
 *
 * @param {string} method - HTTP method
 * @param {string} route  - Route path
 * @param {number} [timeoutMs] - How long to wait in the queue before giving up
 * @returns {Promise<{ acquired: boolean, release: () => void, overload?: object }>}
 */
export async function acquireSlot(method, route, timeoutMs) {
  const budget = getRouteBudget(method, route);
  const routeKey = `${method}:${route}`;
  const effectiveTimeout = timeoutMs ?? budget.timeoutMs;

  // Check global limit
  if (globalInFlight >= getMaxConcurrentGlobal()) {
    emitCounter("capacity_global_reject_total", { route: routeKey });
    return {
      acquired: false,
      release: noop,
      overload: buildOverloadResponse({
        route: routeKey,
        reason: "system_overload",
        retryAfterSeconds: Math.ceil(effectiveTimeout / 1000),
        detail: "System-wide concurrency limit reached",
      }),
    };
  }

  // Check route limit
  const current = inFlight.get(routeKey) || 0;
  if (current >= budget.maxConcurrent) {
    // Check queue depth
    const queue = queues.get(routeKey) || [];
    if (queue.length >= budget.maxQueueDepth) {
      emitCounter("capacity_queue_full_total", { route: routeKey });
      return {
        acquired: false,
        release: noop,
        overload: buildOverloadResponse({
          route: routeKey,
          reason: "queue_full",
          retryAfterSeconds: Math.ceil(effectiveTimeout / 1000),
          detail: `Route ${routeKey} has ${current} in-flight requests and ${queue.length} queued`,
        }),
      };
    }

    // Enqueue with timeout
    return new Promise((resolve) => {
      const enqueuedAt = Date.now();
      const entry = { resolve, reject: null, enqueuedAt };

      if (!queues.has(routeKey)) queues.set(routeKey, []);
      queues.get(routeKey).push(entry);

      const timer = setTimeout(() => {
        activeTimers.delete(timer);
        // Remove from queue if still present
        const q = queues.get(routeKey);
        if (q) {
          const idx = q.indexOf(entry);
          if (idx !== -1) q.splice(idx, 1);
        }
        emitCounter("capacity_queue_timeout_total", { route: routeKey });
        resolve({
          acquired: false,
          release: noop,
          overload: buildOverloadResponse({
            route: routeKey,
            reason: "timeout",
            retryAfterSeconds: Math.ceil(effectiveTimeout / 1000),
            detail: `Request timed out waiting for a concurrency slot on ${routeKey}`,
          }),
        });
      }, effectiveTimeout);

      activeTimers.add(timer);

      entry.cancelTimer = () => {
        clearTimeout(timer);
        activeTimers.delete(timer);
      };
    });
  }

  // Acquire immediately
  inFlight.set(routeKey, current + 1);
  globalInFlight++;
  updateGauges();

  let released = false;
  function release() {
    if (released) return;
    released = true;

    const remaining = (inFlight.get(routeKey) || 1) - 1;
    if (remaining <= 0) {
      inFlight.delete(routeKey);
    } else {
      inFlight.set(routeKey, remaining);
    }
    globalInFlight = Math.max(0, globalInFlight - 1);
    updateGauges();

    // Dequeue next waiting request
    const queue = queues.get(routeKey);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      if (next.cancelTimer) next.cancelTimer();
      const newCount = (inFlight.get(routeKey) || 0) + 1;
      inFlight.set(routeKey, newCount);
      globalInFlight++;
      updateGauges();
      next.resolve({ acquired: true, release: createReleaser(routeKey) });
    }
  }

  return { acquired: true, release };
}

/**
 * Get current concurrency stats for monitoring.
 *
 * @returns {{ global: number, routes: Record<string, { inFlight: number, queued: number }> }}
 */
export function getConcurrencyStats() {
  const routes = {};
  for (const [key, count] of inFlight.entries()) {
    const queue = queues.get(key);
    routes[key] = {
      inFlight: count,
      queued: queue ? queue.length : 0,
    };
  }
  return { global: globalInFlight, routes };
}

/**
 * Reset all concurrency state — for tests.
 */
export function resetConcurrencyState() {
  for (const timer of activeTimers) {
    clearTimeout(timer);
  }
  activeTimers.clear();
  inFlight.clear();
  queues.clear();
  globalInFlight = 0;
  updateGauges();
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function createReleaser(routeKey) {
  let released = false;
  return function release() {
    if (released) return;
    released = true;

    const remaining = (inFlight.get(routeKey) || 1) - 1;
    if (remaining <= 0) {
      inFlight.delete(routeKey);
    } else {
      inFlight.set(routeKey, remaining);
    }
    globalInFlight = Math.max(0, globalInFlight - 1);
    updateGauges();

    const queue = queues.get(routeKey);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      if (next.cancelTimer) next.cancelTimer();
      const newCount = (inFlight.get(routeKey) || 0) + 1;
      inFlight.set(routeKey, newCount);
      globalInFlight++;
      updateGauges();
      next.resolve({ acquired: true, release: createReleaser(routeKey) });
    }
  };
}

function noop() {}

function getMaxConcurrentGlobal() {
  return SYSTEM_LIMITS.maxConcurrentRequests;
}

function updateGauges() {
  emitGauge("capacity_inflight_global", {}, globalInFlight);
  for (const [key, count] of inFlight.entries()) {
    emitGauge("capacity_inflight_route", { route: key }, count);
  }
}

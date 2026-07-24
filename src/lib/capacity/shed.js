/**
 * Load shedding — priority-based shedding of noncritical work before
 * critical flows (purchase verification, entitlement, protected delivery)
 * are impacted.
 *
 * When system pressure exceeds thresholds, low-priority requests are
 * rejected with 503 + Retry-After headers. Shedding order follows the
 * priority field in route budgets (lower priority = shed first).
 */

import { getRouteBudget, buildOverloadResponse, SYSTEM_LIMITS } from './budgets.js';
import { getConcurrencyStats } from './concurrency.js';

// ── Optional telemetry hook ──────────────────────────────────────────────────
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

// ── Pressure Signals ─────────────────────────────────────────────────────────

const pressureSignals = {
  memoryUsedBytes: 0,
  memoryPressure: 0,
  mongoPoolExhausted: false,
  outboundHttpExhausted: false,
};

/**
 * Update a pressure signal. Called by subsystems when they detect pressure.
 *
 * @param {string} signal - The signal name
 * @param {any} value     - The signal value
 */
export function updatePressureSignal(signal, value) {
  pressureSignals[signal] = value;
  evaluatePressure();
}

/**
 * Get current pressure level (0 = no pressure, 1 = critical).
 *
 * @returns {{ level: number, reasons: string[], memoryPercent: number }}
 */
export function getPressureLevel() {
  return evaluatePressure();
}

/**
 * Should we shed this route given current pressure?
 *
 * @param {string} method - HTTP method
 * @param {string} route  - Route path
 * @returns {{ shouldShed: boolean, overload?: object }}
 */
export function shouldShed(method, route) {
  const budget = getRouteBudget(method, route);
  const { level, reasons } = evaluatePressure();

  // Priority 0 (critical) never sheds
  if (budget.priority === 0) {
    return { shouldShed: false };
  }

  // Shed based on pressure level vs priority threshold
  const shedThresholds = {
    1: 0.5,  // priority 1 sheds at 50% pressure
    2: 0.3,  // priority 2 sheds at 30% pressure
    3: 0.1,  // priority 3 sheds at 10% pressure
  };

  const threshold = shedThresholds[budget.priority] ?? 0.3;

  if (level >= threshold) {
    const retryAfterSeconds = Math.ceil(2 + level * 10);
    emitCounter("capacity_load_shed_total", { route: `${method}:${route}` });
    return {
      shouldShed: true,
      overload: buildOverloadResponse({
        route: `${method}:${route}`,
        reason: "load_shedding",
        retryAfterSeconds,
        detail: `Load shedding active (pressure: ${(level * 100).toFixed(0)}%). Reasons: ${reasons.join(', ')}`,
      }),
    };
  }

  return { shouldShed: false };
}

// ── Pressure Evaluation ──────────────────────────────────────────────────────

function evaluatePressure() {
  const reasons = [];
  let score = 0;

  // Memory pressure — use explicitly set signal if available, else real usage
  let memPressure = pressureSignals.memoryPressure || 0;
  if (memPressure === 0 && typeof process !== 'undefined' && process.memoryUsage) {
    const usage = process.memoryUsage();
    const usedBytes = usage.heapUsed || 0;
    memPressure = Math.min(1, usedBytes / SYSTEM_LIMITS.memoryHardLimitBytes);
  }
  pressureSignals.memoryPressure = memPressure;
  if (memPressure > 0.7) {
    reasons.push(`memory ${(memPressure * 100).toFixed(0)}%`);
    score = Math.max(score, memPressure);
  }

  // Concurrency pressure
  const stats = getConcurrencyStats();
  const concurrencyRatio = stats.global / SYSTEM_LIMITS.maxConcurrentRequests;
  if (concurrencyRatio > 0.7) {
    reasons.push(`concurrency ${(concurrencyRatio * 100).toFixed(0)}%`);
    score = Math.max(score, concurrencyRatio);
  }

  // MongoDB pressure
  if (pressureSignals.mongoPoolExhausted) {
    reasons.push("mongo_pool_exhausted");
    score = Math.max(score, 0.8);
  }

  // Outbound HTTP pressure
  if (pressureSignals.outboundHttpExhausted) {
    reasons.push("outbound_http_exhausted");
    score = Math.max(score, 0.7);
  }

  const level = Math.min(1, score);

  emitGauge("capacity_pressure_level", {}, level);
  emitGauge("capacity_pressure_memory", {}, memPressure);
  emitGauge("capacity_pressure_concurrency", {}, concurrencyRatio);

  return { level, reasons, memoryPercent: memPressure };
}

// ── Request Phase Shedding ───────────────────────────────────────────────────

/**
 * Evaluate whether a request should be shed before processing.
 * Returns null if OK, or a NextResponse 503 if shed.
 *
 * @param {string} method
 * @param {string} route
 * @returns {{ shed: boolean, response?: object }}
 */
export function preRequestShed(method, route) {
  const { shouldShed: shed, overload } = shouldShed(method, route);
  if (shed && overload) {
    return {
      shed: true,
      response: {
        status: overload.status,
        body: overload.body,
        headers: overload.headers,
      },
    };
  }
  return { shed: false };
}

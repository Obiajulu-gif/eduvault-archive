/**
 * Capacity control — unified entry point for all capacity management.
 *
 * Re-exports the budget, concurrency, shedding, and backpressure modules
 * for convenient importing from route handlers and middleware.
 */

export {
  SYSTEM_LIMITS,
  ROUTE_BUDGETS,
  getRouteBudget,
  buildOverloadResponse,
} from './budgets.js';

export {
  acquireSlot,
  getConcurrencyStats,
  resetConcurrencyState,
  setMetricsHooks as setConcurrencyMetrics,
} from './concurrency.js';

export {
  updatePressureSignal,
  getPressureLevel,
  shouldShed,
  preRequestShed,
  setMetricsHooks as setShedMetrics,
} from './shed.js';

export {
  createBackpressuredStream,
  pipeWithBackpressure,
  createDisconnectSignal,
  createBoundedQueue,
  createCancellableStream,
} from './backpressure.js';

/**
 * Wire up telemetry metrics for all capacity modules.
 * Call once at application startup in the Next.js context.
 */
export function initCapacityMetrics(metrics) {
  const { setMetricsHooks: setConcurrencyHooks } = require('./concurrency.js');
  const { setMetricsHooks: setShedHooks } = require('./shed.js');
  setConcurrencyHooks(metrics);
  setShedHooks(metrics);
}

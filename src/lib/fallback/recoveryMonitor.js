/**
 * Dependency outage fallback and recovery monitor — Issue #1122
 *
 * Extends the service registry from src/lib/fallback.js with:
 * - Probe-based auto-recovery: periodically calls a health probe and
 *   transitions state automatically when a service comes back up.
 * - Recovery events: emits a 'service.recovered' event so callers can
 *   display a "back online" banner or toast.
 * - User-safe outage summary: returns a list of degraded/unavailable services
 *   with safe messages (no internal details).
 * - Retry-with-backoff: when a service is unavailable, the probe backs off
 *   exponentially rather than hammering the endpoint.
 */

import {
  SERVICE_STATE,
  reportServiceState,
  getServiceState,
  getRegisteredServices,
  resolveFallbackAction,
  FALLBACK_ACTION,
} from '../fallback.js';

export const RECOVERY_EVENT = Object.freeze({
  PROBE_STARTED: 'recovery.probe_started',
  PROBE_SUCCESS: 'recovery.probe_success',
  PROBE_FAILURE: 'recovery.probe_failure',
  SERVICE_RECOVERED: 'recovery.service_recovered',
  SERVICE_DEGRADED: 'recovery.service_degraded',
  SERVICE_UNAVAILABLE: 'recovery.service_unavailable',
});

const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;
const DEFAULT_BACKOFF_FACTOR = 2;

/**
 * Creates a recovery monitor for one registered service.
 *
 * @param {object} opts
 * @param {string} opts.name - Service name (must already be registered).
 * @param {Function} opts.probe - Async function that resolves if service is healthy, rejects otherwise.
 * @param {Function} [opts.emit] - (event, payload) => void
 * @param {number} [opts.intervalMs] - Base probe interval.
 * @param {number} [opts.maxBackoffMs]
 * @param {number} [opts.backoffFactor]
 * @returns {{ start, stop, getStatus }}
 */
export function createRecoveryMonitor({
  name,
  probe,
  emit = () => {},
  intervalMs = DEFAULT_PROBE_INTERVAL_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  backoffFactor = DEFAULT_BACKOFF_FACTOR,
} = {}) {
  if (!name || typeof name !== 'string') throw new TypeError('name is required');
  if (typeof probe !== 'function') throw new TypeError('probe must be a function');

  let timer = null;
  let currentDelay = intervalMs;
  let consecutiveFailures = 0;
  let running = false;
  const history = [];

  async function runProbe() {
    emit(RECOVERY_EVENT.PROBE_STARTED, { service: name });

    const before = getServiceState(name)?.state ?? SERVICE_STATE.HEALTHY;

    try {
      await probe();
      consecutiveFailures = 0;
      currentDelay = intervalMs; // Reset backoff on success

      emit(RECOVERY_EVENT.PROBE_SUCCESS, { service: name });

      if (before !== SERVICE_STATE.HEALTHY) {
        reportServiceState(name, SERVICE_STATE.HEALTHY, 'probe-recovery');
        const event = { service: name, from: before, to: SERVICE_STATE.HEALTHY, at: new Date().toISOString() };
        history.push(event);
        emit(RECOVERY_EVENT.SERVICE_RECOVERED, event);
      }
    } catch (err) {
      consecutiveFailures++;
      const errMessage = err?.message ?? 'probe failed';

      emit(RECOVERY_EVENT.PROBE_FAILURE, { service: name, error: errMessage, consecutiveFailures });

      const newState =
        consecutiveFailures >= 3 ? SERVICE_STATE.UNAVAILABLE : SERVICE_STATE.DEGRADED;

      if (before !== newState) {
        reportServiceState(name, newState, `probe-failure-${consecutiveFailures}`);
        const event = { service: name, from: before, to: newState, at: new Date().toISOString() };
        history.push(event);
        emit(
          newState === SERVICE_STATE.UNAVAILABLE
            ? RECOVERY_EVENT.SERVICE_UNAVAILABLE
            : RECOVERY_EVENT.SERVICE_DEGRADED,
          event
        );
      }

      // Exponential backoff when unavailable
      if (newState === SERVICE_STATE.UNAVAILABLE) {
        currentDelay = Math.min(currentDelay * backoffFactor, maxBackoffMs);
      }
    }
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimeout(async () => {
      await runProbe();
      scheduleNext();
    }, currentDelay);
  }

  function start() {
    if (running) return;
    running = true;
    scheduleNext();
  }

  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function getStatus() {
    return {
      service: name,
      state: getServiceState(name)?.state ?? null,
      consecutiveFailures,
      currentDelayMs: currentDelay,
      running,
      history: history.slice(-20),
    };
  }

  return { start, stop, getStatus, _runProbe: runProbe };
}

/**
 * Returns a user-safe outage summary for all registered services.
 * Never includes internal error details, stack traces, or configuration.
 *
 * @returns {Array<{ service: string, state: string, message: string, action: string }>}
 */
export function getOutageSummary() {
  const services = getRegisteredServices();
  const degraded = [];

  for (const name of services) {
    const state = getServiceState(name);
    if (!state || state.state === SERVICE_STATE.HEALTHY) continue;

    const { action, message } = resolveFallbackAction(name);
    degraded.push({
      service: name,
      state: state.state,
      message,
      action,
      since: state.lastTransitionAt,
    });
  }

  return degraded;
}

/**
 * Returns a user-facing status object suitable for a banner or toast:
 * - If all services healthy: { healthy: true, services: [] }
 * - If some degraded/unavailable: { healthy: false, services: [...] }
 *
 * @returns {{ healthy: boolean, services: Array }}
 */
export function getUserFacingStatus() {
  const degraded = getOutageSummary();
  return {
    healthy: degraded.length === 0,
    services: degraded.map(({ service, state, message, action }) => ({
      service,
      state,
      message,
      canQueue: action === FALLBACK_ACTION.QUEUE,
      willBlock: action === FALLBACK_ACTION.BLOCK,
    })),
  };
}

/**
 * Creates a fleet of recovery monitors for multiple services and starts them.
 *
 * @param {Array<{ name, probe, intervalMs?, emit? }>} configs
 * @param {object} [shared] - Shared options applied to all monitors.
 * @returns {Array<ReturnType<createRecoveryMonitor>>}
 */
export function startRecoveryFleet(configs, shared = {}) {
  return configs.map((cfg) => {
    const monitor = createRecoveryMonitor({ ...shared, ...cfg });
    monitor.start();
    return monitor;
  });
}

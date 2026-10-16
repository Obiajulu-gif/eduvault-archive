/**
 * Deterministic fallback behavior for degraded third-party services — Issue #885
 *
 * Provides a centralized service health registry, fallback state machine,
 * observability events, and user-safe messaging when third-party dependencies
 * (Pinata, Stellar, Email, MongoDB) degrade or become unavailable.
 *
 * Design:
 *   - Services register with a fallback policy mapping states to actions.
 *   - State transitions are deterministic: healthy → degraded → unavailable.
 *   - Every transition emits an observability event for monitoring.
 *   - Critical unsafe actions (purchases, protected downloads) are blocked
 *     when their required dependencies are unavailable.
 *   - User-facing messages are safe (no internal details leaked).
 */

export const SERVICE_STATE = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable',
});

export const FALLBACK_ACTION = Object.freeze({
  ALLOW: 'allow',
  DEGRADE: 'degrade',
  BLOCK: 'block',
  QUEUE: 'queue',
});

const VALID_STATES = new Set(Object.values(SERVICE_STATE));
const VALID_ACTIONS = new Set(Object.values(FALLBACK_ACTION));

const serviceRegistry = new Map();
const stateHistory = new Map();
const observabilityEvents = [];
const MAX_OBSERVABILITY_EVENTS = 1000;

export function registerService(name, config = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('Service name must be a non-empty string');
  }

  const policy = config.policy || {};
  const operations = config.operations || {};
  const criticalActions = new Set(config.criticalActions || []);

  const entry = {
    name,
    policy: {
      [SERVICE_STATE.HEALTHY]: policy[SERVICE_STATE.HEALTHY] || FALLBACK_ACTION.ALLOW,
      [SERVICE_STATE.DEGRADED]: policy[SERVICE_STATE.DEGRADED] || FALLBACK_ACTION.DEGRADE,
      [SERVICE_STATE.UNAVAILABLE]: policy[SERVICE_STATE.UNAVAILABLE] || FALLBACK_ACTION.BLOCK,
    },
    operations,
    criticalActions,
    currentState: SERVICE_STATE.HEALTHY,
    lastTransitionAt: new Date().toISOString(),
    metadata: config.metadata || {},
  };

  serviceRegistry.set(name, entry);
  stateHistory.set(name, [{
    state: SERVICE_STATE.HEALTHY,
    at: entry.lastTransitionAt,
    reason: 'registered',
  }]);

  return entry;
}

export function reportServiceState(name, newState, reason = '') {
  const service = serviceRegistry.get(name);
  if (!service) {
    throw new Error(`Unknown service: ${name}`);
  }
  if (!VALID_STATES.has(newState)) {
    throw new Error(`Invalid state: ${newState}. Must be one of: ${[...VALID_STATES].join(', ')}`);
  }

  const previousState = service.currentState;
  if (previousState === newState) {
    return { changed: false, state: newState };
  }

  const now = new Date().toISOString();
  service.currentState = newState;
  service.lastTransitionAt = now;

  const history = stateHistory.get(name);
  history.push({ state: newState, at: now, reason: reason || 'manual-report' });
  if (history.length > 100) history.shift();

  const event = {
    type: 'fallback_state_change',
    service: name,
    from: previousState,
    to: newState,
    reason: reason || 'manual-report',
    timestamp: now,
  };
  observabilityEvents.push(event);
  if (observabilityEvents.length > MAX_OBSERVABILITY_EVENTS) {
    observabilityEvents.shift();
  }

  return { changed: true, from: previousState, to: newState, event };
}

export function getServiceState(name) {
  const service = serviceRegistry.get(name);
  if (!service) return null;
  return {
    name: service.name,
    state: service.currentState,
    lastTransitionAt: service.lastTransitionAt,
    metadata: service.metadata,
  };
}

export function getAllServiceStates() {
  const states = {};
  for (const [name, service] of serviceRegistry) {
    states[name] = {
      state: service.currentState,
      lastTransitionAt: service.lastTransitionAt,
    };
  }
  return states;
}

export function resolveFallbackAction(serviceName, operation = 'default') {
  const service = serviceRegistry.get(serviceName);
  if (!service) {
    return { action: FALLBACK_ACTION.BLOCK, reason: 'unknown-service', message: 'Service is not registered.' };
  }

  const opConfig = service.operations[operation];
  if (opConfig && opConfig.action) {
    if (!VALID_ACTIONS.has(opConfig.action)) {
      return { action: FALLBACK_ACTION.BLOCK, reason: 'invalid-policy', message: 'Invalid fallback policy.' };
    }
    return {
      action: opConfig.action,
      reason: opConfig.reason || 'operation-policy',
      message: opConfig.message || getDefaultMessage(serviceName, opConfig.action),
    };
  }

  const state = service.currentState;
  const action = service.policy[state] || FALLBACK_ACTION.BLOCK;
  return {
    action,
    reason: `service-${state}`,
    message: getDefaultMessage(serviceName, action),
  };
}

export function isCriticalActionBlocked(serviceName) {
  const service = serviceRegistry.get(serviceName);
  if (!service) return true;
  if (service.criticalActions.size === 0) return false;
  return service.currentState === SERVICE_STATE.UNAVAILABLE;
}

export function getCriticalActions(serviceName) {
  const service = serviceRegistry.get(serviceName);
  if (!service) return [];
  return [...service.criticalActions];
}

export function getFallbackMessage(serviceName, action) {
  return getDefaultMessage(serviceName, action);
}

function getDefaultMessage(serviceName, action) {
  const messages = {
    [FALLBACK_ACTION.ALLOW]: `${serviceName} is operating normally.`,
    [FALLBACK_ACTION.DEGRADE]: `${serviceName} is experiencing reduced functionality. Some features may be slower or temporarily unavailable.`,
    [FALLBACK_ACTION.BLOCK]: `${serviceName} is temporarily unavailable. Please try again later.`,
    [FALLBACK_ACTION.QUEUE]: `Your request has been queued and will be processed when ${serviceName} recovers.`,
  };
  return messages[action] || 'Service status is unknown. Please try again later.';
}

export function getObservabilityEvents(serviceName = null, limit = 100) {
  let events = observabilityEvents;
  if (serviceName) {
    events = events.filter((e) => e.service === serviceName);
  }
  return events.slice(-limit);
}

export function clearObservabilityEvents() {
  observabilityEvents.length = 0;
}

export function getServiceHistory(name, limit = 50) {
  const history = stateHistory.get(name);
  if (!history) return [];
  return history.slice(-limit);
}

export function resetFallbackRegistry() {
  serviceRegistry.clear();
  stateHistory.clear();
  observabilityEvents.length = 0;
}

export function getRegisteredServices() {
  return [...serviceRegistry.keys()];
}

export function isServiceRegistered(name) {
  return serviceRegistry.has(name);
}

export function assertServiceAvailable(serviceName, operation = 'default') {
  const result = resolveFallbackAction(serviceName, operation);
  if (result.action === FALLBACK_ACTION.BLOCK) {
    const error = new Error(result.message);
    error.code = 'SERVICE_UNAVAILABLE';
    error.service = serviceName;
    error.operation = operation;
    throw error;
  }
  return result;
}

export function withFallback(serviceName, operation, handler) {
  return async (...args) => {
    const fallback = resolveFallbackAction(serviceName, operation);
    if (fallback.action === FALLBACK_ACTION.BLOCK) {
      return {
        ok: false,
        error: fallback.message,
        code: 'SERVICE_UNAVAILABLE',
        service: serviceName,
        operation,
      };
    }
    if (fallback.action === FALLBACK_ACTION.QUEUE) {
      return {
        ok: true,
        queued: true,
        message: fallback.message,
        service: serviceName,
        operation,
      };
    }
    try {
      const result = await handler(...args);
      return { ok: true, result, degraded: fallback.action === FALLBACK_ACTION.DEGRADE };
    } catch {
      return {
        ok: false,
        error: fallback.message,
        code: 'SERVICE_ERROR',
        service: serviceName,
        operation,
      };
    }
  };
}

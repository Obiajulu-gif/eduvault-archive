/**
 * External Dependency Degradation Matrix with User-Safe Fallback Behavior — Issue #956
 *
 * Implements a centralized, declarative degradation matrix for all critical
 * third-party dependencies (Stellar, MongoDB, Pinata/IPFS, Email/SMTP, Webhooks).
 *
 * Features:
 *   - Dependency Criticality Tiers (Tier 1: Core Financial/Data, Tier 2: Content Delivery, Tier 3: Async/Side-Effects)
 *   - Documented failure modes and root cause classifications per dependency
 *   - Per-operation degradation actions (ALLOW, DEGRADE, BLOCK, QUEUE)
 *   - User-safe, sanitized fallback API responses & client actionable guidance
 *   - Circuit breaker tracking with automated health check probe execution
 *   - Zero internal credential or topology leakage
 */

import {
  SERVICE_STATE,
  FALLBACK_ACTION,
  registerService,
  reportServiceState,
  getServiceState,
  getAllServiceStates,
  resolveFallbackAction,
  isCriticalActionBlocked,
} from './fallback.js';

import { sanitizeErrorMessage, sanitizeText } from './status/publicStatusModel.js';

/**
 * Dependency Criticality Tiers
 */
export const DEPENDENCY_TIER = Object.freeze({
  TIER_1_CRITICAL: 'tier_1_critical', // Core financial mutation or primary state; must block on failure
  TIER_2_ESSENTIAL: 'tier_2_essential', // Content retrieval & storage; can degrade to replicas/placeholders
  TIER_3_SUPPORTING: 'tier_3_supporting', // Async notifications & side effects; can queue for later processing
});

/**
 * Standard Failure Mode Identifiers across dependencies
 */
export const FAILURE_MODES = Object.freeze({
  // Stellar / Soroban
  STELLAR_HORIZON_UNAVAILABLE: 'STELLAR_HORIZON_UNAVAILABLE',
  STELLAR_RPC_TIMEOUT: 'STELLAR_RPC_TIMEOUT',
  STELLAR_SURGE_FEE_CONGESTION: 'STELLAR_SURGE_FEE_CONGESTION',
  STELLAR_SEQUENCE_DESYNC: 'STELLAR_SEQUENCE_DESYNC',
  STELLAR_LEDGER_BEHIND: 'STELLAR_LEDGER_BEHIND',

  // MongoDB
  MONGO_PRIMARY_ELECTION: 'MONGO_PRIMARY_ELECTION',
  MONGO_POOL_EXHAUSTION: 'MONGO_POOL_EXHAUSTION',
  MONGO_WRITE_CONFLICT: 'MONGO_WRITE_CONFLICT',
  MONGO_SOCKET_TIMEOUT: 'MONGO_SOCKET_TIMEOUT',

  // Pinata / IPFS
  PINATA_RATE_LIMIT_429: 'PINATA_RATE_LIMIT_429',
  PINATA_GATEWAY_TIMEOUT_504: 'PINATA_GATEWAY_TIMEOUT_504',
  PINATA_PINNING_UNAVAILABLE: 'PINATA_PINNING_UNAVAILABLE',
  PINATA_AUTH_INVALID: 'PINATA_AUTH_INVALID',

  // Email / SMTP
  EMAIL_SMTP_REFUSED: 'EMAIL_SMTP_REFUSED',
  EMAIL_AUTH_FAILED: 'EMAIL_AUTH_FAILED',
  EMAIL_QUOTA_EXCEEDED: 'EMAIL_QUOTA_EXCEEDED',
  EMAIL_DNS_TIMEOUT: 'EMAIL_DNS_TIMEOUT',

  // Webhooks
  WEBHOOK_ENDPOINT_TIMEOUT: 'WEBHOOK_ENDPOINT_TIMEOUT',
  WEBHOOK_SSRF_BLOCKED: 'WEBHOOK_SSRF_BLOCKED',
  WEBHOOK_DESTINATION_5XX: 'WEBHOOK_DESTINATION_5XX',
  WEBHOOK_SSL_INVALID: 'WEBHOOK_SSL_INVALID',
});

/**
 * Client UX Action directives for frontend consumer handling
 */
export const CLIENT_ACTION = Object.freeze({
  DISABLE_BUTTON: 'disable_button',
  RETRY_WITH_BACKOFF: 'retry_with_backoff',
  SHOW_DEGRADATION_BANNER: 'show_degradation_banner',
  USE_CACHED_CONTENT: 'use_cached_content',
  AWAIT_ASYNC_COMPLETION: 'await_async_completion',
  FALLBACK_REPLICA: 'fallback_replica',
});

/**
 * Declarative External Dependency Degradation Matrix
 */
export const DEGRADATION_MATRIX = Object.freeze({
  stellar: {
    name: 'stellar',
    displayName: 'Stellar Horizon & Soroban RPC',
    tier: DEPENDENCY_TIER.TIER_1_CRITICAL,
    criticalActions: ['purchase', 'payout', 'refund'],
    failureModes: [
      FAILURE_MODES.STELLAR_HORIZON_UNAVAILABLE,
      FAILURE_MODES.STELLAR_RPC_TIMEOUT,
      FAILURE_MODES.STELLAR_SURGE_FEE_CONGESTION,
      FAILURE_MODES.STELLAR_SEQUENCE_DESYNC,
      FAILURE_MODES.STELLAR_LEDGER_BEHIND,
    ],
    operations: {
      purchase: {
        degraded: {
          action: FALLBACK_ACTION.ALLOW,
          userMessage: 'Stellar network is experiencing minor congestion. Payment may take a moment to finalize.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.RETRY_WITH_BACKOFF,
          retryAfterSeconds: 5,
        },
        unavailable: {
          action: FALLBACK_ACTION.BLOCK,
          userMessage: 'Stellar payment processing is temporarily paused. Your wallet has not been charged.',
          httpStatus: 503,
          clientAction: CLIENT_ACTION.DISABLE_BUTTON,
          retryAfterSeconds: 30,
        },
      },
      payout: {
        degraded: {
          action: FALLBACK_ACTION.QUEUE,
          userMessage: 'Creator payouts are queued and will process as soon as network traffic subsides.',
          httpStatus: 202,
          clientAction: CLIENT_ACTION.AWAIT_ASYNC_COMPLETION,
          retryAfterSeconds: 60,
        },
        unavailable: {
          action: FALLBACK_ACTION.BLOCK,
          userMessage: 'Creator payouts are currently unavailable. No funds have been moved.',
          httpStatus: 503,
          clientAction: CLIENT_ACTION.DISABLE_BUTTON,
          retryAfterSeconds: 120,
        },
      },
      refund: {
        degraded: {
          action: FALLBACK_ACTION.QUEUE,
          userMessage: 'Refund request accepted and queued for settlement.',
          httpStatus: 202,
          clientAction: CLIENT_ACTION.AWAIT_ASYNC_COMPLETION,
          retryAfterSeconds: 60,
        },
        unavailable: {
          action: FALLBACK_ACTION.BLOCK,
          userMessage: 'Refund settlement is temporarily paused. Please try again shortly.',
          httpStatus: 503,
          clientAction: CLIENT_ACTION.DISABLE_BUTTON,
          retryAfterSeconds: 60,
        },
      },
      balance_read: {
        degraded: {
          action: FALLBACK_ACTION.ALLOW,
          userMessage: 'Stellar node query delayed; returning latest verified balance.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.USE_CACHED_CONTENT,
          retryAfterSeconds: 15,
        },
        unavailable: {
          action: FALLBACK_ACTION.DEGRADE,
          userMessage: 'Live balance check unavailable; showing last confirmed ledger balance.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.USE_CACHED_CONTENT,
          retryAfterSeconds: 60,
        },
      },
    },
    healthThresholds: {
      failureThreshold: 2,
      recoveryThreshold: 2,
      timeoutMs: 4000,
    },
  },

  mongodb: {
    name: 'mongodb',
    displayName: 'Primary State Database (MongoDB)',
    tier: DEPENDENCY_TIER.TIER_1_CRITICAL,
    criticalActions: ['write_intent', 'write_purchase', 'settle_refund'],
    failureModes: [
      FAILURE_MODES.MONGO_PRIMARY_ELECTION,
      FAILURE_MODES.MONGO_POOL_EXHAUSTION,
      FAILURE_MODES.MONGO_WRITE_CONFLICT,
      FAILURE_MODES.MONGO_SOCKET_TIMEOUT,
    ],
    operations: {
      write_purchase: {
        degraded: {
          action: FALLBACK_ACTION.ALLOW,
          userMessage: 'Database processing is slower than usual. Please do not submit multiple times.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.RETRY_WITH_BACKOFF,
          retryAfterSeconds: 5,
        },
        unavailable: {
          action: FALLBACK_ACTION.BLOCK,
          userMessage: 'Database is currently unavailable. No purchase records were created and no funds were deducted.',
          httpStatus: 503,
          clientAction: CLIENT_ACTION.DISABLE_BUTTON,
          retryAfterSeconds: 15,
        },
      },
      write_intent: {
        degraded: {
          action: FALLBACK_ACTION.ALLOW,
          userMessage: 'Order creation in progress.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.RETRY_WITH_BACKOFF,
          retryAfterSeconds: 3,
        },
        unavailable: {
          action: FALLBACK_ACTION.BLOCK,
          userMessage: 'Checkout intent creation is temporarily paused. Please try again.',
          httpStatus: 503,
          clientAction: CLIENT_ACTION.DISABLE_BUTTON,
          retryAfterSeconds: 20,
        },
      },
      read_catalog: {
        degraded: {
          action: FALLBACK_ACTION.DEGRADE,
          userMessage: 'Serving cached catalog materials.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.USE_CACHED_CONTENT,
          retryAfterSeconds: 30,
        },
        unavailable: {
          action: FALLBACK_ACTION.DEGRADE,
          userMessage: 'Serving read-only offline catalog snapshot.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.USE_CACHED_CONTENT,
          retryAfterSeconds: 60,
        },
      },
    },
    healthThresholds: {
      failureThreshold: 2,
      recoveryThreshold: 1,
      timeoutMs: 3000,
    },
  },

  pinata: {
    name: 'pinata',
    displayName: 'Pinata IPFS & Content Storage',
    tier: DEPENDENCY_TIER.TIER_2_ESSENTIAL,
    criticalActions: ['upload_material'],
    failureModes: [
      FAILURE_MODES.PINATA_RATE_LIMIT_429,
      FAILURE_MODES.PINATA_GATEWAY_TIMEOUT_504,
      FAILURE_MODES.PINATA_PINNING_UNAVAILABLE,
      FAILURE_MODES.PINATA_AUTH_INVALID,
    ],
    operations: {
      upload_material: {
        degraded: {
          action: FALLBACK_ACTION.QUEUE,
          userMessage: 'IPFS gateway is running slowly; your uploaded material has been saved to quarantine and will be pinned shortly.',
          httpStatus: 202,
          clientAction: CLIENT_ACTION.AWAIT_ASYNC_COMPLETION,
          retryAfterSeconds: 30,
        },
        unavailable: {
          action: FALLBACK_ACTION.BLOCK,
          userMessage: 'Content storage pinning is temporarily unavailable. Please try uploading again in a few minutes.',
          httpStatus: 503,
          clientAction: CLIENT_ACTION.DISABLE_BUTTON,
          retryAfterSeconds: 60,
        },
      },
      download_content: {
        degraded: {
          action: FALLBACK_ACTION.DEGRADE,
          userMessage: 'Primary storage gateway is degraded. Routing download through fallback gateway.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.FALLBACK_REPLICA,
          retryAfterSeconds: 10,
        },
        unavailable: {
          action: FALLBACK_ACTION.DEGRADE,
          userMessage: 'Serving content from decentralized public IPFS replica.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.FALLBACK_REPLICA,
          retryAfterSeconds: 30,
        },
      },
      preview: {
        degraded: {
          action: FALLBACK_ACTION.DEGRADE,
          userMessage: 'Displaying low-resolution preview image.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.USE_CACHED_CONTENT,
          retryAfterSeconds: 15,
        },
        unavailable: {
          action: FALLBACK_ACTION.DEGRADE,
          userMessage: 'Content preview is temporarily unavailable. Resource details remain visible.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.SHOW_DEGRADATION_BANNER,
          retryAfterSeconds: 45,
        },
      },
    },
    healthThresholds: {
      failureThreshold: 3,
      recoveryThreshold: 2,
      timeoutMs: 5000,
    },
  },

  email: {
    name: 'email',
    displayName: 'Transactional Email (Nodemailer/SMTP)',
    tier: DEPENDENCY_TIER.TIER_3_SUPPORTING,
    criticalActions: [],
    failureModes: [
      FAILURE_MODES.EMAIL_SMTP_REFUSED,
      FAILURE_MODES.EMAIL_AUTH_FAILED,
      FAILURE_MODES.EMAIL_QUOTA_EXCEEDED,
      FAILURE_MODES.EMAIL_DNS_TIMEOUT,
    ],
    operations: {
      send_receipt: {
        degraded: {
          action: FALLBACK_ACTION.QUEUE,
          userMessage: 'Your purchase is complete. Your receipt has been queued and will arrive in your inbox shortly.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.AWAIT_ASYNC_COMPLETION,
          retryAfterSeconds: 30,
        },
        unavailable: {
          action: FALLBACK_ACTION.QUEUE,
          userMessage: 'Purchase finalized. Email notifications are currently delayed; receipt will be sent upon mail service recovery.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.AWAIT_ASYNC_COMPLETION,
          retryAfterSeconds: 120,
        },
      },
      send_notification: {
        degraded: {
          action: FALLBACK_ACTION.QUEUE,
          userMessage: 'Notification queued.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.AWAIT_ASYNC_COMPLETION,
          retryAfterSeconds: 60,
        },
        unavailable: {
          action: FALLBACK_ACTION.QUEUE,
          userMessage: 'Notification stored for background dispatch.',
          httpStatus: 200,
          clientAction: CLIENT_ACTION.AWAIT_ASYNC_COMPLETION,
          retryAfterSeconds: 180,
        },
      },
    },
    healthThresholds: {
      failureThreshold: 2,
      recoveryThreshold: 1,
      timeoutMs: 3000,
    },
  },

  webhooks: {
    name: 'webhooks',
    displayName: 'External Event Webhooks',
    tier: DEPENDENCY_TIER.TIER_3_SUPPORTING,
    criticalActions: [],
    failureModes: [
      FAILURE_MODES.WEBHOOK_ENDPOINT_TIMEOUT,
      FAILURE_MODES.WEBHOOK_SSRF_BLOCKED,
      FAILURE_MODES.WEBHOOK_DESTINATION_5XX,
      FAILURE_MODES.WEBHOOK_SSL_INVALID,
    ],
    operations: {
      dispatch: {
        degraded: {
          action: FALLBACK_ACTION.QUEUE,
          userMessage: 'Webhook delivery queued for background retry.',
          httpStatus: 202,
          clientAction: CLIENT_ACTION.AWAIT_ASYNC_COMPLETION,
          retryAfterSeconds: 30,
        },
        unavailable: {
          action: FALLBACK_ACTION.QUEUE,
          userMessage: 'Webhook delivery held in dead-letter queue.',
          httpStatus: 202,
          clientAction: CLIENT_ACTION.AWAIT_ASYNC_COMPLETION,
          retryAfterSeconds: 300,
        },
      },
    },
    healthThresholds: {
      failureThreshold: 3,
      recoveryThreshold: 1,
      timeoutMs: 4000,
    },
  },
});

/**
 * In-memory circuit breaker and automated check tracking
 */
const circuitBreakerState = new Map();

function getOrCreateCircuit(serviceName) {
  if (!circuitBreakerState.has(serviceName)) {
    circuitBreakerState.set(serviceName, {
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastCheckAt: null,
      lastError: null,
      lastFailureMode: null,
      probeCount: 0,
    });
  }
  return circuitBreakerState.get(serviceName);
}

/**
 * Initialize all matrix services into the fallback registry
 */
export function initializeDegradationRegistry() {
  for (const [name, config] of Object.entries(DEGRADATION_MATRIX)) {
    registerService(name, {
      criticalActions: config.criticalActions,
      metadata: {
        tier: config.tier,
        displayName: config.displayName,
        failureModes: config.failureModes,
      },
    });
    getOrCreateCircuit(name);
  }
}

/**
 * Look up the degradation policy for a given service and operation in the matrix
 */
export function getDegradationPolicy(serviceName, operation = 'default', state = null) {
  const serviceConfig = DEGRADATION_MATRIX[serviceName];
  if (!serviceConfig) return null;

  const resolvedState = state || getServiceState(serviceName)?.state || SERVICE_STATE.HEALTHY;
  const opConfig = serviceConfig.operations[operation];

  if (!opConfig) {
    // Default fallback based on service-wide policy
    const isCritical = serviceConfig.criticalActions.includes(operation);
    if (resolvedState === SERVICE_STATE.HEALTHY) {
      return {
        action: FALLBACK_ACTION.ALLOW,
        userMessage: `${serviceConfig.displayName} is operating normally.`,
        httpStatus: 200,
        clientAction: CLIENT_ACTION.RETRY_WITH_BACKOFF,
        retryAfterSeconds: 0,
      };
    }
    if (resolvedState === SERVICE_STATE.DEGRADED) {
      return {
        action: isCritical ? FALLBACK_ACTION.ALLOW : FALLBACK_ACTION.DEGRADE,
        userMessage: `${serviceConfig.displayName} is experiencing degraded performance.`,
        httpStatus: 200,
        clientAction: CLIENT_ACTION.RETRY_WITH_BACKOFF,
        retryAfterSeconds: 10,
      };
    }
    return {
      action: isCritical ? FALLBACK_ACTION.BLOCK : FALLBACK_ACTION.QUEUE,
      userMessage: `${serviceConfig.displayName} is temporarily unavailable.`,
      httpStatus: isCritical ? 503 : 202,
      clientAction: isCritical ? CLIENT_ACTION.DISABLE_BUTTON : CLIENT_ACTION.AWAIT_ASYNC_COMPLETION,
      retryAfterSeconds: 30,
    };
  }

  if (resolvedState === SERVICE_STATE.HEALTHY) {
    return {
      action: FALLBACK_ACTION.ALLOW,
      userMessage: `${serviceConfig.displayName} is operating normally.`,
      httpStatus: 200,
      clientAction: CLIENT_ACTION.RETRY_WITH_BACKOFF,
      retryAfterSeconds: 0,
    };
  }

  return opConfig[resolvedState] || {
    action: FALLBACK_ACTION.BLOCK,
    userMessage: 'Service operation is temporarily blocked.',
    httpStatus: 503,
    clientAction: CLIENT_ACTION.DISABLE_BUTTON,
    retryAfterSeconds: 30,
  };
}

/**
 * Construct a standardized, user-safe API response payload when a dependency is degraded
 */
export function createDegradedApiResponse(serviceName, operation = 'default', options = {}) {
  const { state = null, failureMode = null, rawError = null } = options;
  const policy = getDegradationPolicy(serviceName, operation, state);
  const serviceState = state || getServiceState(serviceName)?.state || SERVICE_STATE.DEGRADED;

  const isBlocked = policy?.action === FALLBACK_ACTION.BLOCK;
  const isQueued = policy?.action === FALLBACK_ACTION.QUEUE;

  const payload = {
    ok: !isBlocked,
    code: isBlocked ? 'SERVICE_UNAVAILABLE' : isQueued ? 'REQUEST_QUEUED' : 'SERVICE_DEGRADED',
    service: serviceName,
    operation,
    userMessage: policy?.userMessage || 'Service is temporarily degraded.',
    clientAction: policy?.clientAction || CLIENT_ACTION.RETRY_WITH_BACKOFF,
    retryAfterSeconds: policy?.retryAfterSeconds || 30,
    degraded: serviceState !== SERVICE_STATE.HEALTHY,
    queued: isQueued,
    timestamp: new Date().toISOString(),
  };

  // Ensure raw internal error traces NEVER leak to caller
  if (rawError) {
    const clean = sanitizeErrorMessage(rawError);
    // Only expose non-sensitive error categorization
    payload.diagnostic = clean.slice(0, 100);
  }

  if (failureMode) {
    payload.failureMode = failureMode;
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-EduVault-Degraded-Service': serviceName,
    'X-EduVault-Fallback-Action': policy?.action || FALLBACK_ACTION.BLOCK,
    'Retry-After': String(policy?.retryAfterSeconds || 30),
  };

  return {
    status: policy?.httpStatus || (isBlocked ? 503 : 200),
    body: payload,
    headers,
  };
}

/**
 * Execute an automated check probe for a dependency and transition state according to matrix thresholds
 */
export async function runDependencyCheck(serviceName, probeFn = null) {
  const config = DEGRADATION_MATRIX[serviceName];
  if (!config) {
    throw new Error(`Unknown dependency: ${serviceName}`);
  }

  const circuit = getOrCreateCircuit(serviceName);
  circuit.probeCount += 1;
  circuit.lastCheckAt = new Date().toISOString();

  let healthy = true;
  let failureMode = null;
  let errorMsg = null;
  const startTime = Date.now();

  try {
    if (probeFn) {
      const probeResult = await probeFn();
      healthy = probeResult === true || probeResult?.healthy === true;
      if (!healthy) {
        failureMode = probeResult?.failureMode || 'CHECK_RETURNED_UNHEALTHY';
        errorMsg = probeResult?.error || 'Probe failed';
      }
    } else {
      // Default mockable simulated check (healthy unless state was manually degraded)
      const current = getServiceState(serviceName);
      healthy = current?.state === SERVICE_STATE.HEALTHY;
    }
  } catch (err) {
    healthy = false;
    failureMode = 'EXCEPTION_DURING_PROBE';
    errorMsg = sanitizeErrorMessage(err);
  }

  const latencyMs = Date.now() - startTime;

  if (healthy) {
    circuit.consecutiveSuccesses += 1;
    circuit.consecutiveFailures = 0;
    circuit.lastError = null;
    circuit.lastFailureMode = null;

    if (circuit.consecutiveSuccesses >= config.healthThresholds.recoveryThreshold) {
      reportServiceState(serviceName, SERVICE_STATE.HEALTHY, 'automated_check_recovered');
    }
  } else {
    circuit.consecutiveFailures += 1;
    circuit.consecutiveSuccesses = 0;
    circuit.lastError = errorMsg;
    circuit.lastFailureMode = failureMode;

    if (circuit.consecutiveFailures >= config.healthThresholds.failureThreshold * 2) {
      reportServiceState(serviceName, SERVICE_STATE.UNAVAILABLE, failureMode || 'probe_threshold_exceeded');
    } else if (circuit.consecutiveFailures >= config.healthThresholds.failureThreshold) {
      reportServiceState(serviceName, SERVICE_STATE.DEGRADED, failureMode || 'probe_threshold_degraded');
    }
  }

  return {
    service: serviceName,
    healthy,
    latencyMs,
    failureMode: circuit.lastFailureMode,
    consecutiveFailures: circuit.consecutiveFailures,
    consecutiveSuccesses: circuit.consecutiveSuccesses,
    currentState: getServiceState(serviceName)?.state || SERVICE_STATE.HEALTHY,
  };
}

/**
 * Run automated checks across all dependencies in the matrix
 */
export async function runAllDependencyChecks(customProbes = {}) {
  const results = {};
  for (const serviceName of Object.keys(DEGRADATION_MATRIX)) {
    const probe = customProbes[serviceName] || null;
    results[serviceName] = await runDependencyCheck(serviceName, probe);
  }
  return results;
}

/**
 * Circuit breaker reset for testing and recovery simulation
 */
export function resetDegradationMatrix() {
  circuitBreakerState.clear();
  initializeDegradationRegistry();
}

/**
 * Execute an operation under the protection of the degradation matrix
 */
export async function executeWithDegradation(serviceName, operation, handler, options = {}) {
  const policy = getDegradationPolicy(serviceName, operation);
  if (policy.action === FALLBACK_ACTION.BLOCK) {
    return createDegradedApiResponse(serviceName, operation, {
      state: SERVICE_STATE.UNAVAILABLE,
      rawError: options.error || null,
    }).body;
  }

  if (policy.action === FALLBACK_ACTION.QUEUE) {
    if (options.onQueue) {
      await options.onQueue();
    }
    return createDegradedApiResponse(serviceName, operation, {
      state: SERVICE_STATE.DEGRADED,
    }).body;
  }

  try {
    const result = await handler();
    return {
      ok: true,
      result,
      degraded: policy.action === FALLBACK_ACTION.DEGRADE,
      clientAction: policy.clientAction,
    };
  } catch (err) {
    // Check if error corresponds to a recognized failure mode
    const clean = sanitizeErrorMessage(err);
    return createDegradedApiResponse(serviceName, operation, {
      state: SERVICE_STATE.DEGRADED,
      rawError: clean,
    }).body;
  }
}

// Auto-initialize registry on import
initializeDegradationRegistry();

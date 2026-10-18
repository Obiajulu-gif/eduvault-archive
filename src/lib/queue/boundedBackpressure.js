/**
 * Bounded Queue Backpressure Framework for Background Workers — Issue #984
 *
 * Prevents memory exhaustion, worker starvation, and cascading failure storms
 * across expensive background work (integrity verification, IPFS pinning/unpinning,
 * garbage collection, and ledger syncing).
 *
 * Guarantees:
 * 1. Bounded Concurrency & Capacity: Hard capacity limits prevent unbounded queue growth.
 * 2. Multi-Tier Watermark Shedding: High water mark sheds LOW-priority jobs while
 *    preserving critical financial callbacks and settlement side effects.
 * 3. Structured Backpressure Signals: Rejected requests receive 429 status, retry-after
 *    recommendations, and diagnostic metrics without leaking system internals.
 * 4. Authorization Enforcement: Verify caller permissions prior to queue admission.
 * 5. Deterministic Recovery & Rollback: State returns to NORMAL when depth drops below
 *    the low water mark (hysteresis loop).
 */

import { enqueueJob, DEFAULT_RETRY_CONFIG } from '../workers/backgroundWorker.js';

export const BACKPRESSURE_PRIORITY = Object.freeze({
  HIGH: 'HIGH',
  NORMAL: 'NORMAL',
  LOW: 'LOW',
});

export const BACKPRESSURE_STATE = Object.freeze({
  NORMAL: 'NORMAL',
  SHEDDING_LOW_PRIORITY: 'SHEDDING_LOW_PRIORITY',
  SATURATED: 'SATURATED',
});

/**
 * Custom error thrown when queue backpressure thresholds are exceeded.
 */
export class QueueBackpressureError extends Error {
  constructor({ message, currentDepth, maxCapacity, priority, retryAfterSeconds, jobType }) {
    super(message || 'Queue is currently under backpressure. Please retry later.');
    this.name = 'QueueBackpressureError';
    this.status = 429;
    this.code = 'QUEUE_BACKPRESSURE_SATURATED';
    this.currentDepth = currentDepth;
    this.maxCapacity = maxCapacity;
    this.priority = priority;
    this.retryAfterSeconds = retryAfterSeconds;
    this.jobType = jobType;
    this.isBackpressureRejection = true;
  }
}

/**
 * In-memory or database-backed bounded queue controller.
 */
export class BoundedQueueBackpressure {
  constructor({
    maxCapacity = 200,
    highWaterRatio = 0.8,
    lowWaterRatio = 0.5,
    perJobTypeLimits = {},
    defaultRetryAfterSeconds = 30,
  } = {}) {
    this.maxCapacity = maxCapacity;
    this.highWaterMark = Math.floor(maxCapacity * highWaterRatio);
    this.lowWaterMark = Math.floor(maxCapacity * lowWaterRatio);
    this.perJobTypeLimits = { ...perJobTypeLimits };
    this.defaultRetryAfterSeconds = defaultRetryAfterSeconds;

    this.activeJobCounts = new Map();
    this.totalActiveDepth = 0;
    this.totalAdmitted = 0;
    this.totalRejected = 0;
    this.state = BACKPRESSURE_STATE.NORMAL;
    this.telemetryEvents = [];
  }

  /**
   * Evaluates the current backpressure state based on queue depth.
   *
   * @param {number} [overrideDepth]
   * @returns {'NORMAL'|'SHEDDING_LOW_PRIORITY'|'SATURATED'}
   */
  evaluateState(overrideDepth) {
    const depth = overrideDepth !== undefined ? overrideDepth : this.totalActiveDepth;

    if (depth >= this.maxCapacity) {
      this.state = BACKPRESSURE_STATE.SATURATED;
    } else if (depth >= this.highWaterMark) {
      this.state = BACKPRESSURE_STATE.SHEDDING_LOW_PRIORITY;
    } else if (depth <= this.lowWaterMark) {
      this.state = BACKPRESSURE_STATE.NORMAL;
    }
    // If between lowWaterMark and highWaterMark, maintain previous state (hysteresis)

    return this.state;
  }

  /**
   * Checks whether a job can be admitted to the queue.
   *
   * @param {object} params
   * @param {string} params.name - Job name / type
   * @param {'HIGH'|'NORMAL'|'LOW'} [params.priority='NORMAL']
   * @param {number} [params.currentQueueDepth] - External count from database
   * @param {object} [params.authContext] - Authorization context
   * @param {string|string[]} [params.requiredPermissions] - Required permissions
   * @throws {Error|QueueBackpressureError}
   */
  checkAdmission({
    name,
    priority = BACKPRESSURE_PRIORITY.NORMAL,
    currentQueueDepth,
    authContext = null,
    requiredPermissions = 'jobs:enqueue',
  }) {
    // 1. Authorization check
    if (authContext) {
      if (!authContext.isAuthenticated) {
        const error = new Error('Authentication required to submit background work.');
        error.status = 401;
        error.code = 'UNAUTHENTICATED';
        throw error;
      }

      if (requiredPermissions) {
        const perms = Array.isArray(requiredPermissions) ? requiredPermissions : [requiredPermissions];
        const userPerms = new Set(authContext.permissions || []);
        const hasPerm = perms.every((p) => userPerms.has(p) || userPerms.has('*'));
        if (!hasPerm) {
          const error = new Error('Insufficient permissions to submit background work.');
          error.status = 403;
          error.code = 'FORBIDDEN';
          throw error;
        }
      }
    }

    const depth = currentQueueDepth !== undefined ? currentQueueDepth : this.totalActiveDepth;
    const currentState = this.evaluateState(depth);

    // 2. Per-job-type limit check
    const jobLimit = this.perJobTypeLimits[name];
    const currentJobCount = this.activeJobCounts.get(name) || 0;
    if (jobLimit && currentJobCount >= jobLimit) {
      this.totalRejected++;
      this._recordTelemetry({
        event: 'BACKPRESSURE_JOB_TYPE_REJECTED',
        jobType: name,
        currentJobCount,
        jobLimit,
        timestamp: new Date().toISOString(),
      });
      throw new QueueBackpressureError({
        message: `Background queue for job type '${name}' has reached its concurrency limit of ${jobLimit}.`,
        currentDepth: currentJobCount,
        maxCapacity: jobLimit,
        priority,
        retryAfterSeconds: this.defaultRetryAfterSeconds,
        jobType: name,
      });
    }

    // 3. Global capacity saturation check
    if (currentState === BACKPRESSURE_STATE.SATURATED) {
      // Saturated: only HIGH priority allowed if below absolute buffer (maxCapacity * 1.05)
      const isCriticalHigh = priority === BACKPRESSURE_PRIORITY.HIGH;
      const buffer = Math.floor(this.maxCapacity * 1.05);

      if (!isCriticalHigh || depth >= buffer) {
        this.totalRejected++;
        this._recordTelemetry({
          event: 'BACKPRESSURE_SATURATED_REJECTED',
          jobType: name,
          priority,
          depth,
          timestamp: new Date().toISOString(),
        });

        throw new QueueBackpressureError({
          message: 'Background processing queue is currently saturated. Request throttled.',
          currentDepth: depth,
          maxCapacity: this.maxCapacity,
          priority,
          retryAfterSeconds: this.defaultRetryAfterSeconds * 2,
          jobType: name,
        });
      }
    }

    // 4. Shedding check for LOW priority jobs
    if (currentState === BACKPRESSURE_STATE.SHEDDING_LOW_PRIORITY && priority === BACKPRESSURE_PRIORITY.LOW) {
      this.totalRejected++;
      this._recordTelemetry({
        event: 'BACKPRESSURE_LOW_PRIORITY_SHED',
        jobType: name,
        priority,
        depth,
        timestamp: new Date().toISOString(),
      });

      throw new QueueBackpressureError({
        message: 'Background queue high-water mark reached. Low priority work postponed.',
        currentDepth: depth,
        maxCapacity: this.maxCapacity,
        priority,
        retryAfterSeconds: this.defaultRetryAfterSeconds,
        jobType: name,
      });
    }

    // Job admitted
    this.totalAdmitted++;
    return {
      admitted: true,
      state: currentState,
      currentDepth: depth,
    };
  }

  /**
   * Tracks job admission in memory.
   */
  trackAdmission(name) {
    this.totalActiveDepth++;
    const current = this.activeJobCounts.get(name) || 0;
    this.activeJobCounts.set(name, current + 1);
    this.evaluateState();
  }

  /**
   * Tracks job completion in memory.
   */
  trackCompletion(name) {
    if (this.totalActiveDepth > 0) this.totalActiveDepth--;
    const current = this.activeJobCounts.get(name) || 0;
    if (current > 0) {
      this.activeJobCounts.set(name, current - 1);
    }
    this.evaluateState();
  }

  /**
   * Returns current metrics snapshot.
   */
  getMetrics() {
    return {
      totalActiveDepth: this.totalActiveDepth,
      maxCapacity: this.maxCapacity,
      highWaterMark: this.highWaterMark,
      lowWaterMark: this.lowWaterMark,
      state: this.state,
      totalAdmitted: this.totalAdmitted,
      totalRejected: this.totalRejected,
      jobTypeBreakdown: Object.fromEntries(this.activeJobCounts),
    };
  }

  /**
   * Resets metrics (for testing).
   */
  reset() {
    this.activeJobCounts.clear();
    this.totalActiveDepth = 0;
    this.totalAdmitted = 0;
    this.totalRejected = 0;
    this.state = BACKPRESSURE_STATE.NORMAL;
    this.telemetryEvents.length = 0;
  }

  _recordTelemetry(event) {
    this.telemetryEvents.push(event);
    if (this.telemetryEvents.length > 200) {
      this.telemetryEvents.shift();
    }
  }

  getTelemetryEvents() {
    return [...this.telemetryEvents];
  }
}

// Global default backpressure manager instance
export const globalQueueBackpressure = new BoundedQueueBackpressure({
  maxCapacity: 200,
  highWaterRatio: 0.8,
  lowWaterRatio: 0.5,
  perJobTypeLimits: {
    'storage:garbage-collection': 20,
    'storage:pin-verification': 50,
    'integrity:verification': 30,
  },
});

/**
 * Enqueues a background job under bounded backpressure protection.
 *
 * @param {object} params
 * @param {string} params.name
 * @param {object} [params.payload]
 * @param {'HIGH'|'NORMAL'|'LOW'} [params.priority='NORMAL']
 * @param {object} [params.authContext]
 * @param {string|string[]} [params.requiredPermissions]
 * @param {BoundedQueueBackpressure} [params.backpressureManager]
 * @param {object} [params.db]
 * @returns {Promise<object>} Created job document
 */
export async function enqueueWithBackpressure({
  name,
  payload = {},
  priority = BACKPRESSURE_PRIORITY.NORMAL,
  authContext = null,
  requiredPermissions = null,
  backpressureManager = globalQueueBackpressure,
  db = null,
  scheduledFor = null,
  idempotencyKey = null,
  maxAttempts = DEFAULT_RETRY_CONFIG.maxAttempts,
  retryConfig = {},
} = {}) {
  // If db is provided, count pending jobs to get real database queue depth
  let currentDbDepth;
  if (db) {
    try {
      currentDbDepth = await db.collection('background_jobs').countDocuments({
        status: { $in: ['pending', 'running'] },
      });
    } catch {
      // Fallback to in-memory depth if count fails
    }
  }

  // Check admission
  backpressureManager.checkAdmission({
    name,
    priority,
    currentQueueDepth: currentDbDepth,
    authContext,
    requiredPermissions,
  });

  // Track admission
  backpressureManager.trackAdmission(name);

  try {
    const jobDoc = await enqueueJob({
      name,
      payload: { ...payload, _priority: priority },
      scheduledFor,
      idempotencyKey,
      maxAttempts,
      retryConfig,
      db,
    });

    return jobDoc;
  } catch (err) {
    // If enqueue failed (e.g. database error), rollback tracking
    backpressureManager.trackCompletion(name);
    throw err;
  }
}

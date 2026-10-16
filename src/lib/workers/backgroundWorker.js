// Background Worker Framework for Delayed and Retryable Tasks (#789)
// Provides observable background execution, retry policy with exponential backoff,
// dead-letter handling, distributed leases, and execution tracing.

import crypto from 'node:crypto';

export const BACKGROUND_JOBS_COLLECTION = 'background_jobs';

export const DEFAULT_RETRY_CONFIG = {
  maxAttempts: 3,
  initialMs: 1000,
  multiplier: 2,
  maxMs: 60_000,
  jitterFraction: 0.1,
  leaseTtlMs: 5 * 60 * 1000, // 5 minutes lock
};

/**
 * Lazily resolves MongoDB database instance if not injected.
 */
async function resolveDb(db) {
  if (db) return db;
  const { getDb } = await import('../mongodb.js');
  return getDb();
}

/**
 * Handler registry mapping job names to handler functions.
 * Handlers receive: (payload, context) => Promise<any>
 */
const jobHandlers = new Map();

/**
 * Register a job handler function for a given job type name.
 *
 * @param {string} name - Job identifier name (e.g. "storage:garbage-collection")
 * @param {Function} handler - Async function (payload, context) => Promise<any>
 */
export function registerJobHandler(name, handler) {
  if (typeof handler !== 'function') {
    throw new TypeError(`Handler for job "${name}" must be a function`);
  }
  jobHandlers.set(name, handler);
}

/**
 * Get registered handler for a job type, resolving built-in system handlers lazily.
 *
 * @param {string} name
 * @returns {Promise<Function|undefined>}
 */
export async function getJobHandler(name) {
  if (jobHandlers.has(name)) {
    return jobHandlers.get(name);
  }

  // Lazy resolution for standard storage maintenance job handlers (#789)
  if (name === 'storage:garbage-collection') {
    const { runGarbageCollectionWorker } = await import('./garbageCollectionWorker.js');
    const handler = (payload) =>
      runGarbageCollectionWorker({
        dryRun: payload.dryRun !== false,
        limit: payload.limit || 50,
        notifyOnError: payload.notifyOnError || false,
        performCleanup: payload.performCleanup || false,
      });
    jobHandlers.set(name, handler);
    return handler;
  }

  if (name === 'storage:verify-pins') {
    const { runPinVerificationWorker } = await import('./pinVerificationWorker.js');
    const handler = (payload) =>
      runPinVerificationWorker({
        batchSize: payload.batchSize || 100,
        samplingRate: payload.samplingRate || 0.1,
        notifyOnFailure: payload.notifyOnFailure || false,
        maxConcurrent: payload.maxConcurrent || 5,
      });
    jobHandlers.set(name, handler);
    return handler;
  }

  if (name === 'storage:verify-integrity') {
    const { runIntegrityVerificationWorker } = await import('./integrityVerificationWorker.js');
    const handler = (payload) =>
      runIntegrityVerificationWorker({
        batchSize: payload.batchSize || 50,
        samplingRate: payload.samplingRate || 0.05,
        dryRun: payload.dryRun !== false,
        notifyOnFailure: payload.notifyOnFailure || false,
      });
    jobHandlers.set(name, handler);
    return handler;
  }

  if (name === 'storage:repair-pins') {
    const { runRepairActions } = await import('./pinVerificationWorker.js');
    const handler = (payload, context) => runRepairActions(context.db, payload.maxRepairs || 10);
    jobHandlers.set(name, handler);
    return handler;
  }

  return undefined;
}

/**
 * Clear all registered job handlers (useful in test suites).
 */
export function clearJobHandlers() {
  jobHandlers.clear();
}

/**
 * Calculate the next attempt time using exponential backoff with jitter.
 *
 * @param {number} attemptCount - Current attempt number (0-based)
 * @param {object} config - Backoff configuration
 * @returns {Date} Scheduled retry date
 */
export function computeBackoffTime(attemptCount, config = DEFAULT_RETRY_CONFIG) {
  const initial = config.initialMs ?? DEFAULT_RETRY_CONFIG.initialMs;
  const multiplier = config.multiplier ?? DEFAULT_RETRY_CONFIG.multiplier;
  const maxMs = config.maxMs ?? DEFAULT_RETRY_CONFIG.maxMs;
  const jitterFraction = config.jitterFraction ?? DEFAULT_RETRY_CONFIG.jitterFraction;

  const exponential = initial * Math.pow(multiplier, attemptCount);
  const capped = Math.min(exponential, maxMs);
  const jitter = capped * jitterFraction * Math.random();
  return new Date(Date.now() + Math.round(capped + jitter));
}

/**
 * Format error object preserving diagnostic context for inspection and debugging.
 *
 * @param {Error|any} err
 * @param {number} attempt
 * @returns {object} Structured error context
 */
export function formatErrorContext(err, attempt) {
  if (!err) {
    return {
      message: 'Unknown error',
      failedAt: new Date(),
      attempt,
    };
  }

  return {
    message: err.message || String(err),
    name: err.name || 'Error',
    code: err.code || null,
    stack: err.stack || null,
    failedAt: new Date(),
    attempt,
  };
}

/**
 * Enqueue a job into the background queue.
 *
 * @param {object} params
 * @param {string} params.name - Registered job handler name
 * @param {object} [params.payload={}] - Job input arguments
 * @param {Date|number} [params.scheduledFor] - When the job should run (supports delay)
 * @param {string} [params.idempotencyKey] - Unique key to prevent duplicate enqueue
 * @param {number} [params.maxAttempts] - Max retry attempts before dead-lettering
 * @param {object} [params.retryConfig] - Custom retry settings
 * @param {object} [params.db] - Optional Mongo DB instance
 * @returns {Promise<object>} The created or existing job document
 */
export async function enqueueJob({
  name,
  payload = {},
  scheduledFor = null,
  idempotencyKey = null,
  maxAttempts = DEFAULT_RETRY_CONFIG.maxAttempts,
  retryConfig = {},
  db = null,
} = {}) {
  if (!name || typeof name !== 'string') {
    throw new TypeError('Job name must be a non-empty string');
  }

  const database = await resolveDb(db);
  const collection = database.collection(BACKGROUND_JOBS_COLLECTION);
  const now = new Date();

  const runAt = scheduledFor
    ? scheduledFor instanceof Date
      ? scheduledFor
      : new Date(scheduledFor)
    : now;

  const jobId = crypto.randomUUID();

  const jobDocument = {
    jobId,
    name,
    payload,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: Number.isInteger(maxAttempts) ? maxAttempts : DEFAULT_RETRY_CONFIG.maxAttempts,
    retryConfig: {
      initialMs: retryConfig.initialMs ?? DEFAULT_RETRY_CONFIG.initialMs,
      multiplier: retryConfig.multiplier ?? DEFAULT_RETRY_CONFIG.multiplier,
      maxMs: retryConfig.maxMs ?? DEFAULT_RETRY_CONFIG.maxMs,
      jitterFraction: retryConfig.jitterFraction ?? DEFAULT_RETRY_CONFIG.jitterFraction,
      leaseTtlMs: retryConfig.leaseTtlMs ?? DEFAULT_RETRY_CONFIG.leaseTtlMs,
    },
    scheduledFor: runAt,
    lockedUntil: null,
    lockedBy: null,
    idempotencyKey: idempotencyKey || null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    attempts: [],
  };

  if (idempotencyKey) {
    try {
      await collection.insertOne(jobDocument);
      return jobDocument;
    } catch (err) {
      if (err.code === 11000) {
        // Idempotent duplicate: return existing job
        const existing = await collection.findOne({ idempotencyKey });
        if (existing) return existing;
      }
      throw err;
    }
  }

  await collection.insertOne(jobDocument);
  return jobDocument;
}

/**
 * Lease the next available pending job for execution.
 * Ensures distributed mutual exclusion using atomic findOneAndUpdate.
 *
 * @param {object} options
 * @param {string} options.workerId - Identifier of the leasing worker
 * @param {string[]} [options.jobNames] - Optional filter for specific job types
 * @param {number} [options.leaseTtlMs] - Lock duration in milliseconds
 * @param {object} [options.db] - Optional Mongo DB instance
 * @returns {Promise<object|null>} Leased job or null if no eligible job found
 */
export async function leaseNextJob({
  workerId,
  jobNames = null,
  leaseTtlMs = DEFAULT_RETRY_CONFIG.leaseTtlMs,
  db = null,
} = {}) {
  if (!workerId) {
    throw new TypeError('workerId is required to lease a job');
  }

  const database = await resolveDb(db);
  const collection = database.collection(BACKGROUND_JOBS_COLLECTION);
  const now = new Date();
  const lockExpiresAt = new Date(now.getTime() + leaseTtlMs);

  const filter = {
    status: 'pending',
    scheduledFor: { $lte: now },
    $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
  };

  if (Array.isArray(jobNames) && jobNames.length > 0) {
    filter.name = { $in: jobNames };
  }

  const update = {
    $set: {
      status: 'running',
      lockedUntil: lockExpiresAt,
      lockedBy: workerId,
      startedAt: now,
      updatedAt: now,
    },
    $inc: {
      attemptCount: 1,
    },
  };

  const result = await collection.findOneAndUpdate(filter, update, {
    sort: { scheduledFor: 1, createdAt: 1 },
    returnDocument: 'after',
  });

  return result?.value || result;
}

/**
 * Record job completion and store output result.
 *
 * @param {string} jobId
 * @param {any} result
 * @param {object} options
 * @returns {Promise<object|null>}
 */
export async function completeJob(jobId, result = null, { workerId = null, db = null } = {}) {
  const database = await resolveDb(db);
  const collection = database.collection(BACKGROUND_JOBS_COLLECTION);
  const now = new Date();

  const update = {
    $set: {
      status: 'completed',
      lockedUntil: null,
      lockedBy: null,
      completedAt: now,
      updatedAt: now,
      result: result ?? null,
    },
    $push: {
      attempts: {
        workerId,
        finishedAt: now,
        status: 'completed',
        error: null,
      },
    },
  };

  const doc = await collection.findOneAndUpdate({ jobId }, update, {
    returnDocument: 'after',
  });

  return doc?.value || doc;
}

/**
 * Handle job failure: record error context, trigger retry backoff or transition to dead_letter.
 *
 * @param {string} jobId
 * @param {Error|any} error
 * @param {object} options
 * @returns {Promise<object|null>}
 */
export async function failJob(jobId, error, { workerId = null, db = null } = {}) {
  const database = await resolveDb(db);
  const collection = database.collection(BACKGROUND_JOBS_COLLECTION);
  const now = new Date();

  const job = await collection.findOne({ jobId });
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const currentAttempt = job.attemptCount || 1;
  const maxAttempts = job.maxAttempts || DEFAULT_RETRY_CONFIG.maxAttempts;
  const errorContext = formatErrorContext(error, currentAttempt);

  const attemptLog = {
    attempt: currentAttempt,
    workerId,
    finishedAt: now,
    status: 'failed',
    error: errorContext,
  };

  if (currentAttempt < maxAttempts) {
    // Eligible for retry: schedule with exponential backoff
    const nextRun = computeBackoffTime(currentAttempt, job.retryConfig || DEFAULT_RETRY_CONFIG);

    const update = {
      $set: {
        status: 'pending',
        scheduledFor: nextRun,
        lockedUntil: null,
        lockedBy: null,
        error: errorContext,
        updatedAt: now,
      },
      $push: {
        attempts: attemptLog,
      },
    };

    const updated = await collection.findOneAndUpdate({ jobId }, update, {
      returnDocument: 'after',
    });
    return updated?.value || updated;
  }

  // Exhausted all attempts -> Dead Letter Queue
  const update = {
    $set: {
      status: 'dead_letter',
      lockedUntil: null,
      lockedBy: null,
      error: errorContext,
      updatedAt: now,
    },
    $push: {
      attempts: attemptLog,
    },
  };

  const updated = await collection.findOneAndUpdate({ jobId }, update, {
    returnDocument: 'after',
  });

  return updated?.value || updated;
}

/**
 * Execute a leased job using its registered handler.
 *
 * @param {object} job
 * @param {object} options
 * @returns {Promise<{ success: boolean, result?: any, error?: any }>}
 */
export async function executeJob(job, { workerId = 'default-worker', db = null } = {}) {
  const handler = await getJobHandler(job.name);

  if (!handler) {
    const error = new Error(`No handler registered for job type "${job.name}"`);
    await failJob(job.jobId, error, { workerId, db });
    return { success: false, error };
  }

  try {
    const database = await resolveDb(db);
    const context = {
      jobId: job.jobId,
      name: job.name,
      attemptCount: job.attemptCount,
      workerId,
      db: database,
    };

    const result = await handler(job.payload, context);
    await completeJob(job.jobId, result, { workerId, db: database });
    return { success: true, result };
  } catch (err) {
    await failJob(job.jobId, err, { workerId, db });
    return { success: false, error: err };
  }
}

/**
 * Process the next pending job. Leases and executes it.
 *
 * @param {object} options
 * @returns {Promise<{ processed: boolean, job?: object, result?: any }>}
 */
export async function processNextJob({
  workerId = `worker-${crypto.randomUUID().slice(0, 8)}`,
  jobNames = null,
  db = null,
} = {}) {
  const job = await leaseNextJob({ workerId, jobNames, db });
  if (!job) {
    return { processed: false, job: null };
  }

  const execution = await executeJob(job, { workerId, db });
  return {
    processed: true,
    jobId: job.jobId,
    name: job.name,
    success: execution.success,
    result: execution.result,
    error: execution.error,
  };
}

/**
 * Inspect a specific job by ID with full debugging context and execution attempts.
 *
 * @param {string} jobId
 * @param {object} [options]
 * @returns {Promise<object|null>}
 */
export async function inspectJob(jobId, { db = null } = {}) {
  const database = await resolveDb(db);
  return database.collection(BACKGROUND_JOBS_COLLECTION).findOne({ jobId });
}

/**
 * List jobs with optional filtering by status, name, and pagination.
 *
 * @param {object} filterOptions
 * @returns {Promise<{ jobs: object[], total: number }>}
 */
export async function listJobs({
  status = null,
  name = null,
  limit = 20,
  skip = 0,
  db = null,
} = {}) {
  const database = await resolveDb(db);
  const collection = database.collection(BACKGROUND_JOBS_COLLECTION);

  const query = {};
  if (status) query.status = status;
  if (name) query.name = name;

  const [jobs, total] = await Promise.all([
    collection
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    collection.countDocuments(query),
  ]);

  return { jobs, total };
}

/**
 * Manually retry a failed or dead-lettered job.
 * Resets status to pending, clears lock, and resets or adjusts attempt counter.
 *
 * @param {string} jobId
 * @param {object} options
 * @param {boolean} [options.resetAttempts=true] - If true, resets attemptCount to 0
 * @returns {Promise<object|null>}
 */
export async function retryJob(jobId, { resetAttempts = true, db = null } = {}) {
  const database = await resolveDb(db);
  const collection = database.collection(BACKGROUND_JOBS_COLLECTION);
  const now = new Date();

  const update = {
    $set: {
      status: 'pending',
      scheduledFor: now,
      lockedUntil: null,
      lockedBy: null,
      updatedAt: now,
    },
  };

  if (resetAttempts) {
    update.$set.attemptCount = 0;
  }

  const result = await collection.findOneAndUpdate(
    { jobId, status: { $in: ['failed', 'dead_letter'] } },
    update,
    { returnDocument: 'after' }
  );

  return result?.value || result;
}

/**
 * Batch reprocess dead-letter jobs.
 *
 * @param {object} options
 * @returns {Promise<{ retriedCount: number }>}
 */
export async function reprocessDeadLetters({ jobNames = null, limit = 50, db = null } = {}) {
  const database = await resolveDb(db);
  const collection = database.collection(BACKGROUND_JOBS_COLLECTION);
  const now = new Date();

  const query = { status: 'dead_letter' };
  if (Array.isArray(jobNames) && jobNames.length > 0) {
    query.name = { $in: jobNames };
  }

  const deadLetters = await collection
    .find(query)
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();

  let retriedCount = 0;
  for (const job of deadLetters) {
    await collection.updateOne(
      { jobId: job.jobId },
      {
        $set: {
          status: 'pending',
          scheduledFor: now,
          lockedUntil: null,
          lockedBy: null,
          attemptCount: 0,
          updatedAt: now,
        },
      }
    );
    retriedCount++;
  }

  return { retriedCount };
}

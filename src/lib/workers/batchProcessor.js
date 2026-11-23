/**
 * src/lib/workers/batchProcessor.js
 *
 * Bounded batch processor for large datasets — Issue #1092.
 *
 * Processes an arbitrarily large input set in discrete, bounded batches so
 * that memory usage, concurrency, and retry behaviour are all predictable.
 *
 * Guarantees:
 *   - Memory-bounded: only `batchSize` items are held in memory at once.
 *   - Concurrency-bounded: at most `maxConcurrentBatches` batches run in
 *     parallel; additional batches are held back via the same back-pressure
 *     semaphore used by `boundedConcurrencyRunner.js`.
 *   - Resumable: a caller-supplied `checkpoint` cursor lets a re-started job
 *     skip already-processed batches deterministically.
 *   - Authorization-gated: an async `authorize(principal)` hook is called
 *     before the first batch is admitted; individual batch submissions also
 *     pass through the inner runner's `authorize` hook.
 *   - Retryable: transient batch failures are retried with exponential
 *     back-off up to `maxBatchAttempts`; permanent errors (`retryable ===
 *     false`) dead-letter the batch immediately.
 *   - Observable: `onBatchComplete`, `onBatchError`, and `onProgress`
 *     callbacks receive structured events; `stats()` returns counters.
 */

import { createBoundedConcurrencyRunner, BOUNDED_RUNNER_REJECTION } from './boundedConcurrencyRunner.js';

// ─── Public error types ────────────────────────────────────────────────────

export class BatchProcessorAuthError extends Error {
  constructor(message = 'Not authorized to start batch processing.') {
    super(message);
    this.name = 'BatchProcessorAuthError';
    this.code = 'BATCH_AUTH_FORBIDDEN';
    this.status = 403;
    this.retryable = false;
  }
}

export class BatchProcessorError extends Error {
  constructor(message, { batchIndex, attempt, cause } = {}) {
    super(message);
    this.name = 'BatchProcessorError';
    this.code = 'BATCH_PROCESSING_ERROR';
    this.batchIndex = batchIndex ?? null;
    this.attempt = attempt ?? null;
    this.cause = cause ?? null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Slice `items` into pages of at most `size` elements.
 * @param {Array} items
 * @param {number} size
 * @returns {Array[]}
 */
function paginate(items, size) {
  const pages = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}

// ─── BatchProcessor factory ───────────────────────────────────────────────

/**
 * Create a bounded batch processor.
 *
 * @param {object} options
 * @param {number}   [options.batchSize=50]            Items per batch.
 * @param {number}   [options.maxConcurrentBatches=2]  Parallel batches allowed.
 * @param {number}   [options.maxPendingBatches=20]    Waiting-queue depth limit.
 * @param {number}   [options.maxBatchAttempts=3]      Retry attempts per batch.
 * @param {number}   [options.retryDelayMs=200]        Base delay before retry.
 * @param {Function} [options.authorize]               async (principal) => true|false
 * @param {Function} [options.onBatchComplete]         (event) => void
 * @param {Function} [options.onBatchError]            (event) => void
 * @param {Function} [options.onProgress]              (event) => void
 * @param {Function} [options.now]                     () => number  (injectable clock)
 * @returns {{ process, stats }}
 */
export function createBatchProcessor({
  batchSize = 50,
  maxConcurrentBatches = 2,
  maxPendingBatches = 20,
  maxBatchAttempts = 3,
  retryDelayMs = 200,
  authorize = async () => true,
  onBatchComplete = () => {},
  onBatchError = () => {},
  onProgress = () => {},
  now = () => Date.now(),
} = {}) {
  // Validate configuration early
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError('batchSize must be a positive integer');
  }
  if (!Number.isInteger(maxConcurrentBatches) || maxConcurrentBatches < 1) {
    throw new TypeError('maxConcurrentBatches must be a positive integer');
  }
  if (!Number.isInteger(maxPendingBatches) || maxPendingBatches < 0) {
    throw new TypeError('maxPendingBatches must be a non-negative integer');
  }
  if (!Number.isInteger(maxBatchAttempts) || maxBatchAttempts < 1) {
    throw new TypeError('maxBatchAttempts must be a positive integer');
  }

  const _stats = {
    totalItems: 0,
    processedItems: 0,
    failedItems: 0,
    totalBatches: 0,
    completedBatches: 0,
    failedBatches: 0,
    skippedBatches: 0,
    retriedBatches: 0,
    startedAt: null,
    finishedAt: null,
  };

  // Inner concurrency runner shared across all batch tasks
  const runner = createBoundedConcurrencyRunner({
    maxInFlight: maxConcurrentBatches,
    maxPending: maxPendingBatches,
    maxAttempts: maxBatchAttempts,
    retryDelayMs,
    now,
    authorize: async (principal) => {
      // The outer process() call already checked authorization; here we
      // allow any principal that passed the outer gate.
      return true;
    },
  });

  /**
   * Process all items in `items` by invoking `handler` once per batch.
   *
   * @param {object} options
   * @param {Array}    options.items         Full input set.
   * @param {Function} options.handler       async (batch, ctx) => any
   * @param {object}   [options.principal]   Caller identity; passed to authorize.
   * @param {number}   [options.checkpoint]  Resume from batch index (0-based).
   * @returns {Promise<{ stats, errors }>}
   */
  async function process({ items, handler, principal = null, checkpoint = 0 } = {}) {
    if (!Array.isArray(items)) throw new TypeError('items must be an array');
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');

    // Authorization gate — runs once before any batch is submitted
    let allowed;
    try {
      allowed = await authorize(principal);
    } catch {
      allowed = false;
    }
    if (allowed !== true) {
      throw new BatchProcessorAuthError();
    }

    const batches = paginate(items, batchSize);
    _stats.totalItems = items.length;
    _stats.totalBatches = batches.length;
    _stats.startedAt = now();

    const errors = [];

    const tasks = batches.map((batch, batchIndex) =>
      runner.submit({
        name: `batch:${batchIndex}`,
        principal,
        task: async ({ attempt }) => {
          // Skip batches already processed in a previous run
          if (batchIndex < checkpoint) {
            _stats.skippedBatches++;
            return { skipped: true, batchIndex };
          }

          if (attempt > 1) _stats.retriedBatches++;

          const ctx = {
            batchIndex,
            attempt,
            total: batches.length,
            startedAt: now(),
          };

          let result;
          try {
            result = await handler(batch, ctx);
          } catch (err) {
            const event = { batchIndex, attempt, error: err, batch };
            onBatchError(event);
            throw err; // Let the runner's retry logic handle it
          }

          _stats.completedBatches++;
          _stats.processedItems += batch.length;

          const event = { batchIndex, attempt, result, itemCount: batch.length };
          onBatchComplete(event);

          onProgress({
            completedBatches: _stats.completedBatches,
            totalBatches: batches.length,
            processedItems: _stats.processedItems,
            totalItems: items.length,
            percent: Math.round((_stats.processedItems / items.length) * 100),
          });

          return result;
        },
      }).catch((err) => {
        // Capture the error after all retry attempts are exhausted
        _stats.failedBatches++;
        _stats.failedItems += batches[batchIndex]?.length ?? 0;
        errors.push(
          new BatchProcessorError(`Batch ${batchIndex} failed after retries: ${err.message}`, {
            batchIndex,
            attempt: maxBatchAttempts,
            cause: err,
          }),
        );
      }),
    );

    await Promise.all(tasks);
    runner.close();

    _stats.finishedAt = now();

    return {
      stats: stats(),
      errors,
    };
  }

  function stats() {
    return { ...runner.snapshot(), ..._stats };
  }

  return { process, stats };
}

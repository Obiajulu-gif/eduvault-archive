/**
 * tests/backend/batch-processor.test.mjs
 *
 * Automated tests for the bounded batch processor (issue #1092).
 * Covers normal, failure, retry, authorization, checkpoint, and
 * backpressure edge cases.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBatchProcessor,
  BatchProcessorAuthError,
  BatchProcessorError,
} from '../../src/lib/workers/batchProcessor.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeItems(n) {
  return Array.from({ length: n }, (_, i) => i);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('bounded batch processor (#1092)', () => {
  // ── Normal path ──────────────────────────────────────────────────────

  it('processes all items across multiple batches', async () => {
    const processor = createBatchProcessor({ batchSize: 10 });
    const processed = [];

    const { stats, errors } = await processor.process({
      items: makeItems(25),
      handler: async (batch) => {
        processed.push(...batch);
      },
    });

    assert.equal(errors.length, 0);
    assert.deepEqual(processed.sort((a, b) => a - b), makeItems(25));
    assert.equal(stats.totalItems, 25);
    assert.equal(stats.processedItems, 25);
    assert.equal(stats.completedBatches, 3);
    assert.equal(stats.failedBatches, 0);
  });

  it('calls onProgress after each batch completes', async () => {
    const progress = [];
    const processor = createBatchProcessor({
      batchSize: 5,
      onProgress: (event) => progress.push(event),
    });

    await processor.process({
      items: makeItems(15),
      handler: async () => {},
    });

    assert.equal(progress.length, 3);
    assert.equal(progress[2].percent, 100);
    assert.equal(progress[2].processedItems, 15);
  });

  it('calls onBatchComplete with result and itemCount', async () => {
    const completions = [];
    const processor = createBatchProcessor({
      batchSize: 10,
      onBatchComplete: (event) => completions.push(event),
    });

    await processor.process({
      items: makeItems(10),
      handler: async (batch) => ({ sum: batch.reduce((a, b) => a + b, 0) }),
    });

    assert.equal(completions.length, 1);
    assert.equal(completions[0].result.sum, 45);
    assert.equal(completions[0].itemCount, 10);
  });

  it('handles an empty input set without error', async () => {
    const processor = createBatchProcessor({ batchSize: 10 });
    const { stats, errors } = await processor.process({
      items: [],
      handler: async () => {},
    });

    assert.equal(errors.length, 0);
    assert.equal(stats.totalItems, 0);
    assert.equal(stats.completedBatches, 0);
  });

  // ── Failure and retry paths ───────────────────────────────────────────

  it('retries a failing batch up to maxBatchAttempts, then collects error', async () => {
    const attempts = [];
    const processor = createBatchProcessor({
      batchSize: 5,
      maxBatchAttempts: 3,
      retryDelayMs: 1,
    });

    const { errors, stats } = await processor.process({
      items: makeItems(5),
      handler: async (batch, { attempt }) => {
        attempts.push(attempt);
        throw new Error('transient failure');
      },
    });

    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof BatchProcessorError);
    assert.ok(errors[0].message.includes('failed after retries'));
    assert.equal(stats.failedBatches, 1);
    // Runner retried 2 extra times beyond the first attempt
    assert.equal(attempts.length, 3);
  });

  it('does not retry a batch error marked retryable=false', async () => {
    let calls = 0;
    const processor = createBatchProcessor({
      batchSize: 5,
      maxBatchAttempts: 3,
      retryDelayMs: 1,
    });

    const { errors } = await processor.process({
      items: makeItems(5),
      handler: async () => {
        calls++;
        const err = new Error('permanent');
        err.retryable = false;
        throw err;
      },
    });

    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
  });

  it('calls onBatchError with event when a batch fails', async () => {
    const errorEvents = [];
    const processor = createBatchProcessor({
      batchSize: 5,
      maxBatchAttempts: 1,
      retryDelayMs: 1,
      onBatchError: (e) => errorEvents.push(e),
    });

    await processor.process({
      items: makeItems(5),
      handler: async () => { throw new Error('oops'); },
    });

    assert.ok(errorEvents.length >= 1);
    assert.ok(errorEvents[0].error.message === 'oops');
  });

  it('succeeds on a retry after a transient batch failure', async () => {
    const processor = createBatchProcessor({
      batchSize: 5,
      maxBatchAttempts: 3,
      retryDelayMs: 1,
    });
    let callCount = 0;

    const { errors, stats } = await processor.process({
      items: makeItems(5),
      handler: async (batch, { attempt }) => {
        callCount++;
        if (attempt < 2) throw new Error('flaky');
        return 'ok';
      },
    });

    assert.equal(errors.length, 0);
    assert.equal(stats.completedBatches, 1);
    assert.equal(stats.failedBatches, 0);
  });

  // ── Authorization path ───────────────────────────────────────────────

  it('throws BatchProcessorAuthError when authorize returns false', async () => {
    const processor = createBatchProcessor({
      batchSize: 5,
      authorize: async () => false,
    });

    await assert.rejects(
      () => processor.process({ items: makeItems(5), handler: async () => {} }),
      (err) => err instanceof BatchProcessorAuthError && err.status === 403,
    );
  });

  it('throws BatchProcessorAuthError when authorize throws', async () => {
    const processor = createBatchProcessor({
      batchSize: 5,
      authorize: async () => { throw new Error('auth service down'); },
    });

    await assert.rejects(
      () => processor.process({ items: makeItems(5), handler: async () => {} }),
      (err) => err instanceof BatchProcessorAuthError,
    );
  });

  it('runs normally when authorize returns true', async () => {
    let ran = false;
    const processor = createBatchProcessor({
      batchSize: 5,
      authorize: async (principal) => principal?.role === 'admin',
    });

    const { errors } = await processor.process({
      items: makeItems(5),
      principal: { id: 'u1', role: 'admin' },
      handler: async () => { ran = true; },
    });

    assert.equal(errors.length, 0);
    assert.ok(ran);
  });

  // ── Checkpoint / resume path ─────────────────────────────────────────

  it('skips batches before the checkpoint index', async () => {
    const processed = [];
    const processor = createBatchProcessor({ batchSize: 5 });

    await processor.process({
      items: makeItems(15),   // 3 batches: [0-4], [5-9], [10-14]
      checkpoint: 2,          // Resume from batch index 2 onwards
      handler: async (batch) => { processed.push(...batch); },
    });

    // Only batch 2 ([10-14]) should be processed
    assert.deepEqual(processed.sort((a, b) => a - b), [10, 11, 12, 13, 14]);
  });

  it('reports skipped batches in stats', async () => {
    const processor = createBatchProcessor({ batchSize: 5 });

    const { stats } = await processor.process({
      items: makeItems(15),
      checkpoint: 1,
      handler: async () => {},
    });

    assert.equal(stats.skippedBatches, 1);
    assert.equal(stats.completedBatches, 2);
  });

  // ── Concurrency / back-pressure ──────────────────────────────────────

  it('never exceeds maxConcurrentBatches in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const processor = createBatchProcessor({
      batchSize: 1,
      maxConcurrentBatches: 2,
      maxPendingBatches: 20,
    });

    await processor.process({
      items: makeItems(6),
      handler: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    });

    assert.ok(peak <= 2, `expected peak ≤ 2 but got ${peak}`);
  });

  // ── Configuration validation ─────────────────────────────────────────

  it('throws TypeError for invalid batchSize', () => {
    assert.throws(() => createBatchProcessor({ batchSize: 0 }), TypeError);
    assert.throws(() => createBatchProcessor({ batchSize: -1 }), TypeError);
  });

  it('throws TypeError for invalid maxConcurrentBatches', () => {
    assert.throws(() => createBatchProcessor({ maxConcurrentBatches: 0 }), TypeError);
  });

  it('throws TypeError when items is not an array', async () => {
    const processor = createBatchProcessor();
    await assert.rejects(
      () => processor.process({ items: 'not-an-array', handler: async () => {} }),
      TypeError,
    );
  });

  it('throws TypeError when handler is not a function', async () => {
    const processor = createBatchProcessor();
    await assert.rejects(
      () => processor.process({ items: makeItems(5), handler: 'not-a-function' }),
      TypeError,
    );
  });

  // ── Edge case: single batch ───────────────────────────────────────────

  it('processes a single item correctly', async () => {
    const processor = createBatchProcessor({ batchSize: 50 });
    let handled = null;

    await processor.process({
      items: [42],
      handler: async (batch) => { handled = batch; },
    });

    assert.deepEqual(handled, [42]);
  });

  // ── Stats completeness ───────────────────────────────────────────────

  it('records startedAt and finishedAt timestamps', async () => {
    let tick = 0;
    const processor = createBatchProcessor({
      batchSize: 10,
      now: () => ++tick,
    });

    const { stats } = await processor.process({
      items: makeItems(10),
      handler: async () => {},
    });

    assert.ok(stats.startedAt != null, 'startedAt should be set');
    assert.ok(stats.finishedAt != null, 'finishedAt should be set');
  });
});

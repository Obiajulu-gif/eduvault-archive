// Tests for bounded worker concurrency with backpressure (#1118).
// Covers normal, failure, retry, and authorization paths.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBoundedConcurrencyRunner,
  BOUNDED_RUNNER_REJECTION,
} from '../../src/lib/workers/boundedConcurrencyRunner.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('bounded worker concurrency runner (#1118)', () => {
  it('runs jobs and resolves with their results', async () => {
    const runner = createBoundedConcurrencyRunner({ maxInFlight: 2, maxPending: 5 });
    const result = await runner.submit({ task: async () => 'done', principal: { id: 'u1' } });
    assert.equal(result, 'done');
    assert.equal(runner.snapshot().completed, 1);
  });

  it('never exceeds maxInFlight', async () => {
    const runner = createBoundedConcurrencyRunner({ maxInFlight: 2, maxPending: 10 });
    let running = 0;
    let peak = 0;
    const gates = [];
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      const gate = deferred();
      gates.push(gate);
      jobs.push(
        runner.submit({
          task: async () => {
            running++;
            peak = Math.max(peak, running);
            await gate.promise;
            running--;
            return i;
          },
        }),
      );
    }
    await tick();
    await tick();
    assert.equal(runner.snapshot().inFlight, 2);
    assert.equal(runner.snapshot().pending, 3);
    gates.forEach((gate) => gate.resolve());
    const results = await Promise.all(jobs);
    assert.deepEqual(results, [0, 1, 2, 3, 4]);
    assert.equal(peak, 2);
  });

  it('applies backpressure when the pending queue is full', async () => {
    const runner = createBoundedConcurrencyRunner({ maxInFlight: 1, maxPending: 1 });
    const gate = deferred();
    const first = runner.submit({ task: () => gate.promise });
    const second = runner.submit({ task: async () => 'queued' });
    await assert.rejects(
      runner.submit({ task: async () => 'overflow' }),
      (error) =>
        error.reason === BOUNDED_RUNNER_REJECTION.QUEUE_FULL &&
        error.status === 429 &&
        error.retryable === true,
    );
    gate.resolve('first');
    assert.equal(await first, 'first');
    assert.equal(await second, 'queued');
    assert.equal(runner.snapshot().rejected, 1);
  });

  it('retries a failing job up to maxAttempts and then fails it', async () => {
    const runner = createBoundedConcurrencyRunner({ maxInFlight: 1, maxAttempts: 3, retryDelayMs: 1 });
    const attempts = [];
    await assert.rejects(
      runner.submit({
        task: async ({ attempt }) => {
          attempts.push(attempt);
          throw new Error('transient');
        },
      }),
      /transient/,
    );
    assert.deepEqual(attempts, [1, 2, 3]);
    const snap = runner.snapshot();
    assert.equal(snap.retried, 2);
    assert.equal(snap.failed, 1);
  });

  it('succeeds on a retry after a transient failure', async () => {
    const runner = createBoundedConcurrencyRunner({ maxInFlight: 1, maxAttempts: 3, retryDelayMs: 1 });
    const result = await runner.submit({
      task: async ({ attempt }) => {
        if (attempt < 2) throw new Error('flaky');
        return `ok-on-${attempt}`;
      },
    });
    assert.equal(result, 'ok-on-2');
    assert.equal(runner.snapshot().retried, 1);
    assert.equal(runner.snapshot().failed, 0);
  });

  it('does not retry errors marked non-retryable', async () => {
    const runner = createBoundedConcurrencyRunner({ maxInFlight: 1, maxAttempts: 3, retryDelayMs: 1 });
    let calls = 0;
    await assert.rejects(
      runner.submit({
        task: async () => {
          calls++;
          const error = new Error('bad input');
          error.retryable = false;
          throw error;
        },
      }),
      /bad input/,
    );
    assert.equal(calls, 1);
  });

  it('rejects unauthorized principals before the task runs', async () => {
    const runner = createBoundedConcurrencyRunner({
      maxInFlight: 1,
      authorize: async (principal) => principal?.role === 'admin',
    });
    let ran = false;
    await assert.rejects(
      runner.submit({
        name: 'storage:repair-pins',
        principal: { id: 'viewer', role: 'viewer' },
        task: async () => {
          ran = true;
        },
      }),
      (error) => error.reason === BOUNDED_RUNNER_REJECTION.UNAUTHORIZED && error.status === 403,
    );
    assert.equal(ran, false);
    assert.equal(runner.snapshot().rejected, 1);
  });

  it('treats an authorization hook that throws as unauthorized', async () => {
    const runner = createBoundedConcurrencyRunner({
      authorize: async () => {
        throw new Error('lookup failed');
      },
    });
    await assert.rejects(
      runner.submit({ task: async () => 'never' }),
      (error) => error.reason === BOUNDED_RUNNER_REJECTION.UNAUTHORIZED,
    );
  });

  it('rejects new submissions after close while letting queued work finish', async () => {
    const runner = createBoundedConcurrencyRunner({ maxInFlight: 1, maxPending: 5 });
    const gate = deferred();
    const running = runner.submit({ task: () => gate.promise });
    runner.close();
    await assert.rejects(
      runner.submit({ task: async () => 'late' }),
      (error) => error.reason === BOUNDED_RUNNER_REJECTION.CLOSED,
    );
    gate.resolve('finished');
    assert.equal(await running, 'finished');
  });

  it('validates configuration and task type', () => {
    assert.throws(() => createBoundedConcurrencyRunner({ maxInFlight: 0 }), TypeError);
    assert.throws(() => createBoundedConcurrencyRunner({ maxPending: -1 }), TypeError);
    const runner = createBoundedConcurrencyRunner();
    assert.throws(() => runner.submit({ task: 'not-a-function' }), TypeError);
  });
});

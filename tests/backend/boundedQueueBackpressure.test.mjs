import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundedQueueBackpressure,
  BACKPRESSURE_PRIORITY,
  BACKPRESSURE_STATE,
  QueueBackpressureError,
} from '../../src/lib/queue/boundedBackpressure.js';

describe('Bounded Queue Backpressure (#984)', () => {
  let queue;

  beforeEach(() => {
    queue = new BoundedQueueBackpressure({
      maxCapacity: 10,
      highWaterRatio: 0.7, // high water at 7
      lowWaterRatio: 0.4,  // low water at 4
      perJobTypeLimits: {
        'expensive:indexing': 3,
      },
      defaultRetryAfterSeconds: 15,
    });
  });

  describe('Capacity Admission and Thresholds', () => {
    it('admits jobs when queue depth is within normal capacity', () => {
      const admission = queue.checkAdmission({
        name: 'standard:work',
        priority: BACKPRESSURE_PRIORITY.NORMAL,
      });

      assert.equal(admission.admitted, true);
      assert.equal(admission.state, BACKPRESSURE_STATE.NORMAL);
      queue.trackAdmission('standard:work');
      assert.equal(queue.getMetrics().totalActiveDepth, 1);
    });

    it('rejects unauthenticated and unauthorized callers before evaluating queue', () => {
      assert.throws(
        () => {
          queue.checkAdmission({
            name: 'standard:work',
            authContext: { isAuthenticated: false },
          });
        },
        (err) => {
          assert.equal(err.status, 401);
          assert.equal(err.code, 'UNAUTHENTICATED');
          return true;
        }
      );

      assert.throws(
        () => {
          queue.checkAdmission({
            name: 'standard:work',
            authContext: { isAuthenticated: true, permissions: ['read'] },
            requiredPermissions: 'jobs:enqueue',
          });
        },
        (err) => {
          assert.equal(err.status, 403);
          assert.equal(err.code, 'FORBIDDEN');
          return true;
        }
      );
    });

    it('sheds LOW-priority jobs when high water mark is reached', () => {
      // Fill to high water mark (7)
      for (let i = 0; i < 7; i++) {
        queue.trackAdmission('general:job');
      }

      assert.equal(queue.evaluateState(), BACKPRESSURE_STATE.SHEDDING_LOW_PRIORITY);

      // NORMAL priority is still admitted
      const normalAdmission = queue.checkAdmission({
        name: 'general:job',
        priority: BACKPRESSURE_PRIORITY.NORMAL,
      });
      assert.equal(normalAdmission.admitted, true);

      // LOW priority is rejected with 429
      assert.throws(
        () => {
          queue.checkAdmission({
            name: 'general:job',
            priority: BACKPRESSURE_PRIORITY.LOW,
          });
        },
        (err) => {
          assert.ok(err instanceof QueueBackpressureError);
          assert.equal(err.status, 429);
          assert.equal(err.retryAfterSeconds, 15);
          return true;
        }
      );
    });

    it('strictly throttles non-high jobs when queue is SATURATED', () => {
      // Fill to maxCapacity (10)
      for (let i = 0; i < 10; i++) {
        queue.trackAdmission('general:job');
      }

      assert.equal(queue.evaluateState(), BACKPRESSURE_STATE.SATURATED);

      assert.throws(
        () => {
          queue.checkAdmission({
            name: 'general:job',
            priority: BACKPRESSURE_PRIORITY.NORMAL,
          });
        },
        (err) => {
          assert.ok(err instanceof QueueBackpressureError);
          assert.equal(err.status, 429);
          assert.equal(err.code, 'QUEUE_BACKPRESSURE_SATURATED');
          assert.equal(err.currentDepth, 10);
          assert.equal(err.maxCapacity, 10);
          return true;
        }
      );
    });

    it('enforces per-job-type limit even when global queue has space', () => {
      // Fill expensive:indexing up to its quota (3)
      for (let i = 0; i < 3; i++) {
        queue.trackAdmission('expensive:indexing');
      }

      assert.throws(
        () => {
          queue.checkAdmission({
            name: 'expensive:indexing',
            priority: BACKPRESSURE_PRIORITY.NORMAL,
          });
        },
        (err) => {
          assert.ok(err instanceof QueueBackpressureError);
          assert.equal(err.jobType, 'expensive:indexing');
          return true;
        }
      );

      // Other jobs are still admitted
      const otherAdmission = queue.checkAdmission({
        name: 'other:job',
        priority: BACKPRESSURE_PRIORITY.NORMAL,
      });
      assert.equal(otherAdmission.admitted, true);
    });
  });

  describe('Recovery and Hysteresis', () => {
    it('recovers from SHEDDING to NORMAL once depth falls below low water mark', () => {
      // Push into shedding
      for (let i = 0; i < 8; i++) {
        queue.trackAdmission('general:job');
      }
      assert.equal(queue.evaluateState(), BACKPRESSURE_STATE.SHEDDING_LOW_PRIORITY);

      // Drain down to 5 (between low 4 and high 7) -> hysteresis retains shedding
      for (let i = 0; i < 3; i++) {
        queue.trackCompletion('general:job');
      }
      assert.equal(queue.totalActiveDepth, 5);
      assert.equal(queue.evaluateState(), BACKPRESSURE_STATE.SHEDDING_LOW_PRIORITY);

      // Drain below low water mark (down to 4)
      queue.trackCompletion('general:job');
      assert.equal(queue.totalActiveDepth, 4);
      assert.equal(queue.evaluateState(), BACKPRESSURE_STATE.NORMAL);

      // LOW priority job is accepted again
      const lowAdmission = queue.checkAdmission({
        name: 'general:job',
        priority: BACKPRESSURE_PRIORITY.LOW,
      });
      assert.equal(lowAdmission.admitted, true);
    });
  });
});

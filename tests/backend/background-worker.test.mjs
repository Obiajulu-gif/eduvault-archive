// Tests for Background Worker Framework (#789)
// Verifies job payload format, retry policy, backoff, dead-letter behavior,
// error context preservation, and idempotent reprocessing.

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  enqueueJob,
  leaseNextJob,
  completeJob,
  failJob,
  executeJob,
  processNextJob,
  inspectJob,
  listJobs,
  retryJob,
  reprocessDeadLetters,
  computeBackoffTime,
  registerJobHandler,
  clearJobHandlers,
  BACKGROUND_JOBS_COLLECTION,
  DEFAULT_RETRY_CONFIG,
} from '../../src/lib/workers/backgroundWorker.js';

// ── In-Memory MongoDB Collection Mock ────────────────────────────────────────

function createBackgroundJobsCollection(initialDocs = []) {
  const docs = initialDocs.map((d) => ({ ...d }));

  return {
    get docs() {
      return docs;
    },

    async insertOne(doc) {
      if (doc.jobId && docs.some((d) => d.jobId === doc.jobId)) {
        const error = new Error('Duplicate key: jobId');
        error.code = 11000;
        throw error;
      }
      if (doc.idempotencyKey && docs.some((d) => d.idempotencyKey === doc.idempotencyKey)) {
        const error = new Error('Duplicate key: idempotencyKey');
        error.code = 11000;
        throw error;
      }
      docs.push({ ...doc });
    },

    async findOne(query) {
      return docs.find((d) => matchQuery(d, query)) || null;
    },

    async findOneAndUpdate(filter, update, options = {}) {
      let matching = docs.filter((d) => matchQuery(d, filter));

      if (options.sort) {
        matching.sort((a, b) => {
          for (const [key, dir] of Object.entries(options.sort)) {
            const valA = a[key] instanceof Date ? a[key].getTime() : a[key];
            const valB = b[key] instanceof Date ? b[key].getTime() : b[key];
            if (valA < valB) return dir === 1 ? -1 : 1;
            if (valA > valB) return dir === 1 ? 1 : -1;
          }
          return 0;
        });
      }

      const target = matching[0];
      if (!target) return null;

      if (update.$set) {
        Object.assign(target, update.$set);
      }
      if (update.$inc) {
        for (const [key, amount] of Object.entries(update.$inc)) {
          target[key] = (target[key] || 0) + amount;
        }
      }
      if (update.$push) {
        for (const [key, val] of Object.entries(update.$push)) {
          if (!Array.isArray(target[key])) target[key] = [];
          target[key].push(val);
        }
      }

      return target;
    },

    async updateOne(filter, update) {
      const target = docs.find((d) => matchQuery(d, filter));
      if (!target) return { matchedCount: 0, modifiedCount: 0 };

      if (update.$set) Object.assign(target, update.$set);
      if (update.$inc) {
        for (const [key, amount] of Object.entries(update.$inc)) {
          target[key] = (target[key] || 0) + amount;
        }
      }
      if (update.$push) {
        for (const [key, val] of Object.entries(update.$push)) {
          if (!Array.isArray(target[key])) target[key] = [];
          target[key].push(val);
        }
      }

      return { matchedCount: 1, modifiedCount: 1 };
    },

    find(query) {
      let filtered = docs.filter((d) => matchQuery(d, query));

      const cursor = {
        sort(sortSpec) {
          filtered.sort((a, b) => {
            for (const [key, dir] of Object.entries(sortSpec)) {
              const valA = a[key] instanceof Date ? a[key].getTime() : a[key];
              const valB = b[key] instanceof Date ? b[key].getTime() : b[key];
              if (valA < valB) return dir === 1 ? -1 : 1;
              if (valA > valB) return dir === 1 ? 1 : -1;
            }
            return 0;
          });
          return cursor;
        },
        skip(n) {
          filtered = filtered.slice(n);
          return cursor;
        },
        limit(n) {
          filtered = filtered.slice(0, n);
          return cursor;
        },
        async toArray() {
          return filtered;
        },
      };

      return cursor;
    },

    async countDocuments(query) {
      return docs.filter((d) => matchQuery(d, query)).length;
    },
  };
}

function matchQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;

  for (const [key, val] of Object.entries(query)) {
    if (key === '$or') {
      const orMatched = val.some((subQuery) => matchQuery(doc, subQuery));
      if (!orMatched) return false;
      continue;
    }

    if (val && typeof val === 'object' && !(val instanceof Date)) {
      if (val.$lte !== undefined) {
        const docVal = doc[key] instanceof Date ? doc[key].getTime() : doc[key];
        const cmpVal = val.$lte instanceof Date ? val.$lte.getTime() : val.$lte;
        if (docVal > cmpVal) return false;
      }
      if (val.$in !== undefined) {
        if (!val.$in.includes(doc[key])) return false;
      }
      continue;
    }

    if (val === null) {
      if (doc[key] !== null && doc[key] !== undefined) return false;
      continue;
    }

    if (doc[key] !== val) return false;
  }

  return true;
}

function createMockDb(initialDocs = []) {
  const collection = createBackgroundJobsCollection(initialDocs);
  return {
    collection: (name) => {
      if (name === BACKGROUND_JOBS_COLLECTION) return collection;
      throw new Error(`Collection not mocked: ${name}`);
    },
    _collection: collection,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Background Worker Framework (Issue #789)', () => {
  let db;

  beforeEach(() => {
    clearJobHandlers();
    db = createMockDb();
  });

  describe('Job Enqueueing & Payload Format', () => {
    it('enqueues a job with correct default payload schema and metadata', async () => {
      const job = await enqueueJob({
        name: 'test:sync-task',
        payload: { item: 123, action: 'refresh' },
        db,
      });

      assert.ok(job.jobId);
      assert.equal(job.name, 'test:sync-task');
      assert.deepEqual(job.payload, { item: 123, action: 'refresh' });
      assert.equal(job.status, 'pending');
      assert.equal(job.attemptCount, 0);
      assert.equal(job.maxAttempts, 3);
      assert.ok(job.createdAt instanceof Date);
      assert.ok(job.scheduledFor instanceof Date);
      assert.equal(job.lockedUntil, null);
      assert.equal(job.lockedBy, null);
      assert.deepEqual(job.attempts, []);
    });

    it('supports delayed job scheduling with future scheduledFor', async () => {
      const runIn10Mins = new Date(Date.now() + 600_000);
      const job = await enqueueJob({
        name: 'test:delayed-task',
        payload: { notify: true },
        scheduledFor: runIn10Mins,
        db,
      });

      assert.equal(job.scheduledFor.getTime(), runIn10Mins.getTime());

      // Attempting to lease immediately should return null because scheduledFor > now
      const leased = await leaseNextJob({ workerId: 'worker-1', db });
      assert.equal(leased, null);
    });

    it('enforces idempotency when idempotencyKey is supplied', async () => {
      const first = await enqueueJob({
        name: 'test:idempotent',
        payload: { run: 1 },
        idempotencyKey: 'key-abc-123',
        db,
      });

      const second = await enqueueJob({
        name: 'test:idempotent',
        payload: { run: 2 },
        idempotencyKey: 'key-abc-123',
        db,
      });

      assert.equal(first.jobId, second.jobId);
      assert.equal(db._collection.docs.length, 1);
    });
  });

  describe('Lease Locking & Mutual Exclusion', () => {
    it('leases pending jobs atomically and sets worker lock', async () => {
      await enqueueJob({
        name: 'test:work',
        payload: { a: 1 },
        db,
      });

      const leased = await leaseNextJob({
        workerId: 'worker-alpha',
        leaseTtlMs: 30_000,
        db,
      });

      assert.ok(leased);
      assert.equal(leased.status, 'running');
      assert.equal(leased.lockedBy, 'worker-alpha');
      assert.equal(leased.attemptCount, 1);
      assert.ok(leased.lockedUntil > new Date());

      // Another worker cannot lease the same job while lock is active
      const secondAttempt = await leaseNextJob({
        workerId: 'worker-beta',
        db,
      });
      assert.equal(secondAttempt, null);
    });
  });

  describe('Execution & Completion', () => {
    it('executes registered job handler and records completion result', async () => {
      registerJobHandler('task:math', async (payload) => {
        return { sum: payload.x + payload.y };
      });

      const enqueued = await enqueueJob({
        name: 'task:math',
        payload: { x: 10, y: 32 },
        db,
      });

      const outcome = await processNextJob({ workerId: 'w1', db });

      assert.equal(outcome.processed, true);
      assert.equal(outcome.success, true);
      assert.deepEqual(outcome.result, { sum: 42 });

      const inspected = await inspectJob(enqueued.jobId, { db });
      assert.equal(inspected.status, 'completed');
      assert.deepEqual(inspected.result, { sum: 42 });
      assert.equal(inspected.lockedUntil, null);
      assert.ok(inspected.completedAt instanceof Date);
    });
  });

  describe('Retry Policy, Backoff, and Dead-Letter Queue', () => {
    it('computes exponential backoff with configured multiplier', () => {
      const config = { initialMs: 1000, multiplier: 2, maxMs: 10000, jitterFraction: 0 };
      const t0 = computeBackoffTime(0, config);
      const t1 = computeBackoffTime(1, config);
      const t2 = computeBackoffTime(2, config);

      const now = Date.now();
      const diff0 = t0.getTime() - now;
      const diff1 = t1.getTime() - now;
      const diff2 = t2.getTime() - now;

      assert.ok(diff0 >= 950 && diff0 <= 1050);
      assert.ok(diff1 >= 1950 && diff1 <= 2050);
      assert.ok(diff2 >= 3950 && diff2 <= 4050);
    });

    it('reschedules failed job with backoff and preserves error context for debugging', async () => {
      registerJobHandler('task:flaky', async () => {
        const error = new Error('Transient network error');
        error.code = 'ECONNRESET';
        throw error;
      });

      const enqueued = await enqueueJob({
        name: 'task:flaky',
        payload: { target: 'upstream' },
        maxAttempts: 3,
        db,
      });

      const outcome = await processNextJob({ workerId: 'w1', db });
      assert.equal(outcome.processed, true);
      assert.equal(outcome.success, false);

      const job = await inspectJob(enqueued.jobId, { db });
      assert.equal(job.status, 'pending');
      assert.equal(job.attemptCount, 1);
      assert.ok(job.scheduledFor > new Date());
      assert.equal(job.lockedUntil, null);

      // Verify rich error context is preserved
      assert.ok(job.error);
      assert.equal(job.error.message, 'Transient network error');
      assert.equal(job.error.code, 'ECONNRESET');
      assert.ok(job.error.stack);
      assert.equal(job.error.attempt, 1);
      assert.equal(job.attempts.length, 1);
      assert.equal(job.attempts[0].status, 'failed');
    });

    it('transitions to dead_letter when retry attempts are exhausted', async () => {
      let callCount = 0;
      registerJobHandler('task:fail-always', async () => {
        callCount++;
        throw new Error(`Fatal failure attempt ${callCount}`);
      });

      const enqueued = await enqueueJob({
        name: 'task:fail-always',
        maxAttempts: 2,
        db,
      });

      // Attempt 1 -> fails -> rescheduled
      await processNextJob({ workerId: 'w1', db });
      let job = await inspectJob(enqueued.jobId, { db });
      assert.equal(job.status, 'pending');
      assert.equal(job.attemptCount, 1);

      // Reset scheduledFor to now to simulate backoff elapsing
      job.scheduledFor = new Date(Date.now() - 1000);

      // Attempt 2 -> fails -> maxAttempts (2) reached -> dead_letter
      await processNextJob({ workerId: 'w2', db });
      job = await inspectJob(enqueued.jobId, { db });

      assert.equal(job.status, 'dead_letter');
      assert.equal(job.attemptCount, 2);
      assert.equal(job.lockedUntil, null);
      assert.equal(job.error.message, 'Fatal failure attempt 2');
      assert.equal(job.attempts.length, 2);
    });
  });

  describe('Dead-Letter Inspection and Idempotent Reprocessing', () => {
    it('allows inspecting dead-letter jobs and retrying them', async () => {
      let shouldFail = true;
      registerJobHandler('task:repairable', async () => {
        if (shouldFail) {
          throw new Error('Service outage');
        }
        return { restored: true };
      });

      const enqueued = await enqueueJob({
        name: 'task:repairable',
        maxAttempts: 1,
        db,
      });

      // 1. Initial attempt fails and moves straight to dead_letter
      await processNextJob({ workerId: 'w1', db });
      let job = await inspectJob(enqueued.jobId, { db });
      assert.equal(job.status, 'dead_letter');

      // 2. Query dead letter queue via listJobs
      const deadLetterList = await listJobs({ status: 'dead_letter', db });
      assert.equal(deadLetterList.total, 1);
      assert.equal(deadLetterList.jobs[0].jobId, enqueued.jobId);

      // 3. Fix underlying condition and retry job
      shouldFail = false;
      const retried = await retryJob(enqueued.jobId, { db });
      assert.ok(retried);
      assert.equal(retried.status, 'pending');
      assert.equal(retried.attemptCount, 0);

      // 4. Reprocess job
      const outcome = await processNextJob({ workerId: 'w2', db });
      assert.equal(outcome.processed, true);
      assert.equal(outcome.success, true);

      job = await inspectJob(enqueued.jobId, { db });
      assert.equal(job.status, 'completed');
      assert.deepEqual(job.result, { restored: true });
    });

    it('batch reprocesses multiple dead-letter jobs with reprocessDeadLetters', async () => {
      db._collection.docs.push(
        { jobId: 'j1', name: 'task:dlq', status: 'dead_letter', attemptCount: 3 },
        { jobId: 'j2', name: 'task:dlq', status: 'dead_letter', attemptCount: 3 },
        { jobId: 'j3', name: 'task:other', status: 'completed', attemptCount: 1 }
      );

      const result = await reprocessDeadLetters({ db });
      assert.equal(result.retriedCount, 2);

      const j1 = await inspectJob('j1', { db });
      const j2 = await inspectJob('j2', { db });
      assert.equal(j1.status, 'pending');
      assert.equal(j1.attemptCount, 0);
      assert.equal(j2.status, 'pending');
      assert.equal(j2.attemptCount, 0);
    });
  });

  describe('Storage Maintenance Job Integration', () => {
    it('enqueues and executes storage:garbage-collection maintenance job', async () => {
      let gcExecuted = false;
      registerJobHandler('storage:garbage-collection', async (payload) => {
        gcExecuted = true;
        return { success: true, dryRun: payload.dryRun, cleaned: 5 };
      });

      const job = await enqueueJob({
        name: 'storage:garbage-collection',
        payload: { dryRun: false, limit: 50 },
        db,
      });

      assert.equal(job.name, 'storage:garbage-collection');

      const outcome = await processNextJob({ workerId: 'storage-worker-1', db });
      assert.equal(outcome.processed, true);
      assert.equal(outcome.success, true);
      assert.equal(gcExecuted, true);
      assert.deepEqual(outcome.result, { success: true, dryRun: false, cleaned: 5 });

      const finalState = await inspectJob(job.jobId, { db });
      assert.equal(finalState.status, 'completed');
      assert.deepEqual(finalState.result, { success: true, dryRun: false, cleaned: 5 });
    });
  });
});

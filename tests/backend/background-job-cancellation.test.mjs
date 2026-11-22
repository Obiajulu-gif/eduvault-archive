import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  enqueueJob,
  leaseNextJob,
  cancelJob,
  completeJob,
  registerJobHandler,
  clearJobHandlers,
  BACKGROUND_JOBS_COLLECTION,
} from '../../src/lib/workers/backgroundWorker.js';

function createMockDb() {
  const docs = [];
  const col = {
    docs,
    async insertOne(doc) { docs.push({ ...doc }); },
    async findOne(q) { return docs.find((d) => Object.entries(q || {}).every(([k,v]) => d[k] === v)) || null; },
    async findOneAndUpdate(filter, update) {
      const doc = docs.find((d) => Object.entries(filter || {}).every(([k,v]) => {
        if (v && typeof v === 'object' && v.$in) return v.$in.includes(d[k]);
        return d[k] === v;
      }));
      if (!doc) return null;
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$inc) for (const [k,v] of Object.entries(update.$inc)) doc[k] = (doc[k]||0)+v;
      if (update.$push) for (const [k,v] of Object.entries(update.$push)) { doc[k] = Array.isArray(doc[k]) ? doc[k] : []; doc[k].push(v); }
      return { value: { ...doc } };
    },
    async updateOne(filter, update) { const res = await this.findOneAndUpdate(filter, update); return { modifiedCount: res ? 1 : 0 }; },
  };
  return { collection: (n) => n === BACKGROUND_JOBS_COLLECTION ? col : null, _col: col };
}

describe('background job cancellation (#1102)', () => {
  let db;
  beforeEach(() => { clearJobHandlers(); db = createMockDb(); });

  it('cancels pending job and runs cleanup once', async () => {
    const job = await enqueueJob({ name: 'test:cancel', payload: { a: 1 }, db });
    let cleanupCalls = 0;
    const result = await cancelJob(job.jobId, { db, cleanupFn: async () => { cleanupCalls += 1; return { ok: true }; } });
    assert.equal(result.cancelled, true);
    assert.equal(result.job.status, 'cancelled');
    assert.equal(cleanupCalls, 1);
  });

  it('marks running job as cancel_requested and completeJob finalizes as cancelled', async () => {
    const job = await enqueueJob({ name: 'test:run', payload: {}, db });
    const leased = await leaseNextJob({ workerId: 'w1', db });
    assert.equal(leased.jobId, job.jobId);
    await cancelJob(job.jobId, { db, reason: 'operator' });
    const finalized = await completeJob(job.jobId, { ignored: true }, { workerId: 'w1', db });
    assert.equal(finalized.status, 'cancelled');
  });

  it('does not mutate terminal jobs and reports already_cancelled', async () => {
    const job = await enqueueJob({ name: 'test:term', payload: {}, db });
    await cancelJob(job.jobId, { db });
    const again = await cancelJob(job.jobId, { db });
    assert.equal(again.cancelled, false);
    assert.equal(again.reason, 'already_cancelled');
  });
});

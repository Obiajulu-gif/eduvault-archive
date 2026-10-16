// Deterministic chaos suite for the outbox worker (src/lib/backend/outbox.js).
//
// "Chaos" here means deliberately interrupting workflows at the exact
// moments that are hardest to get right -- a worker crashing mid-delivery,
// a lease expiring while another worker is mid-claim, a stale duplicate
// acknowledgement arriving after a retry already happened -- rather than
// fuzzing with real randomness or real timers. Every induced failure is a
// specific, named sequence of calls against a real MongoMemoryServer (see
// test/global-setup-outbox.js), so these tests are exactly as repeatable
// as any other unit test: no `setTimeout`, no wall-clock sleeps, no
// retries-until-it-passes. The only place "time" moves is a MongoDB
// `updateOne` patching a stored `leaseExpiresAt` directly, which simulates
// "time has passed" without actually waiting.
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '@/lib/mongodb';
import { resetSlidingWindows } from '@/lib/rateLimit';
import {
  enqueueSideEffect,
  leaseNextIntent,
  markDelivered,
  rescheduleIntent,
  releaseLease,
} from '@/lib/backend/outbox';

const OUTBOX_COLLECTION = 'side_effect_outbox';

/** Simulates "the lease worker-A was holding has expired" without waiting. */
async function expireLease(db, intentId) {
  await db
    .collection(OUTBOX_COLLECTION)
    .updateOne({ _id: intentId }, { $set: { leaseExpiresAt: new Date(0) } });
}

describe('outbox chaos: interrupted workflows', () => {
  let db;

  beforeEach(async () => {
    db = await getDb();
    await db.collection(OUTBOX_COLLECTION).deleteMany({});
    resetSlidingWindows();
  });

  it('a worker that crashes after leasing but before delivering never loses the intent', async () => {
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p-crash-1',
      intent: { type: 'email', channel: 'welcome', payload: {} },
    });

    // worker-A leases it, then "crashes" -- it never calls markDelivered or
    // releaseLease. Simulate that by just... not calling them.
    const leased = await leaseNextIntent('worker-A');
    expect(leased._id.toString()).toBe(intent._id.toString());
    expect(leased.status).toBe('leased');

    // While worker-A is still "alive" (lease not yet expired), no other
    // worker may steal the same intent.
    const stolenEarly = await leaseNextIntent('worker-B');
    expect(stolenEarly).toBeNull();

    // Time passes -- worker-A's lease expires without ever being released.
    await expireLease(db, intent._id);

    // worker-B must now be able to reclaim it.
    const reclaimed = await leaseNextIntent('worker-B');
    expect(reclaimed).not.toBeNull();
    expect(reclaimed._id.toString()).toBe(intent._id.toString());
    expect(reclaimed.leasedBy).toBe('worker-B');
    expect(reclaimed.attemptCount).toBe(2); // one attempt per lease, including the crashed one

    // worker-B finishes the job for real.
    const delivered = await markDelivered(reclaimed.deliveryId, reclaimed._id);
    expect(delivered.status).toBe('delivered');
  });

  it('a stale worker that eventually wakes up and double-acknowledges is a no-op, not a second delivery', async () => {
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p-stale-1',
      intent: { type: 'email', channel: 'receipt', payload: {} },
    });

    const leased = await leaseNextIntent('worker-A');

    // worker-A stalls (e.g. a GC pause or a network partition) long enough
    // that its lease expires and worker-B takes over and delivers first.
    await expireLease(db, intent._id);
    const reclaimedByB = await leaseNextIntent('worker-B');
    const delivered = await markDelivered(reclaimedByB.deliveryId, reclaimedByB._id);
    expect(delivered.status).toBe('delivered');

    // worker-A finally wakes up and tries to acknowledge the delivery it
    // thinks it still owns. This must be a harmless no-op, not a second
    // "delivered" transition and not an error.
    const staleAck = await markDelivered(leased.deliveryId, leased._id);
    expect(staleAck).toBeNull();

    const final = await db.collection(OUTBOX_COLLECTION).findOne({ _id: intent._id });
    expect(final.status).toBe('delivered');
    expect(final.leasedBy).toBe('worker-B');
  });

  it('a transient delivery failure reschedules with backoff instead of dead-lettering immediately', async () => {
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p-retry-1',
      intent: { type: 'email', channel: 'welcome', payload: {} },
    });

    const leased = await leaseNextIntent('worker-A');
    expect(leased.attemptCount).toBe(1);

    // Simulate the send throwing (e.g. SMTP timeout) -- the worker catches
    // it and reschedules rather than propagating.
    const rescheduled = await rescheduleIntent(leased._id, new Error('SMTP timeout'));
    expect(rescheduled.lastError).toBe('SMTP timeout');

    const stored = await db.collection(OUTBOX_COLLECTION).findOne({ _id: intent._id });
    expect(stored.status).toBe('pending');
    // nextAttemptAt must have moved into the future relative to when it was
    // rescheduled -- otherwise "backoff" is a no-op and the worker busy-loops.
    expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() - 1000);

    // It is not immediately leasable again (nextAttemptAt is in the future),
    // simulating a worker polling right away and correctly skipping it.
    const immediateRelease = await leaseNextIntent('worker-B');
    expect(immediateRelease).toBeNull();
  });

  it('repeated transient failures eventually dead-letter instead of retrying forever', async () => {
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p-exhaust-1',
      intent: { type: 'email', channel: 'welcome', payload: {} },
    });

    // Drive attemptCount up to the configured ceiling by repeatedly forcing
    // nextAttemptAt into the past (simulating backoff elapsing) and
    // re-leasing, without any real waiting.
    const maxAttempts = 5; // matches DEFAULT_CONFIG.maxAttempts in outbox.js
    for (let i = 0; i < maxAttempts; i += 1) {
      await db
        .collection(OUTBOX_COLLECTION)
        .updateOne({ _id: intent._id }, { $set: { nextAttemptAt: new Date(0), status: 'pending' } });
      await leaseNextIntent(`worker-${i}`);
    }

    const finalAttempt = await db
      .collection(OUTBOX_COLLECTION)
      .updateOne({ _id: intent._id }, { $set: { nextAttemptAt: new Date(0), status: 'pending' } });
    expect(finalAttempt.matchedCount).toBe(1);

    const final = await db.collection(OUTBOX_COLLECTION).findOne({ _id: intent._id });
    expect(final.status).toBe('dead_letter');
    expect(final.lastError).toBe('Max attempts exceeded');

    // A dead-lettered intent must never be picked up by a fresh worker poll.
    const leasedAfterDeadLetter = await leaseNextIntent('worker-final');
    expect(leasedAfterDeadLetter).toBeNull();
  });

  it('a successor never delivers out of causal order when its predecessor is interrupted mid-flight', async () => {
    const first = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p-causal-1',
      intent: { type: 'email', channel: 'welcome', payload: {} },
      sourceVersion: 1,
    });

    const second = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p-causal-1',
      intent: { type: 'email', channel: 'receipt', payload: {} },
      sourceVersion: 2,
      previousDeliveryId: first.deliveryId,
    });
    expect(second.predecessorDelivered).toBe(false);

    // worker-A leases the predecessor and then "crashes" without delivering.
    const leasedFirst = await leaseNextIntent('worker-A');
    expect(leasedFirst._id.toString()).toBe(first._id.toString());

    // While the predecessor is stuck, the successor must never become
    // leasable, no matter how many times a worker polls.
    for (let i = 0; i < 3; i += 1) {
      const attempt = await leaseNextIntent(`worker-poll-${i}`);
      expect(attempt === null || attempt._id.toString() !== second._id.toString()).toBe(true);
    }

    // The predecessor's lease expires and a different worker finally
    // delivers it.
    await expireLease(db, first._id);
    const reclaimedFirst = await leaseNextIntent('worker-B');
    await markDelivered(reclaimedFirst.deliveryId, reclaimedFirst._id);

    // Only now may the successor be leased.
    const leasedSecond = await leaseNextIntent('worker-C');
    expect(leasedSecond).not.toBeNull();
    expect(leasedSecond._id.toString()).toBe(second._id.toString());
  });

  it('releasing a lease the caller no longer holds is a no-op, not a theft', async () => {
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p-release-1',
      intent: { type: 'email', channel: 'welcome', payload: {} },
    });

    await leaseNextIntent('worker-A');

    // worker-B, which never held the lease, tries to release it (e.g. a
    // confused retry after a network blip made it think it owned this
    // intent). This must not touch worker-A's lease.
    await releaseLease(intent._id, 'worker-B');

    const stored = await db.collection(OUTBOX_COLLECTION).findOne({ _id: intent._id });
    expect(stored.status).toBe('leased');
    expect(stored.leasedBy).toBe('worker-A');
  });
});

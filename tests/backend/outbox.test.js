import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '@/lib/mongodb';
import { resetSlidingWindows } from '@/lib/rateLimit';
import {
  enqueueSideEffect,
  leaseNextIntent,
  markDelivered,
  rescheduleIntent,
  releaseLease,
  replayDeadLetters,
  replaySource,
  getOutboxStats,
  getNextCausalLink,
  findSequenceGap,
} from '@/lib/backend/outbox';

// The "processes emails through worker" test below exercises the worker's
// routing/status-transition logic, not real SMTP delivery — real email
// sending requires EMAIL_USER/EMAIL_PASS or SMTP_* creds this environment
// doesn't have, so sendPurchaseReceiptEmail is mocked at the module level.
vi.mock('@/lib/email', () => ({
  sendPurchaseReceiptEmail: vi.fn().mockResolvedValue(undefined),
}));

// A single MongoMemoryServer instance is started once for the whole run (see
// test/global-setup-outbox.js) rather than per test — spinning up a fresh
// mongod per test is slow and unnecessary. Each test instead clears the
// outbox collection so tests stay isolated from each other.
describe('outbox', () => {
  let db;

  beforeEach(async () => {
    db = await getDb();
    await db.collection('side_effect_outbox').deleteMany({});
    resetSlidingWindows();
  });

  it('enqueues a side effect intent', async () => {
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', channel: 'welcome', payload: {} },
    });

    expect(intent._id).toBeDefined();
    expect(intent.deliveryId).toBeDefined();
    expect(intent.status).toBe('pending');
    expect(intent.attemptCount).toBe(0);
  });

  it('leases pending intents in FIFO order', async () => {
    await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', payload: {} },
    });

    await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p2',
      intent: { type: 'webhook', payload: {} },
    });

    const a = await leaseNextIntent('worker-a');
    expect(a).not.toBeNull();
    expect(a.sourceId).toBe('p1');
    expect(a.status).toBe('leased');
    expect(a.leasedBy).toBe('worker-a');

    const b = await leaseNextIntent('worker-b');
    expect(b).not.toBeNull();
    expect(b.sourceId).toBe('p2');
  });

  it('prevents concurrent lease of same intent', async () => {
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', payload: {} },
    });

    const first = await leaseNextIntent('worker-a');
    expect(first).not.toBeNull();

    const second = await leaseNextIntent('worker-b');
    expect(second).toBeNull();
  });

  it('moves intents to dead_letter after max attempts', async () => {
    // `config` on enqueueSideEffect is accepted but not persisted onto the
    // stored intent — it must be passed to every call (leaseNextIntent,
    // rescheduleIntent) that needs a non-default maxAttempts, not just the
    // initial enqueue.
    const config = { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1 };
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', payload: {} },
      config,
    });

    await leaseNextIntent('worker-a', config);
    await rescheduleIntent(intent._id, new Error('boom'), config);

    await leaseNextIntent('worker-a', config);
    const stats = await getOutboxStats();
    expect(stats.byStatus.dead_letter).toBe(1);
  });

  it('replays dead letters', async () => {
    // maxAttempts: 2 so the first lease (attemptCount -> 1) doesn't already
    // dead-letter it on its own — rescheduleIntent unconditionally sets
    // status back to 'pending' regardless of current status, so if
    // leaseNextIntent had already dead-lettered it, rescheduleIntent would
    // silently un-dead-letter it before this test ever got to call replay.
    const config = { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1 };
    const i1 = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', payload: {} },
      config,
    });

    await leaseNextIntent('worker-a', config);
    await rescheduleIntent(i1._id, new Error('boom'), config);
    await leaseNextIntent('worker-a', config);

    const count = await replayDeadLetters(100, 'ops-admin');
    expect(count).toBe(1);

    const stats = await getOutboxStats();
    expect(stats.byStatus.pending).toBe(1);
  });

  it('rejects replayDeadLetters without an authorizedBy identity', async () => {
    await expect(replayDeadLetters(100)).rejects.toThrow(/authorizedBy/);
  });

  it('rate-limits replayDeadLetters per identity', async () => {
    resetSlidingWindows();
    for (let i = 0; i < 10; i++) {
      await replayDeadLetters(100, 'burst-actor');
    }

    await expect(replayDeadLetters(100, 'burst-actor')).rejects.toThrow(/rate limit/i);
  });

  it('marks delivered and prevents replay', async () => {
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', payload: {} },
    });

    const leased = await leaseNextIntent('worker-a');
    expect(leased).not.toBeNull();

    await markDelivered(leased.deliveryId, leased._id);

    const again = await leaseNextIntent('worker-a');
    expect(again).toBeNull();
  });

  it('releases lease for rebalance', async () => {
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', payload: {} },
    });

    const leased = await leaseNextIntent('worker-a');
    expect(leased.status).toBe('leased');

    await releaseLease(leased._id, 'worker-a');

    const next = await leaseNextIntent('worker-b');
    expect(next).not.toBeNull();
    expect(next.sourceId).toBe('p1');
    expect(next.status).toBe('leased');
  });

  it('processes emails through worker', async () => {
    const { runSideEffectWorker } = await import('@/lib/backend/sideEffectWorker');

    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: {
        type: 'email',
        channel: 'purchase_receipt',
        payload: {
          email: 'test@example.com',
          purchase: { _id: 'p1', amount: '10', asset: 'XLM' },
          material: { title: 'Math Notes' },
        },
      },
    });

    // Run one processing cycle manually by invoking the worker borrow logic
    const leased = await leaseNextIntent('worker-a');
    expect(leased).not.toBeNull();

    const { processSideEffectIntent } = await import('@/lib/backend/sideEffectWorker');
    await processSideEffectIntent(leased);
    await markDelivered(leased.deliveryId, leased._id);

    const stats = await getOutboxStats();
    expect(stats.byStatus.delivered).toBe(1);
  });

  it('reclaims expired leases for other workers', async () => {
    const config = { leaseTtlMs: 50, maxAttempts: 10, initialBackoffMs: 1, maxBackoffMs: 1 };
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', payload: {} },
      config,
    });

    const first = await leaseNextIntent('worker-a', config);
    expect(first).not.toBeNull();
    expect(first.status).toBe('leased');

    // Wait for lease to expire, then another worker can claim it.
    await new Promise(resolve => setTimeout(resolve, 60));

    const second = await leaseNextIntent('worker-b', config);
    expect(second).not.toBeNull();
    expect(second.status).toBe('leased');
    expect(second.leasedBy).toBe('worker-b');
  });

  it('reschedules failed intents with backoff', async () => {
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', payload: {} },
      config: { initialBackoffMs: 100, maxBackoffMs: 1000, maxAttempts: 10 },
    });

    const leased = await leaseNextIntent('worker-a');
    expect(leased.attemptCount).toBe(1);

    await rescheduleIntent(leased._id, new Error('provider 429'));

    const pending = await db.collection('side_effect_outbox').findOne({ _id: leased._id });
    expect(pending.status).toBe('pending');
    expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('provides outbox stats', async () => {
    await enqueueSideEffect({ sourceAggregate: 'purchase', sourceId: 'p1', intent: { type: 'email', payload: {} } });
    await enqueueSideEffect({ sourceAggregate: 'purchase', sourceId: 'p2', intent: { type: 'webhook', payload: {} } });

    const stats = await getOutboxStats();
    expect(stats.byStatus.pending).toBe(2);
    expect(stats.byIntentType.email).toBe(1);
    expect(stats.byIntentType.webhook).toBe(1);
  });

  describe('causal ordering (issue #635)', () => {
    it('never leases a successor before its predecessor is delivered', async () => {
      const link1 = await getNextCausalLink('material', 'm1');
      expect(link1.sourceVersion).toBe(1);
      expect(link1.previousDeliveryId).toBeNull();

      const first = await enqueueSideEffect({
        sourceAggregate: 'material',
        sourceId: 'm1',
        sourceVersion: link1.sourceVersion,
        previousDeliveryId: link1.previousDeliveryId,
        intent: { type: 'webhook', channel: 'purchase.completed', payload: {} },
      });

      const link2 = await getNextCausalLink('material', 'm1');
      expect(link2.sourceVersion).toBe(2);
      expect(link2.previousDeliveryId).toBe(first.deliveryId);

      await enqueueSideEffect({
        sourceAggregate: 'material',
        sourceId: 'm1',
        sourceVersion: link2.sourceVersion,
        previousDeliveryId: link2.previousDeliveryId,
        intent: { type: 'webhook', channel: 'refund.issued', payload: {} },
      });

      // The successor (v2) must not be leasable while its predecessor (v1)
      // is still pending — this is the core ordering guarantee.
      const leased = await leaseNextIntent('worker-a');
      expect(leased.sourceVersion).toBe(1);

      const nothingElseLeasable = await leaseNextIntent('worker-b');
      expect(nothingElseLeasable).toBeNull();

      // Only once v1 is marked delivered does v2 become claimable.
      await markDelivered(leased.deliveryId, leased._id);
      const secondLeased = await leaseNextIntent('worker-b');
      expect(secondLeased).not.toBeNull();
      expect(secondLeased.sourceVersion).toBe(2);
    });

    it('holds ordering under a concurrent retry-storm simulation', async () => {
      let link = await getNextCausalLink('material', 'm-storm');
      const deliveryIds = [];
      for (let v = 1; v <= 5; v++) {
        const created = await enqueueSideEffect({
          sourceAggregate: 'material',
          sourceId: 'm-storm',
          sourceVersion: link.sourceVersion,
          previousDeliveryId: link.previousDeliveryId,
          intent: { type: 'webhook', channel: `event.${v}`, payload: {} },
        });
        deliveryIds.push(created.deliveryId);
        link = await getNextCausalLink('material', 'm-storm');
      }

      // Simulate several workers hammering leaseNextIntent concurrently, as
      // a retry storm would. Only one intent should ever be leasable at a
      // time for this source, and always the lowest pending version.
      const deliveredOrder = [];
      for (let round = 0; round < 5; round++) {
        const results = await Promise.all([
          leaseNextIntent('worker-a'),
          leaseNextIntent('worker-b'),
          leaseNextIntent('worker-c'),
        ]);
        const claimed = results.filter(Boolean);
        expect(claimed.length).toBe(1);

        const leased = claimed[0];
        deliveredOrder.push(leased.sourceVersion);
        await markDelivered(leased.deliveryId, leased._id);
      }

      expect(deliveredOrder).toEqual([1, 2, 3, 4, 5]);
    });

    it('is idempotent when the same delivery is acknowledged twice', async () => {
      const intent = await enqueueSideEffect({
        sourceAggregate: 'material',
        sourceId: 'm-dup',
        intent: { type: 'webhook', payload: {} },
      });

      const leased = await leaseNextIntent('worker-a');
      const first = await markDelivered(leased.deliveryId, leased._id);
      expect(first).not.toBeNull();

      // A duplicate acknowledgement (e.g. crash-and-retry after send) must
      // be a no-op, not an error and not a state flip.
      const second = await markDelivered(leased.deliveryId, leased._id);
      expect(second).toBeNull();

      const stats = await getOutboxStats();
      expect(stats.byStatus.delivered).toBe(1);
    });
  });

  describe('findSequenceGap', () => {
    it('reports null when no versioned effects exist', async () => {
      const gap = await findSequenceGap('material', 'm-none');
      expect(gap).toEqual({ highestContiguousVersion: null, gapAt: null, deliveredCount: 0 });
    });

    it('reports the highest contiguously delivered version', async () => {
      for (let v = 1; v <= 3; v++) {
        const link = await getNextCausalLink('material', 'm-contig');
        const created = await enqueueSideEffect({
          sourceAggregate: 'material',
          sourceId: 'm-contig',
          sourceVersion: link.sourceVersion,
          previousDeliveryId: link.previousDeliveryId,
          intent: { type: 'webhook', payload: {} },
        });
        const leased = await leaseNextIntent(`worker-${v}`);
        await markDelivered(leased.deliveryId, leased._id);
      }

      const gap = await findSequenceGap('material', 'm-contig');
      expect(gap.highestContiguousVersion).toBe(3);
      expect(gap.gapAt).toBeNull();
      expect(gap.deliveredCount).toBe(3);
    });

    it('detects a missing sequence number', async () => {
      const db = await getDb();
      const now = new Date();
      // Directly insert versions 1 and 3, skipping 2, to simulate a lost
      // event a subscriber needs to detect.
      await db.collection('side_effect_outbox').insertMany([
        {
          sourceAggregate: 'material', sourceId: 'm-gap', sourceVersion: 1,
          deliveryId: 'd1', status: 'delivered', previousDeliveryId: null,
          predecessorDelivered: true, createdAt: now, updatedAt: now,
        },
        {
          sourceAggregate: 'material', sourceId: 'm-gap', sourceVersion: 3,
          deliveryId: 'd3', status: 'pending', previousDeliveryId: 'd2',
          predecessorDelivered: false, createdAt: now, updatedAt: now,
        },
      ]);

      const gap = await findSequenceGap('material', 'm-gap');
      expect(gap.gapAt).toBe(2);
      expect(gap.highestContiguousVersion).toBe(1);
    });
  });

  describe('replay authorization, auditing, and rate limiting (issue #635)', () => {
    it('rejects replaySource without an authorizedBy identity', async () => {
      await expect(replaySource('material', 'm1')).rejects.toThrow(/authorizedBy/);
    });

    it('replaySource never renumbers sourceVersion', async () => {
      const link = await getNextCausalLink('material', 'm-replay');
      const created = await enqueueSideEffect({
        sourceAggregate: 'material',
        sourceId: 'm-replay',
        sourceVersion: link.sourceVersion,
        previousDeliveryId: link.previousDeliveryId,
        intent: { type: 'webhook', payload: {} },
      });

      const count = await replaySource('material', 'm-replay', 'ops-admin');
      expect(count).toBe(1);

      const db = await getDb();
      const reloaded = await db.collection('side_effect_outbox').findOne({ _id: created._id });
      expect(reloaded.sourceVersion).toBe(link.sourceVersion);
      expect(reloaded.deliveryId).toBe(created.deliveryId);
    });

    it('rate-limits replaySource per identity', async () => {
      resetSlidingWindows();
      for (let i = 0; i < 10; i++) {
        await replaySource('material', 'm-rl', 'burst-actor-2');
      }

      await expect(replaySource('material', 'm-rl', 'burst-actor-2')).rejects.toThrow(/rate limit/i);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getDb } from '@/lib/mongodb';
import {
  enqueueSideEffect,
  leaseNextIntent,
  markDelivered,
  rescheduleIntent,
  releaseLease,
  replayDeadLetters,
  getOutboxStats,
} from '@/lib/backend/outbox';

describe('outbox', () => {
  let mongod;
  let db;

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    process.env.MONGODB_URI = uri;
    process.env.MONGODB_DB = 'test';
    db = await getDb();
  });

  afterEach(async () => {
    await mongod.stop();
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
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', payload: {} },
      config: { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1 },
    });

    await leaseNextIntent('worker-a');
    await rescheduleIntent(intent._id, new Error('boom'));

    await leaseNextIntent('worker-a');
    const stats = await getOutboxStats();
    expect(stats.byStatus.dead_letter).toBe(1);
  });

  it('replays dead letters', async () => {
    const i1 = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', payload: {} },
      config: { maxAttempts: 1, initialBackoffMs: 1, maxBackoffMs: 1 },
    });

    await leaseNextIntent('worker-a');
    await rescheduleIntent(i1._id, new Error('boom'));

    const count = await replayDeadLetters();
    expect(count).toBe(1);

    const stats = await getOutboxStats();
    expect(stats.byStatus.pending).toBe(1);
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
    const intent = await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: 'p1',
      intent: { type: 'email', payload: {} },
      config: { leaseTtlMs: 50, maxAttempts: 10, initialBackoffMs: 1, maxBackoffMs: 1 },
    });

    const first = await leaseNextIntent('worker-a');
    expect(first).not.toBeNull();
    expect(first.status).toBe('leased');

    // Wait for lease to expire, then another worker can claim it.
    await new Promise(resolve => setTimeout(resolve, 60));

    const second = await leaseNextIntent('worker-b');
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
});

import { describe, it, expect, vi } from 'vitest';
import {
  OUTBOX_COLLECTION,
  replayDeadLetterWebhook,
  replayDeadLetterWebhooksBatch,
  listDeadLetterWebhooks,
  WebhookReplayAuthorizationError,
  WebhookReplayValidationError,
  WebhookReplayNotFoundError,
  WebhookReplayStateError,
  WebhookReplayDeliveryError,
} from './deadLetterReplay';
import { IDEMPOTENCY_KEYS_COLLECTION } from '@/lib/backend/idempotency';

/**
 * Minimal in-memory Mongo-like database double supporting the exact
 * operations used by `deadLetterReplay` and `withIdempotency`.
 */
function createInMemoryDb() {
  const store = new Map();

  function getDocs(name) {
    if (!store.has(name)) store.set(name, []);
    return store.get(name);
  }

  function matches(doc, filter = {}) {
    for (const [key, expected] of Object.entries(filter)) {
      const actual = key.split('.').reduce((obj, part) => obj?.[part], doc);
      if (String(actual) !== String(expected)) {
        return false;
      }
    }
    return true;
  }

  return {
    collection(name) {
      const docs = getDocs(name);
      return {
        async insertOne(doc) {
          if (doc._id !== undefined && docs.some((d) => String(d._id) === String(doc._id))) {
            const err = new Error('Duplicate key error');
            err.code = 11000;
            throw err;
          }
          const copy = structuredClone(doc);
          docs.push(copy);
          return { insertedId: copy._id };
        },
        async findOne(filter) {
          const found = docs.find((d) => matches(d, filter));
          return found ? structuredClone(found) : null;
        },
        find(filter) {
          let result = docs.filter((d) => matches(d, filter)).map((d) => structuredClone(d));
          return {
            sort() {
              return this;
            },
            skip(n) {
              result = result.slice(n);
              return this;
            },
            limit(n) {
              result = result.slice(0, n);
              return this;
            },
            async toArray() {
              return result;
            },
          };
        },
        async updateOne(filter, update) {
          const idx = docs.findIndex((d) => matches(d, filter));
          if (idx === -1) return { matchedCount: 0, modifiedCount: 0 };
          const target = docs[idx];
          if (update.$set) {
            Object.assign(target, structuredClone(update.$set));
          }
          if (update.$inc) {
            for (const [k, v] of Object.entries(update.$inc)) {
              target[k] = (target[k] || 0) + v;
            }
          }
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async updateMany(filter, update) {
          let modifiedCount = 0;
          for (const target of docs) {
            if (matches(target, filter)) {
              if (update.$set) Object.assign(target, structuredClone(update.$set));
              modifiedCount += 1;
            }
          }
          return { matchedCount: modifiedCount, modifiedCount };
        },
        async deleteOne(filter) {
          const idx = docs.findIndex((d) => matches(d, filter));
          if (idx === -1) return { deletedCount: 0 };
          docs.splice(idx, 1);
          return { deletedCount: 1 };
        },
      };
    },
    _dump(name) {
      return getDocs(name);
    },
  };
}

function makeDeadLetterEntry(overrides = {}) {
  return {
    _id: 'entry-1',
    deliveryId: 'del-1',
    status: 'dead_letter',
    intent: {
      type: 'webhook',
      channel: 'purchase.completed',
      payload: {
        urls: ['https://creator.example/hook'],
        payload: { event: 'purchase.completed', data: { materialId: 'mat-1' } },
        signingSecret: 'secret-123',
      },
    },
    attemptCount: 5,
    replayAttempts: 0,
    updatedAt: new Date('2026-11-23T00:00:00Z'),
    ...overrides,
  };
}

const adminActor = { id: 'admin-1', role: 'admin', isAdmin: true };
const regularUser = { id: 'user-1', role: 'learner', isAdmin: false };

describe('webhook dead-letter replay with idempotency guards', () => {
  it('replays a dead-letter webhook normally, marks it delivered, and unblocks causal successors', async () => {
    const db = createInMemoryDb();
    await db.collection(OUTBOX_COLLECTION).insertOne(makeDeadLetterEntry());
    await db.collection(OUTBOX_COLLECTION).insertOne({
      _id: 'entry-2',
      deliveryId: 'del-2',
      previousDeliveryId: 'del-1',
      predecessorDelivered: false,
      status: 'pending',
    });

    const deliver = vi.fn().mockResolvedValue(true);
    const audit = vi.fn().mockResolvedValue(undefined);

    const res = await replayDeadLetterWebhook(db, {
      entryId: 'entry-1',
      idempotencyKey: 'replay-op-1',
      actor: adminActor,
      deliver,
      audit,
    });

    expect(res.replayed).toBe(false);
    expect(res.status).toBe('delivered');
    expect(res.deliveredUrls).toEqual(['https://creator.example/hook']);
    expect(deliver).toHaveBeenCalledTimes(1);

    const updated = await db.collection(OUTBOX_COLLECTION).findOne({ _id: 'entry-1' });
    expect(updated.status).toBe('delivered');
    expect(updated.replayAttempts).toBe(1);

    const successor = await db.collection(OUTBOX_COLLECTION).findOne({ _id: 'entry-2' });
    expect(successor.predecessorDelivered).toBe(true);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'webhook_dlq_replay_succeeded', actorId: 'admin-1' })
    );
  });

  it('guards against duplicate replays with the same idempotency key without re-sending webhooks', async () => {
    const db = createInMemoryDb();
    await db.collection(OUTBOX_COLLECTION).insertOne(makeDeadLetterEntry());

    const deliver = vi.fn().mockResolvedValue(true);

    const first = await replayDeadLetterWebhook(db, {
      entryId: 'entry-1',
      idempotencyKey: 'dup-key-1',
      actor: adminActor,
      deliver,
    });
    const second = await replayDeadLetterWebhook(db, {
      entryId: 'entry-1',
      idempotencyKey: 'dup-key-1',
      actor: adminActor,
      deliver,
    });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entryId).toBe(first.entryId);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('rejects reusing an idempotency key with a different payload/target', async () => {
    const db = createInMemoryDb();
    await db.collection(OUTBOX_COLLECTION).insertOne(makeDeadLetterEntry({ _id: 'entry-1' }));
    await db.collection(OUTBOX_COLLECTION).insertOne(makeDeadLetterEntry({ _id: 'entry-2', deliveryId: 'del-2' }));

    const deliver = vi.fn().mockResolvedValue(true);

    await replayDeadLetterWebhook(db, {
      entryId: 'entry-1',
      idempotencyKey: 'shared-key',
      actor: adminActor,
      deliver,
    });

    await expect(
      replayDeadLetterWebhook(db, {
        entryId: 'entry-2',
        idempotencyKey: 'shared-key',
        actor: adminActor,
        deliver,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT_IDEMPOTENCY_KEY' });
  });

  it('rejects concurrent in-flight replays sharing the same idempotency key', async () => {
    const db = createInMemoryDb();
    await db.collection(OUTBOX_COLLECTION).insertOne(makeDeadLetterEntry());

    let resolveDelivery;
    const deliver = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDelivery = resolve;
        })
    );

    const firstPromise = replayDeadLetterWebhook(db, {
      entryId: 'entry-1',
      idempotencyKey: 'inflight-key',
      actor: adminActor,
      deliver,
    });

    // Wait a microtask so the first call has claimed the idempotency lock
    await Promise.resolve();

    await expect(
      replayDeadLetterWebhook(db, {
        entryId: 'entry-1',
        idempotencyKey: 'inflight-key',
        actor: adminActor,
        deliver,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT_IN_PROGRESS' });

    resolveDelivery(true);
    const firstResult = await firstPromise;
    expect(firstResult.status).toBe('delivered');
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('keeps entry in dead_letter on failure and allows safe retry with the same idempotency key', async () => {
    const db = createInMemoryDb();
    await db.collection(OUTBOX_COLLECTION).insertOne(makeDeadLetterEntry());

    const deliver = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const audit = vi.fn().mockResolvedValue(undefined);

    await expect(
      replayDeadLetterWebhook(db, {
        entryId: 'entry-1',
        idempotencyKey: 'retry-key-1',
        actor: adminActor,
        deliver,
        audit,
      })
    ).rejects.toBeInstanceOf(WebhookReplayDeliveryError);

    const afterFailure = await db.collection(OUTBOX_COLLECTION).findOne({ _id: 'entry-1' });
    expect(afterFailure.status).toBe('dead_letter');
    expect(afterFailure.replayAttempts).toBe(1);
    expect(afterFailure.lastReplayError).toContain('https://creator.example/hook');

    // Retry with the exact same idempotency key now succeeds
    const retryRes = await replayDeadLetterWebhook(db, {
      entryId: 'entry-1',
      idempotencyKey: 'retry-key-1',
      actor: adminActor,
      deliver,
      audit,
    });

    expect(retryRes.status).toBe('delivered');
    expect(retryRes.replayed).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('does not re-deliver already-succeeded URLs when retrying after partial multi-URL failure', async () => {
    const db = createInMemoryDb();
    await db.collection(OUTBOX_COLLECTION).insertOne(
      makeDeadLetterEntry({
        intent: {
          type: 'webhook',
          channel: 'purchase.completed',
          payload: {
            urls: ['https://hook-a.example/events', 'https://hook-b.example/events'],
            payload: { event: 'purchase.completed' },
            signingSecret: 'sec',
          },
        },
      })
    );

    const deliver = vi
      .fn()
      .mockResolvedValueOnce(true)  // hook-a succeeds on attempt 1
      .mockResolvedValueOnce(false) // hook-b fails on attempt 1
      .mockResolvedValueOnce(true); // hook-b succeeds on attempt 2

    await expect(
      replayDeadLetterWebhook(db, {
        entryId: 'entry-1',
        idempotencyKey: 'partial-key',
        actor: adminActor,
        deliver,
      })
    ).rejects.toBeInstanceOf(WebhookReplayDeliveryError);

    const retryRes = await replayDeadLetterWebhook(db, {
      entryId: 'entry-1',
      idempotencyKey: 'partial-key',
      actor: adminActor,
      deliver,
    });

    expect(retryRes.status).toBe('delivered');
    expect(retryRes.deliveredUrls).toEqual([
      'https://hook-a.example/events',
      'https://hook-b.example/events',
    ]);
    // hook-a was called once, hook-b was called twice => 3 total calls, never 4
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls[2][0]).toBe('https://hook-b.example/events');
  });

  it('rejects unauthorized actors before touching outbox or idempotency store', async () => {
    const db = createInMemoryDb();
    await db.collection(OUTBOX_COLLECTION).insertOne(makeDeadLetterEntry());
    const deliver = vi.fn().mockResolvedValue(true);
    const audit = vi.fn().mockResolvedValue(undefined);

    await expect(
      replayDeadLetterWebhook(db, {
        entryId: 'entry-1',
        idempotencyKey: 'unauth-key',
        actor: regularUser,
        deliver,
        audit,
      })
    ).rejects.toBeInstanceOf(WebhookReplayAuthorizationError);

    expect(deliver).not.toHaveBeenCalled();
    expect(db._dump(IDEMPOTENCY_KEYS_COLLECTION)).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'webhook_dlq_replay_denied', actorId: 'user-1' })
    );

    await expect(listDeadLetterWebhooks(db, { actor: regularUser })).rejects.toBeInstanceOf(
      WebhookReplayAuthorizationError
    );
  });

  it('validates missing idempotencyKey, missing entry, non-webhook intent, and non-dead-letter state', async () => {
    const db = createInMemoryDb();
    await db.collection(OUTBOX_COLLECTION).insertOne(
      makeDeadLetterEntry({ _id: 'email-1', intent: { type: 'email', payload: {} } })
    );
    await db.collection(OUTBOX_COLLECTION).insertOne(
      makeDeadLetterEntry({ _id: 'delivered-1', status: 'delivered' })
    );

    await expect(
      replayDeadLetterWebhook(db, { entryId: 'entry-1', actor: adminActor })
    ).rejects.toBeInstanceOf(WebhookReplayValidationError);

    await expect(
      replayDeadLetterWebhook(db, { entryId: 'missing-id', idempotencyKey: 'k1', actor: adminActor })
    ).rejects.toBeInstanceOf(WebhookReplayNotFoundError);

    await expect(
      replayDeadLetterWebhook(db, { entryId: 'email-1', idempotencyKey: 'k2', actor: adminActor })
    ).rejects.toBeInstanceOf(WebhookReplayValidationError);

    await expect(
      replayDeadLetterWebhook(db, { entryId: 'delivered-1', idempotencyKey: 'k3', actor: adminActor })
    ).rejects.toBeInstanceOf(WebhookReplayStateError);
  });

  it('replays a batch with per-entry idempotency isolation so batch retries skip already-succeeded entries', async () => {
    const db = createInMemoryDb();
    await db.collection(OUTBOX_COLLECTION).insertOne(makeDeadLetterEntry({ _id: 'b-1', deliveryId: 'd-1' }));
    await db.collection(OUTBOX_COLLECTION).insertOne(makeDeadLetterEntry({ _id: 'b-2', deliveryId: 'd-2' }));

    const deliver = vi
      .fn()
      .mockResolvedValueOnce(true)  // b-1 succeeds
      .mockResolvedValueOnce(false) // b-2 fails
      .mockResolvedValueOnce(true); // b-2 succeeds on batch retry

    const firstBatch = await replayDeadLetterWebhooksBatch(db, {
      entryIds: ['b-1', 'b-2'],
      idempotencyKey: 'batch-1',
      actor: adminActor,
      deliver,
    });

    expect(firstBatch).toMatchObject({ total: 2, succeeded: 1, replayed: 0, failed: 1 });

    const secondBatch = await replayDeadLetterWebhooksBatch(db, {
      entryIds: ['b-1', 'b-2'],
      idempotencyKey: 'batch-1',
      actor: adminActor,
      deliver,
    });

    expect(secondBatch).toMatchObject({ total: 2, succeeded: 1, replayed: 1, failed: 0 });
    expect(deliver).toHaveBeenCalledTimes(3);
  });
});

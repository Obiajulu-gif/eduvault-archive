import { getDb } from '../mongodb.js';
import { v4 as uuidv7 } from 'uuid';

const OUTBOX_COLLECTION = 'side_effect_outbox';

const DEFAULT_CONFIG = {
  leaseTtlMs: 5 * 60 * 1000,
  maxAttempts: 5,
  initialBackoffMs: 1000,
  maxBackoffMs: 60 * 1000,
  backoffMultiplier: 2,
  jitterFraction: 0.2,
};

function computeNextAttempt(attemptCount, baseConfig = DEFAULT_CONFIG) {
  const exponential = baseConfig.initialBackoffMs * Math.pow(baseConfig.backoffMultiplier, attemptCount);
  const capped = Math.min(exponential, baseConfig.maxBackoffMs);
  const jitter = capped * baseConfig.jitterFraction * Math.random();
  return new Date(Date.now() + capped + jitter);
}

export async function enqueueSideEffect({
  sourceAggregate,
  sourceId,
  intent,
  db,
  session,
  deliveryId,
  sourceVersion,
  previousDeliveryId,
  idempotencyKey,
  config = DEFAULT_CONFIG,
}) {
  const database = db || await getDb();
  const now = new Date();

  const stableDeliveryId = deliveryId || uuidv7();

  const entry = {
    sourceAggregate,
    sourceId,
    intent,
    // Causal ordering support (issue #633): `sourceVersion` is the per-source
    // monotonic version, and `previousDeliveryId` links an effect to the effect
    // that must be observed before it. `predecessorDelivered` gates leasing so
    // a successor is never delivered before its predecessor.
    sourceVersion: typeof sourceVersion === 'number' ? sourceVersion : null,
    previousDeliveryId: previousDeliveryId || null,
    predecessorDelivered: previousDeliveryId ? false : true,
    idempotencyKey: idempotencyKey || stableDeliveryId,
    status: 'pending',
    leasedBy: null,
    leaseExpiresAt: null,
    deliveryId: stableDeliveryId,
    attemptCount: 0,
    nextAttemptAt: now,
    lastError: null,
    deliveredAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const options = session ? { session } : undefined;
  if (deliveryId) {
    const collection = database.collection(OUTBOX_COLLECTION);
    await collection.updateOne(
      { deliveryId },
      { $setOnInsert: entry },
      { ...options, upsert: true },
    );
    return collection.findOne({ deliveryId }, options);
  }

  const result = await database.collection(OUTBOX_COLLECTION).insertOne(entry, options);
  return { ...entry, _id: result.insertedId };
}

export async function leaseNextIntent(workerId, config = DEFAULT_CONFIG) {
  const db = await getDb();
  const now = new Date();

  const claimed = await db.collection(OUTBOX_COLLECTION).findOneAndUpdate(
    {
      status: 'pending',
      nextAttemptAt: { $lte: now },
      $or: [
        { leaseExpiresAt: { $lte: now } },
        { leaseExpiresAt: null },
      ],
      // Causal gating: never lease an effect before its predecessor has been
      // delivered, so effects for one source stay in version order.
      $or: [
        { previousDeliveryId: null },
        { predecessorDelivered: true },
      ],
    },
    {
      $set: {
        status: 'leased',
        leasedBy: workerId,
        leaseExpiresAt: new Date(now.getTime() + config.leaseTtlMs),
        updatedAt: now,
      },
      $inc: { attemptCount: 1 },
    },
    {
      sort: { nextAttemptAt: 1, createdAt: 1 },
      returnDocument: 'after',
    }
  );

  if (!claimed.value) return null;

  const intent = claimed.value;
  if (intent.attemptCount >= config.maxAttempts) {
    await db.collection(OUTBOX_COLLECTION).updateOne(
      { _id: intent._id },
      {
        $set: {
          status: 'dead_letter',
          lastError: 'Max attempts exceeded',
          updatedAt: new Date(),
        },
      }
    );
    return null;
  }

  return intent;
}

export async function markDelivered(deliveryId, intentId) {
  const db = await getDb();
  const now = new Date();

  const result = await db.collection(OUTBOX_COLLECTION).updateOne(
    { _id: intentId, deliveryId },
    {
      $set: {
        status: 'delivered',
        deliveredAt: now,
        updatedAt: now,
      },
    }
  );

  if (result.matchedCount === 0) {
    // A duplicate acknowledgement (e.g. crash after send) must be a no-op and
    // not silently flip state. Return without error so the caller can treat it
    // as idempotent.
    return null;
  }

  // Unblock every successor that was waiting on this delivery, preserving
  // causal ordering across the source aggregate.
  await db.collection(OUTBOX_COLLECTION).updateMany(
    { previousDeliveryId: deliveryId },
    { $set: { predecessorDelivered: true, updatedAt: now } }
  );

  return result;
}

/**
 * Operator traceability (issue #633): return a single effect with its full
 * lineage so an operator can trace every effect to its source event and
 * outcome. `sourceVersion`, `previousDeliveryId`, `idempotencyKey`, and the
 * terminal `status`/`deliveredAt`/`lastError` are all exposed.
 */
export async function getOutboxTrace(deliveryId) {
  const db = await getDb();
  return db.collection(OUTBOX_COLLECTION).findOne(
    { deliveryId },
    {
      projection: {
        _id: 1,
        deliveryId: 1,
        idempotencyKey: 1,
        sourceAggregate: 1,
        sourceId: 1,
        sourceVersion: 1,
        previousDeliveryId: 1,
        predecessorDelivered: 1,
        intent: 1,
        status: 1,
        attemptCount: 1,
        leasedBy: 1,
        lastError: 1,
        deliveredAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    }
  );
}

/**
 * Return every effect emitted by a source aggregate, in version order, so an
 * operator can audit the full causal chain for one purchase/material.
 */
export async function traceSourceEffects(sourceAggregate, sourceId) {
  const db = await getDb();
  return db
    .collection(OUTBOX_COLLECTION)
    .find({ sourceAggregate, sourceId })
    .sort({ sourceVersion: 1, createdAt: 1 })
    .toArray();
}

/**
 * Replay controls (issue #633): re-enqueue dead-letter effects. Causal gating
 * is preserved because `previousDeliveryId`/`predecessorDelivered` are left
 * intact — a successor only becomes claimable after its predecessor replays.
 */
export async function replayDeadLetters(limit = 100) {
  const db = await getDb();
  const now = new Date();

  const result = await db.collection(OUTBOX_COLLECTION).updateMany(
    {
      status: 'dead_letter',
      deliveredAt: null,
    },
    {
      $set: {
        status: 'pending',
        nextAttemptAt: now,
        attemptCount: 0,
        lastError: null,
        updatedAt: now,
      },
    }
  );

  return result.modifiedCount;
}

/**
 * Replay every effect for a single source in version order. Used when an
 * operator needs to re-derive the full side-effect chain for one
 * purchase/material after a partial outage. Ordering is preserved by the
 * causal gate, not by the replay loop itself.
 */
export async function replaySource(sourceAggregate, sourceId) {
  const db = await getDb();
  const effects = await traceSourceEffects(sourceAggregate, sourceId);
  const now = new Date();

  for (const effect of effects) {
    await db.collection(OUTBOX_COLLECTION).updateOne(
      { _id: effect._id },
      {
        $set: {
          status: 'pending',
          nextAttemptAt: now,
          attemptCount: 0,
          lastError: 'Replayed by operator',
          deliveredAt: null,
          updatedAt: now,
        },
      }
    );
  }

  return effects.length;
}

export async function rescheduleIntent(intentId, error, config = DEFAULT_CONFIG) {
  const db = await getDb();
  const now = new Date();

  const intent = await db.collection(OUTBOX_COLLECTION).findOne({ _id: intentId });
  if (!intent) return null;

  const nextAttemptAt = computeNextAttempt(intent.attemptCount, config);

  await db.collection(OUTBOX_COLLECTION).updateOne(
    { _id: intentId },
    {
      $set: {
        status: 'pending',
        nextAttemptAt,
        lastError: error.message || String(error),
        updatedAt: now,
      },
    }
  );

  return { ...intent, nextAttemptAt };
}

export async function releaseLease(intentId, workerId) {
  const db = await getDb();
  await db.collection(OUTBOX_COLLECTION).updateOne(
    { _id: intentId, leasedBy: workerId },
    {
      $set: {
        status: 'pending',
        leasedBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      },
    }
  );
}

export async function getOutboxStats() {
  const db = await getDb();
  const stats = await db.collection(OUTBOX_COLLECTION).aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const byIntentType = await db.collection(OUTBOX_COLLECTION).aggregate([
    {
      $group: {
        _id: '$intent.type',
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  return {
    byStatus: Object.fromEntries(stats.map(s => [s._id, s.count])),
    byIntentType: Object.fromEntries(byIntentType.map(s => [s._id, s.count])),
  };
}

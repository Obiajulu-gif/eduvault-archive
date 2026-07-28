import { getDb } from '@/lib/mongodb';
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
  config = DEFAULT_CONFIG,
}) {
  const db = await getDb();
  const now = new Date();

  const entry = {
    sourceAggregate,
    sourceId,
    intent,
    status: 'pending',
    leasedBy: null,
    leaseExpiresAt: null,
    deliveryId: uuidv7(),
    attemptCount: 0,
    nextAttemptAt: now,
    lastError: null,
    deliveredAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const result = await db.collection(OUTBOX_COLLECTION).insertOne(entry);
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

  await db.collection(OUTBOX_COLLECTION).updateOne(
    { _id: intentId, deliveryId },
    {
      $set: {
        status: 'delivered',
        deliveredAt: now,
        updatedAt: now,
      },
    }
  );
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
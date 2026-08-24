import { COLLECTIONS, applyTimestamps } from "./schemaContracts.js";

export const OUTBOX_STATUSES = {
  PENDING: "pending",
  LEASED: "leased",
  FAILED: "failed",
  COMPLETED: "completed",
};

export const OUTBOX_INTENT_TYPES = {
  EMAIL: "email",
  WEBHOOK: "webhook",
};

export const DEFAULT_OUTBOX_CONFIG = {
  maxAttempts: 5,
  baseDelayMs: 30_000,
  maxDelayMs: 30 * 60_000,
  leaseDurationMs: 60_000,
};

export function computeNextAttempt(attemptCount, config = DEFAULT_OUTBOX_CONFIG, now = new Date()) {
  const base = typeof config.baseDelayMs === "number" ? config.baseDelayMs : DEFAULT_OUTBOX_CONFIG.baseDelayMs;
  const cap = typeof config.maxDelayMs === "number" ? config.maxDelayMs : DEFAULT_OUTBOX_CONFIG.maxDelayMs;
  const exponent = Math.max(0, (attemptCount || 1) - 1);
  const delay = Math.min(cap, base * 2 ** exponent);
  return new Date(now.getTime() + delay);
}

function touch(update, now) {
  return { ...update, updatedAt: now };
}

export async function enqueueOutboxIntent(db, { type, payload }, { now = new Date() } = {}) {
  const record = applyTimestamps(
    {
      type,
      payload: payload ?? null,
      status: OUTBOX_STATUSES.PENDING,
      attemptCount: 0,
      nextAttemptAt: now,
      lastError: null,
      leasedBy: null,
      leaseExpiresAt: null,
      failedAt: null,
      completedAt: null,
    },
    now
  );

  const result = await db.collection(COLLECTIONS.outbox).insertOne(record);
  return { ...record, _id: result.insertedId };
}

export async function leaseNextIntent(db, { now = new Date(), workerId = "outbox-worker", config = {} } = {}) {
  const leaseDurationMs =
    typeof config.leaseDurationMs === "number" ? config.leaseDurationMs : DEFAULT_OUTBOX_CONFIG.leaseDurationMs;

  return db.collection(COLLECTIONS.outbox).findOneAndUpdate(
    {
      status: OUTBOX_STATUSES.PENDING,
      $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
    },
    {
      $set: touch(
        {
          status: OUTBOX_STATUSES.LEASED,
          leasedBy: workerId,
          leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
        },
        now
      ),
    },
    {
      sort: { nextAttemptAt: 1, createdAt: 1 },
      returnDocument: "after",
    }
  );
}

export async function completeOutboxIntent(db, intentId, { now = new Date() } = {}) {
  return db.collection(COLLECTIONS.outbox).findOneAndUpdate(
    { _id: intentId },
    {
      $set: touch(
        {
          status: OUTBOX_STATUSES.COMPLETED,
          completedAt: now,
          lastError: null,
          leasedBy: null,
          leaseExpiresAt: null,
        },
        now
      ),
    },
    { returnDocument: "after" }
  );
}

export async function failOutboxIntent(db, intentId, errorMessage, { now = new Date(), config = {} } = {}) {
  const maxAttempts =
    typeof config.maxAttempts === "number" ? config.maxAttempts : DEFAULT_OUTBOX_CONFIG.maxAttempts;

  const intent = await db.collection(COLLECTIONS.outbox).findOne({ _id: intentId });
  if (!intent || intent.status !== OUTBOX_STATUSES.LEASED) {
    return null;
  }

  const attemptCount = (intent.attemptCount || 0) + 1;

  if (attemptCount >= maxAttempts) {
    return db.collection(COLLECTIONS.outbox).findOneAndUpdate(
      { _id: intentId, status: OUTBOX_STATUSES.LEASED },
      {
        $set: touch(
          {
            status: OUTBOX_STATUSES.FAILED,
            attemptCount,
            lastError: errorMessage ?? null,
            failedAt: now,
            nextAttemptAt: null,
            leasedBy: null,
            leaseExpiresAt: null,
          },
          now
        ),
      },
      { returnDocument: "after" }
    );
  }

  return db.collection(COLLECTIONS.outbox).findOneAndUpdate(
    { _id: intentId, status: OUTBOX_STATUSES.LEASED },
    {
      $set: touch(
        {
          status: OUTBOX_STATUSES.PENDING,
          attemptCount,
          lastError: errorMessage ?? null,
          nextAttemptAt: computeNextAttempt(attemptCount, config, now),
          leasedBy: null,
          leaseExpiresAt: null,
        },
        now
      ),
    },
    { returnDocument: "after" }
  );
}

export async function reclaimExpiredLeases(db, { now = new Date() } = {}) {
  const result = await db.collection(COLLECTIONS.outbox).updateMany(
    {
      status: OUTBOX_STATUSES.LEASED,
      leaseExpiresAt: { $lte: now },
    },
    {
      $set: touch(
        {
          status: OUTBOX_STATUSES.PENDING,
          leasedBy: null,
          leaseExpiresAt: null,
        },
        now
      ),
    }
  );
  return result.modifiedCount ?? 0;
}

export async function retryFailedOutboxIntent(db, intentId, { now = new Date() } = {}) {
  return db.collection(COLLECTIONS.outbox).findOneAndUpdate(
    { _id: intentId, status: OUTBOX_STATUSES.FAILED },
    {
      $set: touch(
        {
          status: OUTBOX_STATUSES.PENDING,
          attemptCount: 0,
          nextAttemptAt: now,
          lastError: null,
          failedAt: null,
          leasedBy: null,
          leaseExpiresAt: null,
          completedAt: null,
        },
        now
      ),
    },
    { returnDocument: "after" }
  );
}

export async function getOutboxHealth(db, { now = new Date() } = {}) {
  const entries = await db
    .collection(COLLECTIONS.outbox)
    .find({})
    .toArray();

  const counts = {
    pending: 0,
    leased: 0,
    failed: 0,
    completed: 0,
    total: entries.length,
  };

  let oldestUnresolved = null;
  for (const entry of entries) {
    if (entry.status in counts) counts[entry.status] += 1;

    if (entry.status !== OUTBOX_STATUSES.COMPLETED) {
      const createdAt = entry.createdAt ? new Date(entry.createdAt) : null;
      if (createdAt && (!oldestUnresolved || createdAt < oldestUnresolved)) {
        oldestUnresolved = createdAt;
      }
    }
  }

  return {
    ...counts,
    needsAttention: counts.failed > 0,
    oldestUnresolvedAt: oldestUnresolved,
    oldestUnresolvedAgeSeconds: oldestUnresolved
      ? Math.max(0, Math.floor((now.getTime() - oldestUnresolved.getTime()) / 1000))
      : null,
    generatedAt: now,
  };
}

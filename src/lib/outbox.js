import { ObjectId } from "mongodb";

export const OUTBOX_STATUS = {
  PENDING: "pending",
  COMPLETED: "completed",
  DEAD_LETTER: "dead_letter",
};

export const OUTBOX_EVENT_TYPES = {
  GRANT_ENTITLEMENT: "grant_entitlement",
  SEND_PURCHASE_WEBHOOK: "send_purchase_webhook",
  SEND_WELCOME_EMAIL: "send_welcome_email", // Example
};

export async function insertOutboxEvent(db, session, { type, payload, idempotencyKey }) {
  const collection = db.collection("outbox");
  const event = {
    type,
    payload,
    idempotencyKey,
    status: OUTBOX_STATUS.PENDING,
    lockedUntil: null,
    retries: 0,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // If using idempotency key, we could potentially do an upsert or ignore if exists,
  // but for outbox, inserting duplicate keys can be handled if we have a unique index on idempotencyKey.
  // We'll just insert, assuming the caller passes a truly unique key per action.
  await collection.insertOne(event, { session });
}

export async function pollOutbox(db, limit = 10, leaseDurationMs = 30000) {
  const collection = db.collection("outbox");
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + leaseDurationMs);

  // Find events that are PENDING and either not locked or the lock has expired
  const query = {
    status: OUTBOX_STATUS.PENDING,
    $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
  };

  // We need to fetch and lock atomically. Using findOneAndUpdate in a loop or updating multiple.
  // To update multiple and return them, we can do an updateMany and then find, but that's not atomic for concurrent workers.
  // We'll use findOneAndUpdate for each, up to limit.
  const events = [];
  for (let i = 0; i < limit; i++) {
    const result = await collection.findOneAndUpdate(
      query,
      { $set: { lockedUntil, updatedAt: new Date() } },
      { sort: { createdAt: 1 }, returnDocument: "after" }
    );
    if (result) {
      events.push(result);
    } else {
      break; // No more events
    }
  }

  return events;
}

export async function completeOutboxEvent(db, eventId) {
  const collection = db.collection("outbox");
  await collection.updateOne(
    { _id: new ObjectId(eventId) },
    {
      $set: {
        status: OUTBOX_STATUS.COMPLETED,
        lockedUntil: null,
        updatedAt: new Date(),
      },
    }
  );
}

export async function failOutboxEvent(db, eventId, errorMsg, maxRetries = 5) {
  const collection = db.collection("outbox");
  const event = await collection.findOne({ _id: new ObjectId(eventId) });
  if (!event) return;

  const retries = (event.retries || 0) + 1;
  const isDead = retries >= maxRetries;

  // Bounded exponential backoff: 2s, 4s, 8s, 16s, 32s (max 60s)
  const backoffDelay = Math.min(Math.pow(2, retries) * 1000, 60000);
  const nextRetry = new Date(Date.now() + backoffDelay);

  await collection.updateOne(
    { _id: new ObjectId(eventId) },
    {
      $set: {
        status: isDead ? OUTBOX_STATUS.DEAD_LETTER : OUTBOX_STATUS.PENDING,
        retries,
        lastError: errorMsg,
        // Release the lease but delay next execution via lockedUntil if not dead
        lockedUntil: isDead ? null : nextRetry,
        updatedAt: new Date(),
      },
    }
  );
}

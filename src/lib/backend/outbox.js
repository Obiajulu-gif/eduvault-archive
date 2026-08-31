import { getDb } from '../mongodb.js';
import { v4 as uuidv7 } from 'uuid';
import { auditLog } from '../api/audit.js';
import { slidingWindowRateLimit } from '../rateLimit.js';

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

  // If the predecessor was already delivered before this successor was even
  // enqueued (issue #635 — e.g. a very fast worker delivers effect N before
  // effect N+1's caller finishes building it), `markDelivered`'s "unblock
  // waiting successors" update ran too early to reach this row, since it
  // didn't exist yet. Checking the predecessor's current status here closes
  // that gap — without it, a successor enqueued after its predecessor
  // already delivered would stay gated (`predecessorDelivered: false`)
  // forever, since no future delivery re-triggers the unblock.
  let predecessorDelivered = !previousDeliveryId;
  if (previousDeliveryId) {
    const predecessor = await database
      .collection(OUTBOX_COLLECTION)
      .findOne({ deliveryId: previousDeliveryId }, { projection: { status: 1 } });
    predecessorDelivered = predecessor?.status === 'delivered';
  }

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
    predecessorDelivered,
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
      nextAttemptAt: { $lte: now },
      // Two independent $or conditions can't both be object keys named
      // "$or" (the second silently overwrote the first) — combined under
      // $and so both the lease-availability check and the causal-ordering
      // gate actually apply.
      //
      // Lease-availability also has to match `status: 'pending'` OR
      // (`status: 'leased'` AND its lease has expired) — a lease that
      // expired without an explicit reset stays `status: 'leased'`
      // forever, so requiring `status: 'pending'` unconditionally (as a
      // top-level field alongside this $and, rather than inside it) meant
      // an expired lease could never actually be reclaimed.
      $and: [
        {
          $or: [
            { status: 'pending' },
            { status: 'leased', leaseExpiresAt: { $lte: now } },
          ],
        },
        // Causal gating: never lease an effect before its predecessor has
        // been delivered, so effects for one source stay in version order.
        {
          $or: [
            { previousDeliveryId: null },
            { predecessorDelivered: true },
          ],
        },
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

  // MongoDB Node driver v6 returns the matched document directly from
  // findOneAndUpdate (or null) unless `includeResultMetadata: true` is
  // passed — it no longer wraps the result in a `{ value }` envelope by
  // default (that was the v4/v5 behavior). `claimed` here IS the document.
  if (!claimed) return null;

  const intent = claimed;
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

  // Filtering on `status: { $ne: 'delivered' }` (not just matching on
  // _id/deliveryId) is what actually makes this idempotent: without it, a
  // duplicate acknowledgement still matches (same _id/deliveryId) and the
  // caller can't tell a fresh delivery from a no-op replay apart just from
  // the return value (issue #635 — receivers need to be able to detect
  // deduplication, not just "the write didn't error").
  const result = await db.collection(OUTBOX_COLLECTION).updateOne(
    { _id: intentId, deliveryId, status: { $ne: 'delivered' } },
    {
      $set: {
        status: 'delivered',
        deliveredAt: now,
        updatedAt: now,
      },
    }
  );

  if (result.matchedCount === 0) {
    // Either no such intent exists, or it was already delivered — a
    // duplicate acknowledgement (e.g. crash after send) must be a no-op and
    // not silently flip state. Return without error so the caller can treat
    // it as idempotent.
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
 * Compute the next causal-chain link for a new effect on a source aggregate
 * (issue #635): the next monotonic `sourceVersion` and the `deliveryId` of
 * the most recently enqueued effect for the same source, to pass through as
 * `previousDeliveryId` so the new effect can't be leased ahead of it.
 *
 * Callers that don't need cross-event ordering for a given aggregate (e.g. a
 * one-off, non-webhook side effect) can skip this and call
 * `enqueueSideEffect` without version/predecessor fields, as before.
 */
export async function getNextCausalLink(sourceAggregate, sourceId) {
  const db = await getDb();
  const latest = await db
    .collection(OUTBOX_COLLECTION)
    .find({ sourceAggregate, sourceId })
    .sort({ sourceVersion: -1, createdAt: -1 })
    .limit(1)
    .toArray();

  const previous = latest[0];
  const previousVersion = typeof previous?.sourceVersion === 'number' ? previous.sourceVersion : 0;

  return {
    sourceVersion: previousVersion + 1,
    previousDeliveryId: previous?.deliveryId || null,
  };
}

/**
 * Report the highest contiguously-delivered sourceVersion for an aggregate
 * and any gap in the sequence (issue #635): a receiver that only sees
 * `traceSourceEffects` output has to reconstruct this itself; this computes
 * it directly so a subscriber-facing "what's missing" check is cheap.
 *
 * Only versioned effects (`sourceVersion` not null) are considered — legacy
 * unversioned effects predate ordering support and can't be sequenced.
 */
export async function findSequenceGap(sourceAggregate, sourceId) {
  const effects = await traceSourceEffects(sourceAggregate, sourceId);
  const versioned = effects.filter((e) => typeof e.sourceVersion === 'number');

  if (versioned.length === 0) {
    return { highestContiguousVersion: null, gapAt: null, deliveredCount: 0 };
  }

  let highestContiguousVersion = null;
  let gapAt = null;
  let deliveredCount = 0;
  let expected = versioned[0].sourceVersion;

  for (const effect of versioned) {
    if (effect.sourceVersion !== expected) {
      gapAt = expected;
      break;
    }
    if (effect.status === 'delivered') {
      highestContiguousVersion = effect.sourceVersion;
      deliveredCount += 1;
    } else {
      // Not yet delivered — the contiguous-delivered run stops here, but
      // this isn't a "gap" (a missing version), it's pending delivery.
      break;
    }
    expected += 1;
  }

  return { highestContiguousVersion, gapAt, deliveredCount };
}

const REPLAY_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

function assertReplayAuthorized(authorizedBy) {
  if (!authorizedBy || typeof authorizedBy !== 'string') {
    throw new Error('Replay requires an authorizedBy identifier for audit purposes');
  }

  const { allowed, retryAfter } = slidingWindowRateLimit(`outbox-replay:${authorizedBy}`, REPLAY_RATE_LIMIT);
  if (!allowed) {
    throw new Error(`Replay rate limit exceeded for ${authorizedBy}; retry after ${retryAfter}s`);
  }
}

/**
 * Replay controls (issue #633, hardened for #635): re-enqueue dead-letter
 * effects. Causal gating is preserved because `previousDeliveryId`/
 * `predecessorDelivered` are left intact — a successor only becomes
 * claimable after its predecessor replays. `sourceVersion` is never
 * modified, so replay cannot renumber events.
 *
 * Requires `authorizedBy` (the operator/system identity triggering the
 * replay) — this is audited and rate-limited per identity.
 */
export async function replayDeadLetters(limit = 100, authorizedBy) {
  assertReplayAuthorized(authorizedBy);

  const db = await getDb();
  const now = new Date();

  const candidates = await db
    .collection(OUTBOX_COLLECTION)
    .find({ status: 'dead_letter', deliveredAt: null })
    .limit(limit)
    .toArray();

  if (candidates.length === 0) {
    auditLog({ event: 'outbox_replay_dead_letters', actor: authorizedBy, reason: 'no_candidates' });
    return 0;
  }

  const result = await db.collection(OUTBOX_COLLECTION).updateMany(
    { _id: { $in: candidates.map((c) => c._id) } },
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

  auditLog({
    event: 'outbox_replay_dead_letters',
    actor: authorizedBy,
    reason: `replayed_${result.modifiedCount}`,
  });
  return result.modifiedCount;
}

/**
 * Replay every effect for a single source in version order. Used when an
 * operator needs to re-derive the full side-effect chain for one
 * purchase/material after a partial outage. Ordering is preserved by the
 * causal gate, not by the replay loop itself — `sourceVersion` is left
 * untouched, so replay cannot renumber events.
 *
 * Requires `authorizedBy` — audited and rate-limited per identity, same as
 * `replayDeadLetters`.
 */
export async function replaySource(sourceAggregate, sourceId, authorizedBy) {
  assertReplayAuthorized(authorizedBy);

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

  auditLog({
    event: 'outbox_replay_source',
    actor: authorizedBy,
    reason: `replayed_${effects.length}`,
    correlationId: `${sourceAggregate}:${sourceId}`,
  });

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

export async function getOutboxHealth(db) {
  const database = db || await getDb();
  const now = new Date();

  const statusCounts = await database.collection(OUTBOX_COLLECTION).aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const byStatus = Object.fromEntries(statusCounts.map(s => [s._id, s.count]));

  const oldestUnresolved = await database.collection(OUTBOX_COLLECTION)
    .find({ status: { $ne: 'delivered' } })
    .sort({ createdAt: 1 })
    .limit(1)
    .toArray();

  let oldestUnresolvedAgeMs = 0;
  if (oldestUnresolved.length > 0) {
    oldestUnresolvedAgeMs = now.getTime() - oldestUnresolved[0].createdAt.getTime();
  }

  return {
    pending: byStatus['pending'] || 0,
    leased: byStatus['leased'] || 0,
    failed: byStatus['dead_letter'] || 0,
    delivered: byStatus['delivered'] || 0,
    oldestUnresolvedAgeMs,
  };
}
export async function retryFailedOutboxEntry(db, entryId, authorizedBy) {
  const database = db || await getDb();
  
  if (!authorizedBy) {
    throw new Error('Retry requires an authorizedBy identifier for audit purposes');
  }

  const intent = await database.collection(OUTBOX_COLLECTION).findOne({ _id: entryId });
  if (!intent) return { outcome: 'not_found' };
  
  if (intent.status !== 'dead_letter') {
    return { outcome: 'not_failed', intent };
  }

  const now = new Date();
  
  const result = await database.collection(OUTBOX_COLLECTION).findOneAndUpdate(
    { _id: entryId, status: 'dead_letter' },
    {
      $set: {
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        lastError: `Manual retry by ${authorizedBy}`,
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  );

  if (result) {
    auditLog({
      event: 'outbox_manual_retry',
      actor: authorizedBy,
      intentId: String(entryId),
      deliveryId: intent.deliveryId
    });
    return { outcome: 'retried', intent: result };
  }

  return { outcome: 'conflict' };
}

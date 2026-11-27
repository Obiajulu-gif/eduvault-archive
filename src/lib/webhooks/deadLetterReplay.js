import { ObjectId } from 'mongodb';
import { withIdempotency } from '@/lib/backend/idempotency';
import { sendWebhookWithRetry } from '@/lib/webhooks/sender';

export const OUTBOX_COLLECTION = 'side_effect_outbox';
export const REPLAY_IDEMPOTENCY_PREFIX = 'webhook-dlq-replay:';
export const DEFAULT_REPLAY_RETRIES = 3;
export const MAX_BATCH_LIMIT = 50;

export class WebhookReplayError extends Error {
  constructor(message, { code = 'WEBHOOK_REPLAY_ERROR', status = 500, details = {} } = {}) {
    super(message);
    this.name = 'WebhookReplayError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class WebhookReplayAuthorizationError extends WebhookReplayError {
  constructor(message = 'Authorized operator is required to replay dead-letter webhooks', details = {}) {
    super(message, { code: 'WEBHOOK_REPLAY_FORBIDDEN', status: 403, details });
    this.name = 'WebhookReplayAuthorizationError';
  }
}

export class WebhookReplayValidationError extends WebhookReplayError {
  constructor(message, details = {}) {
    super(message, { code: 'WEBHOOK_REPLAY_INVALID_INPUT', status: 400, details });
    this.name = 'WebhookReplayValidationError';
  }
}

export class WebhookReplayNotFoundError extends WebhookReplayError {
  constructor(identifier) {
    super(`Dead-letter webhook entry not found: ${identifier}`, {
      code: 'WEBHOOK_REPLAY_NOT_FOUND',
      status: 404,
      details: { identifier },
    });
    this.name = 'WebhookReplayNotFoundError';
  }
}

export class WebhookReplayStateError extends WebhookReplayError {
  constructor(message, details = {}) {
    super(message, { code: 'WEBHOOK_REPLAY_INVALID_STATE', status: 409, details });
    this.name = 'WebhookReplayStateError';
  }
}

export class WebhookReplayDeliveryError extends WebhookReplayError {
  constructor(message, details = {}) {
    super(message, { code: 'WEBHOOK_REPLAY_DELIVERY_FAILED', status: 502, details });
    this.name = 'WebhookReplayDeliveryError';
  }
}

function defaultAuthorize(actor) {
  if (!actor) return false;
  const role = typeof actor.role === 'string' ? actor.role.toLowerCase() : '';
  return actor.isAdmin === true || role === 'admin' || role === 'operator';
}

function buildEntryFilter({ entryId, deliveryId }) {
  if (entryId) {
    if (entryId instanceof ObjectId) {
      return { _id: entryId };
    }
    if (typeof entryId === 'string' && ObjectId.isValid(entryId)) {
      return { _id: new ObjectId(entryId) };
    }
    return { _id: entryId };
  }
  if (deliveryId && typeof deliveryId === 'string') {
    return { deliveryId };
  }
  throw new WebhookReplayValidationError('Either entryId or deliveryId is required');
}

function normalizeIdempotencyKey(rawKey) {
  if (typeof rawKey !== 'string' || !rawKey.trim()) {
    throw new WebhookReplayValidationError(
      'An idempotencyKey is required for dead-letter webhook replay'
    );
  }
  const trimmed = rawKey.trim();
  return trimmed.startsWith(REPLAY_IDEMPOTENCY_PREFIX)
    ? trimmed
    : `${REPLAY_IDEMPOTENCY_PREFIX}${trimmed}`;
}

async function emitAudit(audit, event) {
  if (typeof audit !== 'function') return;
  try {
    await audit(event);
  } catch {
    // Audit logging must not mask replay outcomes
  }
}

/**
 * List dead-lettered webhook entries for operator inspection.
 */
export async function listDeadLetterWebhooks(
  db,
  { actor, authorize = defaultAuthorize, limit = 25, skip = 0 } = {}
) {
  const allowed = await authorize(actor, 'webhook-dlq:list');
  if (allowed !== true) {
    throw new WebhookReplayAuthorizationError();
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), MAX_BATCH_LIMIT);
  const safeSkip = Math.max(Number(skip) || 0, 0);

  const cursor = db
    .collection(OUTBOX_COLLECTION)
    .find({ status: 'dead_letter', 'intent.type': 'webhook' })
    .sort({ updatedAt: -1 })
    .skip(safeSkip)
    .limit(safeLimit);

  const items = await cursor.toArray();
  return { items, count: items.length, limit: safeLimit, skip: safeSkip };
}

/**
 * Replay a single dead-lettered webhook entry with strict authorization
 * and idempotency guards.
 *
 * Behavior:
 * - Authorization is checked BEFORE touching the idempotency store or outbox.
 * - `withIdempotency` guarantees:
 *   1. Completed replays with the same key & payload return `{ ...result, replayed: true }`
 *      without re-sending webhooks.
 *   2. Concurrent in-flight replays with the same key throw `CONFLICT_IN_PROGRESS` (409).
 *   3. Same key with a different target/payload throws `CONFLICT_IDEMPOTENCY_KEY` (409).
 *   4. Failed deliveries mark the idempotency key `failed`, allowing safe retry with the
 *      same key. Already-delivered URLs are tracked on the outbox entry so retries only
 *      re-attempt failed URLs.
 */
export async function replayDeadLetterWebhook(
  db,
  {
    entryId,
    deliveryId,
    idempotencyKey,
    actor,
    authorize = defaultAuthorize,
    deliver = sendWebhookWithRetry,
    audit = async () => {},
    retries = DEFAULT_REPLAY_RETRIES,
    reason = 'manual_operator_replay',
    clock = () => new Date(),
    lockMs,
    ttlMs,
  } = {}
) {
  const allowed = await authorize(actor, 'webhook-dlq:replay', { entryId, deliveryId });
  if (allowed !== true) {
    await emitAudit(audit, {
      action: 'webhook_dlq_replay_denied',
      actorId: actor?.id ?? actor?.sub ?? null,
      entryId: entryId ? String(entryId) : null,
      deliveryId: deliveryId ?? null,
      at: clock(),
    });
    throw new WebhookReplayAuthorizationError();
  }

  const filter = buildEntryFilter({ entryId, deliveryId });
  const scopedKey = normalizeIdempotencyKey(idempotencyKey);
  const identifier = String(entryId ?? deliveryId);

  const idempotencyPayload = {
    entryId: entryId ? String(entryId) : null,
    deliveryId: deliveryId ?? null,
    reason,
  };

  const { result, replayed } = await withIdempotency(
    db,
    scopedKey,
    idempotencyPayload,
    async () => {
      const collection = db.collection(OUTBOX_COLLECTION);
      const entry = await collection.findOne(filter);

      if (!entry) {
        throw new WebhookReplayNotFoundError(identifier);
      }

      if (entry.intent?.type !== 'webhook') {
        throw new WebhookReplayValidationError('Outbox entry is not a webhook intent', {
          entryId: String(entry._id),
          intentType: entry.intent?.type ?? null,
        });
      }

      if (entry.status !== 'dead_letter') {
        throw new WebhookReplayStateError(
          `Outbox entry is in '${entry.status}' state; only 'dead_letter' entries can be replayed`,
          { entryId: String(entry._id), status: entry.status }
        );
      }

      const urls = Array.isArray(entry.intent?.payload?.urls) ? entry.intent.payload.urls : [];
      if (urls.length === 0) {
        throw new WebhookReplayValidationError('Webhook entry has no target URLs to replay', {
          entryId: String(entry._id),
        });
      }

      const webhookPayload = entry.intent.payload.payload;
      const signingSecret = entry.intent.payload.signingSecret;
      const alreadyDelivered = new Set(
        Array.isArray(entry.replayDeliveredUrls) ? entry.replayDeliveredUrls : []
      );
      const pendingUrls = urls.filter((url) => !alreadyDelivered.has(url));

      const deliveredNow = [];
      const failedUrls = [];

      for (const url of pendingUrls) {
        let ok = false;
        let errorMessage = null;
        try {
          ok = Boolean(await deliver(url, webhookPayload, retries, { signingSecret }));
        } catch (err) {
          ok = false;
          errorMessage = err?.message || 'Delivery threw an error';
        }

        if (ok) {
          deliveredNow.push(url);
          alreadyDelivered.add(url);
        } else {
          failedUrls.push({
            url,
            error: errorMessage || 'Webhook delivery returned false after retries',
          });
        }
      }

      const now = clock();
      const actorId = actor?.id ?? actor?.sub ?? 'unknown';
      const allDeliveredUrls = Array.from(alreadyDelivered);

      if (failedUrls.length > 0) {
        // Keep entry in dead_letter state and persist partial progress so a retry
        // with the same idempotency key only re-attempts the remaining failed URLs.
        await collection.updateOne(
          { _id: entry._id, status: 'dead_letter' },
          {
            $set: {
              replayDeliveredUrls: allDeliveredUrls,
              lastReplayAt: now,
              lastReplayBy: actorId,
              lastReplayError: failedUrls.map((f) => `${f.url}: ${f.error}`).join('; '),
              lastReplayKey: scopedKey,
              updatedAt: now,
            },
            $inc: { replayAttempts: 1 },
          }
        );

        await emitAudit(audit, {
          action: 'webhook_dlq_replay_failed',
          actorId,
          entryId: String(entry._id),
          deliveryId: entry.deliveryId ?? null,
          deliveredUrls: deliveredNow,
          failedUrls,
          idempotencyKey: scopedKey,
          at: now,
        });

        throw new WebhookReplayDeliveryError(
          `Failed to deliver webhook replay to ${failedUrls.length} of ${urls.length} destination(s)`,
          {
            entryId: String(entry._id),
            deliveryId: entry.deliveryId ?? null,
            deliveredUrls: allDeliveredUrls,
            failedUrls,
          }
        );
      }

      // All destinations succeeded — transition entry atomically to delivered.
      const updateResult = await collection.updateOne(
        { _id: entry._id, status: 'dead_letter' },
        {
          $set: {
            status: 'delivered',
            deliveredAt: now,
            replayDeliveredUrls: allDeliveredUrls,
            lastReplayAt: now,
            lastReplayBy: actorId,
            lastReplayError: null,
            lastReplayKey: scopedKey,
            lastError: null,
            updatedAt: now,
          },
          $inc: { replayAttempts: 1 },
        }
      );

      if (updateResult.modifiedCount === 0) {
        throw new WebhookReplayStateError(
          'Outbox entry state changed concurrently during replay',
          { entryId: String(entry._id) }
        );
      }

      // Unblock any causal successors waiting on this deliveryId
      if (entry.deliveryId) {
        await collection.updateMany(
          { previousDeliveryId: entry.deliveryId },
          { $set: { predecessorDelivered: true, updatedAt: now } }
        );
      }

      await emitAudit(audit, {
        action: 'webhook_dlq_replay_succeeded',
        actorId,
        entryId: String(entry._id),
        deliveryId: entry.deliveryId ?? null,
        deliveredUrls: allDeliveredUrls,
        idempotencyKey: scopedKey,
        reason,
        at: now,
      });

      return {
        entryId: String(entry._id),
        deliveryId: entry.deliveryId ?? null,
        status: 'delivered',
        deliveredUrls: allDeliveredUrls,
        replayedAt: now.toISOString(),
        idempotencyKey: scopedKey,
      };
    },
    { clock, ...(lockMs ? { lockMs } : {}), ...(ttlMs ? { ttlMs } : {}) }
  );

  return { ...result, replayed };
}

/**
 * Replay a batch of dead-lettered webhook entries with per-entry idempotency keys
 * derived from the batch idempotency key so partial batch failures can be retried
 * safely without duplicating already-succeeded entries.
 */
export async function replayDeadLetterWebhooksBatch(
  db,
  {
    entryIds = [],
    idempotencyKey,
    actor,
    authorize = defaultAuthorize,
    deliver = sendWebhookWithRetry,
    audit = async () => {},
    retries = DEFAULT_REPLAY_RETRIES,
    reason = 'batch_operator_replay',
    clock = () => new Date(),
  } = {}
) {
  const allowed = await authorize(actor, 'webhook-dlq:replay-batch', { count: entryIds.length });
  if (allowed !== true) {
    throw new WebhookReplayAuthorizationError();
  }

  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    throw new WebhookReplayValidationError('entryIds must be a non-empty array');
  }
  if (entryIds.length > MAX_BATCH_LIMIT) {
    throw new WebhookReplayValidationError(`Batch size cannot exceed ${MAX_BATCH_LIMIT}`);
  }

  const baseKey = normalizeIdempotencyKey(idempotencyKey);
  const results = [];
  let succeeded = 0;
  let replayed = 0;
  let failed = 0;

  for (const id of entryIds) {
    const itemKey = `${baseKey}:${String(id)}`;
    try {
      const outcome = await replayDeadLetterWebhook(db, {
        entryId: id,
        idempotencyKey: itemKey,
        actor,
        authorize: () => true, // already authorized at batch level
        deliver,
        audit,
        retries,
        reason,
        clock,
      });
      if (outcome.replayed) replayed += 1;
      else succeeded += 1;
      results.push({ entryId: String(id), ok: true, ...outcome });
    } catch (error) {
      failed += 1;
      results.push({
        entryId: String(id),
        ok: false,
        code: error.code || 'WEBHOOK_REPLAY_ERROR',
        error: error.message,
      });
    }
  }

  return {
    total: entryIds.length,
    succeeded,
    replayed,
    failed,
    results,
  };
}

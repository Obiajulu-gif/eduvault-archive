import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '@/lib/mongodb';
import { logger } from '@/lib/logger';
import { ensureCorrelationId } from '@/lib/monitoring/telemetry';
import { validateWebhookDestination, safeFetch, SsrfError } from './ssrfGuard';

const replayCache = new Map();
const DEFAULT_REPLAY_TTL_SECONDS = 300;
const DEFAULT_ROTATION_GRACE_SECONDS = 86400;

// ─── Replay-window enforcement — Issue #1096 ─────────────────────────────
//
// A per-endpoint configurable replay-window enforcer that:
//   - Accepts a custom `replayWindowSeconds` per receiver instance so
//     high-throughput endpoints can use a tighter window and low-volume ones
//     a broader grace period.
//   - Rejects delivery when the signed timestamp falls outside the window
//     (future-dated and past-dated payloads both rejected).
//   - Tracks seen signatures in an internal LRU-like map; evicts expired
//     entries on every verify call to bound memory.
//   - Exposes `stats()` for observability and `clear()` for test isolation.
//   - Treats missing, malformed, or unsigned headers as rejections.

export class ReplayWindowViolationError extends Error {
  constructor(reason) {
    super(`Webhook replay-window violation: ${reason}`);
    this.name = 'ReplayWindowViolationError';
    this.code = 'REPLAY_WINDOW_VIOLATION';
    this.reason = reason;
    this.status = 400;
  }
}

/**
 * Create a stateful replay-window enforcer for a webhook receiver.
 *
 * @param {object} [options]
 * @param {number}   [options.replayWindowSeconds=300]  Symmetric skew window (past and future).
 * @param {number}   [options.maxCacheSize=10000]       Max signatures held before forced eviction.
 * @param {Function} [options.now]                       Injectable clock: () => unix seconds.
 * @returns {{ verify, stats, clear }}
 */
export function createReplayWindowEnforcer({
  replayWindowSeconds = DEFAULT_REPLAY_TTL_SECONDS,
  maxCacheSize = 10_000,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!Number.isFinite(replayWindowSeconds) || replayWindowSeconds <= 0) {
    throw new TypeError('replayWindowSeconds must be a positive number');
  }

  // signature → expiresAt (unix seconds)
  const seen = new Map();
  let _accepted = 0;
  let _rejectedExpired = 0;
  let _rejectedReplay = 0;
  let _rejectedMalformed = 0;

  function evictExpired(nowSec) {
    for (const [key, expiresAt] of seen.entries()) {
      if (expiresAt <= nowSec) seen.delete(key);
    }
  }

  function enforceMaxSize() {
    if (seen.size < maxCacheSize) return;
    // Evict oldest entries (insertion order) until below limit
    const toDelete = seen.size - Math.floor(maxCacheSize * 0.8);
    let deleted = 0;
    for (const key of seen.keys()) {
      if (deleted >= toDelete) break;
      seen.delete(key);
      deleted++;
    }
  }

  /**
   * Verify a signed webhook delivery against the replay window.
   *
   * @param {string} body              Raw request body string.
   * @param {string} signatureHeader   Value of the X-EduVault-Signature header.
   * @param {string} secret            Expected signing secret.
   * @returns {true}                   On success.
   * @throws {ReplayWindowViolationError}  On any rejection.
   */
  function verify(body, signatureHeader, secret) {
    const nowSec = now();
    evictExpired(nowSec);

    if (!body || !signatureHeader || !secret) {
      _rejectedMalformed++;
      throw new ReplayWindowViolationError('missing body, signature header, or secret');
    }

    // Parse "t=<ts>,v1=<hex>" header
    let timestamp;
    let signature;
    try {
      const parts = Object.fromEntries(
        signatureHeader.split(',').map((p) => {
          const eq = p.indexOf('=');
          return [p.slice(0, eq), p.slice(eq + 1)];
        }),
      );
      timestamp = Number(parts.t);
      signature = parts.v1;
    } catch {
      _rejectedMalformed++;
      throw new ReplayWindowViolationError('malformed signature header');
    }

    if (!Number.isFinite(timestamp) || !signature) {
      _rejectedMalformed++;
      throw new ReplayWindowViolationError('malformed signature header fields');
    }

    // Skew check: reject if the timestamp is outside ±replayWindowSeconds
    const skew = Math.abs(nowSec - timestamp);
    if (skew > replayWindowSeconds) {
      _rejectedExpired++;
      throw new ReplayWindowViolationError(
        `timestamp is ${skew}s away from server time; window is ±${replayWindowSeconds}s`,
      );
    }

    // Replay check: reject if we have already processed this exact signature
    const cacheKey = signatureHeader;
    if (seen.has(cacheKey)) {
      _rejectedReplay++;
      throw new ReplayWindowViolationError('replayed signature already processed');
    }

    // HMAC verification
    const signedPayload = `${timestamp}.${body}`;
    const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(signature, 'hex');
    const valid =
      expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf);

    if (!valid) {
      _rejectedMalformed++;
      throw new ReplayWindowViolationError('HMAC signature mismatch');
    }

    // Record the signature so it cannot be replayed within the window
    enforceMaxSize();
    seen.set(cacheKey, timestamp + replayWindowSeconds);
    _accepted++;
    return true;
  }

  function stats() {
    return {
      replayWindowSeconds,
      cacheSize: seen.size,
      accepted: _accepted,
      rejectedExpired: _rejectedExpired,
      rejectedReplay: _rejectedReplay,
      rejectedMalformed: _rejectedMalformed,
    };
  }

  function clear() {
    seen.clear();
    _accepted = 0;
    _rejectedExpired = 0;
    _rejectedReplay = 0;
    _rejectedMalformed = 0;
  }

  return { verify, stats, clear };
}

// ─── End replay-window enforcement ───────────────────────────────────────

function replayCacheKey(signatureHeader) {
  return signatureHeader;
}

function pruneReplayCache(nowSeconds) {
  for (const [key, expiresAt] of replayCache.entries()) {
    if (expiresAt <= nowSeconds) replayCache.delete(key);
  }
}

function rememberSignature(signatureHeader, timestamp, ttlSeconds = DEFAULT_REPLAY_TTL_SECONDS) {
  const expiresAt = timestamp + ttlSeconds;
  replayCache.set(replayCacheKey(signatureHeader), expiresAt);
  pruneReplayCache(timestamp);
}

function isReplayedSignature(signatureHeader, nowSeconds) {
  const expiresAt = replayCache.get(replayCacheKey(signatureHeader));
  return typeof expiresAt === 'number' && expiresAt > nowSeconds;
}

export function verifyWebhookSignatureWithRotation(
  body,
  signatureHeader,
  {
    currentSecret,
    previousSecret = null,
    previousSecretRotatedAt = null,
    toleranceSeconds = 300,
    now = Math.floor(Date.now() / 1000),
    rotationGraceSeconds = DEFAULT_ROTATION_GRACE_SECONDS,
  } = {},
) {
  if (!currentSecret) return false;
  if (isReplayedSignature(signatureHeader, now)) return false;

  const verifyOptions = { toleranceSeconds, now, replayCacheEnabled: false };
  if (verifyWebhookSignature(body, signatureHeader, currentSecret, verifyOptions)) {
    rememberSignature(signatureHeader, now, toleranceSeconds);
    return true;
  }

  if (
    previousSecret &&
    previousSecretRotatedAt &&
    now <= Math.floor(new Date(previousSecretRotatedAt).getTime() / 1000) + rotationGraceSeconds &&
    verifyWebhookSignature(body, signatureHeader, previousSecret, verifyOptions)
  ) {
    rememberSignature(signatureHeader, now, toleranceSeconds);
    return true;
  }

  return false;
}

export function clearWebhookReplayCache() {
  replayCache.clear();
}

export async function getDailyStats(db) {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const completedStatuses = ['confirmed', 'settled', 'completed'];

  const salesAgg = await (
    await db.collection('purchases').aggregate([
      {
        $match: {
          status: { $in: completedStatuses },
          purchasedAt: { $gte: yesterday, $lte: now },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: '$amount' } },
          count: { $sum: 1 },
        },
      },
    ])
  ).toArray();

  const signupsAgg = await (
    await db.collection('users').aggregate([
      {
        $match: {
          createdAt: { $gte: yesterday, $lte: now },
        },
      },
      { $count: 'count' },
    ])
  ).toArray();

  const activeMaterials = await db.collection('materials').countDocuments({
    visibility: { $ne: 'private' },
  });

  return {
    volume: salesAgg[0]?.total ?? 0,
    totalSales: salesAgg[0]?.count ?? 0,
    signups: signupsAgg[0]?.count ?? 0,
    activeMaterials,
  };
}

export function generateWebhookSigningSecret() {
  return randomBytes(32).toString('hex');
}

export function createWebhookSignatureHeader(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  if (!secret) return null;
  const signedPayload = `${timestamp}.${body}`;
  const signature = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

export function verifyWebhookSignature(body, signatureHeader, secret, { toleranceSeconds = 300, now = Math.floor(Date.now() / 1000), replayCacheEnabled = true } = {}) {
  if (!body || !signatureHeader || !secret) return false;
  const parts = Object.fromEntries(signatureHeader.split(',').map((part) => part.split('=')));
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) return false;
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;
  if (replayCacheEnabled && isReplayedSignature(signatureHeader, now)) return false;

  const expected = createWebhookSignatureHeader(body, secret, timestamp).split('v1=')[1];
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(signature, 'hex');
  const valid =
    expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);

  if (valid && replayCacheEnabled) {
    rememberSignature(signatureHeader, now, toleranceSeconds);
  }

  return valid;
}

async function ensureWebhookSigningSecret(db, creator) {
  if (creator.webhookSigningSecret) return creator.webhookSigningSecret;
  const secret = generateWebhookSigningSecret();
  await db.collection('users').updateOne(
    { _id: creator._id },
    {
      $set: {
        webhookSigningSecret: secret,
        webhookSigningSecretCreatedAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );
  return secret;
}

export async function sendWebhookWithRetry(url, payload, retries = 3, { signingSecret } = {}) {
  const body = JSON.stringify(payload);

  // Validate the destination against the SSRF/DNS-rebinding policy every time
  // we attempt delivery (delivery-time enforcement of issue #634). A host that
  // rebinds between registration and delivery is still caught here.
  try {
    await validateWebhookDestination(url);
  } catch (error) {
    if (error instanceof SsrfError) {
      logger.error({ code: error.code, url }, 'Webhook destination rejected by SSRF policy');
      return false;
    }
    throw error;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const signature = createWebhookSignatureHeader(body, signingSecret);
      const correlationId = ensureCorrelationId();

      const response = await safeFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'EduVault-Webhook-Sender/1.0',
          'X-Correlation-Id': correlationId,
          ...(signature ? { 'X-EduVault-Signature': signature } : {}),
        },
        body,
      });

      if (response.ok) {
        logger.info({ url }, 'Webhook sent successfully');
        return true;
      } else {
        logger.warn({ attempt, retries, status: response.status, statusText: response.statusText }, 'Webhook failed');
      }
    } catch (error) {
      if (error instanceof SsrfError) {
        logger.error({ code: error.code, url }, 'Webhook blocked by SSRF policy');
        return false;
      }
      logger.error({ attempt, retries, url, err: error }, 'Webhook error');
    }

    if (attempt < retries) {
      // Exponential backoff: 1s, 2s, 4s...
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  logger.error({ retries, url }, 'Webhook failed permanently');
  return false;
}

import { enqueueSideEffect, getNextCausalLink } from '@/lib/backend/outbox';

export async function broadcastPurchaseEvent(materialId, purchaseData) {
  try {
    const db = await getDb();
    
    // Find the material to get the creatorId
    const material = await db.collection('materials').findOne({ id: materialId });
    if (!material || !material.creatorId) return;

    // Find the creator's webhook URLs
    const creator = await db.collection('users').findOne({ 
      $or: [
        { id: material.creatorId },
        { _id: material.creatorId },
        { walletAddress: material.creatorId }
      ]
    });

    if (!creator || !creator.webhookUrls || !Array.isArray(creator.webhookUrls)) {
      return;
    }
    const signingSecret = await ensureWebhookSigningSecret(db, creator);

    const payload = {
      event: 'purchase.completed',
      data: {
        materialId,
        buyerAddress: purchaseData.buyerAddress,
        amount: purchaseData.amount,
        asset: purchaseData.asset,
        transactionHash: purchaseData.transactionHash,
        purchasedAt: new Date().toISOString()
      }
    };

    // Causal ordering (issue #635): link this delivery to the previous one
    // for the same material so purchase/refund/entitlement-change webhooks
    // for one subscriber can never be leased out of order, even under a
    // retry storm.
    const sourceAggregate = 'material';
    const sourceId = String(material._id || materialId);
    const { sourceVersion, previousDeliveryId } = await getNextCausalLink(sourceAggregate, sourceId);

    await enqueueSideEffect({
      sourceAggregate,
      sourceId,
      sourceVersion,
      previousDeliveryId,
      intent: {
        type: 'webhook',
        channel: 'purchase.completed',
        payload: {
          urls: creator.webhookUrls,
          payload,
          signingSecret,
        },
      },
    });

  } catch (error) {
    logger.error({ materialId, err: error }, 'Failed to enqueue purchase webhook');
  }
}

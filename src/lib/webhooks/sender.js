import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '@/lib/mongodb';
import { logger } from '@/lib/logger';
import { validateWebhookDestination, safeFetch, SsrfError } from './ssrfGuard';

const replayCache = new Map();
const DEFAULT_REPLAY_TTL_SECONDS = 300;
const DEFAULT_ROTATION_GRACE_SECONDS = 86400;

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
      logger.error(`Webhook destination rejected by SSRF policy (${error.code}): ${url}`);
      return false;
    }
    throw error;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const signature = createWebhookSignatureHeader(body, signingSecret);

      const response = await safeFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'EduVault-Webhook-Sender/1.0',
          ...(signature ? { 'X-EduVault-Signature': signature } : {}),
        },
        body,
      });

      if (response.ok) {
        logger.info(`Webhook sent successfully to ${url}`);
        return true;
      } else {
        logger.warn(`Webhook failed (Attempt ${attempt}/${retries}): ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      if (error instanceof SsrfError) {
        logger.error(`Webhook blocked by SSRF policy (${error.code}) for ${url}`);
        return false;
      }
      logger.error(`Webhook error (Attempt ${attempt}/${retries}) for ${url}: ${error.message}`);
    }

    if (attempt < retries) {
      // Exponential backoff: 1s, 2s, 4s...
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  logger.error(`Webhook failed permanently after ${retries} attempts for ${url}`);
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
    logger.error(`Failed to enqueue purchase webhook for material ${materialId}: ${error.message}`);
  }
}

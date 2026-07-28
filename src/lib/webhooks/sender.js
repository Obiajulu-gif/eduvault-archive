import { getDb } from '@/lib/mongodb';
import { logger } from '@/lib/logger';

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

export async function sendWebhookWithRetry(url, payload, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'EduVault-Webhook-Sender/1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        logger.info(`Webhook sent successfully to ${url}`);
        return true;
      } else {
        logger.warn(`Webhook failed (Attempt ${attempt}/${retries}): ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        logger.warn(`Webhook timeout (Attempt ${attempt}/${retries}) for ${url}`);
      } else {
        logger.error(`Webhook error (Attempt ${attempt}/${retries}) for ${url}: ${error.message}`);
      }
    }

    if (attempt < retries) {
      // Exponential backoff: 1s, 2s, 4s...
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  logger.error(`Webhook failed permanently after ${retries} attempts for ${url}`);
  return false;
}

import { enqueueSideEffect } from '@/lib/backend/outbox';

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

    await enqueueSideEffect({
      sourceAggregate: 'material',
      sourceId: String(material._id || materialId),
      intent: {
        type: 'webhook',
        channel: 'purchase.completed',
        payload: {
          urls: creator.webhookUrls,
          payload,
        },
      },
    });

  } catch (error) {
    logger.error(`Failed to enqueue purchase webhook for material ${materialId}: ${error.message}`);
  }
}

import { getDb } from '../mongodb.js';
import { logger } from '../logger.js';
import { COLLECTIONS } from '../backend/schemaContracts.js';
import { generateEventId, createWebhookPayload } from './signature.js';
import crypto from 'node:crypto';

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

export async function broadcastPurchaseEvent(materialId, purchaseData) {
  try {
    const db = await getDb();
    
    // Find the material to get the creatorId
    const material = await db.collection(COLLECTIONS.materials).findOne({ id: materialId });
    if (!material || !material.creatorId) return;

    // Find the creator's webhooks
    let webhooks = await db.collection(COLLECTIONS.webhooks).find({
      userId: material.creatorId,
      status: 'active'
    }).toArray();

    // Migration: if no webhooks but user has legacy webhookUrls, migrate them
    if (webhooks.length === 0) {
      const creator = await db.collection(COLLECTIONS.users).findOne({ 
        $or: [
          { id: material.creatorId },
          { _id: material.creatorId },
          { walletAddress: material.creatorId }
        ]
      });

      if (creator && creator.webhookUrls && Array.isArray(creator.webhookUrls)) {
        const newWebhooks = creator.webhookUrls.map(url => ({
          userId: material.creatorId,
          url,
          secrets: [{
            key: crypto.randomBytes(32).toString('hex'),
            createdAt: new Date(),
            expiresAt: null
          }],
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date()
        }));

        if (newWebhooks.length > 0) {
          await db.collection(COLLECTIONS.webhooks).insertMany(newWebhooks);
          webhooks = await db.collection(COLLECTIONS.webhooks).find({
            userId: material.creatorId,
            status: 'active'
          }).toArray();
        }
      }
    }

    if (!webhooks || webhooks.length === 0) {
      return;
    }

    const payloadData = {
      materialId,
      buyerAddress: purchaseData.buyerAddress,
      amount: purchaseData.amount,
      asset: purchaseData.asset,
      transactionHash: purchaseData.transactionHash,
      purchasedAt: new Date().toISOString()
    };

    const deliveriesCollection = db.collection(COLLECTIONS.webhookDeliveries);

    // Enqueue webhook deliveries for all active endpoints
    const promises = webhooks.map(async (webhook) => {
      const eventId = generateEventId();
      const payload = createWebhookPayload(eventId, 'purchase.completed', payloadData);
      
      return deliveriesCollection.insertOne({
        webhookId: webhook._id,
        userId: material.creatorId,
        eventId,
        eventType: 'purchase.completed',
        payload,
        status: 'pending',
        attempts: [],
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
    
    await Promise.allSettled(promises);

  } catch (error) {
    logger.error(`Failed to broadcast purchase event for material ${materialId}: ${error.message}`);
  }
}

import { getDb } from '@/lib/mongodb';
import { COLLECTIONS } from '@/lib/backend/schemaContracts';
import { dispatchWebhook } from '@/lib/webhooks/dispatcher';
import { generateSignaturesHeader } from '@/lib/webhooks/signature';
import { logger } from '@/lib/logger';

const CONFIG = {
  pollingInterval: 10000,
  maxConcurrentJobs: 10,
  maxRetries: 5,
};

function calculateBackoff(attempt) {
  // Exponential backoff: 2s, 4s, 8s, 16s, 32s + jitter
  const baseDelay = Math.pow(2, attempt) * 1000;
  const jitter = Math.random() * 1000;
  return baseDelay + jitter;
}

export async function processWebhookDeliveries() {
  try {
    const db = await getDb();
    const deliveriesCollection = db.collection(COLLECTIONS.webhookDeliveries);
    const webhooksCollection = db.collection(COLLECTIONS.webhooks);

    const pendingDeliveries = await deliveriesCollection
      .find({
        status: 'pending',
        nextAttemptAt: { $lte: new Date() },
      })
      .sort({ createdAt: 1 }) // Process oldest first to try to maintain ordering
      .limit(CONFIG.maxConcurrentJobs)
      .toArray();

    if (pendingDeliveries.length === 0) return 0;

    logger.info(`[Webhook Worker] Processing ${pendingDeliveries.length} deliveries`);

    const promises = pendingDeliveries.map(async (delivery) => {
      const webhook = await webhooksCollection.findOne({ _id: delivery.webhookId });

      if (!webhook || webhook.status !== 'active') {
        // Webhook deleted or disabled
        await deliveriesCollection.updateOne(
          { _id: delivery._id },
          { $set: { status: 'failed', updatedAt: new Date() } }
        );
        return;
      }

      const activeSecrets = webhook.secrets.filter(s => !s.expiresAt || s.expiresAt > new Date());
      const payloadStr = JSON.stringify(delivery.payload);
      const signatureHeader = activeSecrets.length > 0 
        ? generateSignaturesHeader(payloadStr, activeSecrets) 
        : null;

      const attemptRecord = {
        timestamp: new Date(),
        attemptNumber: (delivery.attempts?.length || 0) + 1,
      };

      try {
        const start = Date.now();
        const response = await dispatchWebhook(webhook.url, payloadStr, signatureHeader);
        attemptRecord.duration = Date.now() - start;
        attemptRecord.responseStatus = response.status;
        attemptRecord.responseBody = response.body ? response.body.substring(0, 1024) : ''; // Truncate

        if (response.status >= 200 && response.status < 300) {
          // Success
          await deliveriesCollection.updateOne(
            { _id: delivery._id },
            { 
              $set: { status: 'success', updatedAt: new Date() },
              $push: { attempts: attemptRecord }
            }
          );
          logger.info(`[Webhook Worker] Delivery ${delivery._id} successful`);
        } else {
          // HTTP Error
          attemptRecord.error = `HTTP ${response.status}`;
          await handleFailure(deliveriesCollection, delivery, attemptRecord);
        }
      } catch (error) {
        // Network or dispatch error
        attemptRecord.error = error.message;
        await handleFailure(deliveriesCollection, delivery, attemptRecord);
      }
    });

    await Promise.allSettled(promises);
    return pendingDeliveries.length;
  } catch (error) {
    logger.error(`[Webhook Worker] Error in main loop: ${error.message}`);
    return 0;
  }
}

async function handleFailure(collection, delivery, attemptRecord) {
  const isFinalAttempt = attemptRecord.attemptNumber >= CONFIG.maxRetries;
  const updateDoc = {
    $push: { attempts: attemptRecord },
    $set: { updatedAt: new Date() }
  };

  if (isFinalAttempt) {
    updateDoc.$set.status = 'dead_letter';
    updateDoc.$set.nextAttemptAt = null;
    logger.warn(`[Webhook Worker] Delivery ${delivery._id} moved to dead_letter`);
  } else {
    const delay = calculateBackoff(attemptRecord.attemptNumber);
    updateDoc.$set.nextAttemptAt = new Date(Date.now() + delay);
  }

  await collection.updateOne({ _id: delivery._id }, updateDoc);
}

export async function runWebhookWorker() {
  logger.info("[Webhook Worker] Starting...");
  while (true) {
    const processed = await processWebhookDeliveries();
    if (processed === 0) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.pollingInterval));
    }
  }
}

if (process.env.RUN_WEBHOOK_WORKER === "true") {
  runWebhookWorker().catch((error) => {
    logger.error("[Webhook Worker] Fatal error:", error);
    process.exit(1);
  });
}

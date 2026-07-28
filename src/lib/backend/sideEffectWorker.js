/**
 * Background Worker for Side Effect Delivery
 * 
 * Processes side_effect_outbox intents for email, webhook, and indexer
 * side effects with leased execution, bounded retries, and dead-letter handling.
 */

import { getDb } from '@/lib/mongodb';
import { sendPurchaseReceiptEmail } from '@/lib/email';
import { sendWebhookWithRetry } from '@/lib/webhooks/sender';
import {
  leaseNextIntent,
  markDelivered,
  rescheduleIntent,
  releaseLease,
} from './outbox';

const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
const POLL_INTERVAL_MS = parseInt(process.env.SIDE_EFFECT_POLL_MS || '5000', 10);
const LEASE_RENEW_INTERVAL_MS = parseInt(process.env.SIDE_EFFECT_LEASE_RENEW_MS || '60_000', 10);
const OUTBOX_COLLECTION = 'side_effect_outbox';

async function processEmailIntent(intent) {
  const { email, purchase, material } = intent.intent.payload;
  await sendPurchaseReceiptEmail(email, purchase, material);
}

async function processWebhookIntent(intent) {
  const { urls, payload } = intent.intent.payload;
  if (!Array.isArray(urls)) {
    throw new Error('Webhook intent missing urls array');
  }

  const results = await Promise.allSettled(
    urls.map(url => sendWebhookWithRetry(url, payload, 3))
  );

  const failures = results
    .map((result, idx) => ({ url: urls[idx], result }))
    .filter(({ result }) => result.status === 'rejected');

  if (failures.length > 0) {
    throw new Error(
      `Webhook delivery failed for ${failures.length}/${urls.length} URLs: ` +
      failures.map(f => f.url).join(', ')
    );
  }
}

export async function processSideEffectIntent(intent) {
  const type = intent.intent?.type;

  switch (type) {
    case 'email':
      await processEmailIntent(intent);
      break;
    case 'webhook':
      await processWebhookIntent(intent);
      break;
    case 'indexer':
      // Placeholder for indexer side effects (e.g., reindex request, cache warming).
      console.log(`[SideEffectWorker] Indexer intent not yet implemented: ${intent._id}`);
      await new Promise(resolve => setTimeout(resolve, 100));
      break;
    default:
      throw new Error(`Unknown side effect type: ${type}`);
  }
}

async function renewLease(db, intent) {
  if (intent.status !== 'leased' || intent.leasedBy !== WORKER_ID) {
    return;
  }

  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_RENEW_INTERVAL_MS);

  await db.collection(OUTBOX_COLLECTION).updateOne(
    { _id: intent._id, leasedBy: WORKER_ID },
    {
      $set: {
        leaseExpiresAt,
        updatedAt: now,
      },
    }
  );
}

export async function runSideEffectWorker() {
  console.log(`[SideEffectWorker] Starting side effect processor (worker=${WORKER_ID})...`);

  while (true) {
    try {
      const db = await getDb();
      const intent = await leaseNextIntent(WORKER_ID);

      if (!intent) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(
        `[SideEffectWorker] Processing intent ${intent._id} (type=${intent.intent?.type}, attempt=${intent.attemptCount})`
      );

      try {
        await processSideEffectIntent(intent);
        await markDelivered(intent.deliveryId, intent._id);
        console.log(`[SideEffectWorker] Delivered intent ${intent._id}`);
      } catch (error) {
        console.error(`[SideEffectWorker] Failed intent ${intent._id}:`, error);
        await rescheduleIntent(intent._id, error);
      }
    } catch (error) {
      console.error('[SideEffectWorker] Worker loop error:', error);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (process.env.RUN_SIDE_EFFECT_WORKER === 'true') {
  runSideEffectWorker().catch(error => {
    console.error('[SideEffectWorker] Fatal error:', error);
    process.exit(1);
  });
}
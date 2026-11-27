/**
 * Background Worker for Side Effect Delivery
 * 
 * Processes side_effect_outbox intents for email, webhook, and indexer
 * side effects with leased execution, bounded retries, and dead-letter handling.
 */

import { getDb } from '../mongodb.js';
import { sendPurchaseReceiptEmail } from '../email.js';
import {
  leaseNextIntent,
  markDelivered,
  rescheduleIntent,
  releaseLease,
} from './outbox';
import { applyMaterialSearchProjection } from './materialSearchProjection.js';
import { applyAnalyticsEvent } from './analyticsEvents.js';
import {
  recordScanProvenance,
  SCAN_PROVENANCE_ERROR_CODES,
  ScanProvenanceError,
} from '../publishing/scanProvenance.js';

const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
const POLL_INTERVAL_MS = parseInt(process.env.SIDE_EFFECT_POLL_MS || '5000', 10);
const LEASE_RENEW_INTERVAL_MS = parseInt(process.env.SIDE_EFFECT_LEASE_RENEW_MS || '60_000', 10);
const OUTBOX_COLLECTION = 'side_effect_outbox';

async function processEmailIntent(intent) {
  const { email, purchase, material } = intent.intent.payload;
  await sendPurchaseReceiptEmail(email, purchase, material);
}

async function processWebhookIntent(intent) {
  const { sendWebhookWithRetry } = await import('../webhooks/sender.js');
  const { urls, payload, signingSecret } = intent.intent.payload;
  if (!Array.isArray(urls)) {
    throw new Error('Webhook intent missing urls array');
  }

  const results = await Promise.allSettled(
    urls.map(url => sendWebhookWithRetry(url, payload, 3, { signingSecret }))
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

function isRecognizedScanIntent(intent) {
  const inner = intent?.intent || {};
  const payload = inner.payload || {};
  const action = inner.action || payload.action;
  return (
    action === 'scan_content'
    || action === 'scan'
    || payload.action === 'scan'
    || inner.channel === 'scan_content'
    || payload.channel === 'scan_content'
  );
}

async function fetchScanBytes({ contentHash }) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('No fetch implementation available to retrieve scan bytes');
  }

  const gateway = process.env.NEXT_PUBLIC_GATEWAY_URL
    || process.env.IPFS_GATEWAY_URL
    || 'https://gateway.pinata.cloud';
  const url = `${gateway.replace(/\/$/, '')}/ipfs/${encodeURIComponent(contentHash)}`;
  const response = await globalThis.fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Unable to fetch scan bytes: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function processScanIntent(intent, options = {}) {
  const inner = intent?.intent || {};
  const payload = inner.payload || {};
  if (!isRecognizedScanIntent(intent)) {
    throw new ScanProvenanceError(SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT, 'Intent is not a scan_content intent');
  }

  const db = options.db || await getDb();
  const contentHash = payload.contentHash || payload.cid || intent.sourceId;
  if (!contentHash) {
    throw new ScanProvenanceError(SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT, 'Scan intent missing contentHash');
  }

  const quarantineCollection = typeof db.collection === 'function'
    ? db.collection('quarantine')
    : null;
  const quarantine = quarantineCollection && typeof quarantineCollection.findOne === 'function'
    ? await quarantineCollection.findOne({ contentHash })
    : null;

  const byteHash = payload.byteHash ?? payload.expectedByteHash ?? quarantine?.byteHash;
  const sizeBytes = payload.sizeBytes ?? quarantine?.sizeBytes;
  if (!byteHash || sizeBytes === undefined || sizeBytes === null) {
    throw new ScanProvenanceError(SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT, 'Scan intent missing byteHash or sizeBytes');
  }

  let bytes = options.bytes ?? payload.bytes ?? payload.contentBytes;
  if (bytes === undefined || bytes === null) {
    const fetcher = options.fetchBytes || fetchScanBytes;
    bytes = await fetcher({ contentHash, payload, quarantine });
  }

  const signatureVersion = payload.signatureVersion
    ?? payload.scanResult?.signatureVersion
    ?? (payload.scanner && typeof payload.scanner === 'object' ? payload.scanner.signatureVersion : null)
    ?? process.env.MALWARE_SCANNER_SIGNATURE_VERSION
    ?? 'unversioned';
  const scanner = payload.scanner
    ?? payload.scannerName
    ?? payload.scanResult?.scannerName
    ?? (payload.scanner && typeof payload.scanner === 'object' ? payload.scanner.name : null)
    ?? process.env.MALWARE_SCANNER_NAME
    ?? 'clamav';

  const scanResult = payload.scanResult || {
    verdict: payload.verdict ?? null,
    threats: payload.threats ?? [],
    signatureVersion,
    scannerName: typeof scanner === 'string' ? scanner : scanner.name,
    artifactHash: contentHash,
  };
  const recordProvenance = options.recordProvenance || recordScanProvenance;
  const now = options.now || new Date();

  return recordProvenance({
    db,
    bytes,
    contentHash,
    cid: payload.cid ?? contentHash,
    byteHash,
    sizeBytes,
    scanner,
    signatureVersion,
    actor: options.actor || { id: WORKER_ID, role: 'system' },
    allowSystem: true,
    scannedAt: payload.scannedAt ?? now,
    now,
    scanResult,
    mimeType: payload.mimeType,
    materialId: payload.materialId,
    uploaderAddress: payload.uploaderAddress ?? quarantine?.uploaderAddress,
  });
}

async function processIndexerIntent(intent, options = {}) {
  if (isRecognizedScanIntent(intent)) {
    return processScanIntent(intent, options);
  }

  if (intent.intent?.action !== 'material_search_sync') {
    console.log(`[SideEffectWorker] Indexer intent not yet implemented: ${intent._id}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    return;
  }

  const db = options.db || await getDb();
  await applyMaterialSearchProjection(db, intent.intent.payload);
}

async function processAnalyticsIntent(intent) {
  const db = await getDb();
  await applyAnalyticsEvent(db, intent.intent.payload);
}

export async function processPreviewIntent(intent) {
  // #638: generate the preview in the disposable sandbox. `runPreviewPipeline`
  // records the outcome on `material_previews` and never throws, so a preview
  // failure does not fail (or retry) the intent and never affects the original
  // file's gating.
  const { runPreviewPipeline } = await import('./previewPipeline.js');
  const { contentHash, mimeType, sizeBytes, materialId } = intent.intent.payload || {};
  const result = await runPreviewPipeline({ contentHash, mimeType, sizeBytes, materialId });
  console.log(`[SideEffectWorker] Preview ${contentHash} -> ${result.state}${result.reason ? ` (${result.reason})` : ''}`);
}

export async function processSideEffectIntent(intent, options = {}) {
  const type = intent.intent?.type;

  switch (type) {
    case 'email':
      await processEmailIntent(intent);
      break;
    case 'webhook':
      await processWebhookIntent(intent);
      break;
    case 'indexer':
      return processIndexerIntent(intent, options);
    case 'preview':
      await processPreviewIntent(intent);
      break;
    case 'analytics':
      await processAnalyticsIntent(intent);
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

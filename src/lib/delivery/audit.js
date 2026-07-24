/**
 * Delivery Audit Service
 *
 * Records download audit events capturing actor, material, bytes/range,
 * result, and correlation ID without logging secrets (CIDs, tokens, etc.).
 * Uses the existing auditLog pattern from src/lib/api/audit.js but adds
 * persistent storage for compliance and debugging.
 */

import { getDb } from '@/lib/mongodb';
import { currentCorrelationId } from '@/lib/telemetry/context';

const SAFE_AUDIT_FIELDS = new Set([
  'event',
  'actor',
  'buyerAddress',
  'materialId',
  'bytesRequested',
  'bytesStreamed',
  'rangeStart',
  'rangeEnd',
  'statusCode',
  'result',
  'correlationId',
  'userAgent',
  'clientIp',
  'durationMs',
  'errorReason',
]);

/**
 * Record a delivery audit event.
 *
 * @param {object} fields
 * @param {string} fields.event - Event type (e.g., 'delivery_token_issued', 'delivery_stream_started', 'delivery_completed', 'delivery_failed')
 * @param {string} [fields.actor] - User identifier (sub or wallet address)
 * @param {string} [fields.buyerAddress] - Buyer's Stellar public key
 * @param {string} [fields.materialId] - Material identifier
 * @param {number} [fields.bytesRequested] - Total bytes requested
 * @param {number} [fields.bytesStreamed] - Actual bytes streamed
 * @param {number} [fields.rangeStart] - Start of byte range (for range requests)
 * @param {number} [fields.rangeEnd] - End of byte range
 * @param {number} [fields.statusCode] - HTTP status code returned
 * @param {string} [fields.result] - Outcome: 'success', 'partial', 'error', 'denied', 'timeout'
 * @param {string} [fields.userAgent] - Client user-agent
 * @param {string} [fields.clientIp] - Client IP address
 * @param {number} [fields.durationMs] - Request duration in milliseconds
 * @param {string} [fields.errorReason] - Error reason if failed
 */
export async function recordDeliveryAudit(fields) {
  const correlationId = currentCorrelationId() || fields.correlationId || null;

  // Build safe entry (no secrets)
  const entry = {
    timestamp: new Date().toISOString(),
    correlationId,
  };

  for (const [key, value] of Object.entries(fields || {})) {
    if (SAFE_AUDIT_FIELDS.has(key) && value !== undefined && value !== null) {
      entry[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    }
  }

  // Always log to console for immediate observability
  console.info('[delivery-audit]', JSON.stringify(entry));

  // Persist to MongoDB for compliance and debugging
  try {
    const db = await getDb();
    await db.collection('delivery_audit').insertOne({
      ...entry,
      createdAt: new Date(),
    });
  } catch (err) {
    // Non-blocking: don't fail the request if audit write fails
    console.error('[delivery-audit] failed to persist audit entry:', err.message);
  }

  return entry;
}

/**
 * Query delivery audit records for a given material and/or buyer.
 *
 * @param {object} filters
 * @param {string} [filters.materialId]
 * @param {string} [filters.buyerAddress]
 * @param {string} [filters.actor]
 * @param {number} [filters.limit] - Max records to return (default 50)
 * @param {number} [filters.skip] - Records to skip (for pagination)
 * @returns {Promise<Array>}
 */
export async function queryDeliveryAudit(filters = {}) {
  const query = {};
  if (filters.materialId) query.materialId = filters.materialId;
  if (filters.buyerAddress) query.buyerAddress = filters.buyerAddress.toLowerCase();
  if (filters.actor) query.actor = filters.actor;

  const db = await getDb();
  return db
    .collection('delivery_audit')
    .find(query)
    .sort({ timestamp: -1 })
    .limit(Math.min(filters.limit || 50, 200))
    .skip(filters.skip || 0)
    .toArray();
}

/**
 * Get delivery statistics for a material.
 *
 * @param {string} materialId
 * @returns {Promise<{totalDeliveries: number, totalBytesStreamed: number, uniqueBuyers: number, lastDelivery: string|null}>}
 */
export async function getMaterialDeliveryStats(materialId) {
  const db = await getDb();
  const collection = db.collection('delivery_audit');

  const [stats] = await collection
    .aggregate([
      { $match: { materialId, event: { $in: ['delivery_completed', 'delivery_stream_started'] } } },
      {
        $group: {
          _id: null,
          totalDeliveries: { $sum: 1 },
          totalBytesStreamed: { $sum: '$bytesStreamed' },
          uniqueBuyers: { $addToSet: '$buyerAddress' },
          lastDelivery: { $max: '$timestamp' },
        },
      },
    ])
    .toArray();

  if (!stats) {
    return { totalDeliveries: 0, totalBytesStreamed: 0, uniqueBuyers: 0, lastDelivery: null };
  }

  return {
    totalDeliveries: stats.totalDeliveries,
    totalBytesStreamed: stats.totalBytesStreamed,
    uniqueBuyers: stats.uniqueBuyers.length,
    lastDelivery: stats.lastDelivery,
  };
}
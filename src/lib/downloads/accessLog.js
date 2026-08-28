/**
 * Persisted, audit-safe download access log (#675).
 *
 * `lib/api/audit.js`'s auditLog() is console-only (JSON.stringify →
 * console.info) — useful for a log aggregator, but not queryable evidence
 * an operator or a buyer dispute can be resolved against later, and nothing
 * in app/api/download/route.js called it anyway. This is a separate,
 * dedicated collection because download events have a different retention
 * and query shape than the general API audit trail (SAFE_FIELDS in
 * lib/api/audit.js has no field for capability/nonce/jti/byteRange).
 *
 * "Audit-safe" here means: never persist the raw capability token, the
 * signed IPFS gateway URL, or anything else that would let a log reader
 * replay a download themselves — only the identity/decision metadata
 * needed to answer "who accessed what, when, and was it authorized."
 */

const COLLECTION = 'download_access_log';

/**
 * Record one download-capability decision (issued or denied). Never throws
 * — a logging failure must not block or fail the download itself; it's
 * caught and reported to console so the failure itself is at least visible.
 */
export async function recordDownloadAccess(db, event) {
  const entry = {
    timestamp: new Date(),
    event: event.event, // 'capability_issued' | 'access_denied'
    materialId: event.materialId ?? null,
    buyerAddress: event.buyerAddress ?? null,
    decisionSource: event.decisionSource ?? null, // authorizeMaterialAccess()'s decision.source, when issued
    denialReason: event.denialReason ?? null, // set only on access_denied
    byteRangeStart: event.byteRangeStart ?? null,
    byteRangeEnd: event.byteRangeEnd ?? null,
    // The capability's jti (token id), never the token itself — enough to
    // correlate a later verification failure back to the issuance event
    // without the log entry being a usable credential on its own.
    capabilityId: event.capabilityId ?? null,
    ipAddress: event.ipAddress ?? null,
  };

  try {
    await db.collection(COLLECTION).insertOne(entry);
  } catch (err) {
    console.error('[download-access-log] failed to persist access log entry:', err);
  }
}

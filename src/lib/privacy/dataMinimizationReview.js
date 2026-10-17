/**
 * Data minimization review for operational metadata (#954).
 *
 * Retention (scripts/data-retention-cleanup.mjs) answers "how long do we keep
 * this record". This module answers the complementary question: "does this
 * record only contain the fields it was designed to contain". A collection
 * can have a perfectly enforced retention window and still violate
 * minimization if a caller starts stuffing extra, undocumented fields (an
 * email, a raw token, a full request body) into a log entry over time.
 *
 * Each operational metadata collection below is paired with the exact field
 * allowlist its own writer module produces, so a "violation" always means a
 * document on disk has drifted from the shape its own code intends to write.
 */

import { SENSITIVE_ACCESS_COLLECTION } from "../security/sensitiveAccessLog.js";
import { DOWNLOAD_ACCESS_LOG_COLLECTION } from "../downloads/accessLog.js";
import { IDEMPOTENCY_KEYS_COLLECTION } from "../backend/idempotency.js";
import { ANALYTICS_DEDUPE_COLLECTION } from "../backend/analyticsEvents.js";

/**
 * Registry of operational metadata collections under minimization review.
 * `allowedFields` always includes `_id`; callers do not need to repeat it.
 */
export const OPERATIONAL_METADATA_REGISTRY = Object.freeze({
  [SENSITIVE_ACCESS_COLLECTION]: Object.freeze({
    description: "Field-name-only access log; see buildSensitiveAccessEvent().",
    allowedFields: Object.freeze([
      "actorId", "actorType", "purpose", "resourceType", "resourceId",
      "fields", "decision", "at", "correlationId", "metadata",
    ]),
  }),
  [DOWNLOAD_ACCESS_LOG_COLLECTION]: Object.freeze({
    description: "Download capability decisions; see recordDownloadAccess().",
    allowedFields: Object.freeze([
      "timestamp", "event", "materialId", "buyerAddress", "decisionSource",
      "denialReason", "byteRangeStart", "byteRangeEnd", "capabilityId", "ipAddress",
    ]),
  }),
  [IDEMPOTENCY_KEYS_COLLECTION]: Object.freeze({
    description: "Request replay guard; see withIdempotency().",
    allowedFields: Object.freeze([
      "claimId", "status", "payloadHash", "createdAt", "lockExpiresAt",
      "expiresAt", "response", "completedAt", "error", "failedAt",
    ]),
  }),
  [ANALYTICS_DEDUPE_COLLECTION]: Object.freeze({
    description: "Opaque HMAC dedupe key; see buildAnalyticsEvent()/applyAnalyticsEvent().",
    allowedFields: Object.freeze(["expiresAt"]),
  }),
});

/**
 * Returns the top-level field names of `doc` that are not in `allowedFields`
 * (and are not `_id`, which every document carries).
 */
export function findUnexpectedFields(doc, allowedFields) {
  const allowed = new Set(allowedFields);
  return Object.keys(doc || {})
    .filter((key) => key !== "_id" && !allowed.has(key))
    .sort();
}

/**
 * Samples up to `limit` documents from `collection` and tallies which
 * unexpected field names appear, and how many sampled documents carry each.
 * Read-only: only `find`/`countDocuments` are used.
 */
export async function reviewCollection(db, collection, entry, { limit = 100 } = {}) {
  const exists = await db.listCollections({ name: collection }).toArray();
  if (exists.length === 0) {
    return {
      collection,
      status: "skipped",
      reason: "collection_not_found",
      sampled: 0,
      unexpectedFields: [],
    };
  }

  const docs = await db
    .collection(collection)
    .find({})
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();

  const counts = new Map();
  for (const doc of docs) {
    for (const field of findUnexpectedFields(doc, entry.allowedFields)) {
      counts.set(field, (counts.get(field) || 0) + 1);
    }
  }

  const unexpectedFields = [...counts.entries()]
    .map(([field, count]) => ({ field, count }))
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));

  return {
    collection,
    status: unexpectedFields.length > 0 ? "violations" : "ok",
    sampled: docs.length,
    unexpectedFields,
  };
}

/**
 * Runs the full minimization review across every registered operational
 * metadata collection. Deterministic: collections are processed in
 * alphabetical order and every per-collection field list is sorted.
 *
 * @param {import("mongodb").Db} db
 * @param {{ limit?: number, registry?: object }} [options]
 */
export async function runDataMinimizationReview(db, { limit = 100, registry = OPERATIONAL_METADATA_REGISTRY } = {}) {
  const collections = [];
  for (const name of Object.keys(registry).sort()) {
    collections.push(await reviewCollection(db, name, registry[name], { limit }));
  }

  const summary = {
    totalCollections: collections.length,
    collectionsOk: collections.filter((c) => c.status === "ok").length,
    collectionsWithViolations: collections.filter((c) => c.status === "violations").length,
    collectionsSkipped: collections.filter((c) => c.status === "skipped").length,
    totalUnexpectedFieldKinds: collections.reduce((n, c) => n + c.unexpectedFields.length, 0),
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    collections,
  };
}

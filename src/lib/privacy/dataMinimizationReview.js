/**
 * Data minimization review for operational metadata (#874, #954).
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
 *
 * Field Classification:
 * - required: Must be present for the record to function; never removable.
 * - optional: May be absent or null; safe to omit.
 * - sensitive: Contains PII, credentials, or keys; requires explicit justification.
 * - removable: Candidate for removal; migration/cleanup guidance provided.
 */

import { SENSITIVE_ACCESS_COLLECTION } from "../security/sensitiveAccessLog.js";
import { DOWNLOAD_ACCESS_LOG_COLLECTION } from "../downloads/accessLog.js";
import { IDEMPOTENCY_KEYS_COLLECTION } from "../backend/idempotency.js";
import { ANALYTICS_DEDUPE_COLLECTION } from "../backend/analyticsEvents.js";
import { COLLECTIONS } from "../backend/schemaContracts.js";

/**
 * Field classification constants for documentation and tooling.
 */
export const FIELD_CLASSIFICATION = Object.freeze({
  REQUIRED: "required",
  OPTIONAL: "optional",
  SENSITIVE: "sensitive",
  REMOVABLE: "removable",
});

/**
 * Registry of operational metadata collections under minimization review.
 * Each entry includes:
 * - description: Human-readable purpose of the collection.
 * - allowedFields: Exact field names the writer module produces (excludes _id).
 * - fieldClassifications: Map of field -> classification for governance.
 * - migrationGuidance: Optional cleanup/migration notes for removable fields.
 * - writerModule: Source module that writes to this collection.
 */
export const OPERATIONAL_METADATA_REGISTRY = Object.freeze({
  [SENSITIVE_ACCESS_COLLECTION]: Object.freeze({
    description:
      "Field-name-only access log; see buildSensitiveAccessEvent(). Never stores values.",
    allowedFields: Object.freeze([
      "actorId",
      "actorType",
      "purpose",
      "resourceType",
      "resourceId",
      "fields",
      "decision",
      "at",
      "correlationId",
      "metadata",
    ]),
    fieldClassifications: Object.freeze({
      actorId: FIELD_CLASSIFICATION.REQUIRED,
      actorType: FIELD_CLASSIFICATION.REQUIRED,
      purpose: FIELD_CLASSIFICATION.OPTIONAL,
      resourceType: FIELD_CLASSIFICATION.REQUIRED,
      resourceId: FIELD_CLASSIFICATION.REQUIRED,
      fields: FIELD_CLASSIFICATION.REQUIRED,
      decision: FIELD_CLASSIFICATION.REQUIRED,
      at: FIELD_CLASSIFICATION.REQUIRED,
      correlationId: FIELD_CLASSIFICATION.REQUIRED,
      metadata: FIELD_CLASSIFICATION.SENSITIVE,
    }),
    migrationGuidance: Object.freeze({
      metadata:
        "Redacted by redactSensitivePayload() at write time. If raw values appear, audit the caller. No migration needed; fix the writer.",
    }),
    writerModule: "src/lib/security/sensitiveAccessLog.js",
  }),
  [DOWNLOAD_ACCESS_LOG_COLLECTION]: Object.freeze({
    description:
      "Download capability decisions; see recordDownloadAccess(). Audit-safe: no tokens or URLs.",
    allowedFields: Object.freeze([
      "timestamp",
      "event",
      "materialId",
      "buyerAddress",
      "decisionSource",
      "denialReason",
      "byteRangeStart",
      "byteRangeEnd",
      "capabilityId",
      "ipAddress",
    ]),
    fieldClassifications: Object.freeze({
      timestamp: FIELD_CLASSIFICATION.REQUIRED,
      event: FIELD_CLASSIFICATION.REQUIRED,
      materialId: FIELD_CLASSIFICATION.REQUIRED,
      buyerAddress: FIELD_CLASSIFICATION.SENSITIVE,
      decisionSource: FIELD_CLASSIFICATION.OPTIONAL,
      denialReason: FIELD_CLASSIFICATION.OPTIONAL,
      byteRangeStart: FIELD_CLASSIFICATION.OPTIONAL,
      byteRangeEnd: FIELD_CLASSIFICATION.OPTIONAL,
      capabilityId: FIELD_CLASSIFICATION.OPTIONAL,
      ipAddress: FIELD_CLASSIFICATION.SENSITIVE,
    }),
    migrationGuidance: Object.freeze({
      ipAddress:
        "PII. Retained for 180 days per retention policy. If minimization requires removal, hash at write time (see sensitiveAccessLog pattern) and update dispute-resolution queries.",
      buyerAddress:
        "Pseudonymous identifier. Required for dispute resolution. If removal needed, replace with salted hash and update lookup paths.",
    }),
    writerModule: "src/lib/downloads/accessLog.js",
  }),
  [IDEMPOTENCY_KEYS_COLLECTION]: Object.freeze({
    description: "Request replay guard; see withIdempotency().",
    allowedFields: Object.freeze([
      "claimId",
      "status",
      "payloadHash",
      "createdAt",
      "lockExpiresAt",
      "expiresAt",
      "response",
      "completedAt",
      "error",
      "failedAt",
    ]),
    fieldClassifications: Object.freeze({
      claimId: FIELD_CLASSIFICATION.REQUIRED,
      status: FIELD_CLASSIFICATION.REQUIRED,
      payloadHash: FIELD_CLASSIFICATION.SENSITIVE,
      createdAt: FIELD_CLASSIFICATION.REQUIRED,
      lockExpiresAt: FIELD_CLASSIFICATION.REQUIRED,
      expiresAt: FIELD_CLASSIFICATION.REQUIRED,
      response: FIELD_CLASSIFICATION.OPTIONAL,
      completedAt: FIELD_CLASSIFICATION.OPTIONAL,
      error: FIELD_CLASSIFICATION.OPTIONAL,
      failedAt: FIELD_CLASSIFICATION.OPTIONAL,
    }),
    migrationGuidance: Object.freeze({
      payloadHash:
        "One-way SHA-256 of canonicalized payload. Not reversible. Retained for collision detection. If removal needed, truncate after claim completion and update withIdempotency() to not store it.",
      response:
        "May contain business data. Retained for replay. If minimization required, store only a result summary hash and fetch full response from source-of-truth on replay.",
      error:
        "May leak internal details. Truncate to 500 chars at write. If removal needed, replace with error code enum.",
    }),
    writerModule: "src/lib/backend/idempotency.js",
  }),
  [ANALYTICS_DEDUPE_COLLECTION]: Object.freeze({
    description:
      "Opaque HMAC dedupe key; see buildAnalyticsEvent()/applyAnalyticsEvent(). Never contains PII.",
    allowedFields: Object.freeze(["expiresAt"]),
    fieldClassifications: Object.freeze({
      expiresAt: FIELD_CLASSIFICATION.REQUIRED,
    }),
    migrationGuidance: Object.freeze({}),
    writerModule: "src/lib/backend/analyticsEvents.js",
  }),
  [COLLECTIONS.maintainerApprovalIntents]: Object.freeze({
    description:
      "Proposed maintainer actions awaiting signature; see createApprovalIntent(). Expires after 30 min.",
    allowedFields: Object.freeze([
      "intentId",
      "actionType",
      "actor",
      "target",
      "payload",
      "reason",
      "createdAt",
      "expiresAt",
      "intentHash",
    ]),
    fieldClassifications: Object.freeze({
      intentId: FIELD_CLASSIFICATION.REQUIRED,
      actionType: FIELD_CLASSIFICATION.REQUIRED,
      actor: FIELD_CLASSIFICATION.SENSITIVE,
      target: FIELD_CLASSIFICATION.REQUIRED,
      payload: FIELD_CLASSIFICATION.SENSITIVE,
      reason: FIELD_CLASSIFICATION.REQUIRED,
      createdAt: FIELD_CLASSIFICATION.REQUIRED,
      expiresAt: FIELD_CLASSIFICATION.REQUIRED,
      intentHash: FIELD_CLASSIFICATION.REQUIRED,
    }),
    migrationGuidance: Object.freeze({
      actor:
        "Stellar public key (pseudonymous). Required for self-approval prevention. If removal needed, hash at write and update verification logic.",
      payload:
        "Caller-supplied action parameters. Must never contain secrets. If PII detected, add redaction at write time (see sensitiveAccessLog pattern).",
    }),
    writerModule: "src/lib/approvals/maintainerApprovalFlow.js",
  }),
  [COLLECTIONS.maintainerApprovalReceipts]: Object.freeze({
    description:
      "Signed approval receipts; see createSignedReceipt()/persistApprovalReceipt(). Immutable once written.",
    allowedFields: Object.freeze([
      "receiptId",
      "intentId",
      "intentHash",
      "approverAddress",
      "decision",
      "signature",
      "signedAt",
      "intent",
    ]),
    fieldClassifications: Object.freeze({
      receiptId: FIELD_CLASSIFICATION.REQUIRED,
      intentId: FIELD_CLASSIFICATION.REQUIRED,
      intentHash: FIELD_CLASSIFICATION.REQUIRED,
      approverAddress: FIELD_CLASSIFICATION.SENSITIVE,
      decision: FIELD_CLASSIFICATION.REQUIRED,
      signature: FIELD_CLASSIFICATION.SENSITIVE,
      signedAt: FIELD_CLASSIFICATION.REQUIRED,
      intent: FIELD_CLASSIFICATION.REQUIRED,
    }),
    migrationGuidance: Object.freeze({
      approverAddress:
        "Stellar public key (pseudonymous). Required for audit trail. If removal needed, hash at write and update audit ledger correlation.",
      signature:
        "Ed25519 signature. Required for cryptographic verification. Cannot be removed without breaking the approval model.",
      intent:
        "Embedded intent copy for self-contained verification. Duplicates intent collection. If minimization required, store only intentHash and fetch intent on demand.",
    }),
    writerModule: "src/lib/approvals/maintainerApprovalFlow.js",
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
 * Classifies a document's fields against the registry entry.
 * Returns an object with arrays for each classification category.
 */
export function classifyDocumentFields(doc, entry) {
  if (!doc || typeof doc !== "object") {
    return { required: [], optional: [], sensitive: [], removable: [], unknown: [] };
  }
  const classifications = entry.fieldClassifications || {};
  const result = {
    required: [],
    optional: [],
    sensitive: [],
    removable: [],
    unknown: [],
  };
  for (const [field, value] of Object.entries(doc)) {
    if (field === "_id") continue;
    const classification = classifications[field] || FIELD_CLASSIFICATION.UNKNOWN;
    if (result[classification]) {
      result[classification].push({ field, hasValue: value !== null && value !== undefined });
    } else {
      result.unknown.push({ field, hasValue: value !== null && value !== undefined });
    }
  }
  return result;
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
      fieldClassificationSummary: {},
    };
  }

  const docs = await db
    .collection(collection)
    .find({})
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();

  const unexpectedCounts = new Map();
  const classificationSummary = {
    required: new Map(),
    optional: new Map(),
    sensitive: new Map(),
    removable: new Map(),
    unknown: new Map(),
  };

  for (const doc of docs) {
    // Track unexpected fields
    for (const field of findUnexpectedFields(doc, entry.allowedFields)) {
      unexpectedCounts.set(field, (unexpectedCounts.get(field) || 0) + 1);
    }
    // Track field classification presence
    const classified = classifyDocumentFields(doc, entry);
    for (const cat of Object.keys(classificationSummary)) {
      for (const { field, hasValue } of classified[cat]) {
        if (hasValue) {
          classificationSummary[cat].set(field, (classificationSummary[cat].get(field) || 0) + 1);
        }
      }
    }
  }

  const unexpectedFields = [...unexpectedCounts.entries()]
    .map(([field, count]) => ({ field, count }))
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));

  const classificationSummaryFormatted = {};
  for (const [cat, map] of Object.entries(classificationSummary)) {
    classificationSummaryFormatted[cat] = [...map.entries()]
      .map(([field, count]) => ({ field, count }))
      .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  }

  return {
    collection,
    status: unexpectedFields.length > 0 ? "violations" : "ok",
    sampled: docs.length,
    unexpectedFields,
    fieldClassificationSummary: classificationSummaryFormatted,
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
    totalSensitiveFieldsObserved: collections.reduce(
      (n, c) => n + (c.fieldClassificationSummary?.sensitive?.length || 0),
      0
    ),
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    collections,
  };
}

/**
 * Generates a human-readable inventory report for documentation/contributor onboarding.
 * @param {object} registry - The operational metadata registry (default: OPERATIONAL_METADATA_REGISTRY)
 * @returns {string} Markdown-formatted inventory
 */
export function generateMetadataInventoryReport(registry = OPERATIONAL_METADATA_REGISTRY) {
  const lines = [
    "# Operational Metadata Inventory",
    "",
    "Generated from `src/lib/privacy/dataMinimizationReview.js`",
    "",
    "## Field Classification Legend",
    "",
    "- **REQUIRED**: Must be present for the record to function; never removable.",
    "- **OPTIONAL**: May be absent or null; safe to omit.",
    "- **SENSITIVE**: Contains PII, credentials, or keys; requires explicit justification.",
    "- **REMOVABLE**: Candidate for removal; migration/cleanup guidance provided.",
    "",
  ];

  for (const [collection, entry] of Object.entries(registry)) {
    lines.push(`## ${collection}`);
    lines.push("");
    lines.push(`**Purpose**: ${entry.description}`);
    lines.push(`**Writer**: \`${entry.writerModule}\``);
    lines.push("");

    if (entry.allowedFields.length > 0) {
      lines.push("### Fields");
      lines.push("");
      lines.push("| Field | Classification | Migration Guidance |");
      lines.push("|-------|----------------|-------------------|");
      for (const field of [...entry.allowedFields].sort()) {
        const classification = entry.fieldClassifications?.[field] || "unclassified";
        const guidance = entry.migrationGuidance?.[field] || "—";
        lines.push(`| \`${field}\` | ${classification.toUpperCase()} | ${guidance} |`);
      }
      lines.push("");
    }

    if (entry.migrationGuidance && Object.keys(entry.migrationGuidance).length > 0) {
      lines.push("### Migration / Cleanup Guidance");
      lines.push("");
      for (const [field, guidance] of Object.entries(entry.migrationGuidance)) {
        lines.push(`- **${field}**: ${guidance}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
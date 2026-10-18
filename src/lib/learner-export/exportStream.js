/**
 * src/lib/learner-export/exportStream.js
 *
 * Permission-aware export pipeline with bounded memory and cancellation support
 * (Issue #949).
 *
 * Design goals
 * ────────────
 * 1. Bounded memory   — purchases are fetched in fixed-size pages (default 200).
 *    The heap never holds more than one page plus identity/summary at once.
 *
 * 2. Cancellation     — every async step checks `signal.aborted` before
 *    proceeding.  When the caller's AbortSignal fires the pipeline tears down
 *    immediately.
 *
 * 3. Permission enforcement — the effective requester role is derived from the
 *    authenticated session object (server-side), never from a caller-supplied
 *    HTTP header.  Field-level authorization is applied per batch so forbidden
 *    fields never reach the stream even transiently.
 *
 * 4. Streaming wire format — NDJSON (newline-delimited JSON).  Each line is a
 *    JSON object with a discriminator `type` field:
 *      {"type":"header",   "schemaVersion":…}
 *      {"type":"purchase", …purchaseEntry…}   (one per purchase)
 *      {"type":"summary",  …summaryCounters…}
 *
 * Error handling / failure modes
 * ──────────────────────────────
 * - ExportAuthorizationError  — thrown synchronously from authorizeStreamExport.
 * - ExportCancelledError      — thrown when the AbortSignal fires.
 * - DB errors                 — propagated as-is.
 *
 * Rollback / recovery
 * ───────────────────
 * Exports are never persisted server-side.  Partial streams are incomplete —
 * consumers MUST check that the final "summary" line is present before trusting
 * the data.  A missing summary means the export was truncated; retry.
 */

import crypto from 'node:crypto';
import { buildLearnerExport }          from './buildLearnerExport.js';
import { applyFieldLevelAuthorization, ExportRole } from './fieldAuthorization.js';
import { RedactionLevel, EXPORT_SCHEMA_VERSION }    from './schema.js';
import {
  authorizeExport,
  ExportAuthorizationError,
  ExportScope,
} from './exportLearnerData.js';

export { ExportAuthorizationError, ExportScope };

// ── constants ─────────────────────────────────────────────────────────────────

/** Default purchases per DB round-trip. */
export const DEFAULT_PAGE_SIZE = 200;

/** Hard upper limit — guards against OOM from crafted inputs. */
export const MAX_PAGE_SIZE = 1_000;

// ── typed error ───────────────────────────────────────────────────────────────

/**
 * Thrown when the export pipeline is aborted via its AbortSignal.
 */
export class ExportCancelledError extends Error {
  constructor(message) {
    super(message || 'Export cancelled by caller');
    this.name = 'ExportCancelledError';
  }
}

// ── role derivation ───────────────────────────────────────────────────────────

/**
 * Derive the field-level ExportRole from an authenticated requester.
 *
 * This is intentionally conservative: unknown roles fall back to the most
 * restrictive policy (SUBJECT) rather than an elevated one.
 */
export function deriveExportRole(requester) {
  if (!requester) return ExportRole.SUBJECT;
  switch (requester.role) {
    case 'admin':   return ExportRole.ADMIN;
    case 'support': return ExportRole.SUPPORT;
    default:        return ExportRole.SUBJECT;
  }
}

// ── authorization ─────────────────────────────────────────────────────────────

/**
 * Authorize a streaming export and derive the field-level role server-side.
 *
 * @returns {{ authorized: true, scope: string, exportRole: string, reason: string|null }}
 * @throws {ExportAuthorizationError}
 */
export function authorizeStreamExport(opts) {
  if (!opts) opts = {};
  var decision   = authorizeExport({ requester: opts.requester, subject: opts.subject, reason: opts.reason });
  var exportRole = deriveExportRole(opts.requester);
  return Object.assign({}, decision, { exportRole: exportRole });
}

// ── internal helpers ──────────────────────────────────────────────────────────

function walletOf(entity) {
  if (!entity || typeof entity !== 'object') return null;
  var raw = entity.walletAddressLower != null ? entity.walletAddressLower
          : entity.walletAddress      != null ? entity.walletAddress
          : entity.buyerAddress;
  if (typeof raw !== 'string') return null;
  var normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ndjsonLine(obj) {
  return JSON.stringify(obj) + '\n';
}

function buildIdentity(user, redactionLevel) {
  return {
    walletAddress: user.walletAddress != null ? user.walletAddress : (user.walletAddressLower || ''),
    email:    redactionLevel === RedactionLevel.FULL ? (user.email    || null) : null,
    fullName: redactionLevel === RedactionLevel.FULL ? (user.fullName || null) : null,
  };
}

function accumulateSummary(acc, entry) {
  acc.totalPurchases++;
  if (entry.entitlementState === 'active')    acc.activePurchases++;
  if (entry.entitlementState === 'revoked')   acc.revokedPurchases++;
  if (entry.refundStatus     === 'completed') acc.refundedPurchases++;
  if (entry.progress !== null && entry.progress !== undefined) acc.purchasesWithProgress++;
  acc.totalSpendMinorUnits += (entry.amount || 0);
}

function makeExportId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

// ── async page generator ──────────────────────────────────────────────────────

/**
 * Async generator that yields purchase documents for a wallet in pages.
 * Checks `signal.aborted` before each DB round-trip.
 */
async function* purchasePageGenerator(db, subjectWallet, pageSize, signal) {
  var skip = 0;
  var walletRegex = new RegExp('^' + escapeRegex(subjectWallet) + '$', 'i');

  while (true) {
    if (signal && signal.aborted) throw new ExportCancelledError();

    var page = await db
      .collection('purchases')
      .find({ buyerAddress: walletRegex })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .toArray();

    if (page.length === 0) break;
    if (signal && signal.aborted) throw new ExportCancelledError();

    yield page;

    if (page.length < pageSize) break;
    skip += pageSize;
  }
}

// ── streaming export ──────────────────────────────────────────────────────────

/**
 * Returns a ReadableStream of NDJSON representing the permission-filtered
 * learner export.  Purchases are fetched in bounded pages; each page is
 * field-authorized before any bytes hit the wire.
 *
 * @param {object}      opts
 * @param {object}      opts.db              Mongo db handle
 * @param {object}      opts.requester       Authenticated session user
 * @param {object}      opts.subject         Owner of the data
 * @param {string}      [opts.reason]        Audit reason (privileged exports)
 * @param {string}      [opts.redactionLevel]
 * @param {string}      [opts.purpose]
 * @param {number}      [opts.pageSize]
 * @param {AbortSignal} [opts.signal]
 * @returns {ReadableStream}
 * @throws {ExportAuthorizationError} synchronously (before stream opens)
 */
export function createExportStream(opts) {
  if (!opts) opts = {};
  var db             = opts.db;
  var requester      = opts.requester;
  var subject        = opts.subject;
  var reason         = opts.reason;
  var redactionLevel = opts.redactionLevel || RedactionLevel.PARTIAL;
  var purpose        = opts.purpose || 'library_export';
  var pageSize       = opts.pageSize || DEFAULT_PAGE_SIZE;
  var signal         = opts.signal;

  // Authorization — synchronous throw on deny.
  var decision = authorizeStreamExport({ requester: requester, subject: subject, reason: reason });

  var effectivePageSize = Math.min(Math.max(1, Math.floor(pageSize)), MAX_PAGE_SIZE);

  // PII cap.
  var effectiveRedactionLevel =
    (decision.scope === ExportScope.PRIVILEGED && redactionLevel === RedactionLevel.FULL)
      ? RedactionLevel.PARTIAL
      : redactionLevel;

  var subjectWallet = walletOf(subject);
  var exportId      = makeExportId();
  var generatedAt   = new Date().toISOString();
  var exportRole    = decision.exportRole;

  return new ReadableStream({
    start: function(controller) {
      return (async function() {
        try {
          var header = {
            type:          'header',
            schemaVersion: EXPORT_SCHEMA_VERSION,
            exportId:      exportId,
            generatedAt:   generatedAt,
            redactionLevel: effectiveRedactionLevel,
            identity:      null,
            authorization: {
              scope:          decision.scope,
              redactionLevel: effectiveRedactionLevel,
              reason:         decision.reason != null ? decision.reason : null,
            },
            retention: {
              artifactLifetime: 'ephemeral',
              generatedAt:      generatedAt,
              expiresAt:        null,
              policy: 'Exports are generated on demand and are not retained on the server. ' +
                      'Download and store your export locally; it is not recoverable once lost.',
            },
          };

          if (signal && signal.aborted) { controller.close(); return; }

          // Fetch user and supporting collections (small, non-paginated).
          var walletRegexStr = '^' + escapeRegex(subjectWallet) + '$';
          var walletRegex    = new RegExp(walletRegexStr, 'i');

          var results = await Promise.all([
            db.collection('users').findOne(
              { walletAddressLower: subjectWallet },
              { projection: { password: 0, webhookSigningSecret: 0, webhookSigningSecretPrevious: 0 } },
            ),
            db.collection('entitlement_cache').find({ buyerAddress: { $regex: walletRegex } }).toArray(),
            db.collection('refunds').find({ buyerAddress: { $regex: walletRegex } }).toArray(),
            db.collection('learner_progress').find({ walletAddress: { $regex: walletRegex } }).toArray(),
          ]);

          if (signal && signal.aborted) { controller.close(); return; }

          var user            = results[0];
          var entitlements    = results[1];
          var refunds         = results[2];
          var progressRecords = results[3];

          var entitlementMap = new Map(entitlements.map(function(e) { return [e.materialId, e]; }));
          var refundMap      = new Map(refunds.map(function(r) { return [r.purchaseId != null ? r.purchaseId : String(r._id), r]; }));
          var progressMap    = new Map(progressRecords.map(function(p) { return [p.materialId, p]; }));
          var materialMap    = new Map();

          var effectiveUser = user || { walletAddress: subjectWallet };
          header.identity   = buildIdentity(effectiveUser, effectiveRedactionLevel);
          controller.enqueue(ndjsonLine(header));

          var summaryAcc = {
            totalPurchases:        0,
            activePurchases:       0,
            revokedPurchases:      0,
            refundedPurchases:     0,
            purchasesWithProgress: 0,
            totalSpendMinorUnits:  0,
          };

          var pageGen = purchasePageGenerator(db, subjectWallet, effectivePageSize, signal);

          for await (var page of pageGen) {
            if (signal && signal.aborted) throw new ExportCancelledError();

            // Lazy-load any material titles we haven't fetched yet.
            var unknownIds = [];
            for (var i = 0; i < page.length; i++) {
              var mid = page[i].materialId;
              if (mid && !materialMap.has(mid)) unknownIds.push(mid);
            }
            if (unknownIds.length > 0) {
              var uniqueIds = [...new Set(unknownIds)];
              var mats = await db.collection('materials')
                .find({ materialId: { $in: uniqueIds } })
                .project({ materialId: 1, title: 1 })
                .toArray();
              for (var j = 0; j < mats.length; j++) materialMap.set(mats[j].materialId, mats[j]);
            }

            // Assemble this page using the existing pure assembler.
            var pageExport = buildLearnerExport({
              user:            effectiveUser,
              purchases:       page,
              entitlements:    [...entitlementMap.values()],
              refunds:         [...refundMap.values()],
              materials:       [...materialMap.values()],
              progressRecords: [...progressMap.values()],
              redactionLevel:  effectiveRedactionLevel,
            });

            // Field-authorize and emit each entry individually.
            for (var k = 0; k < pageExport.purchases.length; k++) {
              if (signal && signal.aborted) throw new ExportCancelledError();

              var entry  = pageExport.purchases[k];
              var miniDoc = {
                schemaVersion:  header.schemaVersion,
                exportId:       header.exportId,
                generatedAt:    header.generatedAt,
                redactionLevel: effectiveRedactionLevel,
                identity:       header.identity,
                purchases:      [entry],
                summary:        { totalPurchases: 1, activePurchases: 0, revokedPurchases: 0, refundedPurchases: 0, purchasesWithProgress: 0, totalSpendMinorUnits: 0 },
                retention:      header.retention,
              };

              var filtered = applyFieldLevelAuthorization(miniDoc, {
                requesterRole: exportRole,
                requesterId:   walletOf(requester),
                subjectWallet: subjectWallet,
                purpose:       purpose,
              });

              var filteredEntry = filtered.purchases[0];
              controller.enqueue(ndjsonLine(Object.assign({ type: 'purchase' }, filteredEntry)));
              accumulateSummary(summaryAcc, filteredEntry);
            }
          }

          controller.enqueue(ndjsonLine(Object.assign({ type: 'summary' }, summaryAcc)));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      })();
    },
  });
}

// ── in-memory batch export (for tests and legacy callers) ─────────────────────

/**
 * Non-streaming, permission-aware export.  Use for small exports or tests.
 * For large datasets prefer `createExportStream`.
 *
 * @param {object}    opts
 * @param {object}    opts.requester
 * @param {object}    opts.subject
 * @param {string}    [opts.reason]
 * @param {object[]}  [opts.purchases]
 * @param {object[]}  [opts.entitlements]
 * @param {object[]}  [opts.refunds]
 * @param {object[]}  [opts.materials]
 * @param {object[]}  [opts.progressRecords]
 * @param {string}    [opts.redactionLevel]
 * @param {string}    [opts.purpose]
 * @param {AbortSignal} [opts.signal]
 * @returns {{ header: object, purchases: object[], summary: object }}
 * @throws {ExportAuthorizationError}
 * @throws {ExportCancelledError}
 */
export function createExportBatch(opts) {
  if (!opts) opts = {};
  var requester      = opts.requester;
  var subject        = opts.subject;
  var reason         = opts.reason;
  var purchases      = opts.purchases      || [];
  var entitlements   = opts.entitlements   || [];
  var refunds        = opts.refunds        || [];
  var materials      = opts.materials      || [];
  var progressRecords= opts.progressRecords|| [];
  var redactionLevel = opts.redactionLevel || RedactionLevel.PARTIAL;
  var purpose        = opts.purpose        || 'library_export';
  var signal         = opts.signal;

  var decision = authorizeStreamExport({ requester: requester, subject: subject, reason: reason });

  if (signal && signal.aborted) throw new ExportCancelledError();

  var effectiveRedactionLevel =
    (decision.scope === ExportScope.PRIVILEGED && redactionLevel === RedactionLevel.FULL)
      ? RedactionLevel.PARTIAL
      : redactionLevel;

  var subjectWallet = walletOf(subject);
  var exportRole    = decision.exportRole;
  var exportId      = makeExportId();
  var generatedAt   = new Date().toISOString();

  // Scope to subject's own rows.
  var ownedPurchases    = purchases.filter(function(r) { return walletOf(r) === subjectWallet; });
  var ownedEntitlements = entitlements.filter(function(r) { return walletOf(r) === subjectWallet; });
  var ownedRefunds      = refunds.filter(function(r) { return walletOf(r) === subjectWallet; });
  var ownedProgress     = progressRecords.filter(function(r) { return walletOf(r) === subjectWallet; });

  if (signal && signal.aborted) throw new ExportCancelledError();

  var baseExport = buildLearnerExport({
    user:            subject,
    purchases:       ownedPurchases,
    entitlements:    ownedEntitlements,
    refunds:         ownedRefunds,
    materials:       materials,
    progressRecords: ownedProgress,
    redactionLevel:  effectiveRedactionLevel,
  });

  if (signal && signal.aborted) throw new ExportCancelledError();

  var filtered = applyFieldLevelAuthorization(baseExport, {
    requesterRole: exportRole,
    requesterId:   walletOf(requester),
    subjectWallet: subjectWallet,
    purpose:       purpose,
  });

  var headerObj = {
    type:           'header',
    schemaVersion:  EXPORT_SCHEMA_VERSION,
    exportId:       filtered.exportId != null ? filtered.exportId : exportId,
    generatedAt:    filtered.generatedAt != null ? filtered.generatedAt : generatedAt,
    redactionLevel: effectiveRedactionLevel,
    identity:       filtered.identity,
    authorization: {
      scope:          decision.scope,
      redactionLevel: effectiveRedactionLevel,
      reason:         decision.reason != null ? decision.reason : null,
    },
    retention:      filtered.retention,
    privacyMeta:    filtered.privacyMeta || null,
  };

  var purchaseLines = filtered.purchases.map(function(p) {
    return Object.assign({ type: 'purchase' }, p);
  });

  var summaryAcc = {
    totalPurchases:        0,
    activePurchases:       0,
    revokedPurchases:      0,
    refundedPurchases:     0,
    purchasesWithProgress: 0,
    totalSpendMinorUnits:  0,
  };
  for (var i = 0; i < filtered.purchases.length; i++) {
    accumulateSummary(summaryAcc, filtered.purchases[i]);
  }

  return {
    header:    headerObj,
    purchases: purchaseLines,
    summary:   Object.assign({ type: 'summary' }, summaryAcc),
  };
}

/**
 * src/lib/learner-export/exportLearnerData.js
 *
 * Authorization-aware entrypoint for the learner data export (#838).
 *
 * `buildLearnerExport()` is a pure assembler: it trusts whatever collections it
 * is handed.  That is the right shape for a builder, but it means the *caller*
 * is responsible for proving that the requester is allowed to see the subject's
 * records.  This module centralises that proof so no caller has to reinvent it.
 *
 * Authorization rules
 * ───────────────────
 *   1. Self-export — the requester's wallet owns the subject's wallet. Always
 *      allowed, and the only path that may emit PII (`redactionLevel: 'full'`).
 *   2. Privileged export — the requester holds an allow-listed staff role
 *      (`admin`, or `support`) or the `admin:access` permission. Allowed for
 *      support / dispute / compliance workflows, but the export is capped at
 *      PARTIAL so another user's email and full name never leave the system.
 *   3. Everything else — denied with a typed `ExportAuthorizationError`, thrown
 *      *before* any record is assembled.
 *
 * Defense in depth
 * ────────────────
 * Even after authorization succeeds, every user-owned collection is filtered to
 * records actually owned by the subject. A caller that accidentally (or
 * maliciously) passes another learner's rows cannot exfiltrate them through the
 * export document — unattributable rows are dropped, never included.
 */

import { buildLearnerExport } from './buildLearnerExport.js';
import { RedactionLevel } from './schema.js';
import { hasPermission } from '../auth/permissions.js';

/**
 * Error codes carried by `ExportAuthorizationError`.
 *   EXPORT_UNAUTHENTICATED — no authenticated requester (HTTP 401).
 *   EXPORT_FORBIDDEN       — authenticated but not permitted (HTTP 403).
 */
export const ExportAuthorizationErrorCode = Object.freeze({
  UNAUTHENTICATED: 'EXPORT_UNAUTHENTICATED',
  FORBIDDEN:       'EXPORT_FORBIDDEN',
});

/**
 * Explicit allow-list of staff roles permitted to export another learner's
 * data. Scoped to the support/compliance use case: read-only export, no PII,
 * and never a full-account `role: 'admin'`-style bypass of redaction.
 */
export const EXPORT_PRIVILEGED_ROLES = Object.freeze(['admin', 'support']);

/** The scope an export ran under, recorded in `document.authorization.scope`. */
export const ExportScope = Object.freeze({
  SELF:       'self',
  PRIVILEGED: 'privileged',
});

/**
 * Typed error for a denied export. Carries `code` and `status` so API layers can
 * map it straight onto a 401/403 response without string matching.
 */
export class ExportAuthorizationError extends Error {
  constructor(message, {
    code = ExportAuthorizationErrorCode.FORBIDDEN,
    status = 403,
  } = {}) {
    super(message);
    this.name = 'ExportAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

/** Resolve the wallet address that identifies a user or owned record. */
function walletOf(entity) {
  if (!entity || typeof entity !== 'object') return null;
  const raw = entity.walletAddressLower
    ?? entity.walletAddress
    ?? entity.buyerAddress;
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** True when the requester holds an allow-listed staff role or permission. */
function isPrivilegedReader(requester) {
  if (!requester) return false;
  if (EXPORT_PRIVILEGED_ROLES.includes(requester.role)) return true;
  return hasPermission(requester, 'admin:access');
}

/**
 * Decide whether `requester` may export `subject`'s data.
 *
 * @param {object}  opts
 * @param {object}  opts.requester - Authenticated caller (session user).
 * @param {object}  opts.subject   - Owner of the data being exported.
 * @param {string}  [opts.reason]  - Free-form audit reason (privileged exports).
 * @returns {{ authorized: true, scope: string, reason: string|null }}
 * @throws {ExportAuthorizationError}
 */
export function authorizeExport({ requester, subject, reason } = {}) {
  if (!requester) {
    throw new ExportAuthorizationError(
      'Export denied: no authenticated requester.',
      { code: ExportAuthorizationErrorCode.UNAUTHENTICATED, status: 401 },
    );
  }

  const requesterWallet = walletOf(requester);
  const subjectWallet   = walletOf(subject);

  if (!subjectWallet) {
    throw new ExportAuthorizationError(
      'Export denied: the requested subject has no resolvable wallet address.',
    );
  }

  // 1. Self-export.
  if (requesterWallet && requesterWallet === subjectWallet) {
    return { authorized: true, scope: ExportScope.SELF, reason: reason ?? null };
  }

  // 2. Explicit, allow-listed privileged export.
  if (isPrivilegedReader(requester)) {
    return {
      authorized: true,
      scope:   ExportScope.PRIVILEGED,
      reason:  reason ?? null,
    };
  }

  // 3. Denied.
  throw new ExportAuthorizationError(
    'Export denied: requester is not authorized to export this learner\'s data.',
  );
}

/**
 * Keep only the records owned by `wallet`. Records with no ownership field
 * cannot be attributed to the subject and are dropped rather than trusted.
 */
function scopeToWallet(records, wallet) {
  if (!Array.isArray(records)) return [];
  if (!wallet) return [];
  return records.filter((record) => walletOf(record) === wallet);
}

/**
 * Authorize an export request, then assemble the export document.
 *
 * @param {object}   opts
 * @param {object}   opts.requester         - Authenticated caller (session user).
 * @param {object}   opts.subject           - Owner of the data being exported.
 * @param {string}   [opts.reason]          - Audit reason for privileged exports.
 * @param {object[]} opts.purchases         - Candidate purchase documents.
 * @param {object[]} [opts.entitlements]
 * @param {object[]} [opts.refunds]
 * @param {object[]} [opts.materials]
 * @param {object[]} [opts.progressRecords]
 * @param {string}   [opts.redactionLevel]  - One of RedactionLevel. Default PARTIAL.
 * @returns {import('./schema.js').LearnerExport}
 * @throws {ExportAuthorizationError} when the requester is not authorized.
 */
export function exportLearnerData({
  requester,
  subject,
  reason,
  purchases,
  entitlements    = [],
  refunds         = [],
  materials       = [],
  progressRecords = [],
  redactionLevel  = RedactionLevel.PARTIAL,
} = {}) {
  // Authorize first: a denied request must not touch or assemble any record.
  const decision     = authorizeExport({ requester, subject, reason });
  const subjectWallet = walletOf(subject);

  // Defense in depth — only the subject's own rows reach the builder.
  const ownedPurchases    = scopeToWallet(purchases, subjectWallet);
  const ownedEntitlements = scopeToWallet(entitlements, subjectWallet);
  const ownedRefunds      = scopeToWallet(refunds, subjectWallet);
  const ownedProgress     = scopeToWallet(progressRecords, subjectWallet);

  // PII is never emitted for a cross-user privileged export, even if the caller
  // asks for FULL.
  const effectiveRedactionLevel =
    decision.scope === ExportScope.PRIVILEGED && redactionLevel === RedactionLevel.FULL
      ? RedactionLevel.PARTIAL
      : redactionLevel;

  const exportDoc = buildLearnerExport({
    user: subject,
    purchases: ownedPurchases,
    entitlements: ownedEntitlements,
    refunds: ownedRefunds,
    materials,
    progressRecords: ownedProgress,
    redactionLevel: effectiveRedactionLevel,
  });

  return {
    ...exportDoc,
    authorization: {
      scope:          decision.scope,
      redactionLevel: effectiveRedactionLevel,
      reason:         decision.reason ?? null,
    },
  };
}

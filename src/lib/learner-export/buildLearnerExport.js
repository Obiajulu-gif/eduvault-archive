/**
 * src/lib/learner-export/buildLearnerExport.js
 *
 * Assembles a complete LearnerExport document from the MongoDB collections
 * and on-chain receipt data.
 *
 * Privacy rules
 * ─────────────
 * FULL    — all fields including email and fullName
 * PARTIAL — walletAddress included, email/fullName redacted to null
 * MINIMAL — walletAddress included, all identity PII redacted to null
 *
 * Verification
 * ────────────
 * Each purchase entry carries receiptAnchors (metadataHash, rightsHash,
 * saleTermsVersion, purchaseLedger) sourced from the purchaseSnapshot
 * stored at purchase time.  These can be independently verified against
 * the on-chain contract state via get_purchase_snapshot() without a live
 * API call.
 */

import crypto from 'node:crypto';
import {
  EXPORT_SCHEMA_VERSION,
  RedactionLevel,
  RefundStatus,
  EntitlementState,
  buildSummary,
} from './schema.js';

/**
 * @param {object} opts
 * @param {object} opts.user                - MongoDB user document.
 * @param {object[]} opts.purchases         - MongoDB purchase documents for this learner.
 * @param {object[]} opts.entitlements      - MongoDB entitlement_cache documents.
 * @param {object[]} opts.refunds           - MongoDB refund documents.
 * @param {object[]} opts.materials         - MongoDB material documents (for titles).
 * @param {object[]} [opts.progressRecords] - MongoDB learner progress documents.
 * @param {string}   [opts.redactionLevel]  - One of RedactionLevel. Default: PARTIAL.
 * @returns {import('./schema.js').LearnerExport}
 */
export function buildLearnerExport({
  user,
  purchases,
  entitlements,
  refunds,
  materials,
  progressRecords = [],
  redactionLevel  = RedactionLevel.PARTIAL,
}) {
  if (!user)      throw new Error('buildLearnerExport: user is required');
  if (!purchases) throw new Error('buildLearnerExport: purchases is required');

  const entitlementByMaterial = new Map(
    (entitlements ?? []).map(e => [e.materialId, e]),
  );
  const refundByPurchaseId = new Map(
    (refunds ?? []).map(r => [r.purchaseId, r]),
  );
  const materialByMaterialId = new Map(
    (materials ?? []).map(m => [m.materialId, m]),
  );
  const progressByMaterialId = new Map(
    (progressRecords ?? []).map(p => [p.materialId, p]),
  );

  const purchaseEntries = (purchases ?? []).map(p => {
    const ent        = entitlementByMaterial.get(p.materialId);
    const refund     = refundByPurchaseId.get(p.purchaseId ?? String(p._id));
    const material   = materialByMaterialId.get(p.materialId);
    const progress   = progressByMaterialId.get(p.materialId);
    const snapshot   = p.purchaseSnapshot ?? {};

    // ── entitlement state ─────────────────────────────────────────────────
    let entitlementState = EntitlementState.UNKNOWN;
    if (ent) {
      if (!ent.active) {
        entitlementState = EntitlementState.REVOKED;
      } else {
        entitlementState = EntitlementState.ACTIVE;
      }
    } else if (p.status === 'refunded') {
      entitlementState = EntitlementState.REVOKED;
    }

    // ── refund status ─────────────────────────────────────────────────────
    let refundStatus = RefundStatus.NONE;
    let refundDetail = null;
    if (refund) {
      if (refund.status === 'completed') {
        refundStatus = RefundStatus.COMPLETED;
        entitlementState = EntitlementState.REVOKED;
      } else if (refund.status === 'pending' || refund.status === 'requested') {
        refundStatus = RefundStatus.REQUESTED;
      } else if (refund.status === 'rejected') {
        refundStatus = RefundStatus.REJECTED;
      }
      refundDetail = {
        requestedAt:  toIso(refund.requestedAt  ?? refund.createdAt),
        completedAt:  toIso(refund.completedAt) ?? null,
        refundAmount: refund.amount ?? 0,
        reason:       refund.reason ?? 'admin_initiated',
      };
    }

    // ── receipt anchors ───────────────────────────────────────────────────
    const receiptAnchors = {
      metadataHash:     snapshot.metadataHash     ?? null,
      rightsHash:       snapshot.rightsHash       ?? null,
      saleTermsVersion: snapshot.saleTermsVersion ?? null,
      purchaseLedger:   snapshot.purchaseLedger   ?? null,
      transactionId:    p.chainTxHash             ?? null,
      receiptHash:      computeReceiptHash(p, snapshot),
    };

    // ── progress ──────────────────────────────────────────────────────────
    let progressEntry = null;
    if (progress) {
      progressEntry = {
        version:        progress.version       ?? 'unknown',
        progressPct:    progress.progressPct   ?? 0,
        bookmarks:      (progress.bookmarks ?? []).map(b => ({
          id:        String(b.id ?? b._id ?? ''),
          label:     b.label   ?? '',
          note:      b.note    ?? undefined,
          createdAt: toIso(b.createdAt) ?? new Date().toISOString(),
        })),
        lastAccessedAt: toIso(progress.lastAccessedAt ?? progress.updatedAt) ?? new Date().toISOString(),
      };
    }

    return {
      purchaseId:      p.purchaseId ?? String(p._id),
      materialId:      p.materialId ?? null,
      materialTitle:   material?.title ?? null,
      asset:           p.asset   ?? null,
      amount:          toNumber(p.amount),
      platformFee:     toNumber(snapshot.platformFee ?? 0),
      sellerNet:       toNumber(snapshot.sellerNet   ?? 0),
      purchasedAt:     toIso(p.createdAt) ?? new Date().toISOString(),
      entitlementState,
      refundStatus,
      refund:          refundDetail,
      receiptAnchors,
      progress:        progressEntry,
    };
  });

  // ── identity ──────────────────────────────────────────────────────────────
  const identity = {
    walletAddress: user.walletAddress ?? user.walletAddressLower ?? '',
    email:    redactionLevel === RedactionLevel.FULL ? (user.email    ?? null) : null,
    fullName: redactionLevel === RedactionLevel.FULL ? (user.fullName ?? null) : null,
  };

  const summary = buildSummary(purchaseEntries);

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportId:      generateExportId(),
    generatedAt:   new Date().toISOString(),
    redactionLevel,
    identity,
    purchases:     purchaseEntries,
    summary,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function toIso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

function generateExportId() {
  // crypto.randomUUID() is available in Node 14.17+ / browser with WebCrypto.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback: manual v4 UUID shape from random bytes.
  const bytes = crypto.getRandomValues
    ? crypto.getRandomValues(new Uint8Array(16))
    : Buffer.from(crypto.randomBytes(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/**
 * SHA-256 of the canonical purchase + snapshot bundle — mirrors the approach
 * in receiptProvenance.js so learners can verify the export independently.
 */
function computeReceiptHash(purchase, snapshot) {
  try {
    const canonical = JSON.stringify({
      purchaseId:       purchase.purchaseId ?? String(purchase._id),
      materialId:       purchase.materialId,
      metadataHash:     snapshot.metadataHash,
      rightsHash:       snapshot.rightsHash,
      saleTermsVersion: snapshot.saleTermsVersion,
      purchaseLedger:   snapshot.purchaseLedger,
      asset:            purchase.asset,
      amount:           purchase.amount,
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
  } catch {
    return null;
  }
}

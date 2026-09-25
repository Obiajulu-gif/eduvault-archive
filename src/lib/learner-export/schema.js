/**
 * src/lib/learner-export/schema.js
 *
 * Canonical JSON schema for the learner library export (#learner-export).
 *
 * Learners can export their complete library: purchased materials, immutable
 * purchase receipts, progress/bookmarks, refund state, and on-chain
 * verification metadata.  The schema is designed to be:
 *
 *   • Self-describing  — every export carries its own schemaVersion and a
 *     generatedAt timestamp so consumers can always identify the shape.
 *   • Verifiable       — each purchase entry includes the same metadataHash /
 *     rightsHash / saleTermsVersion captured on-chain at purchase time, so the
 *     export can be verified against the on-chain receipt without a live API.
 *   • Privacy-bounded  — email, full name, and any PII fields are redacted by
 *     default; the exporter must opt in explicitly to include them.
 *   • Forward-compatible — unknown top-level keys should be ignored by
 *     consumers; new optional keys may be added without a schema version bump.
 *
 * The EXPORT_SCHEMA_VERSION constant is the single source of truth for the
 * current wire format.  Bump it when a field is removed, renamed, or its type
 * changes.  Adding a new optional field does not require a bump.
 */

/** Current schema version.  Bump on breaking changes (removals / renames). */
export const EXPORT_SCHEMA_VERSION = '1.0.0';

/**
 * Privacy redaction levels available to callers of buildLearnerExport().
 *
 * FULL    — include all data including PII (email, name).  Reserved for
 *           the learner's own account-level export (GDPR SAR).
 * PARTIAL — include wallet address but redact email and full name.
 *           Suitable for support tickets or creator dispute resolution.
 * MINIMAL — only include purchase receipts and entitlement state, fully
 *           redacting identity fields.
 */
export const RedactionLevel = Object.freeze({
  FULL:    'full',
  PARTIAL: 'partial',
  MINIMAL: 'minimal',
});

/**
 * Refund state values mirroring the on-chain SettlementState enum and the
 * off-chain refunds collection status field.
 */
export const RefundStatus = Object.freeze({
  NONE:       'none',
  REQUESTED:  'requested',
  COMPLETED:  'completed',
  REJECTED:   'rejected',
});

/**
 * Entitlement state values used in export entries.
 * Maps to the on-chain active flag + settlement state:
 *   ACTIVE    — settlement Pending, entitlement.active = true
 *   REVOKED   — refunded, entitlement.active = false
 *   RELEASED  — creator withdrew, entitlement still active
 *   DISPUTED  — dispute open, entitlement still active
 */
export const EntitlementState = Object.freeze({
  ACTIVE:   'active',
  REVOKED:  'revoked',
  RELEASED: 'released',
  DISPUTED: 'disputed',
  UNKNOWN:  'unknown',
});

/**
 * Root export document shape.
 *
 * @typedef {object} LearnerExport
 * @property {string}   schemaVersion  - Always EXPORT_SCHEMA_VERSION.
 * @property {string}   exportId       - Randomly generated UUID for this export.
 * @property {string}   generatedAt    - ISO 8601 timestamp.
 * @property {string}   redactionLevel - One of RedactionLevel values.
 * @property {LearnerIdentity} identity
 * @property {PurchaseEntry[]} purchases
 * @property {ExportSummary} summary
 */

/**
 * @typedef {object} LearnerIdentity
 * @property {string}       walletAddress  - Always included.
 * @property {string|null}  email          - null unless redactionLevel === 'full'.
 * @property {string|null}  fullName       - null unless redactionLevel === 'full'.
 */

/**
 * @typedef {object} PurchaseEntry
 * @property {string}         purchaseId
 * @property {string}         materialId
 * @property {string|null}    materialTitle    - From off-chain materials collection; null if not found.
 * @property {string}         asset            - Payment asset contract address.
 * @property {number}         amount           - Gross amount paid in minor units (i128 as JS number).
 * @property {number}         platformFee      - Platform fee in minor units.
 * @property {number}         sellerNet        - Seller net in minor units.
 * @property {string}         purchasedAt      - ISO 8601; derived from purchase createdAt.
 * @property {EntitlementState} entitlementState
 * @property {RefundStatus}   refundStatus
 * @property {RefundDetail|null} refund        - null when refundStatus === 'none'.
 * @property {ReceiptAnchors} receiptAnchors   - On-chain immutable verification metadata.
 * @property {ProgressEntry|null} progress     - null when no progress record exists.
 */

/**
 * @typedef {object} RefundDetail
 * @property {string|null}  requestedAt    - ISO 8601 or null.
 * @property {string|null}  completedAt    - ISO 8601 or null.
 * @property {number}       refundAmount   - Amount returned in minor units.
 * @property {string}       reason         - Buyer-supplied reason or 'admin_initiated'.
 */

/**
 * @typedef {object} ReceiptAnchors
 * @property {string}   metadataHash       - On-chain metadata hash at purchase time.
 * @property {string}   rightsHash         - On-chain rights hash at purchase time.
 * @property {number}   saleTermsVersion   - Sale-terms version the buyer purchased under.
 * @property {number}   purchaseLedger     - Stellar ledger sequence at purchase time.
 * @property {string|null} transactionId   - Off-chain transaction reference (UUID or hash).
 * @property {string|null} receiptHash     - SHA-256 of the canonical receipt provenance bundle.
 */

/**
 * @typedef {object} ProgressEntry
 * @property {string}   version        - Material content version the progress is scoped to.
 * @property {number}   progressPct    - 0–100 completion percentage.
 * @property {BookmarkEntry[]} bookmarks
 * @property {string}   lastAccessedAt - ISO 8601.
 */

/**
 * @typedef {object} BookmarkEntry
 * @property {string}  id
 * @property {string}  label
 * @property {string}  [note]         - Optional private learner note.
 * @property {string}  createdAt      - ISO 8601.
 */

/**
 * @typedef {object} ExportSummary
 * @property {number}  totalPurchases
 * @property {number}  activePurchases      - entitlementState === 'active'.
 * @property {number}  revokedPurchases     - entitlementState === 'revoked'.
 * @property {number}  refundedPurchases    - refundStatus === 'completed'.
 * @property {number}  purchasesWithProgress
 * @property {number}  totalSpendMinorUnits - Sum of all purchase amounts.
 */

/**
 * Build a summary block from a completed purchases array.
 *
 * @param {PurchaseEntry[]} purchases
 * @returns {ExportSummary}
 */
export function buildSummary(purchases) {
  let activePurchases       = 0;
  let revokedPurchases      = 0;
  let refundedPurchases     = 0;
  let purchasesWithProgress = 0;
  let totalSpendMinorUnits  = 0;

  for (const p of purchases) {
    if (p.entitlementState === EntitlementState.ACTIVE)   activePurchases++;
    if (p.entitlementState === EntitlementState.REVOKED)  revokedPurchases++;
    if (p.refundStatus     === RefundStatus.COMPLETED)    refundedPurchases++;
    if (p.progress !== null)                              purchasesWithProgress++;
    totalSpendMinorUnits += p.amount ?? 0;
  }

  return {
    totalPurchases:       purchases.length,
    activePurchases,
    revokedPurchases,
    refundedPurchases,
    purchasesWithProgress,
    totalSpendMinorUnits,
  };
}

/**
 * Validate a raw export document against the schema invariants.
 * Returns an array of violation strings — empty means the export is valid.
 *
 * @param {unknown} doc
 * @returns {string[]}
 */
export function validateExport(doc) {
  const errors = [];

  if (!doc || typeof doc !== 'object') {
    return ['export must be a non-null object'];
  }

  if (doc.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be "${EXPORT_SCHEMA_VERSION}", got "${doc.schemaVersion}"`);
  }

  if (typeof doc.exportId !== 'string' || doc.exportId.length === 0) {
    errors.push('exportId must be a non-empty string');
  }

  if (typeof doc.generatedAt !== 'string' || isNaN(Date.parse(doc.generatedAt))) {
    errors.push('generatedAt must be a valid ISO 8601 string');
  }

  if (!Object.values(RedactionLevel).includes(doc.redactionLevel)) {
    errors.push(`redactionLevel must be one of: ${Object.values(RedactionLevel).join(', ')}`);
  }

  if (!doc.identity || typeof doc.identity !== 'object') {
    errors.push('identity must be an object');
  } else {
    if (typeof doc.identity.walletAddress !== 'string' || doc.identity.walletAddress.length === 0) {
      errors.push('identity.walletAddress must be a non-empty string');
    }
  }

  if (!Array.isArray(doc.purchases)) {
    errors.push('purchases must be an array');
  } else {
    doc.purchases.forEach((p, i) => {
      const prefix = `purchases[${i}]`;
      if (typeof p.purchaseId  !== 'string') errors.push(`${prefix}.purchaseId must be a string`);
      if (typeof p.materialId  !== 'string') errors.push(`${prefix}.materialId must be a string`);
      if (typeof p.amount      !== 'number') errors.push(`${prefix}.amount must be a number`);
      if (typeof p.purchasedAt !== 'string') errors.push(`${prefix}.purchasedAt must be a string`);
      if (!Object.values(EntitlementState).includes(p.entitlementState)) {
        errors.push(`${prefix}.entitlementState must be one of: ${Object.values(EntitlementState).join(', ')}`);
      }
      if (!Object.values(RefundStatus).includes(p.refundStatus)) {
        errors.push(`${prefix}.refundStatus must be one of: ${Object.values(RefundStatus).join(', ')}`);
      }
      if (!p.receiptAnchors || typeof p.receiptAnchors !== 'object') {
        errors.push(`${prefix}.receiptAnchors must be an object`);
      }
    });
  }

  if (!doc.summary || typeof doc.summary !== 'object') {
    errors.push('summary must be an object');
  } else {
    for (const field of ['totalPurchases', 'activePurchases', 'revokedPurchases',
                         'refundedPurchases', 'purchasesWithProgress', 'totalSpendMinorUnits']) {
      if (typeof doc.summary[field] !== 'number') {
        errors.push(`summary.${field} must be a number`);
      }
    }
  }

  return errors;
}

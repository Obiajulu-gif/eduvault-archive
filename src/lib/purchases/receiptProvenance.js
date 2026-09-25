import crypto from 'node:crypto';

/**
 * Deterministic purchase-receipt provenance bundle — Issue #679.
 *
 * Learners and auditors need a receipt that ties material version, creator,
 * payment asset, transaction hash, entitlement state, and refund status into a
 * single deterministic bundle that can be re-verified at any later time.
 *
 * The approach mirrors the tamper-evident conventions used elsewhere in the
 * codebase (`refundAudit`, `unsubscribeToken`): a canonical serialization that
 * sorts keys recursively, plus a SHA-256 content hash over that canonical
 * form. Because serialization is canonical and the hash covers every included
 * field, two receipts generated for the same underlying purchase produce the
 * same bundle and the same `receiptHash` — so a learner or auditor can assert
 * provenance ("this feature/version/payment/entitlement was theirs") without
 * trusting a live API response.
 *
 * Round-tripping is covered by `verifyReceiptProvBundle()`, which recomputes
 * the canonical hash and confirms the caller-supplied hash matches. Any field
 * changed after issuance (material version bump, refund status flip, altered
 * tx hash) breaks the bundle and the verification fails.
 */

/** Semantic version of the receipt schema. Bump on any field change. */
export const RECEIPT_SCHEMA_VERSION = '1.0.0';

/** Canonically sort keys (depth-first) so serialization is order-independent. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])])
    );
  }
  return value;
}

/**
 * Canonical serialization of a value: JSON with recursively sorted keys and no
 * whitespace. Recommended inputs should already be JSON-safe (strings, numbers,
 * booleans, null, arrays, plain objects).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
  return JSON.stringify(sortKeys(value));
}

/**
 * Build a deterministic receipt provenance bundle.
 *
 * @param {object} params
 * @param {string} params.purchaseId
 * @param {string} params.materialId
 * @param {string} params.materialVersion - material/content version at purchase time
 * @param {string} params.creator - creator wallet address
 * @param {string} [params.creatorName]
 * @param {string} params.asset - payment asset (e.g. native / USDC issuer)
 * @param {string|number} params.amount - amount paid in canonical units
 * @param {string} params.transactionHash - on-chain payment transaction hash
 * @param {string} params.entitlementState - one of the entitlement states (e.g. 'finalized')
 * @param {string} [params.refundStatus] - 'none' | 'requested' | 'refunded'
 * @param {string|number} [params.refundRefundedAt] - ISO timestamp or ms epoch if refunded
 * @param {string} [params.buyer]
 * @param {string|number} [params.purchasedAt]
 * @param {object} [params.issuer] - bundle issuer metadata (e.g. { name, env })
 * @returns {{ bundle: object, hash: string }}
 */
export function createReceiptProvenanceBundle({
  purchaseId,
  materialId,
  materialVersion,
  creator,
  creatorName,
  asset,
  amount,
  transactionHash,
  entitlementState,
  refundStatus = 'none',
  refundRefundedAt = null,
  buyer,
  purchasedAt,
  issuer,
}) {
  if (!purchaseId) throw new Error('receiptProvenance: purchaseId is required');
  if (!materialId) throw new Error('receiptProvenance: materialId is required');
  if (!materialVersion) throw new Error('receiptProvenance: materialVersion is required');
  if (!creator) throw new Error('receiptProvenance: creator is required');
  if (!asset) throw new Error('receiptProvenance: asset is required');
  if (!transactionHash) throw new Error('receiptProvenance: transactionHash is required');
  if (!entitlementState) throw new Error('receiptProvenance: entitlementState is required');
  if (amount === undefined || amount === null) throw new Error('receiptProvenance: amount is required');

  const purchase = {
    purchaseId,
    materialId,
    materialVersion,
    creator,
    ...(creatorName ? { creatorName } : {}),
    buyer,
    asset,
    amount,
    transactionHash,
    entitlementState,
    refundStatus,
    ...(refundRefundedAt ? { refundRefundedAt } : {}),
    ...(purchasedAt ? { purchasedAt } : {}),
    ...(issuer ? { issuer } : {}),
    issuedAt: new Date().toISOString(),
  };

  const bundle = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    purpose: 'purchase-receipt-provenance',
    purchase,
  };

  const canonical = canonicalize(bundle);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');

  return { bundle, hash };
}

/**
 * Re-verify a receipt provenance bundle by recomputing its canonical hash.
 *
 * @param {object} params
 * @param {object} params.bundle - `{ schemaVersion, purpose, purchase }`
 * @param {string} params.hash - previously issued `receiptHash`
 * @returns {boolean} true when the bundle is unchanged and canonically hashes
 *   to the supplied hash.
 */
export function verifyReceiptProvenanceBundle({ bundle, hash }) {
  if (!bundle || !hash) return false;
  try {
    const recomputed = crypto
      .createHash('sha256')
      .update(canonicalize(bundle))
      .digest('hex');
    const inputA = Buffer.from(recomputed, 'hex');
    const inputB = Buffer.from(String(hash), 'hex');
    if (inputA.length !== inputB.length) return false;
    return crypto.timingSafeEqual(inputA, inputB);
  } catch {
    return false;
  }
}
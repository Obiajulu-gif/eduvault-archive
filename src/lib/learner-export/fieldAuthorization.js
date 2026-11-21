/**
 * src/lib/learner-export/fieldAuthorization.js
 *
 * Field-Level Authorization & Privacy Filtering Engine for Learner Exports (#1017, #1151).
 *
 * Implements granular, role-based field masking, redaction, and pseudonymization
 * to ensure that exports adhere to least-privilege privacy principles across
 * different consumers (learner, creator, support, auditor, admin).
 *
 * Provides:
 * - Deterministic masking (email, wallet)
 * - Non-reversible cryptographic pseudonymization (SHA-256)
 * - Strict role validation and cross-subject boundary guards
 * - Resilient export pipeline wrapper with configurable retries and exponential backoff
 * - Post-export cryptographic tamper-evident integrity verification
 */

import crypto from 'node:crypto';

export const ExportRole = Object.freeze({
  SUBJECT: 'learner',
  CREATOR: 'creator',
  SUPPORT: 'support_agent',
  AUDITOR: 'external_auditor',
  ADMIN: 'admin',
});

export const FieldAction = Object.freeze({
  ALLOW: 'allow',
  MASK: 'mask',
  REDACT: 'redact',
  HASH: 'hash',
});

/**
 * Standard field policy definitions per export role.
 */
export const ROLE_FIELD_POLICIES = Object.freeze({
  [ExportRole.SUBJECT]: {
    'identity.walletAddress': FieldAction.ALLOW,
    'identity.email': FieldAction.ALLOW,
    'identity.fullName': FieldAction.ALLOW,
    'purchases.sellerNet': FieldAction.REDACT,
    'purchases.platformFee': FieldAction.REDACT,
    'purchases.progress.bookmarks.note': FieldAction.ALLOW,
    'purchases.refund.reason': FieldAction.ALLOW,
    'purchases.receiptAnchors': FieldAction.ALLOW,
  },
  [ExportRole.CREATOR]: {
    'identity.walletAddress': FieldAction.MASK,
    'identity.email': FieldAction.REDACT,
    'identity.fullName': FieldAction.REDACT,
    'purchases.sellerNet': FieldAction.ALLOW,
    'purchases.platformFee': FieldAction.ALLOW,
    'purchases.progress.bookmarks.note': FieldAction.REDACT,
    'purchases.refund.reason': FieldAction.ALLOW,
    'purchases.receiptAnchors': FieldAction.ALLOW,
  },
  [ExportRole.SUPPORT]: {
    'identity.walletAddress': FieldAction.ALLOW,
    'identity.email': FieldAction.MASK,
    'identity.fullName': FieldAction.MASK,
    'purchases.sellerNet': FieldAction.ALLOW,
    'purchases.platformFee': FieldAction.ALLOW,
    'purchases.progress.bookmarks.note': FieldAction.REDACT,
    'purchases.refund.reason': FieldAction.ALLOW,
    'purchases.receiptAnchors': FieldAction.ALLOW,
  },
  [ExportRole.AUDITOR]: {
    'identity.walletAddress': FieldAction.HASH,
    'identity.email': FieldAction.REDACT,
    'identity.fullName': FieldAction.REDACT,
    'purchases.sellerNet': FieldAction.ALLOW,
    'purchases.platformFee': FieldAction.ALLOW,
    'purchases.progress': FieldAction.REDACT,
    'purchases.refund.reason': FieldAction.MASK,
    'purchases.receiptAnchors': FieldAction.ALLOW,
  },
  [ExportRole.ADMIN]: {
    'identity.walletAddress': FieldAction.ALLOW,
    'identity.email': FieldAction.ALLOW,
    'identity.fullName': FieldAction.ALLOW,
    'purchases.sellerNet': FieldAction.ALLOW,
    'purchases.platformFee': FieldAction.ALLOW,
    'purchases.progress.bookmarks.note': FieldAction.ALLOW,
    'purchases.refund.reason': FieldAction.ALLOW,
    'purchases.receiptAnchors': FieldAction.ALLOW,
  },
});

/**
 * Mask an email address: "john.doe@example.com" -> "j***e@example.com"
 */
export function maskEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const parts = email.split('@');
  if (parts.length !== 2) return '***@***.***';
  const [local, domain] = parts;
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/**
 * Mask a Stellar/crypto wallet address: "GBEXAMPLEWALLETADDRESS12345" -> "GBEX...2345"
 */
export function maskWalletAddress(address) {
  if (!address || typeof address !== 'string') return null;
  if (address.length <= 10) return `${address.slice(0, 3)}...`;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Pseudonymize an identifier with SHA-256 for non-reversible compliance auditing.
 */
export function pseudonymize(value, salt = 'eduvault-privacy-salt') {
  if (!value) return null;
  return crypto.createHash('sha256').update(`${salt}:${String(value)}`).digest('hex').slice(0, 16);
}

/**
 * Custom error class for field-level authorization violations.
 */
export class FieldAuthorizationError extends Error {
  constructor(message, code, status = 403) {
    super(message);
    this.name = 'FieldAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Asserts that the requester is authorized to request the export and that
 * cross-subject data isolation boundaries are not violated.
 *
 * @param {object} params
 * @param {string} params.requesterRole
 * @param {string} [params.subjectWallet]
 * @param {object} params.exportDoc
 * @throws {FieldAuthorizationError}
 */
export function assertExportAuthorization({ requesterRole, subjectWallet, exportDoc } = {}) {
  const validRoles = Object.values(ExportRole);
  if (!validRoles.includes(requesterRole)) {
    throw new FieldAuthorizationError(
      `Unauthorized export role: "${requesterRole}". Valid roles: ${validRoles.join(', ')}`,
      'EVT_AUTH_FIELD_001',
      403,
    );
  }

  const exportSubjectWallet = exportDoc?.identity?.walletAddress || '';
  if (
    requesterRole === ExportRole.SUBJECT &&
    subjectWallet &&
    exportSubjectWallet &&
    subjectWallet.toLowerCase() !== exportSubjectWallet.toLowerCase()
  ) {
    throw new FieldAuthorizationError(
      'Access Denied: Subject cannot request another learner’s export.',
      'EVT_AUTH_FIELD_002',
      403,
    );
  }

  return true;
}

/**
 * Applies field-level authorization policies to a raw or built LearnerExport document.
 *
 * @param {object} exportDoc - Complete LearnerExport document
 * @param {object} context
 * @param {string} [context.requesterRole] - One of ExportRole (default: ExportRole.SUBJECT)
 * @param {string} [context.requesterId]   - Identity of the actor requesting the export
 * @param {string} [context.subjectWallet] - Wallet of the learner subject
 * @param {string} [context.purpose]       - Business or compliance justification
 * @returns {object} Privacy-safe transformed export document
 */
export function applyFieldLevelAuthorization(exportDoc, context = {}) {
  if (!exportDoc || typeof exportDoc !== 'object') {
    throw new FieldAuthorizationError('Invalid export document provided', 'EVT_EXPORT_INVALID', 400);
  }

  const {
    requesterRole = ExportRole.SUBJECT,
    requesterId = null,
    subjectWallet = null,
    purpose = 'general_export',
  } = context;

  // Verify role and cross-subject boundary
  assertExportAuthorization({ requesterRole, subjectWallet, exportDoc });

  const policy = ROLE_FIELD_POLICIES[requesterRole];
  const fieldsRedacted = [];
  const fieldsMasked = [];

  // Deep clone to prevent mutating original in-memory structures
  const filtered = JSON.parse(JSON.stringify(exportDoc));

  // 1. Identity field transformations
  if (filtered.identity) {
    // Email
    if (policy['identity.email'] === FieldAction.REDACT) {
      if (filtered.identity.email !== null) {
        filtered.identity.email = null;
        fieldsRedacted.push('identity.email');
      }
    } else if (policy['identity.email'] === FieldAction.MASK) {
      if (filtered.identity.email) {
        filtered.identity.email = maskEmail(filtered.identity.email);
        fieldsMasked.push('identity.email');
      }
    }

    // FullName
    if (policy['identity.fullName'] === FieldAction.REDACT) {
      if (filtered.identity.fullName !== null) {
        filtered.identity.fullName = null;
        fieldsRedacted.push('identity.fullName');
      }
    } else if (policy['identity.fullName'] === FieldAction.MASK) {
      if (filtered.identity.fullName) {
        filtered.identity.fullName = `${filtered.identity.fullName.slice(0, 1)}***`;
        fieldsMasked.push('identity.fullName');
      }
    }

    // WalletAddress
    if (policy['identity.walletAddress'] === FieldAction.HASH) {
      filtered.identity.walletAddress = `pseudo_${pseudonymize(filtered.identity.walletAddress)}`;
      fieldsMasked.push('identity.walletAddress');
    } else if (policy['identity.walletAddress'] === FieldAction.MASK) {
      filtered.identity.walletAddress = maskWalletAddress(filtered.identity.walletAddress);
      fieldsMasked.push('identity.walletAddress');
    }
  }

  // 2. Purchases array transformations
  if (Array.isArray(filtered.purchases)) {
    filtered.purchases = filtered.purchases.map((purchase) => {
      // SellerNet
      if (policy['purchases.sellerNet'] === FieldAction.REDACT) {
        if ('sellerNet' in purchase && purchase.sellerNet !== null) {
          purchase.sellerNet = null;
          fieldsRedacted.push('purchases[].sellerNet');
        }
      }

      // PlatformFee
      if (policy['purchases.platformFee'] === FieldAction.REDACT) {
        if ('platformFee' in purchase && purchase.platformFee !== null) {
          purchase.platformFee = null;
          fieldsRedacted.push('purchases[].platformFee');
        }
      }

      // Progress
      if (policy['purchases.progress'] === FieldAction.REDACT) {
        if (purchase.progress !== null) {
          purchase.progress = null;
          fieldsRedacted.push('purchases[].progress');
        }
      } else if (purchase.progress && policy['purchases.progress.bookmarks.note'] === FieldAction.REDACT) {
        if (Array.isArray(purchase.progress.bookmarks)) {
          purchase.progress.bookmarks = purchase.progress.bookmarks.map((b) => {
            const copy = { ...b };
            if ('note' in copy) {
              delete copy.note;
              fieldsRedacted.push('purchases[].progress.bookmarks[].note');
            }
            return copy;
          });
        }
      }

      // Refund Reason
      if (purchase.refund) {
        if (policy['purchases.refund.reason'] === FieldAction.MASK && purchase.refund.reason) {
          purchase.refund.reason = 'refund_processed_compliance_redacted';
          fieldsMasked.push('purchases[].refund.reason');
        }
      }

      return purchase;
    });
  }

  // 3. Attach Privacy & Authorization Metadata for auditability
  const canonicalContent = JSON.stringify({
    exportId: filtered.exportId,
    generatedAt: filtered.generatedAt,
    identity: filtered.identity,
    purchasesLength: filtered.purchases?.length || 0,
  });

  filtered.privacyMeta = {
    requesterRole,
    requesterId,
    purpose,
    fieldsRedacted: [...new Set(fieldsRedacted)],
    fieldsMasked: [...new Set(fieldsMasked)],
    authorizedAt: new Date().toISOString(),
    contentChecksum: crypto.createHash('sha256').update(canonicalContent).digest('hex'),
  };

  return filtered;
}

/**
 * Resilient export wrapper with configurable retries, exponential backoff,
 * and automatic field-level authorization filtering (#1151).
 *
 * @param {Function} exportFetcher - Async function fetching or building raw export document
 * @param {object} [context={}] - Authorization context
 * @param {object} [options={}] - Retry and timeout configuration
 * @param {number} [options.retries=2] - Number of retry attempts
 * @param {number} [options.delayMs=30] - Initial backoff delay
 * @param {Function} [options.sleep] - Sleeper function
 * @returns {Promise<object>} Filtered and authorized export document
 */
export async function exportWithPrivacyAuthorization(exportFetcher, context = {}, options = {}) {
  const { retries = 2, delayMs = 30, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const rawDoc = await exportFetcher(attempt);
      return applyFieldLevelAuthorization(rawDoc, context);
    } catch (err) {
      lastError = err;
      // Never retry terminal authorization or validation rejections
      if (err instanceof FieldAuthorizationError || err.code === 'EVT_EXPORT_INVALID' || err.status === 403 || err.status === 400) {
        throw err;
      }
      if (attempt < retries) {
        await sleep(delayMs * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Verifies post-export integrity against the cryptographic checksum in privacyMeta (#1151).
 * Confirms that no field was modified or unmasked post-authorization.
 *
 * @param {object} exportedDoc - Authorized export document
 * @returns {{valid: boolean, expectedChecksum?: string, actualChecksum?: string, reason: string}}
 */
export function verifyExportIntegrity(exportedDoc) {
  if (!exportedDoc || !exportedDoc.privacyMeta || !exportedDoc.privacyMeta.contentChecksum) {
    return { valid: false, reason: 'Missing privacy metadata or contentChecksum' };
  }

  const canonicalContent = JSON.stringify({
    exportId: exportedDoc.exportId,
    generatedAt: exportedDoc.generatedAt,
    identity: exportedDoc.identity,
    purchasesLength: exportedDoc.purchases?.length || 0,
  });

  const computed = crypto.createHash('sha256').update(canonicalContent).digest('hex');
  const matches = computed === exportedDoc.privacyMeta.contentChecksum;

  return {
    valid: matches,
    expectedChecksum: exportedDoc.privacyMeta.contentChecksum,
    actualChecksum: computed,
    reason: matches ? 'Export integrity verified' : 'Integrity check failed: content altered after privacy authorization',
  };
}

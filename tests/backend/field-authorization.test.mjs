import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  ExportRole,
  FieldAction,
  ROLE_FIELD_POLICIES,
  maskEmail,
  maskWalletAddress,
  pseudonymize,
  FieldAuthorizationError,
  applyFieldLevelAuthorization,
} from '../../src/lib/learner-export/fieldAuthorization.js';

describe('Privacy-Safe Export & Field-Level Authorization (Issue #1017)', () => {
  const sampleExportDoc = {
    schemaVersion: '1.0.0',
    exportId: 'test-export-uuid-1',
    generatedAt: '2026-10-16T12:00:00.000Z',
    redactionLevel: 'full',
    identity: {
      walletAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      email: 'student@example.org',
      fullName: 'Alice Student',
    },
    purchases: [
      {
        purchaseId: 'pur-1',
        materialId: 'mat-101',
        materialTitle: 'Rust for Soroban',
        amount: 5000,
        sellerNet: 4500,
        platformFee: 500,
        purchasedAt: '2026-10-15T10:00:00.000Z',
        entitlementState: 'active',
        refundStatus: 'none',
        refund: null,
        receiptAnchors: {
          metadataHash: 'meta-hash-1',
          rightsHash: 'rights-hash-1',
          saleTermsVersion: 1,
        },
        progress: {
          version: '1.0.0',
          progressPct: 80,
          bookmarks: [
            { id: 'b1', label: 'Chapter 2', note: 'Learner personal secret study note' },
          ],
        },
      },
      {
        purchaseId: 'pur-2',
        materialId: 'mat-102',
        amount: 2000,
        sellerNet: 1800,
        platformFee: 200,
        purchasedAt: '2026-10-14T09:00:00.000Z',
        entitlementState: 'revoked',
        refundStatus: 'completed',
        refund: {
          refundAmount: 2000,
          reason: 'Material contained typo on page 5',
        },
        receiptAnchors: {
          metadataHash: 'meta-hash-2',
        },
        progress: null,
      },
    ],
    summary: {
      totalPurchases: 2,
    },
  };

  describe('Masking and Pseudonymization Utilities', () => {
    test('masks standard and short email addresses', () => {
      assert.equal(maskEmail('alice.smith@university.edu'), 'a***h@university.edu');
      assert.equal(maskEmail('ed@work.co'), 'e***@work.co');
      assert.equal(maskEmail(null), null);
      assert.equal(maskEmail(''), null);
      assert.equal(maskEmail('invalid-email'), '***@***.***');
    });

    test('masks crypto wallet addresses cleanly', () => {
      const masked = maskWalletAddress('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H');
      assert.equal(masked, 'GBRP...OX2H');
      assert.equal(maskWalletAddress('SHORT'), 'SHO...');
      assert.equal(maskWalletAddress(null), null);
    });

    test('generates consistent non-reversible pseudonyms for auditors', () => {
      const hash1 = pseudonymize('user-123', 'saltA');
      const hash2 = pseudonymize('user-123', 'saltA');
      const hash3 = pseudonymize('user-123', 'saltB');

      assert.equal(hash1, hash2);
      assert.notEqual(hash1, hash3);
      assert.equal(hash1.length, 16);
    });
  });

  describe('Subject (Learner) Export Path', () => {
    test('allows learner to view own PII, notes, and receipts while redacting internal sellerNet/platformFee', () => {
      const result = applyFieldLevelAuthorization(sampleExportDoc, {
        requesterRole: ExportRole.SUBJECT,
        subjectWallet: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      });

      // Identity preserved
      assert.equal(result.identity.walletAddress, sampleExportDoc.identity.walletAddress);
      assert.equal(result.identity.email, 'student@example.org');
      assert.equal(result.identity.fullName, 'Alice Student');

      // Internal fee mechanics redacted for learner
      assert.equal(result.purchases[0].sellerNet, null);
      assert.equal(result.purchases[0].platformFee, null);

      // Private study note preserved for learner
      assert.equal(result.purchases[0].progress.bookmarks[0].note, 'Learner personal secret study note');

      // Audit meta attached
      assert.equal(result.privacyMeta.requesterRole, ExportRole.SUBJECT);
      assert.ok(result.privacyMeta.fieldsRedacted.includes('purchases[].sellerNet'));
      assert.ok(result.privacyMeta.contentChecksum);
    });

    test('blocks learner trying to export another learner account (Cross-Subject Authorization)', () => {
      assert.throws(
        () => {
          applyFieldLevelAuthorization(sampleExportDoc, {
            requesterRole: ExportRole.SUBJECT,
            subjectWallet: 'GDIFFERENTWALLETADDRESS99999999999999999999999999999999',
          });
        },
        (err) => err instanceof FieldAuthorizationError && err.code === 'EVT_AUTH_FIELD_002',
      );
    });
  });

  describe('Creator Export Path', () => {
    test('masks learner identity, strips private study notes, but exposes creator revenue net', () => {
      const result = applyFieldLevelAuthorization(sampleExportDoc, {
        requesterRole: ExportRole.CREATOR,
        requesterId: 'creator-99',
        purpose: 'revenue_reconciliation',
      });

      // Identity masked/redacted
      assert.equal(result.identity.walletAddress, 'GBRP...OX2H');
      assert.equal(result.identity.email, null);
      assert.equal(result.identity.fullName, null);

      // Seller revenue allowed
      assert.equal(result.purchases[0].sellerNet, 4500);
      assert.equal(result.purchases[0].platformFee, 500);

      // Private study notes stripped for privacy
      assert.equal(result.purchases[0].progress.bookmarks[0].note, undefined);
      assert.equal(result.purchases[0].progress.progressPct, 80);

      assert.ok(result.privacyMeta.fieldsMasked.includes('identity.walletAddress'));
      assert.ok(result.privacyMeta.fieldsRedacted.includes('identity.email'));
    });
  });

  describe('Customer Support Agent Export Path', () => {
    test('masks email and fullName, strips private learner notes, retains wallet and transaction data', () => {
      const result = applyFieldLevelAuthorization(sampleExportDoc, {
        requesterRole: ExportRole.SUPPORT,
        requesterId: 'support-agent-12',
        purpose: 'dispute_ticket_404',
      });

      assert.equal(result.identity.walletAddress, sampleExportDoc.identity.walletAddress);
      assert.equal(result.identity.email, 's***t@example.org');
      assert.equal(result.identity.fullName, 'A***');
      assert.equal(result.purchases[0].progress.bookmarks[0].note, undefined);
      assert.equal(result.purchases[1].refund.reason, 'Material contained typo on page 5');
    });
  });

  describe('External Auditor Export Path', () => {
    test('pseudonymizes wallet address, redacts progress completely, masks refund text', () => {
      const result = applyFieldLevelAuthorization(sampleExportDoc, {
        requesterRole: ExportRole.AUDITOR,
        requesterId: 'pwc-auditor-2026',
        purpose: 'annual_financial_audit',
      });

      assert.ok(result.identity.walletAddress.startsWith('pseudo_'));
      assert.equal(result.identity.email, null);
      assert.equal(result.identity.fullName, null);

      // Financials fully intact
      assert.equal(result.purchases[0].amount, 5000);
      assert.equal(result.purchases[0].sellerNet, 4500);
      assert.equal(result.purchases[0].platformFee, 500);
      assert.ok(result.purchases[0].receiptAnchors.metadataHash);

      // Progress irrelevant to finance -> redacted
      assert.equal(result.purchases[0].progress, null);

      // Sensitive refund note masked to generic compliance code
      assert.equal(result.purchases[1].refund.reason, 'refund_processed_compliance_redacted');
    });
  });

  describe('Admin and Failure Handling', () => {
    test('rejects unrecognized roles (fail-closed)', () => {
      assert.throws(
        () => {
          applyFieldLevelAuthorization(sampleExportDoc, {
            requesterRole: 'rogue_role',
          });
        },
        (err) => err instanceof FieldAuthorizationError && err.code === 'EVT_AUTH_FIELD_001',
      );
    });

    test('rejects invalid or null export document', () => {
      assert.throws(
        () => {
          applyFieldLevelAuthorization(null);
        },
        (err) => err instanceof FieldAuthorizationError && err.code === 'EVT_EXPORT_INVALID',
      );
    });

    test('admin receives complete unredacted export with audit metadata', () => {
      const result = applyFieldLevelAuthorization(sampleExportDoc, {
        requesterRole: ExportRole.ADMIN,
        requesterId: 'admin-lead',
        purpose: 'legal_investigation',
      });

      assert.equal(result.identity.email, 'student@example.org');
      assert.equal(result.purchases[0].sellerNet, 4500);
      assert.equal(result.purchases[0].progress.bookmarks[0].note, 'Learner personal secret study note');
      assert.equal(result.privacyMeta.requesterRole, ExportRole.ADMIN);
      assert.equal(result.privacyMeta.fieldsRedacted.length, 0);
    });
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExportRole,
  FieldAction,
  FieldAuthorizationError,
  applyFieldLevelAuthorization,
  assertExportAuthorization,
  exportWithPrivacyAuthorization,
  maskEmail,
  maskWalletAddress,
  pseudonymize,
  verifyExportIntegrity,
} from '../../src/lib/learner-export/fieldAuthorization.js';

function createSampleExport() {
  return {
    exportId: 'exp-12345',
    generatedAt: '2026-11-20T12:00:00.000Z',
    identity: {
      walletAddress: 'GBVI7VGL4ZGM4C5ZJ6L3HQVHQ4T2P7QZ7G2F6B7E2H6L4ZGM4C5ZJ6L3',
      email: 'ada.lovelace@example.com',
      fullName: 'Ada Lovelace',
    },
    purchases: [
      {
        materialId: 'mat-001',
        title: 'Algorithmic Foundations',
        price: '50.00',
        sellerNet: '45.00',
        platformFee: '5.00',
        progress: {
          percentage: 85,
          bookmarks: [
            { slide: 12, note: 'Personal private study note' },
          ],
        },
        refund: {
          requested: true,
          reason: 'Duplicate purchase by student mistake',
        },
        receiptAnchors: ['anchor-tx-abc-123'],
      },
    ],
  };
}

test('maskEmail handles standard, short, and malformed emails deterministically', () => {
  assert.equal(maskEmail('ada.lovelace@example.com'), 'a***e@example.com');
  assert.equal(maskEmail('al@example.com'), 'a***@example.com');
  assert.equal(maskEmail('not-an-email'), '***@***.***');
  assert.equal(maskEmail(null), null);
});

test('maskWalletAddress preserves edge characters while masking middle', () => {
  assert.equal(
    maskWalletAddress('GBVI7VGL4ZGM4C5ZJ6L3HQVHQ4T2P7QZ7G2F6B7E2H6L4ZGM4C5ZJ6L3'),
    'GBVI...J6L3'
  );
  assert.equal(maskWalletAddress('SHORT1234'), 'SHO...');
  assert.equal(maskWalletAddress(null), null);
});

test('pseudonymize produces deterministic truncated SHA-256 hex', () => {
  const hash1 = pseudonymize('GBVI7VGL4ZGM4C5ZJ6L3');
  const hash2 = pseudonymize('GBVI7VGL4ZGM4C5ZJ6L3');
  const hash3 = pseudonymize('OTHER_ADDRESS');

  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hash3);
  assert.equal(hash1.length, 16);
});

test('ExportRole.SUBJECT allows own identity but redacts financial revenue split', () => {
  const sample = createSampleExport();
  const filtered = applyFieldLevelAuthorization(sample, {
    requesterRole: ExportRole.SUBJECT,
    requesterId: 'ada',
    subjectWallet: 'GBVI7VGL4ZGM4C5ZJ6L3HQVHQ4T2P7QZ7G2F6B7E2H6L4ZGM4C5ZJ6L3',
  });

  // Learner sees own email, name, wallet, and study notes
  assert.equal(filtered.identity.email, 'ada.lovelace@example.com');
  assert.equal(filtered.identity.fullName, 'Ada Lovelace');
  assert.equal(filtered.identity.walletAddress, 'GBVI7VGL4ZGM4C5ZJ6L3HQVHQ4T2P7QZ7G2F6B7E2H6L4ZGM4C5ZJ6L3');
  assert.equal(filtered.purchases[0].progress.bookmarks[0].note, 'Personal private study note');

  // But internal platform revenue split is redacted
  assert.equal(filtered.purchases[0].sellerNet, null);
  assert.equal(filtered.purchases[0].platformFee, null);

  assert.ok(filtered.privacyMeta.fieldsRedacted.includes('purchases[].sellerNet'));
  assert.ok(filtered.privacyMeta.fieldsRedacted.includes('purchases[].platformFee'));
  assert.equal(verifyExportIntegrity(filtered).valid, true);
});

test('ExportRole.CREATOR masks wallet, redacts email and learner notes, preserves seller net', () => {
  const sample = createSampleExport();
  const filtered = applyFieldLevelAuthorization(sample, {
    requesterRole: ExportRole.CREATOR,
    requesterId: 'instructor-1',
  });

  // Wallet masked, email & name redacted
  assert.equal(filtered.identity.walletAddress, 'GBVI...J6L3');
  assert.equal(filtered.identity.email, null);
  assert.equal(filtered.identity.fullName, null);

  // Creator sees sellerNet and platformFee
  assert.equal(filtered.purchases[0].sellerNet, '45.00');
  assert.equal(filtered.purchases[0].platformFee, '5.00');

  // Learner's private bookmark note is deleted
  assert.equal(filtered.purchases[0].progress.bookmarks[0].note, undefined);
  assert.equal(verifyExportIntegrity(filtered).valid, true);
});

test('ExportRole.SUPPORT masks email and name for frontline privacy', () => {
  const sample = createSampleExport();
  const filtered = applyFieldLevelAuthorization(sample, {
    requesterRole: ExportRole.SUPPORT,
    requesterId: 'agent-42',
  });

  assert.equal(filtered.identity.email, 'a***e@example.com');
  assert.equal(filtered.identity.fullName, 'A***');
  assert.equal(filtered.identity.walletAddress, 'GBVI7VGL4ZGM4C5ZJ6L3HQVHQ4T2P7QZ7G2F6B7E2H6L4ZGM4C5ZJ6L3');
  assert.equal(verifyExportIntegrity(filtered).valid, true);
});

test('ExportRole.AUDITOR hashes wallet address, redacts progress, and masks refund reason', () => {
  const sample = createSampleExport();
  const filtered = applyFieldLevelAuthorization(sample, {
    requesterRole: ExportRole.AUDITOR,
    requesterId: 'external-compliance-audit',
  });

  // Wallet is non-reversibly pseudonymized
  assert.ok(filtered.identity.walletAddress.startsWith('pseudo_'));
  assert.equal(filtered.identity.email, null);
  assert.equal(filtered.identity.fullName, null);

  // Progress completely stripped
  assert.equal(filtered.purchases[0].progress, null);

  // Refund reason masked to generic compliance label
  assert.equal(filtered.purchases[0].refund.reason, 'refund_processed_compliance_redacted');

  // Financial ledger anchors remain intact for reconciliation
  assert.equal(filtered.purchases[0].sellerNet, '45.00');
  assert.equal(filtered.purchases[0].platformFee, '5.00');
  assert.deepEqual(filtered.purchases[0].receiptAnchors, ['anchor-tx-abc-123']);
  assert.equal(verifyExportIntegrity(filtered).valid, true);
});

test('ExportRole.ADMIN retains full unredacted access', () => {
  const sample = createSampleExport();
  const filtered = applyFieldLevelAuthorization(sample, {
    requesterRole: ExportRole.ADMIN,
    requesterId: 'sys-admin',
  });

  assert.equal(filtered.identity.email, 'ada.lovelace@example.com');
  assert.equal(filtered.identity.fullName, 'Ada Lovelace');
  assert.equal(filtered.purchases[0].sellerNet, '45.00');
  assert.equal(filtered.purchases[0].progress.bookmarks[0].note, 'Personal private study note');
  assert.equal(filtered.privacyMeta.fieldsRedacted.length, 0);
  assert.equal(verifyExportIntegrity(filtered).valid, true);
});

test('assertExportAuthorization blocks unauthorized roles and cross-subject attempts', () => {
  const sample = createSampleExport();

  // Invalid role rejected
  assert.throws(
    () => applyFieldLevelAuthorization(sample, { requesterRole: 'super_hacker' }),
    (err) => err instanceof FieldAuthorizationError && err.code === 'EVT_AUTH_FIELD_001'
  );

  // Cross-subject attempt: user B trying to export user A's data
  assert.throws(
    () =>
      applyFieldLevelAuthorization(sample, {
        requesterRole: ExportRole.SUBJECT,
        subjectWallet: 'GB_DIFFERENT_WALLET_USER_B',
      }),
    (err) => err instanceof FieldAuthorizationError && err.code === 'EVT_AUTH_FIELD_002'
  );

  // Null export document rejected
  assert.throws(
    () => applyFieldLevelAuthorization(null),
    (err) => err instanceof FieldAuthorizationError && err.code === 'EVT_EXPORT_INVALID'
  );
});

test('exportWithPrivacyAuthorization retries transient errors and succeeds', async () => {
  let attempts = 0;
  const flakeyFetcher = async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error('Transient network timeout connecting to MongoDB replica');
    }
    return createSampleExport();
  };

  const authorized = await exportWithPrivacyAuthorization(flakeyFetcher, {
    requesterRole: ExportRole.SUPPORT,
    requesterId: 'agent-1',
  }, { retries: 2, delayMs: 10 });

  assert.equal(attempts, 2);
  assert.equal(authorized.identity.email, 'a***e@example.com');
  assert.equal(verifyExportIntegrity(authorized).valid, true);
});

test('exportWithPrivacyAuthorization does not retry authorization rejections', async () => {
  let attempts = 0;
  const fetcher = async () => {
    attempts++;
    return createSampleExport();
  };

  await assert.rejects(
    async () => {
      await exportWithPrivacyAuthorization(fetcher, {
        requesterRole: ExportRole.SUBJECT,
        subjectWallet: 'GB_WRONG_USER',
      }, { retries: 3 });
    },
    (err) => err.code === 'EVT_AUTH_FIELD_002'
  );

  assert.equal(attempts, 1, 'Should fail immediately without retrying authorization rejection');
});

test('verifyExportIntegrity detects unauthorized tampering of export content', () => {
  const sample = createSampleExport();
  const authorized = applyFieldLevelAuthorization(sample, {
    requesterRole: ExportRole.CREATOR,
    requesterId: 'creator-1',
  });

  // Clean document passes
  assert.equal(verifyExportIntegrity(authorized).valid, true);

  // Illegally modify unmasked email post-export
  authorized.identity.email = 'leaked.secret@example.com';
  const tamperResult = verifyExportIntegrity(authorized);
  assert.equal(tamperResult.valid, false);
  assert.ok(tamperResult.reason.includes('Integrity check failed'));
});

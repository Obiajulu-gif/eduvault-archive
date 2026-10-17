import { describe, expect, it } from 'vitest';
import {
  ExportRole,
  maskEmail,
  maskWalletAddress,
  pseudonymize,
  applyFieldLevelAuthorization,
  FieldAuthorizationError,
} from '../learner-export/fieldAuthorization.js';

describe('Field-Level Authorization for Learner Exports (Issue #1017)', () => {
  const dummyDoc = {
    schemaVersion: '1.0.0',
    exportId: 'exp-1',
    generatedAt: new Date().toISOString(),
    redactionLevel: 'full',
    identity: {
      walletAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      email: 'learner@edu.com',
      fullName: 'John Learner',
    },
    purchases: [
      {
        purchaseId: 'p-1',
        materialId: 'm-1',
        amount: 3000,
        sellerNet: 2700,
        platformFee: 300,
        progress: {
          bookmarks: [{ id: '1', note: 'Private learner insight' }],
        },
      },
    ],
  };

  it('masks emails and wallet addresses properly', () => {
    expect(maskEmail('hello@domain.org')).toBe('h***o@domain.org');
    expect(maskWalletAddress('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H')).toBe('GBRP...OX2H');
  });

  it('redacts sellerNet/platformFee for subject learner', () => {
    const res = applyFieldLevelAuthorization(dummyDoc, {
      requesterRole: ExportRole.SUBJECT,
      subjectWallet: dummyDoc.identity.walletAddress,
    });
    expect(res.purchases[0].sellerNet).toBeNull();
    expect(res.purchases[0].platformFee).toBeNull();
    expect(res.purchases[0].progress.bookmarks[0].note).toBe('Private learner insight');
  });

  it('masks learner identity and strips notes for creator', () => {
    const res = applyFieldLevelAuthorization(dummyDoc, {
      requesterRole: ExportRole.CREATOR,
    });
    expect(res.identity.walletAddress).toBe('GBRP...OX2H');
    expect(res.identity.email).toBeNull();
    expect(res.purchases[0].sellerNet).toBe(2700);
    expect(res.purchases[0].progress.bookmarks[0].note).toBeUndefined();
  });

  it('rejects cross-subject request by unauthorized learner', () => {
    expect(() => {
      applyFieldLevelAuthorization(dummyDoc, {
        requesterRole: ExportRole.SUBJECT,
        subjectWallet: 'GDIFFERENTWALLET123',
      });
    }).toThrow(FieldAuthorizationError);
  });
});

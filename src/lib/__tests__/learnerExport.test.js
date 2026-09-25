/**
 * src/lib/__tests__/learnerExport.test.js
 *
 * Vitest unit tests for the learner library export feature.
 *
 * Test coverage:
 *   ✓ Empty library (no purchases, no progress)
 *   ✓ Active purchase with full receipt anchors
 *   ✓ Refunded purchase — entitlement revoked, refund detail present
 *   ✓ Version-update scenario — snapshot preserves purchase-time metadata
 *   ✓ Privacy redaction levels (full / partial / minimal)
 *   ✓ Summary counts are correct across mixed entitlement states
 *   ✓ validateExport passes on well-formed documents
 *   ✓ validateExport catches missing / wrong-type fields
 *   ✓ buildLearnerExport throws on missing required args
 *   ✓ receiptHash is deterministic for the same input
 *   ✓ Progress / bookmark export
 *   ✓ Multiple purchases with mixed refund states
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildLearnerExport } from '../learner-export/buildLearnerExport.js';
import {
  validateExport,
  EXPORT_SCHEMA_VERSION,
  RedactionLevel,
  RefundStatus,
  EntitlementState,
  buildSummary,
} from '../learner-export/schema.js';

// ── shared fixtures ───────────────────────────────────────────────────────────

const WALLET = 'GTEST_WALLET_ADDRESS_LOCAL_00000000000000000000000000000000';

function makeUser(overrides = {}) {
  return {
    walletAddress:      WALLET,
    walletAddressLower: WALLET.toLowerCase(),
    email:              'learner@example.com',
    fullName:           'Test Learner',
    role:               'buyer',
    ...overrides,
  };
}

function makePurchase(overrides = {}) {
  return {
    _id:        'purchase_id_001',
    purchaseId: 'purchase_id_001',
    materialId: 'material_abc',
    buyerAddress: WALLET,
    sellerAddress: 'GCREATOR_XYZ',
    status:     'confirmed',
    asset:      'GDUSDC_LOCAL',
    amount:     10_000_000,
    chainTxHash:'TXHASH_001',
    purchaseSnapshot: {
      metadataHash:     'META_HASH_001',
      rightsHash:       'RIGHTS_HASH_001',
      saleTermsVersion: 1,
      purchaseLedger:   1_000_000,
    },
    createdAt:  new Date('2026-01-15T10:00:00Z'),
    updatedAt:  new Date('2026-01-15T10:00:00Z'),
    ...overrides,
  };
}

function makeEntitlement(overrides = {}) {
  return {
    materialId:   'material_abc',
    buyerAddress: WALLET,
    active:       true,
    source:       'soroban',
    ...overrides,
  };
}

function makeRefund(overrides = {}) {
  return {
    purchaseId:   'purchase_id_001',
    materialId:   'material_abc',
    buyerAddress: WALLET,
    status:       'completed',
    amount:       9_500_000,
    reason:       'Content did not match description',
    requestedAt:  new Date('2026-01-20T09:00:00Z'),
    completedAt:  new Date('2026-01-21T12:00:00Z'),
    createdAt:    new Date('2026-01-20T09:00:00Z'),
    ...overrides,
  };
}

function makeMaterial(overrides = {}) {
  return {
    materialId: 'material_abc',
    title:      'Introduction to Soroban',
    userAddress: 'GCREATOR_XYZ',
    visibility:  'public',
    ...overrides,
  };
}

function makeProgress(overrides = {}) {
  return {
    materialId:     'material_abc',
    walletAddress:  WALLET,
    version:        'v1',
    progressPct:    42,
    lastAccessedAt: new Date('2026-02-01T08:00:00Z'),
    bookmarks: [
      { id: 'bm1', label: 'Chapter 3 intro', note: 're-read', createdAt: new Date('2026-01-25T10:00:00Z') },
      { id: 'bm2', label: 'Final exercise',  createdAt: new Date('2026-01-28T14:00:00Z') },
    ],
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('buildLearnerExport', () => {

  it('throws when user is missing', () => {
    expect(() => buildLearnerExport({ user: null, purchases: [] }))
      .toThrow('user is required');
  });

  it('throws when purchases is missing', () => {
    expect(() => buildLearnerExport({ user: makeUser(), purchases: undefined }))
      .toThrow('purchases is required');
  });

  describe('empty library', () => {
    let exportDoc;

    beforeEach(() => {
      exportDoc = buildLearnerExport({
        user:         makeUser(),
        purchases:    [],
        entitlements: [],
        refunds:      [],
        materials:    [],
      });
    });

    it('produces a valid export document', () => {
      const errors = validateExport(exportDoc);
      expect(errors).toEqual([]);
    });

    it('sets the correct schemaVersion', () => {
      expect(exportDoc.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    });

    it('generates a non-empty exportId', () => {
      expect(typeof exportDoc.exportId).toBe('string');
      expect(exportDoc.exportId.length).toBeGreaterThan(0);
    });

    it('generatedAt is a valid ISO string', () => {
      expect(() => new Date(exportDoc.generatedAt).toISOString()).not.toThrow();
    });

    it('has an empty purchases array', () => {
      expect(exportDoc.purchases).toEqual([]);
    });

    it('summary shows all zeros for an empty library', () => {
      expect(exportDoc.summary.totalPurchases).toBe(0);
      expect(exportDoc.summary.activePurchases).toBe(0);
      expect(exportDoc.summary.totalSpendMinorUnits).toBe(0);
    });

    it('uses PARTIAL redaction by default — email is null', () => {
      expect(exportDoc.redactionLevel).toBe(RedactionLevel.PARTIAL);
      expect(exportDoc.identity.email).toBeNull();
      expect(exportDoc.identity.fullName).toBeNull();
    });

    it('walletAddress is always present', () => {
      expect(exportDoc.identity.walletAddress).toBe(WALLET);
    });
  });

  describe('active purchase with full receipt anchors', () => {
    let exportDoc;

    beforeEach(() => {
      exportDoc = buildLearnerExport({
        user:         makeUser(),
        purchases:    [makePurchase()],
        entitlements: [makeEntitlement()],
        refunds:      [],
        materials:    [makeMaterial()],
      });
    });

    it('produces a valid export document', () => {
      expect(validateExport(exportDoc)).toEqual([]);
    });

    it('includes the purchase', () => {
      expect(exportDoc.purchases).toHaveLength(1);
    });

    it('carries the material title', () => {
      expect(exportDoc.purchases[0].materialTitle).toBe('Introduction to Soroban');
    });

    it('entitlementState is active', () => {
      expect(exportDoc.purchases[0].entitlementState).toBe(EntitlementState.ACTIVE);
    });

    it('refundStatus is none', () => {
      expect(exportDoc.purchases[0].refundStatus).toBe(RefundStatus.NONE);
    });

    it('refund detail is null', () => {
      expect(exportDoc.purchases[0].refund).toBeNull();
    });

    it('carries all receiptAnchor fields', () => {
      const anchors = exportDoc.purchases[0].receiptAnchors;
      expect(anchors.metadataHash).toBe('META_HASH_001');
      expect(anchors.rightsHash).toBe('RIGHTS_HASH_001');
      expect(anchors.saleTermsVersion).toBe(1);
      expect(anchors.purchaseLedger).toBe(1_000_000);
      expect(anchors.transactionId).toBe('TXHASH_001');
    });

    it('receiptHash is a non-empty hex string', () => {
      const h = exportDoc.purchases[0].receiptAnchors.receiptHash;
      expect(typeof h).toBe('string');
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('summary reflects one active purchase', () => {
      expect(exportDoc.summary.totalPurchases).toBe(1);
      expect(exportDoc.summary.activePurchases).toBe(1);
      expect(exportDoc.summary.revokedPurchases).toBe(0);
      expect(exportDoc.summary.totalSpendMinorUnits).toBe(10_000_000);
    });
  });

  describe('refunded purchase', () => {
    let exportDoc;

    beforeEach(() => {
      exportDoc = buildLearnerExport({
        user:         makeUser(),
        purchases:    [makePurchase()],
        entitlements: [makeEntitlement({ active: false })],
        refunds:      [makeRefund()],
        materials:    [makeMaterial()],
      });
    });

    it('produces a valid export document', () => {
      expect(validateExport(exportDoc)).toEqual([]);
    });

    it('entitlementState is revoked', () => {
      expect(exportDoc.purchases[0].entitlementState).toBe(EntitlementState.REVOKED);
    });

    it('refundStatus is completed', () => {
      expect(exportDoc.purchases[0].refundStatus).toBe(RefundStatus.COMPLETED);
    });

    it('refund detail is populated', () => {
      const refund = exportDoc.purchases[0].refund;
      expect(refund).not.toBeNull();
      expect(refund.refundAmount).toBe(9_500_000);
      expect(refund.reason).toBe('Content did not match description');
      expect(refund.requestedAt).toMatch(/^2026-01-20/);
      expect(refund.completedAt).toMatch(/^2026-01-21/);
    });

    it('summary reflects one revoked and one refunded purchase', () => {
      expect(exportDoc.summary.revokedPurchases).toBe(1);
      expect(exportDoc.summary.refundedPurchases).toBe(1);
      expect(exportDoc.summary.activePurchases).toBe(0);
    });
  });

  describe('version update — snapshot preserves purchase-time metadata', () => {
    it('receiptHash does not change when material is updated post-purchase', () => {
      const original = buildLearnerExport({
        user:         makeUser(),
        purchases:    [makePurchase()],
        entitlements: [makeEntitlement()],
        refunds:      [],
        materials:    [makeMaterial({ title: 'v1 title' })],
      });

      // Simulate creator updating material title after purchase.
      const afterUpdate = buildLearnerExport({
        user:         makeUser(),
        purchases:    [makePurchase()],
        entitlements: [makeEntitlement()],
        refunds:      [],
        materials:    [makeMaterial({ title: 'v2 updated title' })],
      });

      expect(original.purchases[0].receiptAnchors.receiptHash)
        .toBe(afterUpdate.purchases[0].receiptAnchors.receiptHash);
    });

    it('receiptHash changes when snapshot metadataHash differs', () => {
      const doc1 = buildLearnerExport({
        user:         makeUser(),
        purchases:    [makePurchase()],
        entitlements: [makeEntitlement()],
        refunds:      [],
        materials:    [],
      });

      const doc2 = buildLearnerExport({
        user:         makeUser(),
        purchases:    [makePurchase({ purchaseSnapshot: { metadataHash: 'DIFFERENT_HASH', rightsHash: 'R', saleTermsVersion: 2, purchaseLedger: 2 } })],
        entitlements: [makeEntitlement()],
        refunds:      [],
        materials:    [],
      });

      expect(doc1.purchases[0].receiptAnchors.receiptHash)
        .not.toBe(doc2.purchases[0].receiptAnchors.receiptHash);
    });
  });

  describe('privacy redaction levels', () => {
    it('FULL redaction exposes email and fullName', () => {
      const doc = buildLearnerExport({
        user:         makeUser(),
        purchases:    [],
        entitlements: [],
        refunds:      [],
        materials:    [],
        redactionLevel: RedactionLevel.FULL,
      });
      expect(doc.identity.email).toBe('learner@example.com');
      expect(doc.identity.fullName).toBe('Test Learner');
      expect(doc.redactionLevel).toBe(RedactionLevel.FULL);
    });

    it('PARTIAL redaction (default) redacts email and fullName', () => {
      const doc = buildLearnerExport({
        user:      makeUser(),
        purchases: [],
        entitlements: [],
        refunds:   [],
        materials: [],
      });
      expect(doc.identity.email).toBeNull();
      expect(doc.identity.fullName).toBeNull();
      expect(doc.identity.walletAddress).toBe(WALLET);
    });

    it('MINIMAL redaction also redacts email and fullName', () => {
      const doc = buildLearnerExport({
        user:         makeUser(),
        purchases:    [],
        entitlements: [],
        refunds:      [],
        materials:    [],
        redactionLevel: RedactionLevel.MINIMAL,
      });
      expect(doc.identity.email).toBeNull();
      expect(doc.identity.fullName).toBeNull();
      expect(doc.identity.walletAddress).toBe(WALLET);
    });

    it('walletAddress is present in all redaction levels', () => {
      for (const level of Object.values(RedactionLevel)) {
        const doc = buildLearnerExport({
          user:         makeUser(),
          purchases:    [],
          entitlements: [],
          refunds:      [],
          materials:    [],
          redactionLevel: level,
        });
        expect(doc.identity.walletAddress).toBe(WALLET);
      }
    });
  });

  describe('progress and bookmarks', () => {
    let exportDoc;

    beforeEach(() => {
      exportDoc = buildLearnerExport({
        user:            makeUser(),
        purchases:       [makePurchase()],
        entitlements:    [makeEntitlement()],
        refunds:         [],
        materials:       [makeMaterial()],
        progressRecords: [makeProgress()],
      });
    });

    it('produces a valid export document', () => {
      expect(validateExport(exportDoc)).toEqual([]);
    });

    it('progress entry is included', () => {
      expect(exportDoc.purchases[0].progress).not.toBeNull();
    });

    it('progress fields are populated', () => {
      const prog = exportDoc.purchases[0].progress;
      expect(prog.version).toBe('v1');
      expect(prog.progressPct).toBe(42);
      expect(prog.lastAccessedAt).toMatch(/^2026-02-01/);
    });

    it('bookmarks are exported', () => {
      const bookmarks = exportDoc.purchases[0].progress.bookmarks;
      expect(bookmarks).toHaveLength(2);
      expect(bookmarks[0].label).toBe('Chapter 3 intro');
      expect(bookmarks[0].note).toBe('re-read');
      expect(bookmarks[1].label).toBe('Final exercise');
    });

    it('summary counts purchases with progress', () => {
      expect(exportDoc.summary.purchasesWithProgress).toBe(1);
    });
  });

  describe('multiple purchases with mixed states', () => {
    let exportDoc;

    beforeEach(() => {
      const p1 = makePurchase({ purchaseId: 'p1', materialId: 'mat_a', amount: 10_000_000 });
      const p2 = makePurchase({ purchaseId: 'p2', materialId: 'mat_b', amount: 20_000_000 });
      const p3 = makePurchase({ purchaseId: 'p3', materialId: 'mat_c', amount: 5_000_000 });

      exportDoc = buildLearnerExport({
        user:      makeUser(),
        purchases: [p1, p2, p3],
        entitlements: [
          makeEntitlement({ materialId: 'mat_a', active: true }),
          makeEntitlement({ materialId: 'mat_b', active: false }),
          makeEntitlement({ materialId: 'mat_c', active: true }),
        ],
        refunds: [
          makeRefund({ purchaseId: 'p2', materialId: 'mat_b', amount: 19_000_000 }),
        ],
        materials: [
          makeMaterial({ materialId: 'mat_a', title: 'Course A' }),
          makeMaterial({ materialId: 'mat_b', title: 'Course B' }),
          makeMaterial({ materialId: 'mat_c', title: 'Course C' }),
        ],
      });
    });

    it('produces a valid export document', () => {
      expect(validateExport(exportDoc)).toEqual([]);
    });

    it('has three purchase entries', () => {
      expect(exportDoc.purchases).toHaveLength(3);
    });

    it('p1 is active', () => {
      const p1 = exportDoc.purchases.find(p => p.purchaseId === 'p1');
      expect(p1.entitlementState).toBe(EntitlementState.ACTIVE);
      expect(p1.refundStatus).toBe(RefundStatus.NONE);
    });

    it('p2 is revoked and refunded', () => {
      const p2 = exportDoc.purchases.find(p => p.purchaseId === 'p2');
      expect(p2.entitlementState).toBe(EntitlementState.REVOKED);
      expect(p2.refundStatus).toBe(RefundStatus.COMPLETED);
      expect(p2.refund.refundAmount).toBe(19_000_000);
    });

    it('p3 is active', () => {
      const p3 = exportDoc.purchases.find(p => p.purchaseId === 'p3');
      expect(p3.entitlementState).toBe(EntitlementState.ACTIVE);
      expect(p3.refundStatus).toBe(RefundStatus.NONE);
    });

    it('summary totals are correct', () => {
      expect(exportDoc.summary.totalPurchases).toBe(3);
      expect(exportDoc.summary.activePurchases).toBe(2);
      expect(exportDoc.summary.revokedPurchases).toBe(1);
      expect(exportDoc.summary.refundedPurchases).toBe(1);
      expect(exportDoc.summary.totalSpendMinorUnits).toBe(35_000_000);
    });
  });

  describe('receiptHash determinism', () => {
    it('same purchase produces the same receiptHash on multiple calls', () => {
      const purchase = makePurchase();
      const doc1 = buildLearnerExport({
        user: makeUser(), purchases: [purchase],
        entitlements: [makeEntitlement()], refunds: [], materials: [],
      });
      const doc2 = buildLearnerExport({
        user: makeUser(), purchases: [purchase],
        entitlements: [makeEntitlement()], refunds: [], materials: [],
      });
      expect(doc1.purchases[0].receiptAnchors.receiptHash)
        .toBe(doc2.purchases[0].receiptAnchors.receiptHash);
    });
  });
});

// ── validateExport unit tests ─────────────────────────────────────────────────

describe('validateExport', () => {
  it('returns no errors for a well-formed export', () => {
    const doc = buildLearnerExport({
      user:         makeUser(),
      purchases:    [makePurchase()],
      entitlements: [makeEntitlement()],
      refunds:      [],
      materials:    [makeMaterial()],
    });
    expect(validateExport(doc)).toEqual([]);
  });

  it('errors on null input', () => {
    const errors = validateExport(null);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/non-null object/);
  });

  it('errors on wrong schemaVersion', () => {
    const doc = buildLearnerExport({ user: makeUser(), purchases: [], entitlements: [], refunds: [], materials: [] });
    doc.schemaVersion = '99.0.0';
    expect(validateExport(doc)).toEqual(
      expect.arrayContaining([expect.stringContaining('schemaVersion')]),
    );
  });

  it('errors when exportId is missing', () => {
    const doc = buildLearnerExport({ user: makeUser(), purchases: [], entitlements: [], refunds: [], materials: [] });
    doc.exportId = '';
    expect(validateExport(doc)).toEqual(
      expect.arrayContaining([expect.stringContaining('exportId')]),
    );
  });

  it('errors when generatedAt is not a valid date', () => {
    const doc = buildLearnerExport({ user: makeUser(), purchases: [], entitlements: [], refunds: [], materials: [] });
    doc.generatedAt = 'not-a-date';
    expect(validateExport(doc)).toEqual(
      expect.arrayContaining([expect.stringContaining('generatedAt')]),
    );
  });

  it('errors on invalid redactionLevel', () => {
    const doc = buildLearnerExport({ user: makeUser(), purchases: [], entitlements: [], refunds: [], materials: [] });
    doc.redactionLevel = 'none';
    expect(validateExport(doc)).toEqual(
      expect.arrayContaining([expect.stringContaining('redactionLevel')]),
    );
  });

  it('errors when identity.walletAddress is missing', () => {
    const doc = buildLearnerExport({ user: makeUser(), purchases: [], entitlements: [], refunds: [], materials: [] });
    doc.identity.walletAddress = '';
    expect(validateExport(doc)).toEqual(
      expect.arrayContaining([expect.stringContaining('walletAddress')]),
    );
  });

  it('errors when purchase entry has wrong-type amount', () => {
    const doc = buildLearnerExport({
      user: makeUser(), purchases: [makePurchase()],
      entitlements: [makeEntitlement()], refunds: [], materials: [],
    });
    doc.purchases[0].amount = 'not-a-number';
    expect(validateExport(doc)).toEqual(
      expect.arrayContaining([expect.stringContaining('amount')]),
    );
  });

  it('errors when purchase entitlementState is invalid', () => {
    const doc = buildLearnerExport({
      user: makeUser(), purchases: [makePurchase()],
      entitlements: [makeEntitlement()], refunds: [], materials: [],
    });
    doc.purchases[0].entitlementState = 'super_active';
    expect(validateExport(doc)).toEqual(
      expect.arrayContaining([expect.stringContaining('entitlementState')]),
    );
  });
});

// ── buildSummary unit tests ───────────────────────────────────────────────────

describe('buildSummary', () => {
  it('all zeros for empty array', () => {
    expect(buildSummary([])).toEqual({
      totalPurchases:       0,
      activePurchases:      0,
      revokedPurchases:     0,
      refundedPurchases:    0,
      purchasesWithProgress:0,
      totalSpendMinorUnits: 0,
    });
  });

  it('counts correctly for mixed states', () => {
    const entries = [
      { entitlementState: EntitlementState.ACTIVE,  refundStatus: RefundStatus.NONE,      progress: null,  amount: 10 },
      { entitlementState: EntitlementState.REVOKED,  refundStatus: RefundStatus.COMPLETED, progress: {},    amount: 20 },
      { entitlementState: EntitlementState.ACTIVE,  refundStatus: RefundStatus.NONE,      progress: {},    amount: 5  },
      { entitlementState: EntitlementState.DISPUTED, refundStatus: RefundStatus.REQUESTED, progress: null, amount: 30 },
    ];
    const summary = buildSummary(entries);
    expect(summary.totalPurchases).toBe(4);
    expect(summary.activePurchases).toBe(2);
    expect(summary.revokedPurchases).toBe(1);
    expect(summary.refundedPurchases).toBe(1);
    expect(summary.purchasesWithProgress).toBe(2);
    expect(summary.totalSpendMinorUnits).toBe(65);
  });
});

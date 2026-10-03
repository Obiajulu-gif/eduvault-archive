// @vitest-environment node
//
// #838: authorization-aware learner export.
//
// Acceptance coverage:
//   ✓ valid export   — authorized self-export produces a valid document
//   ✓ empty export   — a learner with no records gets a valid empty document
//   ✓ denied export  — unauthorized requesters get a typed error and no data
//   ✓ large export   — thousands of purchases complete with correct summary
//
// Security coverage:
//   ✓ FULL redaction is downgraded for privileged (cross-user) exports
//   ✓ foreign rows passed to the wrapper are filtered out
//   ✓ admin/support are allow-listed, ordinary roles are not
import { describe, it, expect } from 'vitest';
import {
  exportLearnerData,
  authorizeExport,
  ExportAuthorizationError,
  ExportAuthorizationErrorCode,
  ExportScope,
  EXPORT_PRIVILEGED_ROLES,
} from '../learner-export/exportLearnerData.js';
import {
  validateExport,
  EXPORT_SCHEMA_VERSION,
  RedactionLevel,
  RefundStatus,
  EntitlementState,
} from '../learner-export/schema.js';

const WALLET_A = 'GEXPORT_A_00000000000000000000000000000000000000000000';
const WALLET_B = 'GEXPORT_B_000000000000000000000000000000000000000000000';

function makeRequester(overrides = {}) {
  return {
    _id:                'user-a',
    walletAddress:      WALLET_A,
    walletAddressLower: WALLET_A.toLowerCase(),
    email:              'a@example.com',
    fullName:           'Learner A',
    role:               'learner',
    ...overrides,
  };
}

function makeSubject(overrides = {}) {
  return {
    _id:                'user-a',
    walletAddress:      WALLET_A,
    walletAddressLower: WALLET_A.toLowerCase(),
    email:              'a@example.com',
    fullName:           'Learner A',
    role:               'learner',
    ...overrides,
  };
}

function makePurchase(overrides = {}) {
  return {
    _id:        'p1',
    purchaseId: 'p1',
    materialId: 'mat_a',
    buyerAddress: WALLET_A,
    sellerAddress: 'GCREATOR',
    status:     'confirmed',
    asset:      'GDUSDC',
    amount:     10_000_000,
    purchaseSnapshot: {
      metadataHash:     'META',
      rightsHash:       'RIGHTS',
      saleTermsVersion: 1,
      purchaseLedger:   100,
    },
    createdAt: new Date('2026-01-15T10:00:00Z'),
    ...overrides,
  };
}

function makeEntitlement(overrides = {}) {
  return {
    materialId:   'mat_a',
    buyerAddress: WALLET_A,
    active:       true,
    ...overrides,
  };
}

function makeRefund(overrides = {}) {
  return {
    purchaseId:   'p1',
    materialId:   'mat_a',
    buyerAddress: WALLET_A,
    status:       'completed',
    amount:       9_500_000,
    reason:       'not as described',
    requestedAt:  new Date('2026-01-20T09:00:00Z'),
    completedAt:  new Date('2026-01-21T12:00:00Z'),
    ...overrides,
  };
}

function makeProgress(overrides = {}) {
  return {
    materialId:    'mat_a',
    walletAddress: WALLET_A,
    version:       'v1',
    progressPct:   50,
    lastAccessedAt: new Date('2026-02-01T08:00:00Z'),
    bookmarks:     [{ id: 'bm1', label: 'ch1', createdAt: new Date('2026-01-25T10:00:00Z') }],
    ...overrides,
  };
}

// ── valid export ──────────────────────────────────────────────────────────────

describe('exportLearnerData — valid export', () => {
  it('authorizes a self-export and returns a schema-valid document', () => {
    const doc = exportLearnerData({
      requester:    makeRequester(),
      subject:      makeSubject(),
      purchases:    [makePurchase()],
      entitlements: [makeEntitlement()],
      refunds:      [],
      materials:    [{ materialId: 'mat_a', title: 'Course A' }],
      progressRecords: [makeProgress()],
    });

    expect(validateExport(doc)).toEqual([]);
    expect(doc.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(typeof doc.generatedAt).toBe('string');
    expect(() => new Date(doc.generatedAt).toISOString()).not.toThrow();
    expect(doc.authorization.scope).toBe(ExportScope.SELF);
    expect(doc.purchases).toHaveLength(1);
    expect(doc.summary.totalPurchases).toBe(1);
    expect(doc.purchases[0].entitlementState).toBe(EntitlementState.ACTIVE);
    expect(doc.retention.artifactLifetime).toBe('ephemeral');
    expect(doc.retention.expiresAt).toBeNull();
  });

  it('allows FULL redaction (PII) for the learner\'s own export', () => {
    const doc = exportLearnerData({
      requester:      makeRequester(),
      subject:        makeSubject(),
      purchases:      [],
      redactionLevel: RedactionLevel.FULL,
    });
    expect(doc.redactionLevel).toBe(RedactionLevel.FULL);
    expect(doc.identity.email).toBe('a@example.com');
    expect(doc.identity.fullName).toBe('Learner A');
  });
});

// ── empty export ──────────────────────────────────────────────────────────────

describe('exportLearnerData — empty export', () => {
  it('produces a valid empty document for a learner with no records', () => {
    const doc = exportLearnerData({
      requester: makeRequester(),
      subject:   makeSubject(),
      purchases: [],
    });

    expect(validateExport(doc)).toEqual([]);
    expect(doc.purchases).toEqual([]);
    expect(doc.summary).toEqual({
      totalPurchases:       0,
      activePurchases:      0,
      revokedPurchases:     0,
      refundedPurchases:    0,
      purchasesWithProgress:0,
      totalSpendMinorUnits: 0,
    });
  });
});

// ── denied export ─────────────────────────────────────────────────────────────

describe('exportLearnerData — denied export', () => {
  it('denies an unauthenticated requester with a typed 401 error', () => {
    let thrown;
    try {
      exportLearnerData({ requester: null, subject: makeSubject(), purchases: [makePurchase()] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExportAuthorizationError);
    expect(thrown.code).toBe(ExportAuthorizationErrorCode.UNAUTHENTICATED);
    expect(thrown.status).toBe(401);
  });

  it('denies a different, non-privileged learner with a typed 403 error', () => {
    const otherLearner = makeRequester({
      _id:                'user-b',
      walletAddress:      WALLET_B,
      walletAddressLower: WALLET_B.toLowerCase(),
      email:              'b@example.com',
      role:               'learner',
    });

    let thrown;
    try {
      exportLearnerData({
        requester: otherLearner,
        subject:   makeSubject(),
        purchases: [makePurchase()],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExportAuthorizationError);
    expect(thrown.name).toBe('ExportAuthorizationError');
    expect(thrown.code).toBe(ExportAuthorizationErrorCode.FORBIDDEN);
    expect(thrown.status).toBe(403);
  });

  it('does not build or leak any export document when denied', () => {
    // A getter proves buildLearnerExport is never reached: the denied path must
    // throw before any record is assembled.
    const forbidden = [];
    const spyPurchases = new Proxy([], {
      get(target, prop) {
        if (prop === 'map' || prop === 'filter') forbidden.push(prop);
        return target[prop];
      },
    });

    expect(() => exportLearnerData({
      requester: makeRequester({ walletAddress: WALLET_B, walletAddressLower: WALLET_B.toLowerCase(), role: 'learner' }),
      subject:   makeSubject(),
      purchases: spyPurchases,
    })).toThrow(ExportAuthorizationError);

    expect(forbidden).toEqual([]);
  });

  it('rejects a subject with no resolvable wallet', () => {
    expect(() => authorizeExport({
      requester: makeRequester(),
      subject:   { _id: 'anonymous' },
    })).toThrow(ExportAuthorizationError);
  });

  it('never exposes another learner\'s PII even when a privileged caller asks for FULL', () => {
    const admin = makeRequester({
      _id:                'admin-1',
      walletAddress:      WALLET_B,
      walletAddressLower: WALLET_B.toLowerCase(),
      email:              'admin@example.com',
      role:               'admin',
    });

    const doc = exportLearnerData({
      requester:      admin,
      subject:        makeSubject(),
      reason:         'support-ticket-123',
      purchases:      [makePurchase()],
      entitlements:   [makeEntitlement()],
      materials:      [],
      redactionLevel: RedactionLevel.FULL,
    });

    expect(doc.authorization.scope).toBe(ExportScope.PRIVILEGED);
    expect(doc.authorization.reason).toBe('support-ticket-123');
    expect(doc.redactionLevel).toBe(RedactionLevel.PARTIAL);
    expect(doc.identity.email).toBeNull();
    expect(doc.identity.fullName).toBeNull();
    expect(validateExport(doc)).toEqual([]);
  });

  it('filters out foreign rows so another learner\'s records never appear', () => {
    const admin = makeRequester({
      role:               'admin',
      walletAddress:      WALLET_B,
      walletAddressLower: WALLET_B.toLowerCase(),
    });

    const doc = exportLearnerData({
      requester:    admin,
      subject:      makeSubject(),
      reason:       'compliance',
      purchases: [
        makePurchase({ purchaseId: 'own', materialId: 'mat_a', buyerAddress: WALLET_A }),
        makePurchase({ purchaseId: 'foreign', materialId: 'mat_b', buyerAddress: WALLET_B }),
      ],
      entitlements: [
        makeEntitlement({ materialId: 'mat_a', buyerAddress: WALLET_A }),
        makeEntitlement({ materialId: 'mat_b', buyerAddress: WALLET_B }),
      ],
      refunds: [
        makeRefund({ purchaseId: 'own', materialId: 'mat_a', buyerAddress: WALLET_A }),
        makeRefund({ purchaseId: 'foreign', materialId: 'mat_b', buyerAddress: WALLET_B }),
      ],
      progressRecords: [
        makeProgress({ materialId: 'mat_a', walletAddress: WALLET_A }),
        makeProgress({ materialId: 'mat_b', walletAddress: WALLET_B }),
      ],
    });

    expect(doc.purchases).toHaveLength(1);
    expect(doc.purchases[0].materialId).toBe('mat_a');
    expect(doc.summary.totalPurchases).toBe(1);
  });
});

// ── authorization policy ──────────────────────────────────────────────────────

describe('authorizeExport policy', () => {
  it('allows allow-listed privileged roles to export another learner', () => {
    for (const role of EXPORT_PRIVILEGED_ROLES) {
      const decision = authorizeExport({
        requester: { walletAddress: WALLET_B, role },
        subject:   makeSubject(),
      });
      expect(decision.authorized).toBe(true);
      expect(decision.scope).toBe(ExportScope.PRIVILEGED);
    }
  });

  it('denies ordinary roles that are not on the allow-list', () => {
    for (const role of ['learner', 'user', 'creator']) {
      expect(() => authorizeExport({
        requester: { walletAddress: WALLET_B, role },
        subject:   makeSubject(),
      })).toThrow(ExportAuthorizationError);
    }
  });

  it('allows a privileged reader even without a resolvable wallet on the requester', () => {
    const decision = authorizeExport({
      requester: { _id: 'admin-1', role: 'admin' },
      subject:   makeSubject(),
    });
    expect(decision.scope).toBe(ExportScope.PRIVILEGED);
  });
});

// ── large export ──────────────────────────────────────────────────────────────

describe('exportLearnerData — large export', () => {
  it('handles thousands of purchases and reports correct summary counts', () => {
    const TOTAL    = 4000;
    const REVOKED  = 200; // first N are revoked + refunded
    const WITHPROG = 400; // every 10th purchase has progress

    const purchases = [];
    const entitlements = [];
    const refunds = [];
    const progressRecords = [];

    for (let i = 0; i < TOTAL; i++) {
      const materialId = `mat_${i}`;
      const purchaseId = `p_${i}`;
      const revoked = i < REVOKED;

      purchases.push(makePurchase({
        _id: purchaseId, purchaseId, materialId,
        buyerAddress: WALLET_A, amount: 1_000_000,
      }));
      entitlements.push(makeEntitlement({ materialId, active: !revoked }));
      if (revoked) {
        refunds.push(makeRefund({ purchaseId, materialId, amount: 950_000 }));
      }
      if (i % 10 === 0) {
        progressRecords.push(makeProgress({ materialId, progressPct: 10 }));
      }
    }

    const doc = exportLearnerData({
      requester: makeRequester(),
      subject:   makeSubject(),
      purchases,
      entitlements,
      refunds,
      progressRecords,
      materials: [],
    });

    expect(validateExport(doc)).toEqual([]);
    expect(doc.purchases).toHaveLength(TOTAL);
    expect(doc.summary.totalPurchases).toBe(TOTAL);
    expect(doc.summary.activePurchases).toBe(TOTAL - REVOKED);
    expect(doc.summary.revokedPurchases).toBe(REVOKED);
    expect(doc.summary.refundedPurchases).toBe(REVOKED);
    expect(doc.summary.purchasesWithProgress).toBe(WITHPROG);
    expect(doc.summary.totalSpendMinorUnits).toBe(TOTAL * 1_000_000);
    expect(doc.authorization.scope).toBe(ExportScope.SELF);
  });
});

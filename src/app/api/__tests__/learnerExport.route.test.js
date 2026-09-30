// @vitest-environment node
//
// #790: authorization, scoping, and retention tests for GET /api/learner-export.
//
// Test coverage:
//   ✓ Denied export — unauthenticated callers get 401
//   ✓ Denied export — suspended accounts get 403
//   ✓ Feature flag off (safe default) returns 503
//   ✓ Empty export — a user with no purchases gets a valid empty document
//   ✓ Large export — many purchases are all included and the document validates
//   ✓ Out-of-scope — a caller only ever receives their own data, never another
//     user's, because every query is scoped to the session user
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const { currentAuth } = vi.hoisted(() => ({ currentAuth: { value: null } }));

vi.mock('@/lib/api/auth', () => ({
  requireActiveUser: vi.fn(async () => currentAuth.value),
}));
vi.mock('@/lib/api/hardening', () => ({
  withApiHardening: vi.fn((req, options, handler) => handler()),
}));

import { getDb } from '@/lib/mongodb';
import { GET as learnerExport } from '../learner-export/route';
import { validateExport } from '../../../lib/learner-export/schema.js';

const jsonRequest = (url) => new Request(`http://localhost${url}`, { method: 'GET' });

const WALLET_A = 'GEXPORT_A_00000000000000000000000000000000000000000000';
const WALLET_B = 'GEXPORT_B_000000000000000000000000000000000000000000000';

function authedUser(wallet) {
  return {
    ok: true,
    user: {
      _id: `user-${wallet}`,
      walletAddress: wallet,
      walletAddressLower: wallet.toLowerCase(),
      email: 'learner@example.com',
      fullName: 'Export Learner',
    },
  };
}

let db;

beforeAll(async () => {
  db = await getDb();
});

beforeEach(async () => {
  await db.collection('purchases').deleteMany({});
  await db.collection('entitlement_cache').deleteMany({});
  await db.collection('refunds').deleteMany({});
  await db.collection('learner_progress').deleteMany({});
  await db.collection('materials').deleteMany({});
  process.env.FEATURE_FLAG_LEARNER_DATA_EXPORT = 'true';
});

afterEach(() => {
  delete process.env.FEATURE_FLAG_LEARNER_DATA_EXPORT;
  currentAuth.value = null;
});

async function seedPurchase(buyerAddress, materialId, overrides = {}) {
  await db.collection('purchases').insertOne({
    purchaseId: `purchase_${materialId}`,
    materialId,
    buyerAddress,
    sellerAddress: 'GCREATOR_XYZ',
    status: 'confirmed',
    asset: 'GDUSDC_LOCAL',
    amount: 1_000_000,
    purchaseSnapshot: {
      metadataHash: `META_${materialId}`,
      rightsHash: `RIGHTS_${materialId}`,
      saleTermsVersion: 1,
      purchaseLedger: 1_000_000,
    },
    createdAt: new Date('2026-01-15T10:00:00Z'),
    ...overrides,
  });
}

describe('GET /api/learner-export authorization', () => {
  it('denies unauthenticated callers with 401', async () => {
    currentAuth.value = { ok: false, status: 401 };
    const res = await learnerExport(jsonRequest('/api/learner-export'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('EVT_AUTH_001');
  });

  it('denies suspended accounts with 403', async () => {
    currentAuth.value = { ok: false, status: 403 };
    const res = await learnerExport(jsonRequest('/api/learner-export'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('EVT_AUTH_002');
  });

  it('returns 503 when the feature flag is off (safe default)', async () => {
    delete process.env.FEATURE_FLAG_LEARNER_DATA_EXPORT;
    currentAuth.value = authedUser(WALLET_A);
    const res = await learnerExport(jsonRequest('/api/learner-export'));
    expect(res.status).toBe(503);
  });
});

describe('GET /api/learner-export scoping', () => {
  it('returns a valid empty export for a user with no purchases', async () => {
    currentAuth.value = authedUser(WALLET_A);
    const res = await learnerExport(jsonRequest('/api/learner-export'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purchases).toEqual([]);
    expect(body.summary.totalPurchases).toBe(0);
    expect(body.retention.artifactLifetime).toBe('ephemeral');
    expect(validateExport(body)).toEqual([]);
  });

  it('includes every purchase for a large library and still validates', async () => {
    currentAuth.value = authedUser(WALLET_A);
    const COUNT = 250;
    for (let i = 0; i < COUNT; i++) {
      await seedPurchase(WALLET_A, `mat_${i}`);
    }

    const res = await learnerExport(jsonRequest('/api/learner-export'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purchases).toHaveLength(COUNT);
    expect(body.summary.totalPurchases).toBe(COUNT);
    expect(body.summary.totalSpendMinorUnits).toBe(COUNT * 1_000_000);
    expect(validateExport(body)).toEqual([]);
  });

  it('never returns another user\'s data — every query is scoped to the session user', async () => {
    // User A has 2 purchases; user B has 1. A's session must only see A's.
    await seedPurchase(WALLET_A, 'mat_a1');
    await seedPurchase(WALLET_A, 'mat_a2');
    await seedPurchase(WALLET_B, 'mat_b1');

    currentAuth.value = authedUser(WALLET_A);
    const resA = await learnerExport(jsonRequest('/api/learner-export'));
    expect(resA.status).toBe(200);
    const bodyA = await resA.json();
    expect(bodyA.purchases).toHaveLength(2);
    expect(bodyA.purchases.map((p) => p.materialId).sort()).toEqual(['mat_a1', 'mat_a2']);
    expect(bodyA.identity.walletAddress).toBe(WALLET_A);

    // And B's session only sees B's.
    currentAuth.value = authedUser(WALLET_B);
    const resB = await learnerExport(jsonRequest('/api/learner-export'));
    const bodyB = await resB.json();
    expect(bodyB.purchases).toHaveLength(1);
    expect(bodyB.purchases[0].materialId).toBe('mat_b1');
  });

  it('scopes entitlements, refunds, and progress to the session user as well', async () => {
    await seedPurchase(WALLET_A, 'mat_a1');
    await seedPurchase(WALLET_B, 'mat_b1');
    await db.collection('entitlement_cache').insertMany([
      { materialId: 'mat_a1', buyerAddress: WALLET_A, active: true },
      { materialId: 'mat_b1', buyerAddress: WALLET_B, active: true },
    ]);
    await db.collection('refunds').insertMany([
      { purchaseId: 'purchase_mat_a1', materialId: 'mat_a1', buyerAddress: WALLET_A, status: 'requested', amount: 500_000 },
      { purchaseId: 'purchase_mat_b1', materialId: 'mat_b1', buyerAddress: WALLET_B, status: 'requested', amount: 500_000 },
    ]);
    await db.collection('learner_progress').insertMany([
      { materialId: 'mat_a1', walletAddress: WALLET_A, version: 'v1', progressPct: 50 },
      { materialId: 'mat_b1', walletAddress: WALLET_B, version: 'v1', progressPct: 90 },
    ]);

    currentAuth.value = authedUser(WALLET_A);
    const res = await learnerExport(jsonRequest('/api/learner-export'));
    const body = await res.json();

    expect(body.purchases).toHaveLength(1);
    expect(body.purchases[0].materialId).toBe('mat_a1');
    expect(body.purchases[0].entitlementState).toBe('active');
    expect(body.purchases[0].refundStatus).toBe('requested');
    expect(body.purchases[0].progress.progressPct).toBe(50);
    expect(validateExport(body)).toEqual([]);
  });
});

/**
 * Deep coverage for the unified entitlement authorization service — Issue #470.
 *
 * These tests exercise src/lib/entitlement.js directly (the single policy
 * boundary) plus the download routes and indexer event handling that sit on
 * top of it, against a controllable in-memory Mongo-like fake so we can
 * simulate refunds, disputes, stale caches, indexer lag, and outages
 * deterministically.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Controllable fake Mongo, shared between the vi.mock factory and tests ──
const { fakeState } = vi.hoisted(() => {
  function makeStore() {
    const docs = new Map();
    return {
      docs,
      async findOne(query) {
        if (this._forceError) throw this._forceError;
        for (const doc of docs.values()) {
          const match = Object.entries(query).every(([k, v]) => doc?.[k] === v);
          if (match) return doc;
        }
        return null;
      },
      async updateOne(query, update, opts = {}) {
        if (this._forceError) throw this._forceError;
        for (const doc of docs.values()) {
          const match = Object.entries(query).every(([k, v]) => doc?.[k] === v);
          if (match) {
            if (update.$set) Object.assign(doc, update.$set);
            return { matchedCount: 1, upsertedCount: 0 };
          }
        }
        if (opts.upsert) {
          const doc = { ...query };
          if (update.$set) Object.assign(doc, update.$set);
          if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
          docs.set(`auto-${docs.size}-${Math.random()}`, doc);
          return { matchedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, upsertedCount: 0 };
      },
      async insertOne(doc) {
        if (this._forceError) throw this._forceError;
        const id = doc._id ?? `auto-${docs.size}-${Math.random()}`;
        if (doc._id != null && docs.has(String(doc._id))) {
          const err = new Error('duplicate key');
          err.code = 11000;
          throw err;
        }
        docs.set(String(id), { ...doc, _id: id });
        return { insertedId: id };
      },
      seed(doc) {
        docs.set(`seed-${docs.size}-${Math.random()}`, doc);
      },
    };
  }

  const collections = {
    materials: makeStore(),
    purchases: makeStore(),
    entitlement_cache: makeStore(),
    users: makeStore(),
  };

  const db = {
    collection: (name) => {
      if (!collections[name]) collections[name] = makeStore();
      return collections[name];
    },
  };

  return {
    fakeState: {
      collections,
      db,
      reset() {
        for (const store of Object.values(collections)) {
          store.docs.clear();
          store._forceError = null;
        }
      },
    },
  };
});

// Controllable chain config, so "indexer lag" tests can flip on a reachable
// chain without affecting every other test in this file (which should keep
// exercising the realistic "chain unconfigured" fail-closed/provisional
// paths).
const { chainConfig } = vi.hoisted(() => ({ chainConfig: { contractId: '', rpcUrl: 'https://rpc.test' } }));

vi.mock('@/lib/mongodb', () => ({
  getDb: vi.fn(async () => fakeState.db),
}));

vi.mock('@/lib/api/auth', () => ({
  getUserFromCookie: vi.fn(async () => ({
    sub: 'buyer-1',
    walletAddress: 'gbuyer',
  })),
}));

// stellarIndexer's purchase.completed path enqueues a receipt email — none
// of these tests exercise that path, but mock it out defensively so
// importing the indexer never has a chance to touch a real mail transport.
vi.mock('@/lib/email', () => ({ sendReceiptIfEligible: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@/lib/config/chain', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get PURCHASE_MANAGER_CONTRACT_ID() {
      return chainConfig.contractId;
    },
    STELLAR_RPC_URL: chainConfig.rpcUrl,
  };
});

const {
  resolveEntitlement,
  authorizeMaterialAccess,
  invalidateEntitlement,
  revokeEntitlement,
  createEntitlement,
  ENTITLEMENT_STATE,
} = await import('../../src/lib/entitlement.js');
const { applyIndexedEvent } = await import('../../src/lib/indexer/stellarIndexer.js');
const { GET: downloadGet } = await import('../../src/app/api/download/route.js');

const MATERIAL_ID = 'mat-policy-1';
const BUYER = 'gbuyer';

function seedCompletedPurchase(overrides = {}) {
  fakeState.collections.purchases.seed({
    materialId: MATERIAL_ID,
    buyerAddress: BUYER,
    status: 'settled',
    purchaseId: 'p-1',
    settlementState: null,
    ...overrides,
  });
}

function seedFreshCache(overrides = {}) {
  fakeState.collections.entitlement_cache.seed({
    materialId: MATERIAL_ID,
    buyerAddress: BUYER,
    state: ENTITLEMENT_STATE.FINALIZED,
    active: true,
    purchaseId: 'p-1',
    settlementState: 'Pending',
    checkedAt: new Date(),
    ...overrides,
  });
}

beforeEach(() => {
  fakeState.reset();
  chainConfig.contractId = '';
  vi.unstubAllGlobals();
});

describe('resolveEntitlement — stale cache can never grant what purchases-db denies', () => {
  it('denies when a fresh, allowing cache entry disagrees with a refunded purchase record', async () => {
    seedFreshCache(); // fresh, FINALIZED, "active": true
    seedCompletedPurchase({ settlementState: 'Refunded' });

    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });

    expect(result.hasAccess).toBe(false);
    expect(result.state).toBe(ENTITLEMENT_STATE.REVOKED);
  });

  it('denies when the purchase was disputed', async () => {
    seedCompletedPurchase({ settlementState: 'Disputed' });

    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });

    expect(result.hasAccess).toBe(false);
    expect(result.state).toBe(ENTITLEMENT_STATE.REVOKED);
  });

  it('grants access from a completed purchase when nothing indicates revocation', async () => {
    seedCompletedPurchase();

    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });

    expect(result.hasAccess).toBe(true);
  });
});

describe('resolveEntitlement — fail-closed outage behavior', () => {
  it('denies (UNAVAILABLE) when the purchases lookup throws, even for a previously-entitled buyer', async () => {
    seedCompletedPurchase();
    fakeState.collections.purchases._forceError = new Error('connection reset');

    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });

    expect(result.hasAccess).toBe(false);
    expect(result.state).toBe(ENTITLEMENT_STATE.UNAVAILABLE);
  });

  it('denies for missing materialId/buyerAddress instead of throwing', async () => {
    const result = await resolveEntitlement({ materialId: '', buyerAddress: '' });
    expect(result.hasAccess).toBe(false);
  });

  it('the download route responds 503, not a silent allow or a plain 403, during an outage', async () => {
    seedCompletedPurchase();
    fakeState.collections.materials.seed({
      materialId: MATERIAL_ID,
      _id: MATERIAL_ID,
      price: 10,
      visibility: 'private',
      storageKey: 'QmSecret',
    });
    fakeState.collections.purchases._forceError = new Error('outage');

    const req = new Request(`http://localhost/api/download?materialId=${MATERIAL_ID}`, {
      headers: { cookie: 'auth_token=irrelevant-because-mocked' },
    });
    const res = await downloadGet(req);
    const data = await res.json();

    expect(res.status).toBe(503);
    expect(data.fileUrl).toBeUndefined();
  });
});

describe('event-driven invalidation — indexer refund/dispute events', () => {
  it('a purchase.refunded chain event immediately revokes a previously-finalized entitlement', async () => {
    seedCompletedPurchase({ settlementState: 'Pending' });
    seedFreshCache({ state: ENTITLEMENT_STATE.FINALIZED, settlementState: 'Pending' });

    // Sanity: access is granted before the refund event lands.
    const before = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });
    expect(before.hasAccess).toBe(true);

    await applyIndexedEvent(fakeState.db, {
      id: 'evt-refund-1',
      type: 'purchase.refunded',
      materialId: MATERIAL_ID,
      buyerAddress: BUYER,
      purchaseId: 'p-1',
      transactionHash: 'tx-refund-1',
    });

    const after = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });
    expect(after.hasAccess).toBe(false);
    expect(after.state).toBe(ENTITLEMENT_STATE.REVOKED);

    const purchase = await fakeState.collections.purchases.findOne({ materialId: MATERIAL_ID, buyerAddress: BUYER });
    expect(purchase.settlementState).toBe('Refunded');
  });

  it('a dispute.opened event revokes access for the disputed purchase', async () => {
    seedCompletedPurchase({ settlementState: 'Pending' });

    await applyIndexedEvent(fakeState.db, {
      id: 'evt-dispute-1',
      type: 'dispute.opened',
      materialId: MATERIAL_ID,
      purchaseId: 'p-1',
      opener: BUYER,
    });

    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });
    expect(result.hasAccess).toBe(false);
    expect(result.state).toBe(ENTITLEMENT_STATE.REVOKED);
  });
});

describe('concurrent refund/download races', () => {
  it('once a revoke resolves, no later concurrent read can observe a stale allow', async () => {
    seedCompletedPurchase({ settlementState: 'Pending' });

    const beforeRevoke = await Promise.all(
      Array.from({ length: 5 }, () => resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER }))
    );
    expect(beforeRevoke.every((r) => r.hasAccess)).toBe(true);

    await revokeEntitlement(MATERIAL_ID, BUYER);

    const afterRevoke = await Promise.all(
      Array.from({ length: 5 }, () => resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER }))
    );
    expect(afterRevoke.every((r) => !r.hasAccess)).toBe(true);
    expect(afterRevoke.every((r) => r.state === ENTITLEMENT_STATE.REVOKED)).toBe(true);
  });

  it('a revocation recorded only in entitlement_cache is still honored on the next read (sticky revoke)', async () => {
    // Simulates the refund route's cache-only invalidation landing before
    // any mirror onto the purchases collection completes.
    seedCompletedPurchase({ settlementState: 'Pending' });
    await invalidateEntitlement(MATERIAL_ID, BUYER, 'refunded', { settlementState: 'Refunded' });

    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });
    expect(result.hasAccess).toBe(false);
  });
});

describe('indexer lag', () => {
  it('grants access via a direct chain check when the buyer paid before the local indexer caught up', async () => {
    chainConfig.contractId = 'CCONTRACT';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ result: { results: [{ xdr: 'AAAE-true-entitlement' }] } }),
      }))
    );

    // No purchase record at all yet — the indexer hasn't processed the
    // on-chain purchase.completed event.
    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });

    expect(result.hasAccess).toBe(true);
    expect(result.state).toBe(ENTITLEMENT_STATE.FINALIZED);
    expect(result.source).toBe('chain');
  });

  it('does not grant access just because the local record is missing and chain is unreachable', async () => {
    // No contractId configured -> checkChainEntitlement short-circuits to null.
    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });
    expect(result.hasAccess).toBe(false);
    expect(result.state).toBe(ENTITLEMENT_STATE.NOT_ENTITLED);
  });
});

describe('service outages degrade to bounded PROVISIONAL access, never to a silent allow', () => {
  it('an existing completed purchase still grants (provisional) access when chain is unconfigured', async () => {
    seedCompletedPurchase();

    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });

    expect(result.hasAccess).toBe(true);
    expect(result.state).toBe(ENTITLEMENT_STATE.PROVISIONAL);
    expect(result.source).toBe('purchases-db');
  });

  it('a buyer who never purchased gets nothing extra out of an outage', async () => {
    fakeState.collections.purchases._forceError = new Error('db down');
    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });
    expect(result.hasAccess).toBe(false);
    expect(result.state).toBe(ENTITLEMENT_STATE.UNAVAILABLE);
  });
});

describe('suspended buyers and orphaned materials', () => {
  it('denies a suspended buyer even with a valid, finalized entitlement', async () => {
    seedCompletedPurchase();
    fakeState.collections.users.seed({ walletAddressLower: BUYER, status: 'suspended' });

    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });
    expect(result.hasAccess).toBe(false);
    expect(result.source).toBe('buyer-suspended');
  });

  it('authorizeMaterialAccess denies with UNAVAILABLE for a missing (orphaned) material reference', async () => {
    const decision = await authorizeMaterialAccess({ db: fakeState.db, material: null, buyerAddress: BUYER });
    expect(decision.allowed).toBe(false);
    expect(decision.state).toBe(ENTITLEMENT_STATE.UNAVAILABLE);
    expect(decision.httpStatus).toBe(404);
  });
});

describe('createEntitlement -> resolveEntitlement round trip', () => {
  it('a fresh purchase grants immediate (provisional) access', async () => {
    await createEntitlement(MATERIAL_ID, BUYER, { purchaseId: 'p-new' });
    seedCompletedPurchase({ purchaseId: 'p-new' });

    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });
    expect(result.hasAccess).toBe(true);
  });
});

describe('bounded cache TTL and binding checks', () => {
  it('an expired cache entry is re-derived rather than trusted forever', async () => {
    seedCompletedPurchase();
    seedFreshCache({ checkedAt: new Date(Date.now() - 10 * 60 * 1000) }); // 10 minutes old

    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });

    expect(result.hasAccess).toBe(true);
    // Re-derived from purchases-db, not served from the stale cache entry.
    expect(result.source).not.toBe('cache');
  });

  it('a fresh cache entry stamped for different content is not trusted via the fast path', async () => {
    seedCompletedPurchase();
    seedFreshCache({ contentHash: 'QmOldContentBeforeSwap' });

    const result = await resolveEntitlement({
      db: fakeState.db,
      materialId: MATERIAL_ID,
      buyerAddress: BUYER,
      contentHash: 'QmNewContentAfterSwap',
    });

    expect(result.hasAccess).toBe(true);
    expect(result.source).not.toBe('cache');
  });

  it('a fresh cache entry for a different purchaseId is not trusted via the fast path', async () => {
    seedCompletedPurchase({ purchaseId: 'p-current' });
    seedFreshCache({ purchaseId: 'p-old-superseded' });

    const result = await resolveEntitlement({ db: fakeState.db, materialId: MATERIAL_ID, buyerAddress: BUYER });

    expect(result.hasAccess).toBe(true);
    expect(result.source).not.toBe('cache');
  });
});

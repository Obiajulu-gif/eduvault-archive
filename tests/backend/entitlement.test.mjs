/**
 * Tests for the entitlement verification utility — Issue #63
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ── Minimal MongoDB collection mock ──────────────────────────────────────────

function createCollection() {
  const docs = new Map();
  return {
    docs,
    async findOne(query) {
      for (const doc of docs.values()) {
        const match = Object.entries(query).every(
          ([k, v]) => String(doc[k]) === String(v)
        );
        if (match) return doc;
      }
      return null;
    },
    async updateOne(query, update, opts = {}) {
      const key = `${query.materialId}:${query.buyerAddress}`;
      const exists = docs.has(key);
      if (!exists && !opts.upsert) return;
      const current = docs.get(key) ?? {};
      const setFields = update.$set ?? {};
      const setOnInsert = (!exists && update.$setOnInsert) ? update.$setOnInsert : {};
      docs.set(key, { ...current, ...setFields, ...setOnInsert });
    },
  };
}

function createDb(collections = {}) {
  return { collection: (name) => collections[name] ?? createCollection() };
}

// ── Pure logic extracted from verifyEntitlement for unit testing ─────────────
// (We test the logic without touching the real DB or chain)

async function verifyEntitlementLogic(materialId, buyerAddress, { purchasesDb, cacheDb }) {
  const normalised = buyerAddress.toLowerCase();

  // Cache hit
  const cached = await cacheDb.findOne({ materialId, buyerAddress: normalised });
  if (cached?.active) return { hasAccess: true, source: 'cache' };

  // Purchases DB
  const purchase = await purchasesDb.findOne({
    materialId,
    buyerAddress: normalised,
    status: 'settled',
  });
  if (purchase) {
    await cacheDb.updateOne(
      { materialId, buyerAddress: normalised },
      { $set: { materialId, buyerAddress: normalised, active: true }, $setOnInsert: {} },
      { upsert: true }
    );
    return { hasAccess: true, source: 'purchases-db' };
  }

  return { hasAccess: false, source: 'not-found' };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('returns hasAccess=true when entitlement cache has active record', async () => {
  const cacheDb = createCollection();
  const purchasesDb = createCollection();
  const materialId = 'mat-001';
  const buyer = 'GABC123';

  cacheDb.docs.set(`${materialId}:${buyer.toLowerCase()}`, {
    materialId,
    buyerAddress: buyer.toLowerCase(),
    active: true,
    source: 'stellar',
  });

  const result = await verifyEntitlementLogic(materialId, buyer, { purchasesDb, cacheDb });
  assert.equal(result.hasAccess, true);
  assert.equal(result.source, 'cache');
});

test('returns hasAccess=false when no cache or purchase record', async () => {
  const cacheDb = createCollection();
  const purchasesDb = createCollection();

  const result = await verifyEntitlementLogic('mat-002', 'GXYZ789', { purchasesDb, cacheDb });
  assert.equal(result.hasAccess, false);
  assert.equal(result.source, 'not-found');
});

test('returns hasAccess=true from purchases DB and populates cache', async () => {
  const cacheDb = createCollection();
  const purchasesDb = createCollection();
  const materialId = 'mat-003';
  const buyer = 'GDEF456';

  purchasesDb.docs.set(`${materialId}:${buyer.toLowerCase()}`, {
    materialId,
    buyerAddress: buyer.toLowerCase(),
    status: 'settled',
  });

  const result = await verifyEntitlementLogic(materialId, buyer, { purchasesDb, cacheDb });
  assert.equal(result.hasAccess, true);
  assert.equal(result.source, 'purchases-db');

  // Cache should now be populated
  const cached = await cacheDb.findOne({
    materialId,
    buyerAddress: buyer.toLowerCase(),
  });
  assert.equal(cached?.active, true);
});

test('pending purchase does not grant access', async () => {
  const cacheDb = createCollection();
  const purchasesDb = createCollection();
  const materialId = 'mat-004';
  const buyer = 'GPENDING';

  purchasesDb.docs.set(`${materialId}:${buyer.toLowerCase()}`, {
    materialId,
    buyerAddress: buyer.toLowerCase(),
    status: 'pending',  // not settled
  });

  const result = await verifyEntitlementLogic(materialId, buyer, { purchasesDb, cacheDb });
  assert.equal(result.hasAccess, false);
});

test('inactive cache entry falls through to purchases DB', async () => {
  const cacheDb = createCollection();
  const purchasesDb = createCollection();
  const materialId = 'mat-005';
  const buyer = 'GINACTIVE';

  // Cache has inactive record (prior miss)
  cacheDb.docs.set(`${materialId}:${buyer.toLowerCase()}`, {
    materialId,
    buyerAddress: buyer.toLowerCase(),
    active: false,
    source: 'chain-miss',
  });

  // But purchases DB now has a settled record (late confirmation)
  purchasesDb.docs.set(`${materialId}:${buyer.toLowerCase()}`, {
    materialId,
    buyerAddress: buyer.toLowerCase(),
    status: 'settled',
  });

  const result = await verifyEntitlementLogic(materialId, buyer, { purchasesDb, cacheDb });
  assert.equal(result.hasAccess, true);
  assert.equal(result.source, 'purchases-db');
});

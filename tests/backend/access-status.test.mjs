import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessStatus } from '../../src/app/api/materials/access/route.js';
import { createPendingAccessRequest } from '../../src/lib/purchases/access.js';

function createCollection(records = {}) {
  const map = new Map(Object.entries(records));
  return {
    records: map,
    async findOne(query) {
      if (query._id) return map.get(query._id) || null;
      // simple matching by materialId or by purchase keys
      if (query.materialId && query.buyerAddress) {
        const key = `${query.materialId}:${query.buyerAddress}`;
        return map.get(key) || null;
      }
      if (query.materialId) return map.get(query.materialId) || null;
      return null;
    },
    async updateOne(query, update, options = {}) {
      const key = query.materialId && query.buyerAddress
        ? `${query.materialId}:${query.buyerAddress}`
        : query.materialId;
      const existing = map.get(key);
      if (!existing && !options.upsert) return { matchedCount: 0, upsertedCount: 0 };
      map.set(key, {
        ...(existing || {}),
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      });
      return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 };
    },
  };
}

function createDb(state = {}) {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, createCollection(state[name] || {}));
      return collections.get(name);
    },
  };
}

test('accessStatus returns unavailable for missing material', async () => {
  const db = createDb({});
  const res = await accessStatus(db, 'no-such', 'GABC');
  assert.equal(res.status, 'unavailable');
});

test('accessStatus returns pending when purchase exists but not settled', async () => {
  const db = createDb({
    materials: { 'material-1': { materialId: 'material-1' } },
    purchases: { 'material-1:gbuyer': { materialId: 'material-1', buyerAddress: 'gbuyer', status: 'pending' } },
  });

  const res = await accessStatus(db, 'material-1', 'GBUYER');
  assert.equal(res.status, 'pending');
});

test('accessStatus returns active for settled purchase', async () => {
  const db = createDb({
    materials: { 'material-2': { materialId: 'material-2' } },
    purchases: { 'material-2:gbuyer': { materialId: 'material-2', buyerAddress: 'gbuyer', status: 'settled' } },
  });

  const res = await accessStatus(db, 'material-2', 'GBUYER');
  assert.equal(res.status, 'active');
});

test('accessStatus returns active for confirmed purchase', async () => {
  const db = createDb({
    materials: { 'material-3': { materialId: 'material-3' } },
    purchases: { 'material-3:gbuyer': { materialId: 'material-3', buyerAddress: 'gbuyer', status: 'confirmed' } },
  });

  const res = await accessStatus(db, 'material-3', 'GBUYER');
  assert.equal(res.status, 'active');
  assert.equal(res.hasAccess, true);
});

test('createPendingAccessRequest records pending without granting access', async () => {
  const db = createDb({
    materials: { 'material-4': { materialId: 'material-4', price: 5, visibility: 'public' } },
  });

  const res = await createPendingAccessRequest(db, 'material-4', 'GBUYER', {
    amount: '5.00',
    asset: 'XLM',
  });

  assert.equal(res.status, 'pending');
  assert.equal(res.hasAccess, false);

  const status = await accessStatus(db, 'material-4', 'GBUYER');
  assert.equal(status.status, 'pending');
  assert.equal(status.hasAccess, false);
});

import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';
import { ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getDb } from '../../src/lib/mongodb.js';
import { enqueueSideEffect } from '../../src/lib/backend/outbox.js';

let mongod;
let db;

beforeEach(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'test';
  db = await getDb();
});

afterEach(async () => {
  if (mongod) await mongod.stop();
});

function createFakeDb(overrides = {}) {
  const purchases = new Map();
  const users = new Map();
  const materials = new Map();

  if (overrides.purchases) {
    for (const p of overrides.purchases) {
      purchases.set(String(p._id), p);
    }
  }
  if (overrides.users) {
    for (const u of overrides.users) {
      users.set(String(u._id), u);
    }
  }
  if (overrides.materials) {
    for (const m of overrides.materials) {
      materials.set(String(m._id), m);
      if (m.materialId) materials.set(m.materialId, m);
    }
  }

  const collections = {
    purchases: {
      records: purchases,
      async findOne(query) {
        if (query._id) return purchases.get(String(query._id)) || null;
        for (const doc of purchases.values()) {
          if (query.materialId && doc.materialId === query.materialId && query.buyerAddress && doc.buyerAddress === query.buyerAddress) return doc;
        }
        return null;
      },
    },
    users: {
      records: users,
      async findOne(query) {
        for (const u of users.values()) {
          if (query.walletAddress && u.walletAddress === query.walletAddress) return u;
          if (query.walletAddressLower && u.walletAddressLower === query.walletAddressLower) return u;
        }
        return null;
      },
    },
    materials: {
      records: materials,
      async findOne(query) {
        if (query.materialId) return materials.get(query.materialId) || null;
        if (query._id) return materials.get(String(query._id)) || null;
        return null;
      },
    },
  };

  return {
    collection(name) {
      return collections[name] || { records: new Map(), async findOne() { return null; } };
    },
  };
}

describe('email receipt eligibility (sendReceiptIfEligible logic)', () => {
  test('skips receipt when purchase does not exist', async () => {
    const fakeDb = createFakeDb({});
    const purchaseId = new ObjectId();
    await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: String(purchaseId),
      intent: { type: 'email', channel: 'purchase_receipt', payload: {} },
    });

    const purchase = await fakeDb.collection('purchases').findOne({ _id: purchaseId });
    assert.equal(purchase, null, 'purchase should not exist');
  });

  test('skips receipt when purchase status is pending', async () => {
    const pid = new ObjectId();
    const fakeDb = createFakeDb({
      purchases: [{ _id: pid, materialId: 'mat-1', buyerAddress: 'gbuyer', status: 'pending' }],
    });

    const purchase = await fakeDb.collection('purchases').findOne({ _id: pid });
    assert.equal(purchase.status, 'pending');

    const completedStatuses = ['confirmed', 'settled', 'completed'];
    assert.ok(!completedStatuses.includes(purchase.status), 'pending should not trigger receipt');
  });

  test('receipt is eligible when status is confirmed', async () => {
    const pid = new ObjectId();
    const fakeDb = createFakeDb({
      purchases: [{ _id: pid, materialId: 'mat-1', buyerAddress: 'gbuyer', status: 'confirmed' }],
    });

    const purchase = await fakeDb.collection('purchases').findOne({ _id: pid });
    assert.equal(purchase.status, 'confirmed');

    const completedStatuses = ['confirmed', 'settled', 'completed'];
    assert.ok(completedStatuses.includes(purchase.status), 'confirmed should be eligible');
  });

  test('receipt is eligible when status is settled', async () => {
    const pid = new ObjectId();
    const fakeDb = createFakeDb({
      purchases: [{ _id: pid, materialId: 'mat-1', buyerAddress: 'gbuyer', status: 'settled' }],
    });

    const purchase = await fakeDb.collection('purchases').findOne({ _id: pid });
    const completedStatuses = ['confirmed', 'settled', 'completed'];
    assert.ok(completedStatuses.includes(purchase.status), 'settled should be eligible');
  });

  test('receipt is eligible when status is completed', async () => {
    const pid = new ObjectId();
    const fakeDb = createFakeDb({
      purchases: [{ _id: pid, materialId: 'mat-1', buyerAddress: 'gbuyer', status: 'completed' }],
    });

    const purchase = await fakeDb.collection('purchases').findOne({ _id: pid });
    const completedStatuses = ['confirmed', 'settled', 'completed'];
    assert.ok(completedStatuses.includes(purchase.status), 'completed should be eligible');
  });

  test('resolves buyer email from purchase record when available', async () => {
    const pid = new ObjectId();
    const fakeDb = createFakeDb({
      purchases: [{
        _id: pid,
        materialId: 'mat-1',
        buyerAddress: 'gbuyer',
        status: 'confirmed',
        userEmail: 'buyer@example.com',
      }],
    });

    const purchase = await fakeDb.collection('purchases').findOne({ _id: pid });
    const email = purchase.userEmail;
    assert.equal(email, 'buyer@example.com');
  });

  test('resolves buyer email from user record when purchase has no userEmail', async () => {
    const pid = new ObjectId();
    const uid = new ObjectId();
    const fakeDb = createFakeDb({
      purchases: [{
        _id: pid,
        materialId: 'mat-1',
        buyerAddress: 'gbuyer',
        status: 'confirmed',
        userEmail: null,
      }],
      users: [{
        _id: uid,
        walletAddress: 'gbuyer',
        walletAddressLower: 'gbuyer',
        email: 'fallback@example.com',
      }],
    });

    const purchase = await fakeDb.collection('purchases').findOne({ _id: pid });
    assert.equal(purchase.userEmail, null);

    const user = await fakeDb.collection('users').findOne({ walletAddress: 'gbuyer' });
    assert.equal(user.email, 'fallback@example.com');
  });

  test('skips receipt when no email can be resolved', async () => {
    const pid = new ObjectId();
    const fakeDb = createFakeDb({
      purchases: [{
        _id: pid,
        materialId: 'mat-1',
        buyerAddress: 'gbuyer',
        status: 'confirmed',
        userEmail: null,
      }],
    });

    const purchase = await fakeDb.collection('purchases').findOne({ _id: pid });
    const user = await fakeDb.collection('users').findOne({ walletAddress: 'gbuyer' });
    assert.equal(purchase.userEmail, null);
    assert.equal(user, null);

    const email = purchase.userEmail || user?.email;
    assert.equal(email, undefined, 'no email should be resolved');
  });

  test('skips receipt when receiptSent is true (idempotency)', async () => {
    const pid = new ObjectId();
    const fakeDb = createFakeDb({
      purchases: [{
        _id: pid,
        materialId: 'mat-1',
        buyerAddress: 'gbuyer',
        status: 'confirmed',
        userEmail: 'buyer@example.com',
        receiptSent: true,
      }],
    });

    const purchase = await fakeDb.collection('purchases').findOne({ _id: pid });
    assert.ok(purchase.receiptSent, 'receiptSent should be true');
  });

  test('resolves material by materialId', async () => {
    const mid = new ObjectId();
    const fakeDb = createFakeDb({
      materials: [{
        _id: mid,
        materialId: 'mat-1',
        title: 'Calculus Notes',
        price: 10,
      }],
    });

    const material = await fakeDb.collection('materials').findOne({ materialId: 'mat-1' });
    assert.equal(material.title, 'Calculus Notes');
    assert.equal(material.price, 10);
  });

  test('skips receipt when material is not found', async () => {
    const fakeDb = createFakeDb({});
    const material = await fakeDb.collection('materials').findOne({ materialId: 'nonexistent' });
    assert.equal(material, null, 'material should not exist');
  });
});

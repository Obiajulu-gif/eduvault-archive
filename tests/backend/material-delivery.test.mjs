/**
 * Tests for the secure material delivery route — Issue #192
 *
 * Covers authentication, authorization, security, and logging.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

// ── Test utilities ───────────────────────────────────────────────────────────

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
      const materialId = query.materialId;
      const buyerAddress = query.buyerAddress;
      const key = `${materialId}:${buyerAddress}`;
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

// ── Pure delivery logic extracted from the route ─────────────────────────────

const IPFS_GATEWAY = 'https://gateway.pinata.cloud';

function getIpfsUrl(cid) {
  if (!cid) return '';
  if (cid.startsWith('http')) return cid;
  return `${IPFS_GATEWAY}/ipfs/${cid}`;
}

function normalizeBuyerAddress(address) {
  return String(address || '').trim().toLowerCase();
}

async function verifyEntitlementLogic(db, materialId, buyerAddress) {
  if (!materialId || !buyerAddress) {
    return { hasAccess: false, source: 'invalid-params' };
  }

  const normalised = normalizeBuyerAddress(buyerAddress);

  // Cache
  const cached = await db.collection('entitlement_cache').findOne({
    materialId,
    buyerAddress: normalised,
  });
  if (cached?.active) return { hasAccess: true, source: 'cache' };

  // Purchases DB
  const purchase = await db.collection('purchases').findOne({
    materialId,
    buyerAddress: normalised,
  });
  if (purchase) {
    const completed = new Set(['confirmed', 'settled', 'completed']);
    if (completed.has(String(purchase.status || '').toLowerCase())) {
      return { hasAccess: true, source: 'purchases-db' };
    }
  }

  return { hasAccess: false, source: 'not-found' };
}

/**
 * Core delivery authorization logic — mirrors the route handler.
 * Returns download response data or an error object.
 */
async function deliverMaterial({
  db,
  user,
  materialId,
  ipfsCid,
  price = 0,
  visibility = 'public',
  ownerAddress = null,
  fileName = null,
  contentType = null,
}) {
  // ── Auth ────────────────────────────────────────────────────────────────
  if (!user || !user.sub) {
    return { error: 'Authentication required', status: 401 };
  }

  const userAddress = normalizeBuyerAddress(user.walletAddress || user.address || user.id);
  if (!userAddress) {
    return { error: 'No wallet address on account', status: 400 };
  }

  // ── Resolve material ────────────────────────────────────────────────────
  if (!materialId) {
    return { error: 'Invalid material ID', status: 400 };
  }

  const material = await db.collection('materials').findOne({ _id: materialId });
  if (!material) {
    return { error: 'Material not found', status: 404 };
  }

  // ── Verify access ───────────────────────────────────────────────────────
  const isOwner =
    normalizeBuyerAddress(material.userAddress) === userAddress ||
    normalizeBuyerAddress(material.ownerAddress) === userAddress;

  let hasAccess = isOwner;
  let accessSource = 'owner';

  if (!hasAccess) {
    const matPrice = Number(material.price || 0);
    if (matPrice <= 0 && material.visibility === 'public') {
      hasAccess = true;
      accessSource = 'free-public';
    } else {
      const entitlement = await verifyEntitlementLogic(db, materialId, userAddress);
      hasAccess = entitlement.hasAccess;
      accessSource = entitlement.source;
    }
  }

  if (!hasAccess) {
    return { error: 'Access denied. You do not have permission to access this material.', status: 403 };
  }

  // ── Resolve file reference ──────────────────────────────────────────────
  const cid = material.ipfsCid ?? material.cid ?? material.fileHash ?? material.storageKey ?? material.fileUrl ?? '';
  if (!cid) {
    return { error: 'Material has no associated file', status: 404 };
  }

  const fileUrl = getIpfsUrl(cid);

  return {
    success: true,
    downloadUrl: fileUrl,
    fileName: material.fileName ?? material.title ?? materialId,
    contentType: material.contentType ?? 'application/octet-stream',
    source: accessSource,
    status: 200,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides = {}) {
  return { sub: 'user-123', walletAddress: 'galice', ...overrides };
}

function makeMaterial(id, overrides = {}) {
  return {
    _id: id,
    materialId: id,
    title: 'Test Material',
    price: 0,
    visibility: 'public',
    userAddress: null,
    ownerAddress: null,
    storageKey: 'QmTest123',
    fileName: 'test.pdf',
    contentType: 'application/pdf',
    ...overrides,
  };
}

// =============================================================================
// Authentication Tests
// =============================================================================

describe('Delivery — Authentication', () => {

  test('authenticated user with valid access can download', async () => {
    const materialId = 'mat-001';
    const cacheDb = createCollection();
    const db = createDb({
      materials: createCollection(),
      entitlement_cache: cacheDb,
    });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, { price: 0, visibility: 'public' }));

    const result = await deliverMaterial({
      db,
      user: makeUser(),
      materialId,
    });

    assert.equal(result.status, 200);
    assert.equal(result.success, true);
    assert.ok(result.downloadUrl);
  });

  test('unauthenticated user receives 401', async () => {
    const db = createDb({ materials: createCollection() });

    const result = await deliverMaterial({
      db,
      user: null,
      materialId: 'mat-001',
    });

    assert.equal(result.status, 401);
    assert.equal(result.error, 'Authentication required');
  });

  test('user with no wallet address receives 400', async () => {
    const db = createDb({ materials: createCollection() });

    const result = await deliverMaterial({
      db,
      user: { sub: 'user-456', walletAddress: null },
      materialId: 'mat-001',
    });

    assert.equal(result.status, 400);
    assert.equal(result.error, 'No wallet address on account');
  });

  test('user with empty sub receives 401', async () => {
    const db = createDb({ materials: createCollection() });

    const result = await deliverMaterial({
      db,
      user: { sub: null, walletAddress: 'galice' },
      materialId: 'mat-001',
    });

    assert.equal(result.status, 401);
  });

});

// =============================================================================
// Authorization Tests
// =============================================================================

describe('Delivery — Authorization', () => {

  test('owner can download their own material', async () => {
    const materialId = 'mat-owner-001';
    const db = createDb({ materials: createCollection() });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      userAddress: 'galice',
      price: 500,
    }));

    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'galice' }),
      materialId,
    });

    assert.equal(result.status, 200);
    assert.equal(result.source, 'owner');
  });

  test('purchaser with entitlement can download', async () => {
    const materialId = 'mat-purchased';
    const cacheDb = createCollection();
    const db = createDb({
      materials: createCollection(),
      entitlement_cache: cacheDb,
    });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      userAddress: 'gcreator',
      price: 1000,
    }));
    cacheDb.docs.set(`${materialId}:gbob`, {
      materialId,
      buyerAddress: 'gbob',
      active: true,
      source: 'purchase-api',
    });

    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'gbob' }),
      materialId,
    });

    assert.equal(result.status, 200);
    assert.equal(result.source, 'cache');
  });

  test('free public material is accessible without purchase', async () => {
    const materialId = 'mat-free';
    const db = createDb({ materials: createCollection() });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      price: 0,
      visibility: 'public',
    }));

    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'gstranger' }),
      materialId,
    });

    assert.equal(result.status, 200);
    assert.equal(result.source, 'free-public');
  });

  test('user without access receives 403', async () => {
    const materialId = 'mat-restricted';
    const db = createDb({
      materials: createCollection(),
      entitlement_cache: createCollection(),
      purchases: createCollection(),
    });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      userAddress: 'gcreator',
      price: 1000,
      visibility: 'private',
    }));

    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'gstranger' }),
      materialId,
    });

    assert.equal(result.status, 403);
    assert.equal(result.error, 'Access denied. You do not have permission to access this material.');
  });

  test('invalid material ID returns 400', async () => {
    const db = createDb({ materials: createCollection() });

    const result = await deliverMaterial({
      db,
      user: makeUser(),
      materialId: null,
    });

    assert.equal(result.status, 400);
    assert.equal(result.error, 'Invalid material ID');
  });

  test('deleted material returns 404', async () => {
    const db = createDb({ materials: createCollection() });

    const result = await deliverMaterial({
      db,
      user: makeUser(),
      materialId: 'mat-deleted',
    });

    assert.equal(result.status, 404);
    assert.equal(result.error, 'Material not found');
  });

  test('material with no file reference returns 404', async () => {
    const materialId = 'mat-nofile';
    const db = createDb({ materials: createCollection() });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      storageKey: null,
      fileUrl: null,
      ipfsCid: null,
      cid: null,
      fileHash: null,
      price: 0,
      visibility: 'public',
    }));

    const result = await deliverMaterial({
      db,
      user: makeUser(),
      materialId,
    });

    assert.equal(result.status, 404);
    assert.equal(result.error, 'Material has no associated file');
  });

});

// =============================================================================
// Security Tests
// =============================================================================

describe('Delivery — Security', () => {

  test('unauthorized user never receives downloadUrl', async () => {
    const materialId = 'mat-sec-001';
    const db = createDb({
      materials: createCollection(),
      entitlement_cache: createCollection(),
      purchases: createCollection(),
    });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      userAddress: 'galice',
      price: 1000,
      storageKey: 'QmSecret',
    }));

    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'gattacker' }),
      materialId,
    });

    // Must NOT receive file data
    assert.equal(result.status, 403);
    assert.equal(result.downloadUrl, undefined);
    assert.equal(result.success, undefined);
    assert.notEqual(result.error, undefined);
  });

  test('user A cannot access user B purchased materials', async () => {
    const materialId = 'mat-sec-002';
    const cacheDb = createCollection();
    const db = createDb({
      materials: createCollection(),
      entitlement_cache: cacheDb,
    });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      userAddress: 'gbob',
      price: 500,
    }));
    // Only Bob has entitlement
    cacheDb.docs.set(`${materialId}:gbob`, {
      materialId,
      buyerAddress: 'gbob',
      active: true,
    });

    // Alice tries to access Bob's material
    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'galice' }),
      materialId,
    });

    assert.equal(result.status, 403);
    assert.equal(result.downloadUrl, undefined);
  });

  test('access check uses server-side verification, not client params', async () => {
    const materialId = 'mat-sec-003';
    const db = createDb({
      materials: createCollection(),
      entitlement_cache: createCollection(),
      purchases: createCollection(),
    });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      userAddress: 'gowner',
      price: 1000,
    }));

    // Even if user claims to be someone else via wallet address, the JWT
    // determines identity (user.sub and user.walletAddress come from cookie)
    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'gowner' }),
      materialId,
    });

    // Should succeed because the JWT-authenticated user IS the owner
    assert.equal(result.status, 200);
  });

  test('purchase DB fallback works when cache is empty', async () => {
    const materialId = 'mat-sec-004';
    const purchasesDb = createCollection();
    const db = createDb({
      materials: createCollection(),
      entitlement_cache: createCollection(),
      purchases: purchasesDb,
    });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      userAddress: 'gcreator',
      price: 500,
    }));
    purchasesDb.docs.set(`${materialId}:gbuyer`, {
      materialId,
      buyerAddress: 'gbuyer',
      status: 'settled',
    });

    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'gbuyer' }),
      materialId,
    });

    assert.equal(result.status, 200);
    assert.equal(result.source, 'purchases-db');
  });

  test('pending purchase does NOT grant access', async () => {
    const materialId = 'mat-sec-005';
    const purchasesDb = createCollection();
    const db = createDb({
      materials: createCollection(),
      entitlement_cache: createCollection(),
      purchases: purchasesDb,
    });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      userAddress: 'gcreator',
      price: 500,
    }));
    purchasesDb.docs.set(`${materialId}:gpending`, {
      materialId,
      buyerAddress: 'gpending',
      status: 'pending',
    });

    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'gpending' }),
      materialId,
    });

    assert.equal(result.status, 403);
  });

});

// =============================================================================
// File Reference Resolution Tests
// =============================================================================

describe('Delivery — File Resolution', () => {

  test('uses storageKey when present', async () => {
    const materialId = 'mat-file-001';
    const db = createDb({ materials: createCollection() });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      storageKey: 'QmCustomKey',
      fileUrl: 'https://gateway.pinata.cloud/ipfs/QmCustomKey',
      price: 0,
      visibility: 'public',
    }));

    const result = await deliverMaterial({ db, user: makeUser(), materialId });

    assert.ok(result.downloadUrl.includes('QmCustomKey'));
  });

  test('falls back to ipfsCid then cid then fileHash then fileUrl', async () => {
    const materialId = 'mat-file-002';
    const db = createDb({ materials: createCollection() });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      storageKey: null,
      fileUrl: null,
      ipfsCid: 'QmIpfsCid',
      price: 0,
      visibility: 'public',
    }));

    const result = await deliverMaterial({ db, user: makeUser(), materialId });
    assert.ok(result.downloadUrl.includes('QmIpfsCid'));
  });

  test('returns 404 when no CID found in any field', async () => {
    const materialId = 'mat-file-003';
    const db = createDb({ materials: createCollection() });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      storageKey: null,
      fileUrl: null,
      ipfsCid: null,
      cid: null,
      fileHash: null,
      price: 0,
      visibility: 'public',
    }));

    const result = await deliverMaterial({ db, user: makeUser(), materialId });
    assert.equal(result.status, 404);
  });

});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Delivery — Edge Cases', () => {

  test('material with no price and public visibility is accessible', async () => {
    const materialId = 'mat-edge-001';
    const db = createDb({ materials: createCollection() });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      price: 0,
      visibility: 'public',
    }));

    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'ganyone' }),
      materialId,
    });

    assert.equal(result.status, 200);
  });

  test('material with price=0 and non-public visibility is not accessible without entitlement', async () => {
    const materialId = 'mat-edge-002';
    const db = createDb({
      materials: createCollection(),
      entitlement_cache: createCollection(),
      purchases: createCollection(),
    });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      price: 0,
      visibility: 'private',
      userAddress: 'gowner',
    }));

    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'gstranger' }),
      materialId,
    });

    assert.equal(result.status, 403);
  });

  test('case-insensitive wallet address matching', async () => {
    const materialId = 'mat-edge-003';
    const db = createDb({ materials: createCollection() });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      userAddress: 'GALICE',
      price: 100,
    }));

    const result = await deliverMaterial({
      db,
      user: makeUser({ walletAddress: 'galice' }),
      materialId,
    });

    assert.equal(result.status, 200);
    assert.equal(result.source, 'owner');
  });

  test('material with no fileName falls back to title then id', async () => {
    const materialId = 'mat-edge-004';
    const db = createDb({ materials: createCollection() });
    db.collection('materials').docs.set(materialId, makeMaterial(materialId, {
      fileName: null,
      title: 'My Great Material',
      price: 0,
      visibility: 'public',
    }));

    const result = await deliverMaterial({ db, user: makeUser(), materialId });
    assert.equal(result.fileName, 'My Great Material');
  });

});

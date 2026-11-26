import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMarketplaceDiscoveryQuery } from '../../src/lib/backend/marketplaceDiscovery.js';
import { canViewHiddenMaterial, assertCanChangeVisibility } from '../../src/lib/materials/visibilityPolicy.js';

describe('hidden record permission contracts (#1103)', () => {
  it('excludes hidden records from public discovery query', () => {
    const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());
    assert.deepEqual(query.isHidden, { $ne: true });
    assert.deepEqual(query.hidden, { $ne: true });
    assert.ok(Array.isArray(query.$and));
    assert.ok(query.$and.some((c) => c.$or?.some((o) => o.visibility === 'public')));
  });

  it('allows owner or admin to view hidden material, denies other users', () => {
    const owner = { sub: 'u1', walletAddress: 'GOWNER', role: 'creator' };
    const admin = { sub: 'a1', role: 'admin' };
    const other = { sub: 'u2', walletAddress: 'GOTHER', role: 'creator' };
    assert.equal(canViewHiddenMaterial({ viewer: owner, ownerWallet: 'GOWNER' }), true);
    assert.equal(canViewHiddenMaterial({ viewer: admin, ownerWallet: 'GOWNER' }), true);
    assert.equal(canViewHiddenMaterial({ viewer: other, ownerWallet: 'GOWNER' }), false);
  });

  it('denies unauthorized visibility change but allows authorized retry-safe change path', () => {
    const owner = { sub: 'u1', walletAddress: 'GOWNER', role: 'creator' };
    const other = { sub: 'u2', walletAddress: 'GOTHER', role: 'creator' };
    assert.throws(() => assertCanChangeVisibility({ viewer: other, ownerWallet: 'GOWNER' }), /Forbidden/);
    assert.doesNotThrow(() => assertCanChangeVisibility({ viewer: owner, ownerWallet: 'GOWNER' }));
    // retry/idempotent: same authorized call remains allowed
    assert.doesNotThrow(() => assertCanChangeVisibility({ viewer: owner, ownerWallet: 'GOWNER' }));
  });
});

/**
 * Integration tests for Soroban Entitlement Gate & XDR Builder — Issue #85
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  buildHasEntitlementXdr,
  checkChainEntitlement,
  verifyEntitlement,
  createEntitlement,
  revokeEntitlement,
} from '../../src/lib/entitlement.js';

describe('Soroban Entitlement Gate (Issue #85)', () => {
  const sampleMaterialId = '507f1f77bcf86cd799439011';
  const sampleBuyer = 'GBBE23356J7FHJDUCR56WETI4PEXML67VJOVIUN4TIVD5CA7S3SG5BMV';

  test('buildHasEntitlementXdr produces a non-empty base64 XDR string for valid params', () => {
    // Set a dummy contract ID for testing if not set
    process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID =
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

    const xdrString = buildHasEntitlementXdr(sampleMaterialId, sampleBuyer);
    assert.ok(typeof xdrString === 'string');
    assert.ok(xdrString.length > 0, 'XDR string should not be empty');
  });

  test('buildHasEntitlementXdr handles missing parameters gracefully', () => {
    assert.equal(buildHasEntitlementXdr('', sampleBuyer), '');
    assert.equal(buildHasEntitlementXdr(sampleMaterialId, ''), '');
  });

  test('checkChainEntitlement returns null when RPC is unavailable or fails', async () => {
    // Set an invalid RPC URL to simulate failure
    const originalRpc = process.env.NEXT_PUBLIC_STELLAR_RPC_URL;
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL = 'http://localhost:59999/invalid-rpc';

    const result = await checkChainEntitlement(sampleMaterialId, sampleBuyer);
    assert.equal(result, null);

    process.env.NEXT_PUBLIC_STELLAR_RPC_URL = originalRpc;
  });

  test('verifyEntitlement returns invalid-params when materialId or buyerAddress is missing', async () => {
    const res1 = await verifyEntitlement('', sampleBuyer);
    assert.equal(res1.hasAccess, false);
    assert.equal(res1.source, 'invalid-params');

    const res2 = await verifyEntitlement(sampleMaterialId, '');
    assert.equal(res2.hasAccess, false);
    assert.equal(res2.source, 'invalid-params');
  });
});

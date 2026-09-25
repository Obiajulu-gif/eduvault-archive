import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapContractAuthError,
  assertResourceOwner,
  assertBuyer,
} from '../../src/lib/api/authorizationBoundary.js';

const CREATOR = 'GDQX______CREATOR___ADDRESS_000000000000001';
const BUYER = 'GBCB______BUYER_____ADDRESS_00000000000000001';
const ADMIN = 'GAAF______ADMIN_____ADDRESS_00000000000000001';
const STRANGER = 'G123______STRANGER__ADDRESS_00000000000000002';

describe('Authorization boundary (#683)', () => {
  describe('unauthorized creator actions are denied', () => {
    it('a non-owner (impersonating buyer) cannot update the resource', () => {
      const denied = assertResourceOwner({
        caller: BUYER,
        owner: CREATOR,
        upgradeAdmin: ADMIN,
        action: 'update this material',
      });
      assert.deepEqual(denied, { error: 'You are not authorized to update this material', statusCode: 403 });
    });

    it('a stranger cannot publish/update', () => {
      const denied = assertResourceOwner({
        caller: STRANGER,
        owner: CREATOR,
        upgradeAdmin: ADMIN,
        action: 'publish or update this material',
      });
      assert.equal(denied.statusCode, 403);
    });
  });

  describe('unauthorized buyer actions are denied', () => {
    it('a stranger cannot refund/access a purchase owned by another buyer', () => {
      const denied = assertBuyer({
        caller: STRANGER,
        buyer: BUYER,
        action: 'refund or access this purchase',
      });
      assert.deepEqual(denied, { error: 'You are not authorized to refund or access this purchase', statusCode: 403 });
    });

    it('the creator cannot act as the buyer on someone else\u2019s purchase', () => {
      const denied = assertBuyer({ caller: CREATOR, buyer: BUYER });
      assert.equal(denied.statusCode, 403);
    });
  });

  describe('missing wallet rejects before any contract call', () => {
    it('returns 401 for a caller with no wallet', () => {
      assert.deepEqual(assertResourceOwner({ caller: '', owner: CREATOR, upgradeAdmin: ADMIN }), {
        error: 'Unauthorized: Wallet connection required',
        statusCode: 401,
      });
      assert.deepEqual(assertBuyer({ caller: null, buyer: BUYER }), {
        error: 'Unauthorized: Wallet connection required',
        statusCode: 401,
      });
    });
  });

  describe('authorized paths pass through', () => {
    it('the owner may update', () => {
      assert.equal(assertResourceOwner({ caller: CREATOR, owner: CREATOR, upgradeAdmin: ADMIN }), null);
    });
    it('the registered buyer may access', () => {
      assert.equal(assertBuyer({ caller: BUYER, buyer: BUYER }), null);
    });
    it('the upgrade admin may manage any resource', () => {
      assert.equal(assertResourceOwner({ caller: ADMIN, owner: CREATOR, upgradeAdmin: ADMIN }), null);
    });
  });

  describe('contract auth failures map to stable API errors', () => {
    it('NotAuthorized -> 403 with a stable message', () => {
      const err = mapContractAuthError({ code: 'NotAuthorized', action: 'refund this purchase' });
      assert.equal(err.statusCode, 403);
      assert.match(err.error, /not authorized/i);
    });

    it('MaterialNotFound -> 403 (fail-closed, no resource leak)', () => {
      const err = mapContractAuthError({ code: 'MaterialNotFound', action: 'purchase this material' });
      assert.equal(err.statusCode, 403);
    });

    it('NotInitialized -> 503', () => {
      assert.equal(mapContractAuthError({ code: 'NotInitialized' }).statusCode, 503);
    });

    it('AlreadyInitialized -> 409', () => {
      assert.equal(mapContractAuthError({ code: 'AlreadyInitialized' }).statusCode, 409);
    });

    it('unknown codes fall back to a generic 400 rejection', () => {
      assert.equal(mapContractAuthError({ code: 'SomeContractFailure' }).statusCode, 400);
    });
  });
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitionMaterialState } from '../../src/lib/db/materialLifecycle.js';

test('catalog mutation includes trust snapshot in both read and atomic write', async () => {
  const expectedFields = { searchVersion: 7, fraudHold: null, userAddress: 'creator' };
  let write;
  const db = { collection: () => ({
    findOne: async filter => {
      assert.deepEqual(filter, { _id: 'asset', ...expectedFields });
      return { _id: 'asset', lifecycleState: 'active', ...expectedFields };
    },
    updateOne: async filter => { write = filter; return { matchedCount: 0 }; },
  }) };
  await assert.rejects(transitionMaterialState(db, 'asset', 'retired', { expectedFields }), /changed state/);
  assert.equal(write.searchVersion, 7);
  assert.equal(write.fraudHold, null);
  assert.equal(write.userAddress, 'creator');
});

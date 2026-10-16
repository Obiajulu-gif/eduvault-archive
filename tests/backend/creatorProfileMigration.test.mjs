import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildWalletLookupQuery,
  normalizeProfileForSession,
  runProfileMigration,
  CHECKPOINT_ID,
} from '../../src/lib/migrations/profileMigration.js';

function createMockId(str) {
  return {
    toString: () => str,
    equals: (other) => (other?.toString ? other.toString() === str : other === str),
  };
}

test('buildWalletLookupQuery covers EVM, lowercased EVM, and Stellar wallet representations', () => {
  const evmAddress = '0x1234567890abcdef1234567890abcdef12345678';
  const query = buildWalletLookupQuery(evmAddress);

  assert.equal(Array.isArray(query.$or), true);
  const clauses = query.$or;

  assert.deepEqual(clauses[0], { walletAddress: evmAddress });
  assert.deepEqual(clauses[1], { walletAddressLower: evmAddress.toLowerCase() });
  assert.deepEqual(clauses[3], { evmWalletAddress: evmAddress.toLowerCase() });
  assert.deepEqual(clauses[5], { 'wallets.evm': evmAddress.toLowerCase() });
});

test('normalizeProfileForSession handles unmigrated and partially-migrated profiles gracefully', () => {
  // Legacy EVM creator profile
  const legacyEvm = {
    _id: 'user-evm-1',
    walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    name: 'EVM Creator',
  };

  const normalizedEvm = normalizeProfileForSession(legacyEvm);
  assert.equal(normalizedEvm.walletAddress, '0xABCDEF1234567890ABCDEF1234567890ABCDEF12');
  assert.equal(normalizedEvm.evmWalletAddress, '0xabcdef1234567890abcdef1234567890abcdef12');
  assert.equal(normalizedEvm.wallets.evm, '0xabcdef1234567890abcdef1234567890abcdef12');

  // Legacy Stellar creator profile
  const legacyStellar = {
    _id: 'user-stellar-1',
    walletAddress: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
    name: 'Stellar Creator',
  };

  const normalizedStellar = normalizeProfileForSession(legacyStellar);
  assert.equal(normalizedStellar.stellarWalletAddress, 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7');
  assert.equal(normalizedStellar.wallets.stellar, 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7');
});

test('runProfileMigration executes dry-run without writing, then executes migration with checkpointing and rollback', async () => {
  const usersStore = [
    {
      _id: createMockId('660000000000000000000001'),
      walletAddress: '0x1111111111111111111111111111111111111111',
      name: 'User 1',
    },
    {
      _id: createMockId('660000000000000000000002'),
      walletAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      name: 'User 2',
    },
    {
      _id: createMockId('660000000000000000000003'),
      walletAddress: '0x2222222222222222222222222222222222222222',
      name: 'User 3',
    },
  ];

  const checkpointStore = {};

  const mockDb = {
    collection: (colName) => {
      if (colName === 'users') {
        return {
          countDocuments: async (q) => {
            if (q?.schemaVersion === 2) return usersStore.filter((u) => u.schemaVersion === 2).length;
            return usersStore.length;
          },
          find: (q) => {
            let res = [...usersStore];
            if (q?._id?.$gt) {
              res = res.filter((u) => u._id.toString() > q._id.$gt.toString());
            }
            return {
              sort: () => ({
                limit: (lim) => ({
                  toArray: async () => res.slice(0, lim),
                }),
              }),
            };
          },
          updateOne: async (filter, update) => {
            const user = usersStore.find((u) => u._id.equals(filter._id));
            if (user && update.$set) {
              Object.assign(user, update.$set);
            }
          },
          updateMany: async (filter, update) => {
            let count = 0;
            usersStore.forEach((u) => {
              if (u.schemaVersion === 2 && update.$unset) {
                delete u.stellarWalletAddress;
                delete u.evmWalletAddress;
                delete u.wallets;
                delete u.schemaVersion;
                count++;
              }
            });
            return { modifiedCount: count };
          },
        };
      }
      if (colName === 'migration_checkpoints') {
        return {
          findOne: async (filter) => checkpointStore[filter._id] || null,
          updateOne: async (filter, update) => {
            checkpointStore[filter._id] = {
              ...(checkpointStore[filter._id] || {}),
              ...(update.$set || {}),
            };
          },
          deleteOne: async (filter) => {
            delete checkpointStore[filter._id];
          },
        };
      }
      return {};
    },
  };

  // 1. Dry Run
  const dryRunResult = await runProfileMigration(mockDb, { dryRun: true, batchSize: 2 });
  assert.equal(dryRunResult.dryRun, true);
  assert.equal(dryRunResult.modifiedCount, 0);
  assert.equal(usersStore[0].schemaVersion, undefined);
  assert.equal(dryRunResult.sampleDiffs.length > 0, true);

  // 2. Real Migration
  const migrationResult = await runProfileMigration(mockDb, { batchSize: 2 });
  assert.equal(migrationResult.completed, true);
  assert.equal(usersStore[0].schemaVersion, 2);
  assert.equal(usersStore[0].wallets.evm, '0x1111111111111111111111111111111111111111');
  assert.equal(usersStore[1].wallets.stellar, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
  assert.equal(checkpointStore[CHECKPOINT_ID].completed, true);

  // 3. Rollback
  const rollbackResult = await runProfileMigration(mockDb, { rollback: true });
  assert.equal(rollbackResult.rollback, true);
  assert.equal(rollbackResult.modifiedCount, 3);
  assert.equal(usersStore[0].schemaVersion, undefined);
  assert.equal(checkpointStore[CHECKPOINT_ID], undefined);
});

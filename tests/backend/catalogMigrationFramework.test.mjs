import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readCatalogMaterial,
  prepareCatalogWrite,
  runCatalogMigration,
  migrationV2,
  CURRENT_CATALOG_VERSION,
} from '../../src/lib/migrations/catalogMigrationFramework.js';

function createMockId(str) {
  return {
    toString: () => str,
    equals: (other) => (other?.toString ? other.toString() === str : other === str),
  };
}

test('readCatalogMaterial provides dual-read tolerance for v1 documents', () => {
  const legacyDoc = {
    _id: 'doc-1',
    title: 'Intro to Soroban Smart Contracts',
    price: 20,
    category: 'Computer Science',
    // schemaVersion missing
  };

  const readResult = readCatalogMaterial(legacyDoc);

  assert.equal(readResult.schemaVersion, CURRENT_CATALOG_VERSION);
  assert.equal(readResult.pricingTier, 'premium');
  assert.equal(readResult.sorobanEntitlementConfig.tokenStandard, 'SEP-0041');
  assert.equal(readResult.title, 'Intro to Soroban Smart Contracts');
  assert.equal(readResult.price, 20);
});

test('prepareCatalogWrite enforces current schemaVersion and sets required metadata', () => {
  const newListing = {
    title: 'Stellar Assets & Anchors',
    price: 0,
    category: 'Finance',
  };

  const written = prepareCatalogWrite(newListing);

  assert.equal(written.schemaVersion, CURRENT_CATALOG_VERSION);
  assert.equal(written.pricingTier, 'free');
  assert.equal(written.rightsMetadata.educationalOnly, true);
});

test('runCatalogMigration executes batched, resumable migration across interruptions and supports rollback', async () => {
  const mockMaterials = [
    { _id: createMockId('mat-001'), title: 'Course 1', price: 0 },
    { _id: createMockId('mat-002'), title: 'Course 2', price: 10 },
    { _id: createMockId('mat-003'), title: 'Course 3', price: 25 },
    { _id: createMockId('mat-004'), title: 'Course 4', price: 5 },
  ];

  const checkpointStore = {};

  const mockDb = {
    collection: (name) => {
      if (name === 'materials') {
        return {
          countDocuments: async (q) => {
            if (q?.schemaVersion === 2) {
              return mockMaterials.filter((m) => m.schemaVersion === 2).length;
            }
            return mockMaterials.filter((m) => !m.schemaVersion || m.schemaVersion < 2).length;
          },
          find: (q) => {
            let res = mockMaterials.filter((m) => !m.schemaVersion || m.schemaVersion < 2);
            if (q?._id?.$gt) {
              res = res.filter((m) => m._id.toString() > q._id.$gt.toString());
            }
            if (q?.schemaVersion === 2) {
              res = mockMaterials.filter((m) => m.schemaVersion === 2);
            }
            let pointer = 0;
            return {
              sort: () => ({
                limit: (lim) => ({
                  toArray: async () => res.slice(0, lim),
                }),
              }),
              hasNext: async () => pointer < res.length,
              next: async () => res[pointer++],
            };
          },
          replaceOne: async (filter, replacement) => {
            const index = mockMaterials.findIndex((m) => m._id.equals(filter._id));
            if (index !== -1) {
              mockMaterials[index] = replacement;
            }
          },
        };
      }
      if (name === 'migration_checkpoints') {
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

  // 1. Dry Run Preview
  const dryRun = await runCatalogMigration(mockDb, migrationV2, { dryRun: true, batchSize: 2 });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.modifiedCount, 0);
  assert.equal(mockMaterials[0].schemaVersion, undefined);

  // 2. First batch execution (interrupted after 1 batch of 2 items)
  const step1 = await runCatalogMigration(mockDb, migrationV2, { batchSize: 2, maxBatches: 1 });
  assert.equal(step1.completed, false);
  assert.equal(step1.modifiedCount, 2);
  assert.equal(mockMaterials[0].schemaVersion, 2);
  assert.equal(mockMaterials[1].schemaVersion, 2);
  assert.equal(mockMaterials[2].schemaVersion, undefined);

  // Checkpoint was stored
  assert.equal(checkpointStore['catalog_migration_v2'].completed, false);
  assert.equal(checkpointStore['catalog_migration_v2'].processedCount, 2);

  // 3. Resume migration to completion
  const step2 = await runCatalogMigration(mockDb, migrationV2, { batchSize: 2 });
  assert.equal(step2.completed, true);
  assert.equal(mockMaterials[2].schemaVersion, 2);
  assert.equal(mockMaterials[3].schemaVersion, 2);
  assert.equal(checkpointStore['catalog_migration_v2'].completed, true);

  // Validate end-to-end migrated shapes
  assert.equal(migrationV2.validate(mockMaterials[0]), true);
  assert.equal(migrationV2.validate(mockMaterials[2]), true);
  assert.equal(mockMaterials[0].pricingTier, 'free');
  assert.equal(mockMaterials[2].pricingTier, 'premium');

  // 4. Rollback
  const rollback = await runCatalogMigration(mockDb, migrationV2, { rollback: true });
  assert.equal(rollback.rollback, true);
  assert.equal(mockMaterials[0].schemaVersion, 1);
  assert.equal(mockMaterials[0].pricingTier, undefined);
  assert.equal(checkpointStore['catalog_migration_v2'], undefined);
});

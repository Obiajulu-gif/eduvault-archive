import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DRIFT_CATEGORY,
  REPAIR_ACTION,
  generateRootCauseHint,
  runProjectionReconciliation,
} from '../../src/lib/reconciliation/projectionReconciler.js';

function createMockDb(initialData = {}) {
  const collections = {};

  for (const [colName, docs] of Object.entries(initialData)) {
    collections[colName] = new Map();
    for (const [key, doc] of Object.entries(docs)) {
      collections[colName].set(key, JSON.parse(JSON.stringify(doc)));
    }
  }

  return {
    collection(name) {
      if (!collections[name]) collections[name] = new Map();
      const map = collections[name];

      return {
        find() {
          return {
            async toArray() {
              return Array.from(map.values()).map((d) => JSON.parse(JSON.stringify(d)));
            },
          };
        },
        async updateOne(query, update, options = {}) {
          let foundKey = null;
          for (const [key, doc] of map.entries()) {
            const matches = Object.entries(query).every(([k, v]) => doc[k] === v);
            if (matches) {
              foundKey = key;
              break;
            }
          }

          if (foundKey) {
            const existing = map.get(foundKey);
            if (update.$set) Object.assign(existing, JSON.parse(JSON.stringify(update.$set)));
            return { matchedCount: 1, modifiedCount: 1 };
          }

          if (options.upsert) {
            const newDoc = {
              ...query,
              ...(update.$set || {}),
              ...(update.$setOnInsert || {}),
            };
            const id = newDoc.materialId && newDoc.buyerAddress
              ? `${newDoc.materialId}:${newDoc.buyerAddress}`
              : (newDoc.materialId || `id-${map.size + 1}`);
            map.set(id, newDoc);
            return { matchedCount: 0, upsertedCount: 1 };
          }

          return { matchedCount: 0, modifiedCount: 0 };
        },
        async deleteOne(query) {
          for (const [key, doc] of map.entries()) {
            const matches = Object.entries(query).every(([k, v]) => doc[k] === v);
            if (matches) {
              map.delete(key);
              return { deletedCount: 1 };
            }
          }
          return { deletedCount: 0 };
        },
      };
    },
    _getRawStore(name) {
      return collections[name];
    },
  };
}

test('generateRootCauseHint returns meaningful hints for all categories', () => {
  const missingHint = generateRootCauseHint(DRIFT_CATEGORY.MISSING_PROJECTION);
  assert.ok(missingHint.includes('outbox asynchronous fanout'));

  const orphanHint = generateRootCauseHint(DRIFT_CATEGORY.ORPHAN_PROJECTION);
  assert.ok(orphanHint.includes('bypassing projection invalidation hooks'));

  const staleHint = generateRootCauseHint(DRIFT_CATEGORY.STALE_PROJECTION);
  assert.ok(staleHint.includes('optimistic concurrency retry') || staleHint.includes('lagged behind'));

  const divergenceHint = generateRootCauseHint(DRIFT_CATEGORY.DATA_DIVERGENCE);
  assert.ok(divergenceHint.includes('race condition') || divergenceHint.includes('refund'));
});

test('reconciles entitlements: detects missing, orphan, and data divergence in dry-run', async () => {
  const db = createMockDb({
    purchases: {
      'p-1': {
        materialId: 'mat-1',
        buyerAddress: 'gbuyer1',
        status: 'settled',
        settlementState: 'Released',
      },
      'p-2': {
        materialId: 'mat-2',
        buyerAddress: 'gbuyer2',
        status: 'settled',
        settlementState: 'Refunded', // refunded in SoT, but cache says active
      },
    },
    entitlement_cache: {
      'mat-2:gbuyer2': {
        materialId: 'mat-2',
        buyerAddress: 'gbuyer2',
        active: true, // divergent!
      },
      'mat-orphan:gbuyer3': {
        materialId: 'mat-orphan',
        buyerAddress: 'gbuyer3',
        active: true, // orphan!
      },
    },
  });

  // Dry-run execution
  const report = await runProjectionReconciliation({
    db,
    scope: 'entitlements',
    dryRun: true,
  });

  assert.equal(report.dryRun, true);
  assert.equal(report.driftCount, 3);
  assert.equal(report.byCategory[DRIFT_CATEGORY.MISSING_PROJECTION], 1);
  assert.equal(report.byCategory[DRIFT_CATEGORY.DATA_DIVERGENCE], 1);
  assert.equal(report.byCategory[DRIFT_CATEGORY.ORPHAN_PROJECTION], 1);

  // Assert no mutations took place in dry run
  const rawCache = db._getRawStore('entitlement_cache');
  assert.equal(rawCache.has('mat-orphan:gbuyer3'), true);
  assert.equal(rawCache.has('mat-1:gbuyer1'), false);
});

test('reconciles search index: detects missing public materials and orphan unlisted materials', async () => {
  const db = createMockDb({
    materials: {
      'mat-public-1': {
        materialId: 'mat-public-1',
        title: 'Quantum Physics',
        visibility: 'public',
        status: 'published',
      },
      'mat-archived-2': {
        materialId: 'mat-archived-2',
        title: 'Deprecated Course',
        visibility: 'public',
        status: 'archived', // archived, should NOT be in search index
      },
    },
    search_index: {
      'mat-archived-2': {
        materialId: 'mat-archived-2',
        title: 'Deprecated Course',
      },
    },
  });

  const report = await runProjectionReconciliation({
    db,
    scope: 'search',
    dryRun: true,
  });

  assert.equal(report.driftCount, 2);
  const missing = report.driftItems.find((d) => d.category === DRIFT_CATEGORY.MISSING_PROJECTION);
  assert.equal(missing.targetId, 'mat-public-1');

  const orphan = report.driftItems.find((d) => d.category === DRIFT_CATEGORY.ORPHAN_PROJECTION);
  assert.equal(orphan.targetId, 'mat-archived-2');
});

test('executes repairs idempotently and achieves zero drift post-repair', async () => {
  const db = createMockDb({
    purchases: {
      'p-1': {
        materialId: 'mat-1',
        buyerAddress: 'gbuyer1',
        status: 'confirmed',
      },
    },
    entitlement_cache: {},
    materials: {
      'mat-math': {
        materialId: 'mat-math',
        title: 'Calculus',
        visibility: 'public',
        status: 'published',
      },
    },
    search_index: {},
  });

  // 1. First dry run: 2 missing projections detected
  const dryReport = await runProjectionReconciliation({ db, scope: 'all', dryRun: true });
  assert.equal(dryReport.driftCount, 2);

  // 2. Execute repairs
  const execReport = await runProjectionReconciliation({ db, scope: 'all', dryRun: false });
  assert.equal(execReport.dryRun, false);
  assert.equal(execReport.repairedCount, 2);
  assert.equal(execReport.errorsCount, 0);

  // 3. Post-repair re-scan: 0 drift detected!
  const postReport = await runProjectionReconciliation({ db, scope: 'all', dryRun: true });
  assert.equal(postReport.driftCount, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DRIFT_CATEGORY,
  REPAIR_ACTION,
  generateRootCauseHint,
  runProjectionReconciliation,
  rollbackProjectionRepairs,
  authorizeProjectionReconciliation,
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
        async findOne(query) {
          for (const doc of map.values()) {
            const matches = Object.entries(query).every(([k, v]) => doc[k] === v);
            if (matches) return JSON.parse(JSON.stringify(doc));
          }
          return null;
        },
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

test('authorization path: rejects unauthorized or non-privileged actors', async () => {
  const db = createMockDb({});

  // 1. Missing actor
  await assert.rejects(
    async () => {
      await runProjectionReconciliation({ db, actor: null });
    },
    (err) => err.code === 'AUTH_FORBIDDEN' || err.status === 403
  );

  // 2. Unauthorized role
  await assert.rejects(
    async () => {
      await runProjectionReconciliation({ db, actor: { role: 'learner' } });
    },
    (err) => err.code === 'AUTH_FORBIDDEN'
  );

  // 3. Custom authorize check returning false
  await assert.rejects(
    async () => {
      await runProjectionReconciliation({
        db,
        actor: { role: 'admin' },
        authorize: () => false,
      });
    },
    (err) => err.code === 'AUTH_FORBIDDEN'
  );

  // 4. Authorized operator succeeds
  const allowedReport = await runProjectionReconciliation({
    db,
    actor: { role: 'operator' },
    dryRun: true,
  });
  assert.equal(allowedReport.dryRun, true);
});

test('retry path: recovers from transient database failure during repair', async () => {
  const db = createMockDb({
    purchases: {
      'p-1': {
        materialId: 'mat-retry',
        buyerAddress: 'gbuyer-retry',
        status: 'confirmed',
      },
    },
    entitlement_cache: {},
  });

  // Inject transient error into updateOne on first attempt
  let attempts = 0;
  const originalCollection = db.collection.bind(db);
  db.collection = (name) => {
    const col = originalCollection(name);
    if (name === 'entitlement_cache') {
      const origUpdate = col.updateOne.bind(col);
      col.updateOne = async (...args) => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Transient connection pool timeout');
        }
        return origUpdate(...args);
      };
    }
    return col;
  };

  const report = await runProjectionReconciliation({
    db,
    scope: 'entitlements',
    dryRun: false,
    maxRetries: 2,
    retryDelayMs: 1,
    sleep: async () => {},
  });

  assert.equal(report.repairedCount, 1);
  assert.equal(report.errorsCount, 0);
  assert.equal(report.retriedCount, 1);
});

test('failure path: records permanent per-item error in failedItems without aborting healthy items', async () => {
  const db = createMockDb({
    purchases: {
      'p-healthy': {
        materialId: 'mat-healthy',
        buyerAddress: 'gbuyer1',
        status: 'confirmed',
      },
      'p-failing': {
        materialId: 'mat-fail',
        buyerAddress: 'gbuyer2',
        status: 'confirmed',
      },
    },
    entitlement_cache: {},
  });

  const originalCollection = db.collection.bind(db);
  db.collection = (name) => {
    const col = originalCollection(name);
    if (name === 'entitlement_cache') {
      const origUpdate = col.updateOne.bind(col);
      col.updateOne = async (query, ...args) => {
        if (query.materialId === 'mat-fail') {
          throw new Error('Database write constraint violation');
        }
        return origUpdate(query, ...args);
      };
    }
    return col;
  };

  const report = await runProjectionReconciliation({
    db,
    scope: 'entitlements',
    dryRun: false,
    maxRetries: 1,
    retryDelayMs: 1,
    sleep: async () => {},
  });

  assert.equal(report.repairedCount, 1);
  assert.equal(report.errorsCount, 1);
  assert.equal(report.failedItems.length, 1);
  assert.equal(report.failedItems[0].targetId, 'mat-fail:gbuyer2');
  assert.match(report.failedItems[0].error, /constraint violation/);
});

test('rollback path: rollbackProjectionRepairs restores pre-repair state', async () => {
  const db = createMockDb({
    purchases: {
      'p-1': {
        materialId: 'mat-existing',
        buyerAddress: 'gbuyer1',
        status: 'completed',
        settlementState: 'active',
      },
    },
    entitlement_cache: {
      'mat-existing:gbuyer1': {
        materialId: 'mat-existing',
        buyerAddress: 'gbuyer1',
        active: false, // Discrepancy
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  });

  // Execute repairs and capture report
  const report = await runProjectionReconciliation({
    db,
    scope: 'entitlements',
    dryRun: false,
  });

  assert.equal(report.repairedCount, 1);
  assert.equal(report.rollbackSnapshot.length, 1);
  assert.equal(report.rollbackSnapshot[0].existedBefore, true);

  // Verify entitlement projection is now repaired (active: true)
  const repairedDoc = await db.collection('entitlement_cache').findOne({ materialId: 'mat-existing', buyerAddress: 'gbuyer1' });
  assert.equal(repairedDoc.active, true);

  // Now perform rollback
  const rollbackRes = await rollbackProjectionRepairs(db, report.rollbackSnapshot);
  assert.equal(rollbackRes.restoredCount, 1);

  // Verify projection is rolled back to previous state (active: false)
  const rolledBackDoc = await db.collection('entitlement_cache').findOne({ materialId: 'mat-existing', buyerAddress: 'gbuyer1' });
  assert.equal(rolledBackDoc.active, false);
  assert.equal(rolledBackDoc.updatedAt, '2026-01-01T00:00:00.000Z');
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  repairMaterialsWithNoCreator,
  repairPurchasesWithNoEntitlement,
  repairEntitlementsWithNoMaterial,
  runAllOrphanRepairs,
  ORPHAN_TYPE,
} from './orphanRepair.js';
import { RepairAuthorizationError } from './resumableRepairJob.js';

const OPERATOR = 'admin';
const authorize = (actor) => actor === OPERATOR;

function makeDb(collections = {}) {
  const colCache = {};

  function makeCol(docs = [], overrides = {}) {
    return {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(docs),
      })),
      findOne: vi.fn().mockResolvedValue(null),
      replaceOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
      ...overrides,
    };
  }

  return {
    collection: (name) => {
      if (!colCache[name]) {
        colCache[name] = collections[name] ?? makeCol();
      }
      return colCache[name];
    },
  };
}

describe('repairMaterialsWithNoCreator()', () => {
  it('throws RepairAuthorizationError for unauthorized actor', async () => {
    await expect(
      repairMaterialsWithNoCreator({ db: makeDb(), actor: 'rogue', authorize })
    ).rejects.toThrow(RepairAuthorizationError);
  });

  it('marks material as orphaned when no creator field', async () => {
    const materialDoc = { _id: 'm1', title: 'Test', status: 'active' };
    const db = makeDb();

    const materialCol = {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi
          .fn()
          .mockResolvedValueOnce([materialDoc])
          .mockResolvedValue([]),
      })),
      replaceOne: vi.fn().mockResolvedValue({}),
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    db.collection = (name) => {
      if (name === 'materials') return materialCol;
      if (name === 'repair_checkpoints')
        return {
          findOne: vi.fn().mockResolvedValue(null),
          updateOne: vi.fn().mockResolvedValue({}),
        };
      return makeDb().collection(name);
    };

    const result = await repairMaterialsWithNoCreator({
      db,
      actor: OPERATOR,
      authorize,
      dryRun: false,
    });
    expect(result.repaired).toBe(1);
  });

  it('marks material as orphaned when creator profile does not exist', async () => {
    const materialDoc = { _id: 'm2', creator: 'GXORPHAN', status: 'active' };
    const checkpointCol = {
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const profileCol = { findOne: vi.fn().mockResolvedValue(null) };
    const materialCol = {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi
          .fn()
          .mockResolvedValueOnce([materialDoc])
          .mockResolvedValue([]),
      })),
      replaceOne: vi.fn().mockResolvedValue({}),
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
    };

    const db = { collection: (name) => ({ materials: materialCol, profiles: profileCol, repair_checkpoints: checkpointCol }[name] ?? makeDb().collection(name)) };

    const result = await repairMaterialsWithNoCreator({ db, actor: OPERATOR, authorize });
    expect(result.repaired).toBe(1);
  });

  it('dry-run does not call replaceOne', async () => {
    const materialDoc = { _id: 'm3', title: 'No creator', status: 'active' };
    const replaceOne = vi.fn();
    const materialCol = {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValueOnce([materialDoc]).mockResolvedValue([]),
      })),
      replaceOne,
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const profileCol = { findOne: vi.fn().mockResolvedValue(null) };
    const checkCol = { findOne: vi.fn().mockResolvedValue(null), updateOne: vi.fn() };
    const db = { collection: (n) => ({ materials: materialCol, profiles: profileCol, repair_checkpoints: checkCol }[n]) };

    const result = await repairMaterialsWithNoCreator({
      db,
      actor: OPERATOR,
      authorize,
      dryRun: true,
    });

    expect(replaceOne).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.repaired).toBe(0); // dryRun means 0 actual repairs
  });

  it('preserves material that has userAddress and a valid profile', async () => {
    // Regression test for the data-safety defect: materials store ownership in
    // `userAddress`, not `creator`/`creatorAddress`/`ownerAddress`. A material
    // with only `userAddress` set must NOT be orphaned when a matching profile
    // exists.
    const materialDoc = {
      _id: 'material-1',
      userAddress: 'GVALIDCREATOR',
      status: 'published',
    };
    const profileDoc = { address: 'GVALIDCREATOR', name: 'Alice' };
    const checkpointCol = {
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const profileCol = { findOne: vi.fn().mockResolvedValue(profileDoc) };
    const replaceOne = vi.fn();
    const materialCol = {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValueOnce([materialDoc]).mockResolvedValue([]),
      })),
      replaceOne,
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const db = {
      collection: (n) =>
        ({ materials: materialCol, profiles: profileCol, repair_checkpoints: checkpointCol }[n] ??
        makeDb().collection(n)),
    };

    const result = await repairMaterialsWithNoCreator({ db, actor: OPERATOR, authorize });
    // The material is valid — it must NOT be marked orphaned.
    expect(result.repaired).toBe(0);
    expect(replaceOne).not.toHaveBeenCalled();
  });

  it('orphans material with userAddress when profile does not exist', async () => {
    const materialDoc = { _id: 'material-2', userAddress: 'GMISSINGPROFILE', status: 'published' };
    const checkpointCol = {
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const profileCol = { findOne: vi.fn().mockResolvedValue(null) };
    const materialCol = {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValueOnce([materialDoc]).mockResolvedValue([]),
      })),
      replaceOne: vi.fn().mockResolvedValue({}),
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const db = {
      collection: (n) =>
        ({ materials: materialCol, profiles: profileCol, repair_checkpoints: checkpointCol }[n] ??
        makeDb().collection(n)),
    };

    const result = await repairMaterialsWithNoCreator({ db, actor: OPERATOR, authorize });
    expect(result.repaired).toBe(1);
  });

  it('skips already-orphaned materials', async () => {
    const materialDoc = { _id: 'm4', status: 'orphaned' };
    const materialCol = {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      })),
      replaceOne: vi.fn(),
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const checkCol = { findOne: vi.fn().mockResolvedValue(null), updateOne: vi.fn() };
    const db = { collection: (n) => ({ materials: materialCol, repair_checkpoints: checkCol }[n]) };

    const result = await repairMaterialsWithNoCreator({ db, actor: OPERATOR, authorize });
    expect(result.processed).toBe(0);
  });
});

describe('repairPurchasesWithNoEntitlement()', () => {
  it('throws for unauthorized actor', async () => {
    await expect(
      repairPurchasesWithNoEntitlement({ db: makeDb(), actor: 'nobody', authorize })
    ).rejects.toThrow(RepairAuthorizationError);
  });

  it('marks purchase when entitlement is missing', async () => {
    const purchase = { _id: 'p1', txHash: '0xabc', status: 'completed' };
    const checkCol = { findOne: vi.fn().mockResolvedValue(null), updateOne: vi.fn() };
    const purchaseCol = {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValueOnce([purchase]).mockResolvedValue([]),
      })),
      replaceOne: vi.fn().mockResolvedValue({}),
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const entitlementCol = { findOne: vi.fn().mockResolvedValue(null) };
    const db = { collection: (n) => ({ purchases: purchaseCol, entitlements: entitlementCol, repair_checkpoints: checkCol }[n]) };

    const result = await repairPurchasesWithNoEntitlement({ db, actor: OPERATOR, authorize });
    expect(result.repaired).toBe(1);
  });

  it('leaves purchase untouched when entitlement exists', async () => {
    const purchase = { _id: 'p2', status: 'completed' };
    const checkCol = { findOne: vi.fn().mockResolvedValue(null), updateOne: vi.fn() };
    const purchaseCol = {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValueOnce([purchase]).mockResolvedValue([]),
      })),
      replaceOne: vi.fn(),
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const entitlementCol = { findOne: vi.fn().mockResolvedValue({ _id: 'e1', purchaseId: 'p2' }) };
    const db = { collection: (n) => ({ purchases: purchaseCol, entitlements: entitlementCol, repair_checkpoints: checkCol }[n]) };

    const result = await repairPurchasesWithNoEntitlement({ db, actor: OPERATOR, authorize });
    expect(result.repaired).toBe(0);
  });
});

describe('repairEntitlementsWithNoMaterial()', () => {
  it('throws for unauthorized actor', async () => {
    await expect(
      repairEntitlementsWithNoMaterial({ db: makeDb(), actor: 'rogue', authorize })
    ).rejects.toThrow(RepairAuthorizationError);
  });

  it('marks entitlement when materialId missing', async () => {
    const entitlement = { _id: 'e1', buyerAddress: 'GX', status: 'ACTIVE' };
    const checkCol = { findOne: vi.fn().mockResolvedValue(null), updateOne: vi.fn() };
    const entitlementCol = {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValueOnce([entitlement]).mockResolvedValue([]),
      })),
      replaceOne: vi.fn().mockResolvedValue({}),
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const db = { collection: (n) => ({ entitlements: entitlementCol, repair_checkpoints: checkCol }[n]) };

    const result = await repairEntitlementsWithNoMaterial({ db, actor: OPERATOR, authorize });
    expect(result.repaired).toBe(1);
  });
});

describe('runAllOrphanRepairs()', () => {
  it('runs all three repair types and returns summary', async () => {
    const checkCol = { findOne: vi.fn().mockResolvedValue(null), updateOne: vi.fn() };
    const emptyCol = {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      })),
      replaceOne: vi.fn(),
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const db = { collection: () => ({ ...emptyCol, findOne: vi.fn().mockResolvedValue(null), updateOne: vi.fn() }) };

    const { results, summary } = await runAllOrphanRepairs({ db, actor: OPERATOR, authorize });

    expect(Object.keys(results)).toContain(ORPHAN_TYPE.MATERIAL_NO_CREATOR);
    expect(Object.keys(results)).toContain(ORPHAN_TYPE.PURCHASE_NO_ENTITLEMENT);
    expect(Object.keys(results)).toContain(ORPHAN_TYPE.ENTITLEMENT_NO_MATERIAL);
    expect(typeof summary.scanned).toBe('number');
    expect(typeof summary.repaired).toBe('number');
  });

  it('propagates dryRun flag', async () => {
    const checkCol = { findOne: vi.fn().mockResolvedValue(null), updateOne: vi.fn() };
    const col = {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      })),
      countDocuments: vi.fn().mockResolvedValue(0),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const db = { collection: () => ({ ...col, findOne: vi.fn().mockResolvedValue(null) }) };

    const { summary } = await runAllOrphanRepairs({ db, actor: OPERATOR, authorize, dryRun: true });
    expect(summary.dryRun).toBe(true);
  });
});

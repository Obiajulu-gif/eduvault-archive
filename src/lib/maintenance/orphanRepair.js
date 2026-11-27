/**
 * Orphan-repair library — Issue #1121
 *
 * Detects and repairs orphaned records in the EduVault database:
 * - Materials without a valid creator/owner profile
 * - Purchases without a corresponding entitlement record
 * - Entitlements that reference non-existent materials
 * - Download-access records for revoked/non-existent entitlements
 *
 * All repair operations are resumable via MongoDB checkpoints. The job is
 * designed so that the same job ID can be re-run after interruption and will
 * continue from where it left off, never re-processing already-handled docs.
 *
 * Authorization is required: only an operator-approved actor may run repairs.
 */

import { runResumableRepair } from './resumableRepairJob.js';

export const ORPHAN_TYPE = Object.freeze({
  MATERIAL_NO_CREATOR: 'material_no_creator',
  PURCHASE_NO_ENTITLEMENT: 'purchase_no_entitlement',
  ENTITLEMENT_NO_MATERIAL: 'entitlement_no_material',
  ACCESS_NO_ENTITLEMENT: 'access_no_entitlement',
});

export class OrphanRepairAuthorizationError extends Error {
  constructor() {
    super('An authorized operator is required to run an orphan-repair job');
    this.name = 'OrphanRepairAuthorizationError';
    this.status = 403;
  }
}

/**
 * Finds materials that have no creator profile in the profiles collection.
 *
 * Repair action: marks the material as `status: 'orphaned'` and records the
 * discovery timestamp so an admin can manually reassign ownership.
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {string} opts.actor
 * @param {Function} opts.authorize
 * @param {boolean} [opts.dryRun=false]
 * @param {string} [opts.jobId]
 * @param {number} [opts.batchSize=100]
 * @returns {Promise<object>}
 */
export async function repairMaterialsWithNoCreator({
  db,
  actor,
  authorize,
  dryRun = false,
  jobId,
  batchSize = 100,
  now = () => new Date(),
} = {}) {
  const resolvedJobId = jobId ?? `orphan-material-no-creator-${Date.now()}`;

  async function repair(material) {
    // Materials store ownership in `userAddress` (the material-delete route and
    // schema-compatibility matrix use this field). The legacy aliases
    // `creator`, `creatorAddress`, and `ownerAddress` are checked as fallbacks
    // for older records, but `userAddress` must be included so that a material
    // with only that field is not falsely classified as ownerless.
    const creatorAddr =
      material.creator ??
      material.creatorAddress ??
      material.ownerAddress ??
      material.userAddress;

    if (!creatorAddr) {
      return {
        changed: true,
        reason: 'missing_creator_field',
        document: {
          ...material,
          status: 'orphaned',
          orphanedAt: now().toISOString(),
          orphanReason: 'no_creator_field',
          previousStatus: material.status ?? null,
        },
      };
    }

    const profile = await db.collection('profiles').findOne({ address: creatorAddr });
    if (!profile) {
      return {
        changed: true,
        reason: 'creator_profile_missing',
        document: {
          ...material,
          status: 'orphaned',
          orphanedAt: now().toISOString(),
          orphanReason: `profile_not_found:${creatorAddr}`,
          previousStatus: material.status ?? null,
        },
      };
    }

    return { changed: false };
  }

  return runResumableRepair({
    db,
    collectionName: 'materials',
    jobId: resolvedJobId,
    query: { status: { $nin: ['orphaned', 'deleted'] } },
    repair,
    authorize,
    actor,
    dryRun,
    batchSize,
    now,
  });
}

/**
 * Finds purchases that have no corresponding entitlement record.
 *
 * Repair action: marks the purchase as `status: 'entitlement_missing'`.
 * Does not create entitlements automatically to avoid duplicating purchases.
 *
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function repairPurchasesWithNoEntitlement({
  db,
  actor,
  authorize,
  dryRun = false,
  jobId,
  batchSize = 100,
  now = () => new Date(),
} = {}) {
  const resolvedJobId = jobId ?? `orphan-purchase-no-entitlement-${Date.now()}`;

  async function repair(purchase) {
    const entitlement = await db.collection('entitlements').findOne({
      $or: [
        { purchaseId: purchase._id?.toString() },
        { purchaseId: String(purchase._id) },
        { txHash: purchase.txHash },
      ].filter(Boolean),
    });

    if (!entitlement) {
      return {
        changed: true,
        reason: 'entitlement_not_found',
        document: {
          ...purchase,
          status: 'entitlement_missing',
          orphanedAt: now().toISOString(),
          previousStatus: purchase.status ?? null,
        },
      };
    }

    return { changed: false };
  }

  return runResumableRepair({
    db,
    collectionName: 'purchases',
    jobId: resolvedJobId,
    query: { status: { $nin: ['entitlement_missing', 'refunded', 'cancelled'] } },
    repair,
    authorize,
    actor,
    dryRun,
    batchSize,
    now,
  });
}

/**
 * Finds entitlements that reference materials which no longer exist.
 *
 * Repair action: marks the entitlement as `status: 'MATERIAL_MISSING'`.
 *
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function repairEntitlementsWithNoMaterial({
  db,
  actor,
  authorize,
  dryRun = false,
  jobId,
  batchSize = 100,
  now = () => new Date(),
} = {}) {
  const resolvedJobId = jobId ?? `orphan-entitlement-no-material-${Date.now()}`;

  async function repair(entitlement) {
    const materialId = entitlement.materialId ?? entitlement.resourceId;
    if (!materialId) {
      return {
        changed: true,
        reason: 'missing_material_reference',
        document: {
          ...entitlement,
          status: 'MATERIAL_MISSING',
          orphanedAt: now().toISOString(),
          previousStatus: entitlement.status ?? null,
        },
      };
    }

    const { ObjectId } = await import('mongodb');
    let oidQuery;
    try {
      oidQuery = { _id: new ObjectId(materialId) };
    } catch {
      oidQuery = { _id: materialId };
    }

    const material = await db.collection('materials').findOne(oidQuery);
    if (!material) {
      return {
        changed: true,
        reason: 'material_not_found',
        document: {
          ...entitlement,
          status: 'MATERIAL_MISSING',
          orphanedAt: now().toISOString(),
          orphanReason: `material_id:${materialId}`,
          previousStatus: entitlement.status ?? null,
        },
      };
    }

    return { changed: false };
  }

  return runResumableRepair({
    db,
    collectionName: 'entitlements',
    jobId: resolvedJobId,
    query: { status: { $nin: ['MATERIAL_MISSING', 'REVOKED', 'REFUNDED'] } },
    repair,
    authorize,
    actor,
    dryRun,
    batchSize,
    now,
  });
}

/**
 * Runs all orphan-repair jobs sequentially and aggregates results.
 *
 * @param {object} opts
 * @returns {Promise<{ results: object, summary: { scanned: number, repaired: number } }>}
 */
export async function runAllOrphanRepairs({
  db,
  actor,
  authorize,
  dryRun = false,
  batchSize = 100,
  jobIdPrefix,
  now = () => new Date(),
} = {}) {
  const prefix = jobIdPrefix ?? `orphan-repair-${Date.now()}`;

  const jobs = [
    {
      type: ORPHAN_TYPE.MATERIAL_NO_CREATOR,
      fn: repairMaterialsWithNoCreator,
      jobId: `${prefix}-materials`,
    },
    {
      type: ORPHAN_TYPE.PURCHASE_NO_ENTITLEMENT,
      fn: repairPurchasesWithNoEntitlement,
      jobId: `${prefix}-purchases`,
    },
    {
      type: ORPHAN_TYPE.ENTITLEMENT_NO_MATERIAL,
      fn: repairEntitlementsWithNoMaterial,
      jobId: `${prefix}-entitlements`,
    },
  ];

  const results = {};
  let totalScanned = 0;
  let totalRepaired = 0;

  for (const { type, fn, jobId } of jobs) {
    const result = await fn({ db, actor, authorize, dryRun, jobId, batchSize, now });
    results[type] = result;
    totalScanned += result.processed ?? 0;
    totalRepaired += result.repaired ?? 0;
  }

  return {
    results,
    summary: { scanned: totalScanned, repaired: totalRepaired, dryRun },
  };
}

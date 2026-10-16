/**
 * Zero-Downtime Catalog Schema Migration Framework
 *
 * Implements Issue #746:
 * Provides versioned-document pattern (schemaVersion), dual-read / dual-write adapters,
 * and an idempotent, resumable batched backfill runner with documented rollback capabilities.
 */

export const CURRENT_CATALOG_VERSION = 2;

/**
 * Migration Definition: v2
 * Adds Soroban entitlement rights metadata and standardized pricing tiers.
 */
export const migrationV2 = {
  version: 2,
  name: 'v2_soroban_entitlements_and_pricing_tiers',
  up: (doc) => {
    const price = Number(doc.price ?? 0);
    const pricingTier = price === 0 ? 'free' : price < 15 ? 'standard' : 'premium';

    return {
      ...doc,
      schemaVersion: 2,
      pricingTier,
      sorobanEntitlementConfig: {
        contractId: doc.contractId || doc.stellarContractId || null,
        tokenStandard: 'SEP-0041',
        transferrable: doc.transferrable !== false,
      },
      rightsMetadata: {
        commercialUse: false,
        educationalOnly: true,
        distributionAllowed: false,
        ...(doc.rightsMetadata || {}),
      },
    };
  },
  down: (doc) => {
    const copy = { ...doc };
    delete copy.pricingTier;
    delete copy.sorobanEntitlementConfig;
    delete copy.rightsMetadata;
    copy.schemaVersion = 1;
    return copy;
  },
  validate: (doc) => {
    return (
      doc &&
      doc.schemaVersion === 2 &&
      typeof doc.pricingTier === 'string' &&
      typeof doc.sorobanEntitlementConfig === 'object'
    );
  },
};

export const CATALOG_MIGRATIONS = {
  2: migrationV2,
};

/**
 * Dual-Read Adapter:
 * Reads a catalog document and dynamically transforms legacy (v1 or unversioned)
 * documents to current schema shape in-memory on the fly.
 * Guarantees zero downtime while background backfills are in-flight.
 */
export function readCatalogMaterial(doc) {
  if (!doc) return doc;

  const version = doc.schemaVersion || 1;
  if (version >= CURRENT_CATALOG_VERSION) {
    return doc;
  }

  // Apply sequential in-memory upgrades if needed
  let upgraded = { ...doc };
  for (let v = version + 1; v <= CURRENT_CATALOG_VERSION; v++) {
    const migration = CATALOG_MIGRATIONS[v];
    if (migration?.up) {
      upgraded = migration.up(upgraded);
    }
  }

  return upgraded;
}

/**
 * Dual-Write Helper:
 * Prepares new listings and updates during transition windows.
 * Writes current schema version while retaining legacy fields.
 */
export function prepareCatalogWrite(doc) {
  if (!doc) return doc;
  const migration = CATALOG_MIGRATIONS[CURRENT_CATALOG_VERSION];
  return migration?.up ? migration.up(doc) : { ...doc, schemaVersion: CURRENT_CATALOG_VERSION };
}

/**
 * Run idempotent, resumable catalog schema migration in batches.
 *
 * @param {import('mongodb').Db} db - Connected MongoDB instance
 * @param {object} migrationDef - Migration specification (e.g. migrationV2)
 * @param {object} [options]
 * @param {number} [options.batchSize=100] - Documents per batch
 * @param {boolean} [options.dryRun=false] - Preview mode without writes
 * @param {boolean} [options.rollback=false] - Revert migration changes
 * @param {number} [options.maxBatches] - Optional batch limit for testing interruptions
 * @param {string} [options.checkpointCollection='migration_checkpoints']
 * @returns {Promise<object>} Execution summary
 */
export async function runCatalogMigration(db, migrationDef = migrationV2, options = {}) {
  const batchSize = Math.max(1, Number(options.batchSize || 100));
  const dryRun = options.dryRun === true;
  const rollback = options.rollback === true;
  const maxBatches = options.maxBatches ? Number(options.maxBatches) : Infinity;
  const checkpointCollectionName = options.checkpointCollection || 'migration_checkpoints';

  const materials = db.collection('materials');
  const checkpoints = db.collection(checkpointCollectionName);
  const checkpointId = `catalog_migration_v${migrationDef.version}`;

  // ── Rollback execution ──
  if (rollback) {
    if (dryRun) {
      const count = await materials.countDocuments({ schemaVersion: migrationDef.version });
      return { dryRun: true, rollback: true, documentsToRollback: count };
    }

    const cursor = materials.find({ schemaVersion: migrationDef.version });
    let rollbackCount = 0;
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      const reverted = migrationDef.down(doc);
      await materials.replaceOne({ _id: doc._id }, reverted);
      rollbackCount++;
    }

    await checkpoints.deleteOne({ _id: checkpointId });
    return { rollback: true, completed: true, rolledBackCount: rollbackCount };
  }

  // ── Checkpoint & Resumption ──
  const checkpoint = await checkpoints.findOne({ _id: checkpointId });
  let lastProcessedId = checkpoint?.lastProcessedId || null;
  let totalProcessed = checkpoint?.processedCount || 0;
  let totalModified = checkpoint?.modifiedCount || 0;

  const sampleDiffs = [];
  let batchCounter = 0;
  let isInterrupted = false;

  while (batchCounter < maxBatches) {
    batchCounter++;

    // Query for unmigrated documents ordered by _id
    const query = {
      $or: [
        { schemaVersion: { $lt: migrationDef.version } },
        { schemaVersion: { $exists: false } },
      ],
    };

    if (lastProcessedId) {
      query._id = { $gt: lastProcessedId };
    }

    const docs = await materials
      .find(query)
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();

    if (docs.length === 0) {
      break;
    }

    for (const doc of docs) {
      lastProcessedId = doc._id;
      totalProcessed++;

      const upgraded = migrationDef.up(doc);

      if (dryRun) {
        if (sampleDiffs.length < 5) {
          sampleDiffs.push({
            id: String(doc._id),
            before: { schemaVersion: doc.schemaVersion, price: doc.price },
            after: { schemaVersion: upgraded.schemaVersion, pricingTier: upgraded.pricingTier },
          });
        }
      } else {
        await materials.replaceOne({ _id: doc._id }, upgraded);
        totalModified++;
      }
    }

    // Save batch progress checkpoint
    if (!dryRun) {
      await checkpoints.updateOne(
        { _id: checkpointId },
        {
          $set: {
            lastProcessedId: String(lastProcessedId),
            processedCount: totalProcessed,
            modifiedCount: totalModified,
            completed: false,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
    }
  }

  const remaining = await materials.countDocuments({
    $or: [
      { schemaVersion: { $lt: migrationDef.version } },
      { schemaVersion: { $exists: false } },
    ],
  });

  const completed = remaining === 0;

  if (!dryRun && completed) {
    await checkpoints.updateOne(
      { _id: checkpointId },
      {
        $set: {
          lastProcessedId: String(lastProcessedId),
          processedCount: totalProcessed,
          modifiedCount: totalModified,
          completed: true,
          completedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  return {
    dryRun,
    rollback: false,
    version: migrationDef.version,
    processedCount: totalProcessed,
    modifiedCount: dryRun ? 0 : totalModified,
    completed,
    remainingUnmigrated: remaining,
    sampleDiffs: dryRun ? sampleDiffs : undefined,
  };
}

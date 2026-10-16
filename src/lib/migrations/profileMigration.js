/**
 * Creator Profile Migration Framework
 *
 * Implements Issue #747:
 * Idempotent, resumable batch migration for creator profile documents.
 * Enables dual-wallet architecture (Stellar + EVM) alongside legacy single-wallet fields.
 * Includes read-path fallbacks to guarantee uninterrupted login and onboarding.
 */

let ObjectId;
try {
  const mongodb = await import('mongodb');
  ObjectId = mongodb.ObjectId;
} catch {
  ObjectId = class MockObjectId {
    constructor(id) {
      this.id = id;
    }
    toString() {
      return String(this.id);
    }
  };
}

export const CHECKPOINT_ID = 'creator_profile_wallet_schema_v2';

/**
 * Generates MongoDB query that matches any wallet representation (EVM or Stellar).
 * Guarantees login/onboarding works for unmigrated, in-flight, or migrated profiles.
 */
export function buildWalletLookupQuery(address) {
  if (!address || typeof address !== 'string') {
    return { walletAddress: null };
  }

  const trimmed = address.trim();
  const lower = trimmed.toLowerCase();

  return {
    $or: [
      { walletAddress: trimmed },
      { walletAddressLower: lower },
      { stellarWalletAddress: trimmed },
      { evmWalletAddress: lower },
      { 'wallets.stellar': trimmed },
      { 'wallets.evm': lower },
    ],
  };
}

/**
 * Normalizes user profile data for session context and API consumption.
 * Ensures caller code always finds expected wallet fields regardless of schema version.
 */
export function normalizeProfileForSession(user) {
  if (!user) return user;

  const primaryAddress = user.walletAddress || user.stellarWalletAddress || user.evmWalletAddress || user.wallets?.stellar || user.wallets?.evm || '';
  const isStellar = /^G[A-Z0-9]{55}$/.test(primaryAddress);
  const isEvm = /^0x[a-fA-F0-9]{40}$/.test(primaryAddress);

  const stellarAddress = user.stellarWalletAddress || user.wallets?.stellar || (isStellar ? primaryAddress : null);
  const evmAddress = user.evmWalletAddress || user.wallets?.evm || (isEvm ? primaryAddress.toLowerCase() : null);

  return {
    ...user,
    walletAddress: primaryAddress,
    walletAddressLower: primaryAddress.toLowerCase(),
    stellarWalletAddress: stellarAddress,
    evmWalletAddress: evmAddress,
    wallets: {
      stellar: stellarAddress,
      evm: evmAddress,
      ...(user.wallets || {}),
    },
    schemaVersion: user.schemaVersion || 1,
  };
}

/**
 * Run idempotent, resumable profile migration in batches.
 *
 * @param {import('mongodb').Db} db
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - Dry run without writing
 * @param {boolean} [options.rollback=false] - Revert migration changes
 * @param {number} [options.batchSize=50] - Number of records per batch
 * @param {string} [options.checkpointCollection='migration_checkpoints']
 * @returns {Promise<object>} Migration run summary
 */
export async function runProfileMigration(db, options = {}) {
  const dryRun = options.dryRun === true;
  const rollback = options.rollback === true;
  const batchSize = Math.max(1, Number(options.batchSize || 50));
  const checkpointCollectionName = options.checkpointCollection || 'migration_checkpoints';

  const usersCollection = db.collection('users');
  const checkpointsCollection = db.collection(checkpointCollectionName);

  // Handle Rollback
  if (rollback) {
    if (dryRun) {
      const rollbackCount = await usersCollection.countDocuments({ schemaVersion: 2 });
      return { dryRun: true, rollback: true, documentsToRollback: rollbackCount };
    }

    const result = await usersCollection.updateMany(
      { schemaVersion: 2 },
      {
        $unset: {
          stellarWalletAddress: '',
          evmWalletAddress: '',
          wallets: '',
          schemaVersion: '',
        },
      }
    );

    await checkpointsCollection.deleteOne({ _id: CHECKPOINT_ID });

    return {
      rollback: true,
      modifiedCount: result.modifiedCount,
      completed: true,
    };
  }

  // Load Checkpoint
  let checkpoint = await checkpointsCollection.findOne({ _id: CHECKPOINT_ID });
  let lastProcessedId = checkpoint?.lastProcessedId ? new ObjectId(checkpoint.lastProcessedId) : null;
  let processedCount = checkpoint?.processedCount || 0;

  const query = lastProcessedId ? { _id: { $gt: lastProcessedId } } : {};
  const totalEligible = await usersCollection.countDocuments(query);

  let batchProcessed = 0;
  let batchModified = 0;
  const sampleDiffs = [];

  while (true) {
    const batchQuery = lastProcessedId ? { _id: { $gt: lastProcessedId } } : {};
    const cursor = usersCollection.find(batchQuery).sort({ _id: 1 }).limit(batchSize);
    const docs = await cursor.toArray();

    if (docs.length === 0) {
      break;
    }

    for (const doc of docs) {
      lastProcessedId = doc._id;
      batchProcessed++;

      const normalized = normalizeProfileForSession(doc);
      const updateFields = {
        stellarWalletAddress: normalized.stellarWalletAddress,
        evmWalletAddress: normalized.evmWalletAddress,
        wallets: normalized.wallets,
        schemaVersion: 2,
      };

      if (dryRun) {
        if (sampleDiffs.length < 5) {
          sampleDiffs.push({
            id: String(doc._id),
            before: { walletAddress: doc.walletAddress, schemaVersion: doc.schemaVersion },
            after: updateFields,
          });
        }
      } else {
        await usersCollection.updateOne({ _id: doc._id }, { $set: updateFields });
        batchModified++;
      }
    }

    processedCount += docs.length;

    // Update checkpoint
    if (!dryRun) {
      await checkpointsCollection.updateOne(
        { _id: CHECKPOINT_ID },
        {
          $set: {
            lastProcessedId: String(lastProcessedId),
            processedCount,
            completed: false,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
    }
  }

  const isCompleted = true;
  if (!dryRun) {
    await checkpointsCollection.updateOne(
      { _id: CHECKPOINT_ID },
      {
        $set: {
          lastProcessedId: lastProcessedId ? String(lastProcessedId) : null,
          processedCount,
          completed: isCompleted,
          completedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  return {
    dryRun,
    rollback: false,
    processedCount,
    modifiedCount: dryRun ? 0 : batchModified,
    completed: isCompleted,
    sampleDiffs: dryRun ? sampleDiffs : undefined,
  };
}

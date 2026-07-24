import process from "node:process";

import {
  COLLECTION_VALIDATORS,
  COLLECTIONS,
  REQUIRED_INDEXES,
} from "../schemaContracts.js";
import {
  normalizeLegacyPayoutMilestones,
  sumMilestoneAmounts,
} from "../../milestones/normalization.js";

const BATCH_SIZE = Number.parseInt(
  process.env.MILESTONE_BACKFILL_BATCH_SIZE || "100",
  10,
);

const MIGRATION_VERSION = 4;

async function ensureIndexes(db) {
  for (const collectionName of [
    COLLECTIONS.milestones,
    COLLECTIONS.milestoneEvidence,
    COLLECTIONS.milestoneTransitions,
    COLLECTIONS.milestoneMigrationExceptions,
  ]) {
    const definitions = REQUIRED_INDEXES[collectionName] || [];
    if (definitions.length === 0) continue;

    await db.collection(collectionName).createIndexes(
      definitions.map((definition) => ({
        key: definition.keys,
        name: definition.name,
        ...definition.options,
      })),
    );
  }
}

async function ensureCollections(db) {
  for (const collectionName of [
    COLLECTIONS.milestoneEvidence,
    COLLECTIONS.milestoneTransitions,
    COLLECTIONS.milestoneMigrationExceptions,
  ]) {
    const exists = await db
      .listCollections({ name: collectionName }, { nameOnly: true })
      .toArray();

    if (exists.length === 0) {
      await db.createCollection(collectionName);
    }

    const validator = COLLECTION_VALIDATORS[collectionName];
    if (validator) {
      await db.command({
        collMod: collectionName,
        validator,
        validationLevel: "moderate",
        validationAction: "error",
      });
    }
  }
}

async function writeException(collection, { payoutId, exception, now }) {
  const milestoneIndex = exception.milestoneIndex ?? null;
  await collection.updateOne(
    {
      exceptionId: `${MIGRATION_VERSION}:${payoutId}:${milestoneIndex ?? "payload"}:${exception.reason}`,
    },
    {
      $setOnInsert: {
        exceptionId: `${MIGRATION_VERSION}:${payoutId}:${milestoneIndex ?? "payload"}:${exception.reason}`,
        migrationVersion: MIGRATION_VERSION,
        payoutId,
        milestoneIndex,
        reason: exception.reason,
        rawValue: exception.rawValue,
        createdAt: now,
      },
    },
    {
      upsert: true,
    },
  );
}

async function backfillPayout({ db, payout, now }) {
  const normalized = normalizeLegacyPayoutMilestones(payout, {
    now,
  });

  const milestones = db.collection(COLLECTIONS.milestones);
  const evidence = db.collection(COLLECTIONS.milestoneEvidence);
  const transitions = db.collection(COLLECTIONS.milestoneTransitions);
  const exceptions = db.collection(COLLECTIONS.milestoneMigrationExceptions);

  for (const milestone of normalized.milestones) {
    await milestones.updateOne(
      {
        milestoneId: milestone.milestoneId,
      },
      {
        $set: {
          ...milestone,
          migrationVersion: MIGRATION_VERSION,
          migratedFromLegacyJson: true,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: milestone.createdAt || now,
        },
      },
      {
        upsert: true,
      },
    );

    await transitions.updateOne(
      {
        transitionId: `${milestone.milestoneId}:migration:${MIGRATION_VERSION}`,
      },
      {
        $setOnInsert: {
          transitionId: `${milestone.milestoneId}:migration:${MIGRATION_VERSION}`,
          milestoneId: milestone.milestoneId,
          payoutId: normalized.payoutId,
          fromStatus: null,
          toStatus: milestone.status,
          actorId: null,
          reason: "legacy-json-backfill",
          source: "migration",
          createdAt: now,
        },
      },
      {
        upsert: true,
      },
    );
  }

  for (const item of normalized.evidence) {
    await evidence.updateOne(
      {
        evidenceId: item.evidenceId,
      },
      {
        $setOnInsert: item,
      },
      {
        upsert: true,
      },
    );
  }

  for (const exception of normalized.exceptions) {
    await writeException(exceptions, {
      payoutId: normalized.payoutId,
      exception,
      now,
    });
  }

  const amountTotal = sumMilestoneAmounts(normalized.milestones);
  const payoutAmount = payout.amount == null ? null : Number(payout.amount);
  if (
    payoutAmount != null &&
    Number.isFinite(payoutAmount) &&
    normalized.milestones.length > 0 &&
    amountTotal !== payoutAmount
  ) {
    await writeException(exceptions, {
      payoutId: normalized.payoutId,
      exception: {
        milestoneIndex: null,
        reason: "amount_total_mismatch",
        rawValue: {
          payoutAmount: payout.amount,
          milestoneAmountTotal: String(amountTotal),
        },
      },
      now,
    });
  }

  await db.collection(COLLECTIONS.payouts).updateOne(
    {
      _id: payout._id,
    },
    {
      $set: {
        milestoneBackfill: {
          migrationVersion: MIGRATION_VERSION,
          sourceCount: normalized.sourceCount,
          targetCount: normalized.milestones.length,
          evidenceCount: normalized.evidence.length,
          exceptionCount: normalized.exceptions.length,
          amountTotal: String(amountTotal),
          completedAt: now,
        },
        updatedAt: payout.updatedAt || now,
      },
    },
  );

  return normalized;
}

async function verifyBackfill(db) {
  const payouts = db.collection(COLLECTIONS.payouts);
  const milestones = db.collection(COLLECTIONS.milestones);

  const source = await payouts
    .find({
      milestones: {
        $exists: true,
      },
    })
    .toArray();

  let sourcePayloadCount = 0;
  let sourceMigratableCount = 0;
  let targetCount = 0;
  let sourceAmountTotal = 0;
  let targetAmountTotal = 0;

  for (const payout of source) {
    const normalized = normalizeLegacyPayoutMilestones(payout);
    sourcePayloadCount += normalized.sourceCount;
    sourceMigratableCount += normalized.milestones.length;
    sourceAmountTotal += sumMilestoneAmounts(normalized.milestones);

    const rows = await milestones
      .find({
        payoutId: String(payout.payoutId || payout._id),
      })
      .toArray();

    targetCount += rows.length;
    targetAmountTotal += sumMilestoneAmounts(rows);
  }

  return {
    payoutCount: source.length,
    sourcePayloadCount,
    sourceMigratableCount,
    targetCount,
    sourceAmountTotal: String(sourceAmountTotal),
    targetAmountTotal: String(targetAmountTotal),
  };
}

const migration = {
  version: MIGRATION_VERSION,
  name: "normalize-payout-milestones",
  description:
    "Expands legacy payouts.milestones JSON into resumable milestone, evidence, and transition collections.",

  async up({
    db,
    logger = console,
    getCheckpoint,
    saveCheckpoint,
    clearCheckpoint,
  }) {
    await ensureCollections(db);
    await ensureIndexes(db);

    const checkpoint = (await getCheckpoint()) || {};
    const payouts = db.collection(COLLECTIONS.payouts);
    let processed = checkpoint.processed || 0;
    let lastId = checkpoint.lastId || null;

    while (true) {
      const filter = {
        milestones: {
          $exists: true,
        },
      };

      if (lastId) {
        filter._id = {
          $gt: lastId,
        };
      }

      const batch = await payouts
        .find(filter)
        .sort({
          _id: 1,
        })
        .limit(BATCH_SIZE)
        .toArray();

      if (batch.length === 0) break;

      for (const payout of batch) {
        const now = new Date();
        const normalized = await backfillPayout({
          db,
          payout,
          now,
        });

        processed += 1;
        lastId = payout._id;

        logger.info?.("[migration:004] Payout milestones backfilled", {
          payoutId: normalized.payoutId,
          sourceCount: normalized.sourceCount,
          targetCount: normalized.milestones.length,
          exceptionCount: normalized.exceptions.length,
        });
      }

      await saveCheckpoint({
        phase: "backfill",
        processed,
        lastId,
        updatedAt: new Date(),
      });
    }

    const verification = await verifyBackfill(db);

    await saveCheckpoint({
      phase: "verify",
      processed,
      verification,
      updatedAt: new Date(),
    });

    if (
      verification.sourceMigratableCount !== verification.targetCount ||
      verification.sourceAmountTotal !== verification.targetAmountTotal
    ) {
      throw new Error(
        `Milestone backfill verification failed: ${JSON.stringify(verification)}`,
      );
    }

    await clearCheckpoint();

    logger.info?.("[migration:004] Milestone backfill verified", verification);
  },

  async down({ db, logger = console }) {
    const milestones = db.collection(COLLECTIONS.milestones);
    const milestoneRows = await milestones
      .find({
        migrationVersion: MIGRATION_VERSION,
        migratedFromLegacyJson: true,
      })
      .toArray();

    for (const milestone of milestoneRows) {
      await db.collection(COLLECTIONS.milestoneEvidence).deleteMany({
        milestoneId: milestone.milestoneId,
      });
      await db.collection(COLLECTIONS.milestoneTransitions).deleteMany({
        milestoneId: milestone.milestoneId,
      });
      await milestones.deleteOne({
        milestoneId: milestone.milestoneId,
      });
    }

    await db.collection(COLLECTIONS.milestoneMigrationExceptions).deleteMany({
      migrationVersion: MIGRATION_VERSION,
    });

    await db.collection(COLLECTIONS.payouts).updateMany(
      {
        "milestoneBackfill.migrationVersion": MIGRATION_VERSION,
      },
      {
        $unset: {
          milestoneBackfill: "",
        },
      },
    );

    logger.info?.("[migration:004] Normalized milestone rows removed", {
      deletedMilestones: milestoneRows.length,
    });
  },
};

export default migration;

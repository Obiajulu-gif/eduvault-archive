import process from "node:process";

import {
  COLLECTIONS,
  REQUIRED_INDEXES,
} from "../schemaContracts.js";

const CONFLICT_COLLECTION =
  COLLECTIONS.migrationConflicts || "_migration_conflicts";

const DUPLICATE_BATCH_SIZE = Number.parseInt(
  process.env.MIGRATION_DUPLICATE_BATCH_SIZE || "100",
  10,
);

function isMigrationInfrastructureCollection(collectionName) {
  return [
    COLLECTIONS.schemaMigrations,
    COLLECTIONS.migrationLock,
    COLLECTIONS.migrationConflicts,
  ].includes(collectionName);
}

function buildPartialMatch(indexDefinition) {
  const partialFilter =
    indexDefinition.options?.partialFilterExpression;

  if (partialFilter) {
    return partialFilter;
  }

  const keys = Object.keys(indexDefinition.keys);

  return {
    $and: keys.map((key) => ({
      [key]: {
        $exists: true,
        $ne: null,
      },
    })),
  };
}

function buildGroupId(indexDefinition) {
  return Object.fromEntries(
    Object.keys(indexDefinition.keys).map((key) => [
      key,
      `$${key}`,
    ]),
  );
}

function buildDuplicatePipeline(indexDefinition) {
  return [
    {
      $match: buildPartialMatch(indexDefinition),
    },
    {
      $group: {
        _id: buildGroupId(indexDefinition),
        documentIds: {
          $push: "$_id",
        },
        count: {
          $sum: 1,
        },
      },
    },
    {
      $match: {
        count: {
          $gt: 1,
        },
      },
    },
    {
      $sort: {
        _id: 1,
      },
    },
  ];
}

function toTimestamp(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (
    typeof value === "string" ||
    typeof value === "number"
  ) {
    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return date.getTime();
    }
  }

  return 0;
}

function selectCanonicalDocument(documents) {
  if (documents.length === 0) {
    return null;
  }

  return [...documents].sort((left, right) => {
    const updatedDifference =
      toTimestamp(right.updatedAt) -
      toTimestamp(left.updatedAt);

    if (updatedDifference !== 0) {
      return updatedDifference;
    }

    const createdDifference =
      toTimestamp(right.createdAt) -
      toTimestamp(left.createdAt);

    if (createdDifference !== 0) {
      return createdDifference;
    }

    return String(left._id).localeCompare(
      String(right._id),
    );
  })[0];
}

async function ensureConflictCollection(db) {
  const existing = await db
    .listCollections(
      {
        name: CONFLICT_COLLECTION,
      },
      {
        nameOnly: true,
      },
    )
    .toArray();

  if (existing.length === 0) {
    await db.createCollection(CONFLICT_COLLECTION);
  }

  const collection = db.collection(CONFLICT_COLLECTION);

  await collection.createIndex(
    {
      migrationVersion: 1,
      sourceCollection: 1,
      sourceId: 1,
      indexName: 1,
    },
    {
      name: "migration_conflicts_source_unique",
      unique: true,
    },
  );

  await collection.createIndex(
    {
      migrationVersion: 1,
      archivedAt: -1,
    },
    {
      name: "migration_conflicts_archived_at",
    },
  );

  return collection;
}

async function archiveDuplicate({
  conflictCollection,
  collectionName,
  indexDefinition,
  duplicateDocument,
  canonicalDocument,
  duplicateKey,
}) {
  const now = new Date();

  await conflictCollection.updateOne(
    {
      migrationVersion: 2,
      sourceCollection: collectionName,
      sourceId: duplicateDocument._id,
      indexName: indexDefinition.name,
    },
    {
      $setOnInsert: {
        migrationVersion: 2,
        sourceCollection: collectionName,
        sourceId: duplicateDocument._id,
        indexName: indexDefinition.name,
        duplicateKey,
        canonicalSourceId: canonicalDocument._id,
        archivedDocument: duplicateDocument,
        archivedAt: now,
        reason: "legacy-duplicate-before-unique-index",
      },
    },
    {
      upsert: true,
    },
  );
}

async function processDuplicateGroup({
  sourceCollection,
  conflictCollection,
  collectionName,
  indexDefinition,
  duplicateGroup,
}) {
  const documents = await sourceCollection
    .find({
      _id: {
        $in: duplicateGroup.documentIds,
      },
    })
    .toArray();

  if (documents.length <= 1) {
    return {
      archived: 0,
      deleted: 0,
    };
  }

  const canonicalDocument =
    selectCanonicalDocument(documents);

  const duplicateDocuments = documents.filter(
    (document) =>
      String(document._id) !==
      String(canonicalDocument._id),
  );

  let archived = 0;
  let deleted = 0;

  for (const duplicateDocument of duplicateDocuments) {
    /*
     * The archive operation happens before deletion.
     *
     * If the migration is interrupted after archiving, the upsert makes
     * the next execution idempotent and deletion can safely be retried.
     */
    await archiveDuplicate({
      conflictCollection,
      collectionName,
      indexDefinition,
      duplicateDocument,
      canonicalDocument,
      duplicateKey: duplicateGroup._id,
    });

    archived += 1;

    const deleteResult =
      await sourceCollection.deleteOne({
        _id: duplicateDocument._id,
      });

    deleted += deleteResult.deletedCount;
  }

  return {
    archived,
    deleted,
  };
}

async function processUniqueIndex({
  db,
  collectionName,
  indexDefinition,
  logger,
  checkpoint,
  saveCheckpoint,
}) {
  if (indexDefinition.options?.unique !== true) {
    return {
      groupsProcessed: 0,
      archived: 0,
      deleted: 0,
    };
  }

  const sourceCollection =
    db.collection(collectionName);

  const conflictCollection =
    db.collection(CONFLICT_COLLECTION);

  const cursor = sourceCollection.aggregate(
    buildDuplicatePipeline(indexDefinition),
    {
      allowDiskUse: true,
      batchSize: DUPLICATE_BATCH_SIZE,
    },
  );

  let groupsProcessed =
    checkpoint?.groupsProcessed || 0;

  let archived =
    checkpoint?.archived || 0;

  let deleted =
    checkpoint?.deleted || 0;

  for await (const duplicateGroup of cursor) {
    const result = await processDuplicateGroup({
      sourceCollection,
      conflictCollection,
      collectionName,
      indexDefinition,
      duplicateGroup,
    });

    groupsProcessed += 1;
    archived += result.archived;
    deleted += result.deleted;

    if (
      groupsProcessed % DUPLICATE_BATCH_SIZE ===
      0
    ) {
      const nextCheckpoint = {
        phase: "deduplicate",
        collectionName,
        indexName: indexDefinition.name,
        groupsProcessed,
        archived,
        deleted,
        updatedAt: new Date(),
      };

      await saveCheckpoint(nextCheckpoint);

      logger.info?.(
        "[migration:002] Duplicate batch processed",
        nextCheckpoint,
      );
    }
  }

  const finalCheckpoint = {
    phase: "deduplicate",
    collectionName,
    indexName: indexDefinition.name,
    groupsProcessed,
    archived,
    deleted,
    completed: true,
    updatedAt: new Date(),
  };

  await saveCheckpoint(finalCheckpoint);

  logger.info?.(
    "[migration:002] Unique index cleanup completed",
    finalCheckpoint,
  );

  return {
    groupsProcessed,
    archived,
    deleted,
  };
}

async function restoreArchivedDocuments({
  db,
  conflictCollection,
  logger,
}) {
  const cursor = conflictCollection.find({
    migrationVersion: 2,
  });

  let restored = 0;

  for await (const conflict of cursor) {
    const sourceCollection = db.collection(
      conflict.sourceCollection,
    );

    await sourceCollection.replaceOne(
      {
        _id: conflict.sourceId,
      },
      conflict.archivedDocument,
      {
        upsert: true,
      },
    );

    await conflictCollection.deleteOne({
      _id: conflict._id,
    });

    restored += 1;

    if (
      restored % DUPLICATE_BATCH_SIZE ===
      0
    ) {
      logger.info?.(
        "[migration:002] Rollback batch restored",
        {
          restored,
        },
      );
    }
  }

  return restored;
}

const migration = {
  version: 2,

  name: "resolve-legacy-duplicates",

  description:
    "Archives and removes duplicate legacy records in batches before unique indexes are enforced.",

  async up({
    db,
    logger = console,
    getCheckpoint,
    saveCheckpoint,
    clearCheckpoint,
  }) {
    await ensureConflictCollection(db);

    const checkpoint =
      (await getCheckpoint()) || {};

    const entries = Object.entries(REQUIRED_INDEXES);

    const startCollectionIndex =
      checkpoint.collectionPosition || 0;

    let startIndexPosition =
      checkpoint.indexPosition || 0;

    let totalGroupsProcessed =
      checkpoint.totalGroupsProcessed || 0;

    let totalArchived =
      checkpoint.totalArchived || 0;

    let totalDeleted =
      checkpoint.totalDeleted || 0;

    for (
      let collectionPosition = startCollectionIndex;
      collectionPosition < entries.length;
      collectionPosition += 1
    ) {
      const [collectionName, indexes] =
        entries[collectionPosition];

      /*
       * Never inspect or modify the collections that control the
       * migration system itself.
       */
      if (
        isMigrationInfrastructureCollection(
          collectionName,
        )
      ) {
        logger.info?.(
          "[migration:002] Migration infrastructure collection skipped",
          {
            collectionName,
          },
        );

        await saveCheckpoint({
          phase: "deduplicate",
          collectionPosition:
            collectionPosition + 1,
          indexPosition: 0,
          totalGroupsProcessed,
          totalArchived,
          totalDeleted,
          updatedAt: new Date(),
        });

        startIndexPosition = 0;
        continue;
      }

      const indexStart =
        collectionPosition ===
        startCollectionIndex
          ? startIndexPosition
          : 0;

      for (
        let indexPosition = indexStart;
        indexPosition < indexes.length;
        indexPosition += 1
      ) {
        const indexDefinition =
          indexes[indexPosition];

        if (
          indexDefinition.options?.unique !== true
        ) {
          continue;
        }

        const result = await processUniqueIndex({
          db,
          collectionName,
          indexDefinition,
          logger,
          checkpoint:
            checkpoint.collectionName ===
              collectionName &&
            checkpoint.indexName ===
              indexDefinition.name
              ? checkpoint
              : null,
          saveCheckpoint,
        });

        totalGroupsProcessed +=
          result.groupsProcessed;

        totalArchived += result.archived;
        totalDeleted += result.deleted;

        await saveCheckpoint({
          phase: "deduplicate",
          collectionPosition,
          indexPosition: indexPosition + 1,
          collectionName,
          indexName: indexDefinition.name,
          totalGroupsProcessed,
          totalArchived,
          totalDeleted,
          updatedAt: new Date(),
        });
      }

      startIndexPosition = 0;

      await saveCheckpoint({
        phase: "deduplicate",
        collectionPosition:
          collectionPosition + 1,
        indexPosition: 0,
        totalGroupsProcessed,
        totalArchived,
        totalDeleted,
        updatedAt: new Date(),
      });
    }

    await clearCheckpoint();

    logger.info?.(
      "[migration:002] Legacy duplicate cleanup completed",
      {
        totalGroupsProcessed,
        totalArchived,
        totalDeleted,
      },
    );
  },

  async down({ db, logger = console }) {
    const conflictCollection =
      db.collection(CONFLICT_COLLECTION);

    const restored =
      await restoreArchivedDocuments({
        db,
        conflictCollection,
        logger,
      });

    logger.info?.(
      "[migration:002] Archived duplicates restored",
      {
        restored,
      }
    );
  },
};

export default migration;
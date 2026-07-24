import { REQUIRED_INDEXES } from "../schemaContracts.js";

function getUniqueIndexes(indexDefinitions) {
  return indexDefinitions.filter(
    (definition) => definition.options?.unique === true,
  );
}

async function createUniqueIndexes(
  db,
  collectionName,
  indexDefinitions,
  logger,
) {
  const uniqueIndexes = getUniqueIndexes(indexDefinitions);

  if (uniqueIndexes.length === 0) {
    return;
  }

  const models = uniqueIndexes.map((definition) => ({
    key: definition.keys,
    name: definition.name,
    ...definition.options,
  }));

  await db.collection(collectionName).createIndexes(models);

  logger.info?.("[migration:003] Unique indexes ensured", {
    collectionName,
    count: uniqueIndexes.length,
    indexes: uniqueIndexes.map((definition) => definition.name),
  });
}

async function dropUniqueIndexes(
  db,
  collectionName,
  indexDefinitions,
  logger,
) {
  const uniqueIndexes = getUniqueIndexes(indexDefinitions);
  const collection = db.collection(collectionName);

  for (const definition of uniqueIndexes) {
    try {
      await collection.dropIndex(definition.name);

      logger.info?.("[migration:003] Unique index dropped", {
        collectionName,
        indexName: definition.name,
      });
    } catch (error) {
      // MongoDB error code 27 means the index does not exist.
      if (error?.code === 27 || error?.codeName === "IndexNotFound") {
        continue;
      }

      throw error;
    }
  }
}

const migration = {
  version: 3,
  name: "enforce-unique-indexes",
  description:
    "Creates unique and partial unique indexes after legacy duplicates have been resolved.",

  async up({ db, logger = console }) {
    for (const [collectionName, indexDefinitions] of Object.entries(
      REQUIRED_INDEXES,
    )) {
      await createUniqueIndexes(
        db,
        collectionName,
        indexDefinitions,
        logger,
      );
    }

    logger.info?.("[migration:003] Unique index enforcement completed");
  },

  async down({ db, logger = console }) {
    for (const [collectionName, indexDefinitions] of Object.entries(
      REQUIRED_INDEXES,
    )) {
      await dropUniqueIndexes(
        db,
        collectionName,
        indexDefinitions,
        logger,
      );
    }

    logger.info?.("[migration:003] Unique index rollback completed");
  },
};

export default migration;
import {
  COLLECTION_VALIDATORS,
  COLLECTIONS,
  REQUIRED_INDEXES,
} from "../schemaContracts.js";

async function collectionExists(db, collectionName) {
  const collections = await db
    .listCollections(
      {
        name: collectionName,
      },
      {
        nameOnly: true,
      },
    )
    .toArray();

  return collections.length > 0;
}

async function ensureCollection(db, collectionName) {
  if (await collectionExists(db, collectionName)) {
    return;
  }

  await db.createCollection(collectionName);
}

async function applyValidator(db, collectionName, validator) {
  await db.command({
    collMod: collectionName,
    validator,
    validationLevel: "moderate",
    validationAction: "error",
  });
}

async function createIndexes(db, collectionName, indexDefinitions) {
  if (!indexDefinitions?.length) {
    return;
  }

  const models = indexDefinitions.map((definition) => ({
    key: definition.keys,
    name: definition.name,
    ...definition.options,
  }));

  await db.collection(collectionName).createIndexes(models);
}

const migration = {
  version: 1,
  name: "initialize-documented-schema",
  description:
    "Creates documented collections, validators, and indexes without inserting operational data.",

  async up({ db, logger = console }) {
    const collectionNames = new Set([
      ...Object.values(COLLECTIONS),
      ...Object.keys(REQUIRED_INDEXES),
      ...Object.keys(COLLECTION_VALIDATORS),
    ]);

    for (const collectionName of collectionNames) {
      await ensureCollection(db, collectionName);

      logger.info?.("[migration:001] Collection ensured", {
        collectionName,
      });
    }

    for (const [collectionName, validator] of Object.entries(
      COLLECTION_VALIDATORS,
    )) {
      await applyValidator(db, collectionName, validator);

      logger.info?.("[migration:001] Validator applied", {
        collectionName,
      });
    }

    for (const [collectionName, definitions] of Object.entries(
      REQUIRED_INDEXES,
    )) {
      // Unique indexes are postponed until legacy duplicates have been
      // archived and removed by migration 002.
      const forwardSafeIndexes = definitions.filter(
        (definition) => definition.options?.unique !== true,
      );

      await createIndexes(db, collectionName, forwardSafeIndexes);

      logger.info?.("[migration:001] Forward-safe indexes ensured", {
        collectionName,
        count: forwardSafeIndexes.length,
      });
    }
  },

  async down({ db, logger = console }) {
    /*
     * Deliberately conservative rollback:
     * removing validators is safe, but deleting production collections is not.
     */
    for (const collectionName of Object.keys(COLLECTION_VALIDATORS)) {
      if (!(await collectionExists(db, collectionName))) {
        continue;
      }

      await db.command({
        collMod: collectionName,
        validator: {},
        validationLevel: "off",
      });

      logger.info?.("[migration:001] Validator disabled", {
        collectionName,
      });
    }
  },
};

export default migration;
import { getDb, closeMongoConnection } from "../src/lib/mongodb.js";
import { REQUIRED_INDEXES } from "../src/lib/backend/schemaContracts.js";

/**
 * Compatibility script.
 *
 * Index creation should normally be performed through the migration runner.
 * This script only reconciles the documented indexes and never inserts data.
 */
async function setupDatabaseIndexes() {
  console.log("[indexes] Starting index reconciliation");

  const db = await getDb();

  for (const [collectionName, indexDefinitions] of Object.entries(
    REQUIRED_INDEXES,
  )) {
    const collection = db.collection(collectionName);

    console.log(
      `[indexes] Reconciling ${indexDefinitions.length} index(es) for ${collectionName}`,
    );

    for (const definition of indexDefinitions) {
      const options = {
        ...definition.options,
        name: definition.name,
      };

      try {
        const indexName = await collection.createIndex(
          definition.keys,
          options,
        );

        console.log(
          `[indexes] Ensured ${collectionName}.${indexName}`,
        );
      } catch (error) {
        console.error(
          `[indexes] Failed to create index ${definition.name} on ${collectionName}`,
          {
            code: error?.code,
            codeName: error?.codeName,
            message: error?.message,
          },
        );

        throw error;
      }
    }
  }

  console.log("[indexes] Index reconciliation completed");
}

setupDatabaseIndexes()
  .catch((error) => {
    console.error("[indexes] Fatal index setup failure", {
      code: error?.code,
      codeName: error?.codeName,
      message: error?.message,
    });

    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongoConnection();
  });